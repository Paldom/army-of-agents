import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { type Db, emit, now } from '../store/db.ts';
import { isAlive, killTurn, readHeartbeat } from '../acp/tmux-runner.ts';
import { parsePromptOutput } from '../acp/session.ts';
import { getAgent, type RunRow, succeed, unfinishedRuns } from './repo.ts';
import { applyResult } from './outcome.ts';

/**
 * Reconcile turns that outlived the supervisor.
 *
 * A crash or restart does not stop the work: the acpx queue owner and the
 * harness it spawned keep running, orphaned. The supervisor comes back, sees a
 * run with no end, settles it, and dispatches again — and because acpx
 * serialises prompts per named session, that new prompt blocks behind the
 * orphan and emits nothing at all. Zero bytes, no error, until the deadline.
 *
 * So a restart must decide about each unfinished run BEFORE normal scheduling
 * resumes. Evidence decides, not the session name:
 *
 *   exit sentinel    → FINALISE. The turn completed with nobody watching. Its
 *                      capture file is the whole result, and it is applied
 *                      exactly as the original poll would have, asks included.
 *   heartbeat fresh  → ADOPT. Real work is in flight; killing it wastes a turn
 *                      the owner already paid for. It finishes into its own
 *                      job dir and a later tick finalises it.
 *   heartbeat stale  → KILL the process group, settle the run, let the agent
 *                      be redispatched. A stale orphan is precisely the thing
 *                      that makes the next turn silent.
 *   no job dir       → nothing to adopt or kill; settle it and move on.
 */
export interface Reconciliation {
  adopted: string[];
  killed: string[];
  settled: string[];
  finalised: string[];
}

/**
 * Runs EVERY TICK, not only at startup.
 *
 * An adopted run has nobody polling it — the poll loop died with the process
 * that started it. Reconciling only at startup would leave that run open and
 * its agent wedged behind the one-live-run index until the next restart, which
 * turns a recovered turn into a permanently stuck agent.
 */

export function reconcile(db: Db, nowMs = now()): Reconciliation {
  const out: Reconciliation = { adopted: [], killed: [], settled: [], finalised: [] };

  for (const run of unfinishedRuns(db)) {
    const job = run.job_dir;

    if (!job || !existsSync(job)) {
      // The executor left no trace. Nothing can be adopted, and there is
      // nothing to kill; the run is simply over as far as the store is aware.
      settle(db, run, 'no executor to adopt');
      out.settled.push(run.id);
      continue;
    }

    // Finished while unwatched. Checked before liveness, because a wrapper
    // that just exited is both "done" and "not beating".
    const exitFile = join(job, 'exit');
    if (existsSync(exitFile)) {
      finalise(db, run, job, exitFile);
      rmSync(job, { recursive: true, force: true });
      out.finalised.push(run.id);
      continue;
    }

    const hb = readHeartbeat(job);
    if (isAlive(hb, nowMs)) {
      // Adopted runs are left EXACTLY as they are: still open, still leased by
      // the one-live-run index, so the scheduler will not dispatch over them.
      emit(db, 'run.adopted', 'system', { runId: run.id, phase: hb?.phase, bytes: hb?.bytes }, run.agent_id);
      out.adopted.push(run.id);
      continue;
    }

    killTurn(job);
    rmSync(job, { recursive: true, force: true });
    emit(db, 'run.orphan_killed', 'system', { runId: run.id, lastPhase: hb?.phase ?? null }, run.agent_id);
    settle(db, run, 'orphan killed');
    out.killed.push(run.id);
  }

  if (out.adopted.length || out.killed.length || out.finalised.length) {
    emit(db, 'supervisor.reconciled', 'system', {
      adopted: out.adopted.length, killed: out.killed.length,
      settled: out.settled.length, finalised: out.finalised.length,
    });
  }
  return out;
}

/**
 * Complete a run from its capture file alone.
 *
 * Goes through the same `applyResult` as a watched run: a separate, simpler
 * path here would silently drop the agent's questions for precisely the runs
 * that were interrupted — the ones most likely to have asked for help.
 */
function finalise(db: Db, run: RunRow, job: string, exitFile: string): void {
  const agent = getAgent(db, run.agent_id);
  if (!agent) return;
  let outcome: 'RETRYABLE_ERROR' | ReturnType<typeof applyResult> = 'RETRYABLE_ERROR';
  try {
    const code = Number(readFileSync(exitFile, 'utf8').trim());
    const capturePath = join(job, 'stdout.ndjson');
    const stdout = existsSync(capturePath) ? readFileSync(capturePath, 'utf8') : '';
    outcome = applyResult(db, agent, run.id, parsePromptOutput(stdout, code));
  } catch (err) {
    emit(db, 'run.finalise_failed', 'system', { runId: run.id, error: String(err) }, run.agent_id);
  }
  succeed(db, run.id, outcome, { nowMs: now() });
  emit(db, 'run.finalised_after_restart', 'system', { runId: run.id, outcome }, run.agent_id);
}

function settle(db: Db, run: RunRow, reason: string): void {
  // RETRYABLE_ERROR, not a failure of the agent: nothing about the work was
  // wrong, the process supervising it went away.
  succeed(db, run.id, 'RETRYABLE_ERROR', { nowMs: now(), toState: 'failed' });
  emit(db, 'run.reconciled', 'system', { runId: run.id, reason }, run.agent_id);
}
