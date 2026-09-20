import { type Db, emit, now } from '../store/db.ts';
import {
  type AgentRow,
  getAgent,
  laneBlockedUntil,
  liveRun,
  lostWakeScan,
  openRun,
  succeed,
} from './repo.ts';
import { type Outcome } from './state.ts';
import { computeNextWake, isDue, parseWake } from './wake.ts';
import { reserve } from './budget.ts';

/**
 * What a dispatcher must provide. Injected so the tick is testable without
 * spawning a harness — the tick's logic is the thing under test, not acpx.
 */
export interface Dispatcher {
  /**
   * A cheap, LLM-FREE check for "is there anything to do?".
   *
   * MANDATORY, not optional. Without it, discovering there is nothing to do
   * still costs a full vendor turn: ten continuous agents at a 1h floor is
   * ~240 turns/day of pure nothing. A tick whose precondition returns false
   * ends before any run exists — the agent never woke in any meaningful sense.
   */
  precondition(agent: AgentRow): Promise<boolean> | boolean;
  /** Run one iteration. Returns the classified outcome. */
  dispatch(agent: AgentRow, runId: string): Promise<Outcome>;
}

export interface TickResult {
  considered: number;
  skippedNotDue: number;
  skippedPrecondition: number;
  skippedResource: number;
  skippedBudget: number;
  dispatched: number;
  lostWake: string[];
}

export interface TickOptions {
  nowMs?: number;
  jitter?: number;
  /** Cap on turns STARTED in one tick. */
  maxDispatch?: number;
  /**
   * Cap on turns in flight ACROSS ticks — the one that protects the quota.
   *
   * maxDispatch alone does not: ticks are seconds apart and turns run for
   * tens of minutes, so four starts per tick accumulate until every agent is
   * running at once. Live, that reached twelve concurrent vendor sessions
   * within minutes of a restart.
   */
  maxInFlight?: number;
  /**
   * Slugs considered before everyone else and allowed one turn beyond the
   * in-flight cap. The orchestrator: a fleet whose judge waits behind six
   * busy workers cannot be asked anything.
   */
  reserved?: string[];
}

