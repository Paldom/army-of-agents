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

/**
 * The real dispatcher: assemble the capsule, drive a named acpx session, watch
 * the stream, classify the outcome.
 */
const dispatcher: Dispatcher = {
  /**
   * Cheap and LLM-free. An agent declares work by having an unread message, an
   * answered verdict, or a schedule that says so. Discovering there is nothing
   * to do must never cost a vendor turn.
   */
  precondition(agent: AgentRow): boolean {
    const unread = db
      .prepare(
        `SELECT COUNT(*) AS n FROM message_deliveries d
         WHERE d.recipient = ? AND d.state IN ('QUEUED','LEASED')`,
      )
      .get(`agent:${agent.slug}`) as { n: number };
    if (unread.n > 0) return true;

    const answered = db
      .prepare(
        `SELECT COUNT(*) AS n FROM approval_requests
         WHERE agent_id = ? AND state = 'APPROVED' AND answered_at > COALESCE(
           (SELECT MAX(ended_at) FROM runs WHERE agent_id = ? AND ended_at IS NOT NULL), 0)`,
      )
      .get(agent.id, agent.id) as { n: number };
    if (answered.n > 0) return true;

    // Being due IS the signal for a scheduled or continuous agent. An earlier
    // version excluded 'continuous' to avoid spending a turn discovering there
    // was nothing to do — but a continuous agent has no other way to start, so
    // it never ran at all. Live, four of them sat at NO_WORK with a growing
    // idle streak having executed exactly zero turns.
    //
    // The cost this was guarding against is what the BACKOFF is for: a
    // continuous agent that keeps reporting NO_WORK decays to its 1h ceiling.
    // 'on_message' and 'event' stay out — those genuinely have a signal, and
    // it is checked above.
    const wake = JSON.parse(agent.wake) as { kind: string };
    return wake.kind === 'schedule' || wake.kind === 'manual' || wake.kind === 'continuous';
  },

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
    const capsule = renderCapsule(assembleCapsule(db, agent.id));

    const allowed = allowedToolsFor(true);
    const spec = {
      name: agent.slug,
      agent: cap?.acpxAgent ?? agent.harness ?? 'codex',
      cwd,
      timeoutSec: 1800,
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

    const res = await prompt(runner, spec, capsule);

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
      const r = await tick(db, dispatcher, { maxInFlight });
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
