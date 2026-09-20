import { homedir } from 'node:os';
import { join } from 'node:path';

import { open } from '../store/db.ts';
import { type AgentRow, attachJobDir, getAgent } from './repo.ts';
import { reconcile } from './reconcile.ts';
import { dbPathFor, paneName } from './workspace.ts';
import { type Dispatcher, tick } from './tick.ts';
import { type Outcome } from './state.ts';
import { assembleCapsule, renderCapsule } from './memory.ts';
import { expireAsks } from './hitl.ts';
import { applyResult } from './outcome.ts';
import { reapExpired } from '../orchestrator/spawn.ts';
import { acpxRunner, ensureSession, prompt } from '../acp/session.ts';
import { paneAvailable, tmuxRunner } from '../acp/tmux-runner.ts';
import { capabilityOf } from '../acp/capabilities.ts';
import { allowedToolsFor } from '../policy/vendor-guard.ts';
import { ensureWorktree, isolationFor } from './isolation.ts';
import { emit } from '../store/db.ts';
import { leaseFor } from './messages.ts';
import { hasWork } from './precondition.ts';
import { ingestMarkers } from './report.ts';
import { installEventHook } from './hooks.ts';
import { textStream } from '../acp/session.ts';
import { ORCHESTRATOR_SLUG, ensureOrchestrator, fleetBriefing } from '../orchestrator/bootstrap.ts';
import { loadHarnessesFor } from '../acp/capabilities.ts';

/**
 * ONE ENTRY POINT. This is the long-running loop.
 *
 * It is deliberately LLM-free: it owns the tick, the store, leases, wake policy
 * and dispatch, and it must keep working when no model is reachable. Judgement
 * lives in the orchestrator agent, which this loop dispatches like any other —
 * so restarting the thinking half costs nothing, because its context is rebuilt
 * from rows rather than from a surviving context window.
 */

const projectRoot = process.env['AOA_PROJECT_ROOT'] ?? process.cwd();
// Beside the project, never inside the skill: an upgrade must not be able to
// delete a fleet's memory, and one checkout has to drive any number of projects.
const dbPath = dbPathFor(projectRoot);
const intervalMs = Number(process.env['AOA_TICK_MS'] ?? 15_000);
// The quota control. Every in-flight turn is a live vendor session.
const maxInFlight = Number(process.env['AOA_MAX_IN_FLIGHT'] ?? 6);

const db = open(dbPath);
// Both processes ensure it: whichever starts first, the orchestrator has a
// thread before anyone can address it.
ensureOrchestrator(db);
installEventHook();
loadHarnessesFor(projectRoot);

/**
 * The real dispatcher: assemble the capsule, drive a named acpx session, watch
 * the stream, classify the outcome.
 */
const dispatcher: Dispatcher = {
  precondition: (agent: AgentRow) => hasWork(db, agent),

  async dispatch(agent: AgentRow, runId: string): Promise<Outcome> {
    const cap = capabilityOf(agent.harness);
    const iso = isolationFor(agent.slug, {
      root: projectRoot,
      home: homedir(),
      assignedVendor: agent.harness,
    });
    // The path is not the directory. Create it before anything is pointed at
    // it, and take back the cwd actually usable — it degrades to the project
    // root when a worktree is not possible.
    const cwd = ensureWorktree(iso, projectRoot, agent.slug);

    // Lease the inbox for the length of the turn. Settling the run acks it in
    // the same transaction; a crash before that lets the lease lapse and the
    // mail is redelivered, which is the at-least-once the store promises.
    const timeoutSec = 1800;
    const inbox = leaseFor(db, `agent:${agent.slug}`, runId, timeoutSec * 1000 + 60_000);
    const body = assembleCapsule(db, agent.id);
    body.inbox = inbox.map((m) => ({ author: m.author, kind: m.kind, body: m.body }));
    if (agent.slug === ORCHESTRATOR_SLUG) body.briefing = fleetBriefing(db);
    const control = (
      db.prepare('SELECT value FROM meta WHERE key = ?').get(`browser_control:${agent.slug}`) as { value: string } | undefined
    )?.value;
    if (control && control !== 'agent_driving') body.browserControl = control;
    const capsule = renderCapsule(body);

    const allowed = allowedToolsFor(true);
    const spec = {
      name: agent.slug,
      agent: cap?.acpxAgent ?? agent.harness ?? 'codex',
      cwd,
      timeoutSec,
      ...(agent.persona ? { systemPrompt: agent.persona } : {}),
      ...(allowed ? { allowedTools: allowed } : {}),
    };

    // Run the turn in the agent's own tmux pane so the workspace's terminal
    // tab shows the real session live. Piped stdio is the fallback on hosts
    // without tmux — same events, just nothing to watch.
    const runner = paneAvailable()
      ? tmuxRunner({
          session: paneName(projectRoot, agent.slug),
          cwd,
          timeoutMs: spec.timeoutSec * 1000,
          // Recorded the moment the job dir exists, so a crash one second later
          // still leaves the next supervisor something to reconcile against.
          onJob: (job) => attachJobDir(db, runId, job),
        })
      : acpxRunner;

    const ready = await ensureSession(runner, spec);
    if (!ready) return 'RETRYABLE_ERROR';

    // Every complete line the agent writes is read as it lands, so a REPORT
    // is in the thread while the turn is still running.
    const onOutput = textStream((text) => {
      try {
        ingestMarkers(db, agent, runId, text, { partial: true });
      } catch (err) {
        emit(db, 'run.stream_error', 'system', { runId, error: String(err) }, agent.id);
      }
    });
    const res = await prompt(runner, spec, capsule, onOutput);

    // A vendor refusal backs off the LANE, not this agent alone.
    return applyResult(db, agent, runId, res);
  },
};

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopping = true;
    process.stdout.write('\nstopping after this tick\n');
  });
}

async function loop(): Promise<void> {
  process.stdout.write(`supervisor: ${dbPath}\nproject: ${projectRoot}\ntick: ${intervalMs}ms\n`);

  // BEFORE the first tick. Turns outlive the process that started them, and
  // dispatching over a live orphan is what makes the next turn silent.
  const r = reconcile(db);
  if (r.adopted.length || r.killed.length || r.settled.length) {
    process.stdout.write(
      `reconciled: ${r.adopted.length} adopted, ${r.killed.length} orphans killed, ` +
        `${r.settled.length} settled without an executor\n`,
    );
  }
  while (!stopping) {
    try {
      // Every tick: an adopted run has no poller, so this is what completes it.
      reconcile(db);
      expireAsks(db);          // expiry pauses and reports; it never approves
      reapExpired(db);         // TTL'd children retire with their descendants
      const r = await tick(db, dispatcher, { maxInFlight, reserved: [ORCHESTRATOR_SLUG] });
      if (r.dispatched > 0 || r.lostWake.length > 0) {
        process.stdout.write(
          `tick: ${r.dispatched} dispatched, ${r.skippedPrecondition} idle, ` +
            `${r.skippedResource} lane-capped${r.lostWake.length ? `, ALARM lost-wake: ${r.lostWake.join(',')}` : ''}\n`,
        );
      }
    } catch (err) {
      // The loop must outlive any single failure — that is its entire job.
      emit(db, 'supervisor.error', 'system', { error: String(err) });
      process.stderr.write(`tick error: ${String(err)}\n`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  db.close();
}

void loop();

export { dispatcher, getAgent };