export async function tick(
  db: Db,
  dispatcher: Dispatcher,
  opts: TickOptions = {},
): Promise<TickResult> {
  const nowMs = opts.nowMs ?? now();
  const result: TickResult = {
    considered: 0,
    skippedNotDue: 0,
    skippedPrecondition: 0,
    skippedResource: 0,
    skippedBudget: 0,
    dispatched: 0,
    lostWake: [],
  };

  const reserved = new Set(opts.reserved ?? []);
  const agents = (
    db.prepare(`SELECT * FROM agents WHERE status = 'ACTIVE' ORDER BY next_due_at`).all() as AgentRow[]
  ).sort((a, b) => Number(reserved.has(b.slug)) - Number(reserved.has(a.slug)));

  const maxDispatch = opts.maxDispatch ?? 4;
  const maxInFlight = opts.maxInFlight ?? 6;
  // Adopted turns from a previous supervisor count too: they are real sessions
  // burning real quota, whoever started them. Reserved agents are outside the
  // ordinary accounting in both directions: their turns do not take a
  // worker's slot, and a full fleet does not stop them.
  let inFlight = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM runs r JOIN agents a ON a.id = r.agent_id
         WHERE r.state NOT IN ('continue','completed','failed')
           AND a.slug NOT IN (${[...reserved].map(() => '?').join(',') || "''"})`,
      )
      .get(...reserved) as { n: number }
  ).n;

  // Selection is sequential — it takes the store's single-writer boundary and
  // must stay ordered — but DISPATCH is not. An earlier version awaited each
  // turn inside this loop, so `maxDispatch` (documented as a concurrency cap)
  // actually serialised the whole fleet behind one agent: with turns running
  // ten to thirty minutes, twenty-two agents shared a single slot and most of
  // them never got a turn at all.
  const dispatches: Array<Promise<void>> = [];

  for (const agent of agents) {
    result.considered++;

    if (result.dispatched >= maxDispatch) break;
    if (!reserved.has(agent.slug) && inFlight >= maxInFlight) {
      result.skippedResource++;
      break;
    }
    if (!isDue(agent.next_due_at, nowMs)) {
      result.skippedNotDue++;
      continue;
    }
    if (liveRun(db, agent.id)) continue; // another tick owns it

    const blocked = laneBlockedUntil(db, agent.harness);
    if (blocked !== null && blocked > nowMs) {
      result.skippedResource++;
      continue;
    }

    // Cheap first, expensive second. No run row is created when there is
    // nothing to do — an earlier version opened one and immediately settled it,
    // which contradicted this comment and put a phantom iteration in the
    // agent's history for every idle tick.
    if (!(await dispatcher.precondition(agent))) {
      result.skippedPrecondition++;
      // The backoff still has to advance, or a cheap check that keeps saying
      // "nothing to do" would re-fire at the floor forever.
      backoffWithoutRun(db, agent, nowMs, opts.jitter ?? 0);
      continue;
    }

    const run = openRun(db, agent, { wakeReason: agent.wake_reason ?? 'schedule' });
    if (!run) continue; // lost the race; the index did its job

    // Budget is reserved in the same transaction that materialises the run.
    if (!reserve(db, agent.id, 1, run.id)) {
      result.skippedBudget++;
      succeed(db, run.id, 'NO_WORK', { nowMs, toState: 'failed' });
      pause(db, agent.id, 'budget exhausted');
      continue;
    }

    result.dispatched++;
    if (!reserved.has(agent.slug)) inFlight++;
    dispatches.push(runOne(db, dispatcher, agent, run.id, opts.jitter ?? 0));
  }

  // Settling happens per run as each finishes; this only waits for the tick to
  // be over. One agent's failure cannot take the tick down — runOne catches.
  await Promise.all(dispatches);

  result.lostWake = lostWakeScan(db).map((a) => a.slug);
  if (result.lostWake.length > 0) {
    emit(db, 'alarm.lost_wake', 'system', { agents: result.lostWake });
  }
  // The server cannot wake anyone. This is how it knows whether anything can.
  db.prepare(`INSERT OR REPLACE INTO meta(key, value) VALUES ('supervisor_last_tick_at', ?)`).run(String(nowMs));
  return result;
}

/** One turn, start to settled. Never throws: the loop must outlive any agent. */
async function runOne(
  db: Db,
  dispatcher: Dispatcher,
  agent: AgentRow,
  runId: string,
  jitter: number,
): Promise<void> {
  let outcome: Outcome;
  try {
    outcome = await dispatcher.dispatch(agent, runId);
  } catch (err) {
    emit(db, 'run.error', 'system', { runId, error: String(err) }, agent.id);
    outcome = 'RETRYABLE_ERROR';
  }
  succeed(db, runId, outcome, { nowMs: now(), jitter });
}

/**
 * Advance the backoff for a tick that never became an iteration.
 *
 * No run row: the agent did not wake in any meaningful sense, so its history
 * should not claim it did. `idle_streak` still climbs, which is what stops a
 * cheap check that keeps saying "nothing to do" from re-firing at the floor.
 *
 * This ALWAYS advances. It used to skip human-bumped agents, by analogy with
 * `succeed()` — but the analogy is wrong. `succeed()` protects a verdict
 * answered while a run was in flight; here there is no run, and the
 * precondition just reported no work, which includes no unconsumed verdict.
 * Skipping the advance left the agent permanently overdue and permanently
 * unrunnable: reconsidered on every tick, never dispatched, never progressing,
 * and invisible to the lost-wake alarm because `next_due_at` was not NULL.
 * Live, two agents sat 28 hours overdue having never run once.
 */
function backoffWithoutRun(db: Db, agent: AgentRow, nowMs: number, jitter: number): void {
  const next = computeNextWake(
    parseWake(agent.wake),
    'NO_WORK',
    { idleStreak: agent.idle_streak, errorStreak: agent.error_streak },
    nowMs,
    jitter,
  );
  db.prepare(
    `UPDATE agents SET next_due_at = ?, wake_reason = ?, idle_streak = ?, last_outcome = 'NO_WORK',
       updated_at = ?, version = version + 1 WHERE id = ?`,
  ).run(next.nextDueAt, next.wakeReason, next.idleStreak, nowMs, agent.id);
  emit(db, 'tick.precondition_false', 'system', { idleStreak: next.idleStreak }, agent.id);
}

export function pause(db: Db, agentId: string, reason: string): void {
  db.prepare(
    `UPDATE agents SET status = 'PAUSED', next_due_at = NULL, updated_at = ?, version = version + 1
     WHERE id = ?`,
  ).run(now(), agentId);
  emit(db, 'agent.paused', 'system', { reason }, agentId);
}

/** Durable, shared vendor backoff. Every agent on the lane waits together. */
export function gateVendor(db: Db, vendor: string, untilMs: number, reason: string): void {
  db.prepare(
    `INSERT INTO provider_gates(vendor, blocked_until, reason)
     VALUES (?,?,?)
     ON CONFLICT(vendor) DO UPDATE SET
       blocked_until = MAX(excluded.blocked_until, provider_gates.blocked_until),
       reason = excluded.reason,
       version = provider_gates.version + 1`,
  ).run(vendor, untilMs, reason);
  emit(db, 'lane.gated', 'system', { vendor, untilMs, reason });
}

export { parseWake, getAgent };
