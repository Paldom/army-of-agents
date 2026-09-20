import { type Db, appendMessage, cas, emit, id, now, tx } from '../store/db.ts';
import { type Outcome, type RunState, TERMINAL, assertLegal } from './state.ts';
import { type WakePolicy, computeNextWake, parseWake } from './wake.ts';
import { type Derivation, derive } from './derived.ts';

export interface AgentRow {
  id: string;
  slug: string;
  display_name: string;
  title: string | null;
  persona: string;
  mission: string;
  harness: string | null;
  wake: string;
  status: string;
  next_due_at: number | null;
  wake_reason: string | null;
  idle_streak: number;
  error_streak: number;
  last_outcome: string | null;
  current_revision_id: string | null;
  parent_agent_id: string | null;
  root_agent_id: string | null;
  depth: number;
  expires_at: number | null;
  created_by: string;
  workspace: string | null;
  browser_profile: string | null;
  docs_ref: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface RunRow {
  id: string;
  agent_id: string;
  revision_id: string | null;
  state: RunState;
  outcome: Outcome | null;
  attempt: number;
  session_name: string | null;
  wake_reason: string | null;
  vendor: string | null;
  tokens: number | null;
  cost_usd: number | null;
  /** Where this run's executor publishes its heartbeat. Null before dispatch. */
  job_dir: string | null;
  started_at: number;
  ended_at: number | null;
  version: number;
}

export function createAgent(
  db: Db,
  a: {
    slug: string;
    displayName: string;
    title?: string;
    persona?: string;
    mission?: string;
    harness?: string;
    wake: WakePolicy;
    createdBy: string;
    status?: 'DRAFT' | 'ACTIVE';
    docsRef?: string;
    parentAgentId?: string;
  },
): AgentRow {
  return tx(db, () => {
    const t = now();
    const agentId = id();
    const parent = a.parentAgentId
      ? (db.prepare('SELECT id, root_agent_id, depth FROM agents WHERE id = ?').get(a.parentAgentId) as
          | { id: string; root_agent_id: string | null; depth: number }
          | undefined)
      : undefined;
    db.prepare(
      `INSERT INTO agents(id,slug,display_name,title,persona,mission,harness,wake,status,
         next_due_at,wake_reason,created_by,docs_ref,parent_agent_id,root_agent_id,depth,
         created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      agentId,
      a.slug,
      a.displayName,
      a.title ?? null,
      a.persona ?? '',
      a.mission ?? '',
      a.harness ?? null,
      JSON.stringify(a.wake),
      a.status ?? 'ACTIVE',
      (a.status ?? 'ACTIVE') === 'ACTIVE' ? t : null,
      (a.status ?? 'ACTIVE') === 'ACTIVE' ? 'schedule' : null,
      a.createdBy,
      a.docsRef ?? null,
      parent?.id ?? null,
      parent ? (parent.root_agent_id ?? parent.id) : agentId,
      parent ? parent.depth + 1 : 0,
      t,
      t,
    );
    emit(db, 'agent.created', a.createdBy, { slug: a.slug }, agentId);
    return getAgent(db, agentId)!;
  });
}

export function getAgent(db: Db, agentId: string): AgentRow | undefined {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as AgentRow | undefined;
}

export function getAgentBySlug(db: Db, slug: string): AgentRow | undefined {
  return db.prepare('SELECT * FROM agents WHERE slug = ?').get(slug) as AgentRow | undefined;
}

export function listAgents(db: Db): AgentRow[] {
  return db.prepare('SELECT * FROM agents ORDER BY slug').all() as AgentRow[];
}

export function liveRun(db: Db, agentId: string): RunRow | undefined {
  return db
    .prepare(
      `SELECT * FROM runs WHERE agent_id = ? AND state NOT IN ('continue','completed','failed')`,
    )
    .get(agentId) as RunRow | undefined;
}

export function laneBlockedUntil(db: Db, vendor: string | null): number | null {
  if (!vendor) return null;
  const row = db
    .prepare('SELECT blocked_until FROM provider_gates WHERE vendor = ?')
    .get(vendor) as { blocked_until: number } | undefined;
  return row ? row.blocked_until : null;
}

export function statusOf(db: Db, a: AgentRow, nowMs = now()): Derivation {
  const run = liveRun(db, a.id);
  return derive({
    status: a.status,
    wakeKind: parseWake(a.wake).kind,
    nextDueAt: a.next_due_at,
    wakeReason: a.wake_reason,
    idleStreak: a.idle_streak,
    liveRunState: run ? run.state : null,
    laneBlockedUntil: laneBlockedUntil(db, a.harness),
    nowMs,
  });
}

/**
 * Open a run. The unique partial index is the real guard: if another tick won,
 * the INSERT raises and we treat it as "another tick won" rather than forcing.
 */
export function openRun(
  db: Db,
  agent: AgentRow,
  opts: { sessionName?: string; wakeReason?: string } = {},
): RunRow | undefined {
  try {
    return tx(db, () => {
      const runId = id();
      db.prepare(
        `INSERT INTO runs(id,agent_id,revision_id,state,attempt,session_name,wake_reason,vendor,started_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(
        runId,
        agent.id,
        agent.current_revision_id,
        'ready' satisfies RunState,
        0,
        opts.sessionName ?? null,
        opts.wakeReason ?? agent.wake_reason,
        agent.harness,
        now(),
      );
      emit(db, 'run.opened', 'system', { runId }, agent.id);
      return db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow;
    });
  } catch (err) {
    if (String(err).includes('UNIQUE') || String(err).includes('constraint')) return undefined;
    throw err;
  }
}

export function transition(db: Db, run: RunRow, to: RunState): boolean {
  assertLegal(run.state, to);
  return cas(db, 'runs', run.id, run.version, { state: to });
}

/**
 * Terminalise a run AND write the successor wake in ONE transaction.
 *
 * This is the fix for the bug three reviewers independently caught in the prior
 * design: with the wake bump on a separate path, an agent whose question was
 * answered went to a terminal state, left `next_due_at` NULL, and slept forever
 * with its work done. There is exactly one writer and no second path to forget.
 *
 * Keyed deterministically on the predecessor run id, so a replay is a no-op
 * rather than a duplicated iteration.
 */
export function succeed(
  db: Db,
  runId: string,
  outcome: Outcome,
  opts: { toState?: RunState; jitter?: number; nowMs?: number } = {},
): { nextDueAt: number | null; wakeReason: string } {
  return tx(db, () => {
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
    if (!run) throw new Error(`no such run ${runId}`);
    const agent = getAgent(db, run.agent_id);
    if (!agent) throw new Error(`no such agent ${run.agent_id}`);

    const nowMs = opts.nowMs ?? now();
    const toState: RunState =
      opts.toState ?? (outcome === 'BLOCKED' ? 'waiting_human' : 'continue');

    // Replay guard: a run already terminal has already had its successor written.
    if (TERMINAL.includes(run.state)) {
      return { nextDueAt: agent.next_due_at, wakeReason: agent.wake_reason ?? 'schedule' };
    }

    const next = computeNextWake(
      parseWake(agent.wake),
      outcome,
      { idleStreak: agent.idle_streak, errorStreak: agent.error_streak },
      nowMs,
      opts.jitter ?? 0,
    );

    db.prepare(
      'UPDATE runs SET state = ?, outcome = ?, ended_at = ?, version = version + 1 WHERE id = ?',
    ).run(toState, outcome, nowMs, runId);

    // A verdict may already have landed while this run was still settling: the
    // agent writes its ask mid-dispatch, the workspace shows it at once, and a
    // fast human can answer before `dispatch()` returns. `answer()` bumps the
    // wake; blind-writing NULL here would erase it and leave the agent asleep
    // with its work done — the exact failure this function exists to prevent.
    // A human bump outranks a scheduler-computed wake, always.
    const answeredSince = db
      .prepare(
        `SELECT COUNT(*) AS n FROM approval_requests
         WHERE agent_id = ? AND state = 'APPROVED' AND answered_at IS NOT NULL
           AND answered_at >= ?`,
      )
      .get(agent.id, run.started_at) as { n: number };

    const humanBumped = answeredSince.n > 0 && agent.wake_reason === 'human';
    let nextDueAt = humanBumped ? (agent.next_due_at ?? nowMs) : next.nextDueAt;
    let wakeReason = humanBumped ? 'human' : next.wakeReason;

    // The lane is gated durably, and the agent is due the moment it reopens.
    // "Not due until the lane reopens" used to mean no due time at all, and
    // nothing ever wrote one when the gate lifted: every agent that had ever
    // hit a 429 slept for good, invisible to the lost-wake alarm.
    if (outcome === 'RATE_LIMITED' && !humanBumped) {
      nextDueAt = laneBlockedUntil(db, agent.harness) ?? nowMs + 3_600_000;
      wakeReason = 'schedule';
    }

    // The messages this run was dispatched with. A turn that completed has
    // read them: acked here, in the settle's own transaction, so a crash
    // before this point redelivers and a crash after it cannot re-wake the
    // agent for mail it already read. A turn that did NOT complete — killed,
    // errored, refused by the vendor — releases them for the next wake, and
    // the third failure parks them rather than retrying forever.
    // Only the leases THIS run holds (a lease with no run id predates the
    // column and is treated as this run's, since one live run per agent is
    // enforced by the schema).
    const recipient = `agent:${agent.slug}`;
    const mine = `recipient = ? AND state = 'LEASED' AND (lease_run_id = ? OR lease_run_id IS NULL)`;
    const consumed = outcome === 'WORK_DONE' || outcome === 'NO_WORK' || outcome === 'BLOCKED';
    if (consumed) {
      db.prepare(`UPDATE message_deliveries SET state = 'ACKED', lease_until = NULL WHERE ${mine}`).run(
        recipient, runId,
      );
      // The verdicts this run was dispatched with are carried. One answered
      // mid-run was not in the capsule and stays owed.
      db.prepare(
        `UPDATE approval_requests SET consumed_at = ? WHERE agent_id = ? AND state = 'APPROVED'
           AND consumed_at IS NULL AND answered_at IS NOT NULL AND answered_at <= ?`,
      ).run(nowMs, agent.id, run.started_at);
    } else {
      // A human's words are never parked: the backoff is the only limit on
      // retrying them. Agent-to-agent mail that could not be delivered three
      // times is a dead letter, said so in the thread.
      const dead = db
        .prepare(
          `UPDATE message_deliveries SET state = 'DEAD', lease_until = NULL WHERE ${mine} AND attempts >= 3
             AND message_id IN (SELECT id FROM messages WHERE kind != 'human')`,
        )
        .run(recipient, runId).changes;
      db.prepare(`UPDATE message_deliveries SET state = 'QUEUED', lease_until = NULL WHERE ${mine}`).run(
        recipient, runId,
      );
      if (dead > 0) {
        emit(db, 'message.dead', 'system', { count: dead, runId }, agent.id);
        appendMessage(db, {
          agentId: agent.id, kind: 'event', author: 'system', runId,
          body: `${dead} message(s) parked after three failed deliveries. A human message is never parked.`,
        });
      }
    }

    // Mail that arrived while a COMPLETED turn ran is still QUEUED. Its
    // delivery bumped the wake, and the scheduler-computed wake above would
    // overwrite that bump — the verdict race again, in a different costume.
    // One more wake, now, for an inbox that is not empty. A FAILED turn keeps
    // its error backoff: waking at once on released mail would burn three
    // attempts in three ticks against a session that cannot start.
    if (consumed && !humanBumped) {
      const queued = db
        .prepare(`SELECT COUNT(*) AS n FROM message_deliveries WHERE recipient = ? AND state = 'QUEUED'`)
        .get(recipient) as { n: number };
      if (queued.n > 0 && (nextDueAt === null || nextDueAt > nowMs)) {
        nextDueAt = nowMs;
        wakeReason = 'event';
      }
    }

    db.prepare(
      `UPDATE agents SET next_due_at = ?, wake_reason = ?, idle_streak = ?, error_streak = ?,
         last_outcome = ?, updated_at = ?, version = version + 1
       WHERE id = ?`,
    ).run(
      nextDueAt,
      wakeReason,
      next.idleStreak,
      next.errorStreak,
      outcome,
      nowMs,
      agent.id,
    );

    emit(db, 'run.settled', 'system', { runId, outcome, nextDueAt }, agent.id);
    return { nextDueAt, wakeReason };
  });
}

/**
 * Let a run that stopped to wait for a human go. A BLOCKED turn parks its
 * run in `waiting_human`, which the one-live-run index and the tick both
 * treat as live — correctly, while the question is open. Once a verdict, a
 * cancellation or an expiry has settled the question, the run has to become
 * terminal or the woken agent can never be dispatched: its next run cannot
 * open, and the tick skips it as "another tick owns it". Live, an answered
 * agent sat WAITING_HUMAN with its verdict in hand until the store was edited.
 */
export function releaseWaitingRun(db: Db, agentId: string): number {
  return db
    .prepare(
      `UPDATE runs SET state = 'continue', ended_at = COALESCE(ended_at, ?), version = version + 1
       WHERE agent_id = ? AND state = 'waiting_human'`,
    )
    .run(now(), agentId).changes;
}

/**
 * Wake a blocked agent by an insert. Called in the SAME transaction that
 * records the verdict — never as a separate step someone can forget.
 */
export function bumpWake(db: Db, agentId: string, reason: string, atMs = now()): void {
  db.prepare(
    `UPDATE agents SET next_due_at = ?, wake_reason = ?, updated_at = ?, version = version + 1
     WHERE id = ?`,
  ).run(atMs, reason, atMs, agentId);
  emit(db, 'agent.woken', 'system', { reason }, agentId);
}

/**
 * The backstop for a lost wake: ACTIVE agents with no live run, no next wake,
 * and a terminal last run whose outcome was not a deliberate park. Surfaced as
 * an operator alarm so the failure is visible instead of silent.
 */
export function lostWakeScan(db: Db): AgentRow[] {
  return db
    .prepare(
      `SELECT a.* FROM agents a
       WHERE a.status = 'ACTIVE'
         AND a.next_due_at IS NULL
         AND a.wake_reason NOT IN ('human','manual','event')
         AND NOT EXISTS (
           SELECT 1 FROM runs r WHERE r.agent_id = a.id
             AND r.state NOT IN ('continue','completed','failed'))`,
    )
    .all() as AgentRow[];
}


/**
 * Remember where a run's executor is publishing itself.
 *
 * Written as soon as the job dir exists rather than at settle time: the whole
 * point is to survive a crash that happens DURING the run, so a value only
 * committed afterwards would never be there when it is needed.
 */
export function attachJobDir(db: Db, runId: string, jobDir: string): void {
  db.prepare('UPDATE runs SET job_dir = ? WHERE id = ?').run(jobDir, runId);
}

/** Runs that never ended. After a crash these are the orphans to reconcile. */
export function unfinishedRuns(db: Db): RunRow[] {
  return db
    .prepare("SELECT * FROM runs WHERE ended_at IS NULL AND state NOT IN ('continue','completed','failed')")
    .all() as RunRow[];
}
