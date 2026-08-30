import { type Db, appendMessage, emit, now, tx } from '../store/db.ts';

/**
 * One message substrate for human↔agent and agent↔agent.
 *
 * They are the same problem — addressed, ordered, durable delivery to a named
 * party — and splitting them means two delivery guarantees to get right instead
 * of one. ACP is deliberately NOT used for this: it is a transport for driving
 * a harness, with no durable queue, no cursor and no replay.
 *
 * `seq` is the cursor a reader tails. Delivery state is separate, because "has
 * this agent seen it" and "has it finished acting on it" are different
 * questions, and only the second one may retire a message.
 */

export interface DeliverInput {
  agentId: string;
  kind: string;
  author: string;
  body: string;
  recipients: string[];
  runId?: string;
  meta?: unknown;
}

export function deliver(db: Db, input: DeliverInput): { id: string; seq: number } {
  return tx(db, () => {
    const msg = appendMessage(db, {
      agentId: input.agentId,
      kind: input.kind,
      author: input.author,
      body: input.body,
      runId: input.runId,
      meta: input.meta,
    });
    const stmt = db.prepare(
      `INSERT INTO message_deliveries(message_id,recipient,state,available_at,attempts)
       VALUES (?,?,'QUEUED',?,0)`,
    );
    for (const r of input.recipients) stmt.run(msg.id, r, now());
    return msg;
  });
}

export interface PendingRow {
  id: string;
  agent_id: string;
  kind: string;
  author: string;
  body: string;
  seq: number;
  meta: string | null;
}

export function pending(db: Db, recipient: string, nowMs = now()): PendingRow[] {
  return db
    .prepare(
      `SELECT m.id, m.agent_id, m.kind, m.author, m.body, m.seq, m.meta
       FROM messages m JOIN message_deliveries d ON d.message_id = m.id
       WHERE d.recipient = ? AND d.state IN ('QUEUED','LEASED')
         AND d.available_at <= ?
         AND (d.lease_until IS NULL OR d.lease_until <= ?)
       ORDER BY m.seq`,
    )
    .all(recipient, nowMs, nowMs) as PendingRow[];
}

/**
 * Take a lease. A crash before the ack simply lets the lease lapse and the
 * message becomes available again — at-least-once, idempotent by message id.
 */
export function leaseFor(
  db: Db,
  recipient: string,
  leaseMs: number,
  nowMs = now(),
): PendingRow[] {
  return tx(db, () => {
    const rows = pending(db, recipient, nowMs);
    const stmt = db.prepare(
      `UPDATE message_deliveries SET state = 'LEASED', lease_until = ?, attempts = attempts + 1
       WHERE message_id = ? AND recipient = ?`,
    );
    for (const r of rows) stmt.run(nowMs + leaseMs, r.id, recipient);
    return rows;
  });
}

/**
 * Called AFTER the receiver has committed its state transition — never on
 * receipt. That ordering is the whole guarantee.
 */
export function ackAfterCommit(db: Db, messageId: string, recipient: string): void {
  db.prepare(
    `UPDATE message_deliveries SET state = 'ACKED', lease_until = NULL
     WHERE message_id = ? AND recipient = ?`,
  ).run(messageId, recipient);
  emit(db, 'message.acked', recipient, { messageId });
}

export function thread(db: Db, agentId: string, afterSeq = 0, limit = 200): PendingRow[] {
  return db
    .prepare(
      `SELECT id, agent_id, kind, author, body, seq, meta FROM messages
       WHERE agent_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
    )
    .all(agentId, afterSeq, limit) as PendingRow[];
}

/** The most recent report an agent produced — surfaced everywhere it is named. */
export function latestReport(
  db: Db,
  agentId: string,
): { body: string; seq: number; created_at: number; run_id: string | null } | undefined {
  return db
    .prepare(
      `SELECT body, seq, created_at, run_id FROM messages
       WHERE agent_id = ? AND kind = 'report' ORDER BY seq DESC LIMIT 1`,
    )
    .get(agentId) as { body: string; seq: number; created_at: number; run_id: string | null } | undefined;
}

/**
 * Agent→agent wake rules are ASYMMETRIC on purpose. A human follow-up in a
 * thread the agent has joined wakes it; an agent→agent message requires an
 * explicit mention. Symmetric rules let two agents ping-pong forever with no
 * human and no backoff, and it looks like progress the whole time.
 */
export function shouldWakeOnMessage(kind: string, body: string, slug: string): boolean {
  if (kind === 'human' || kind === 'verdict') return true;
  if (kind === 'agent_to_agent') return new RegExp(`@${slug}\\b`).test(body);
  return false;
}

/** Hop limit per relayed chain, so a loop is killed rather than degraded. */
export const MAX_RELAY_HOPS = 4;

export function hopCount(meta: string | null): number {
  if (!meta) return 0;
  try {
    return Number((JSON.parse(meta) as Record<string, unknown>)['hops'] ?? 0);
  } catch {
    return 0;
  }
}
