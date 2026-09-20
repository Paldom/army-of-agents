import { type Db } from '../store/db.ts';
import { type AgentRow } from './repo.ts';
import { parseWake } from './wake.ts';

/**
 * Cheap and LLM-free: is there anything for this agent to do?
 *
 * An agent declares work by having unread mail, an answered verdict, or a
 * wake policy that says being due IS the signal. Discovering there is nothing
 * to do must never cost a vendor turn — this runs before any session exists.
 *
 * Shared by the dispatcher and the tests, so what the loop checks and what
 * the proofs check is one function rather than two that drift.
 */
export function hasWork(db: Db, agent: AgentRow, nowMs = Date.now()): boolean {
  const unread = db
    .prepare(
      `SELECT COUNT(*) AS n FROM message_deliveries d
       WHERE d.recipient = ? AND d.state IN ('QUEUED','LEASED') AND d.available_at <= ?`,
    )
    .get(`agent:${agent.slug}`, nowMs) as { n: number };
  if (unread.n > 0) return true;

  // A verdict is work until a completed run has carried it. "Answered since
  // the last run ended" was the old test, and a failed attempt after the
  // answer made the verdict vanish from the agent's to-do forever.
  const owed = db
    .prepare(
      `SELECT COUNT(*) AS n FROM approval_requests
       WHERE agent_id = ? AND state = 'APPROVED' AND consumed_at IS NULL`,
    )
    .get(agent.id) as { n: number };
  if (owed.n > 0) return true;

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
  const wake = parseWake(agent.wake);
  return wake.kind === 'schedule' || wake.kind === 'manual' || wake.kind === 'continuous';
}
