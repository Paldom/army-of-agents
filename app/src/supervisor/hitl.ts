import { createHash } from 'node:crypto';
import { type Db, appendMessage, emit, id, now, tx } from '../store/db.ts';
import { bumpWake, getAgent, releaseWaitingRun } from './repo.ts';

/**
 * Human-in-the-loop, as durable rows.
 *
 * The shape that makes it work: the agent asks, RELEASES ITS SESSION, and ends
 * its turn. Nothing is parked in memory, no callback waits, no watchdog can
 * trip. A reboot between the question and the answer costs exactly nothing. The
 * verdict lands as a row and the next dispatch carries it.
 *
 * This is the only viable design given that acpx's permission escalation does
 * not wait for a human (see acp/session.ts).
 */

export interface AskInput {
  agentId: string;
  runId?: string;
  prompt: string;
  options?: Array<{ id: string; label: string; detail?: string }>;
  evidence?: Array<{ source: string; quote?: string }>;
  /** Set for effects that change the world; binds the verdict to the exact operation. */
  action?: { operation: string; params: Record<string, unknown> };
  policyVersion?: string;
  runVersion?: number;
  /**
   * True for verbs that move money or change signed policy. A gated ask renders
   * in the workspace but is NOT answerable there — the workspace has no path to
   * mint that authority, and saying so plainly is the point.
   */
  gated?: boolean;
  expiresAt?: number;
  /** Set when the ask came from a file with no timestamp. */
  imported?: boolean;
}

/**
 * A stable digest of the exact operation and its parameters — not merely
 * "permission to proceed". A replan that takes a different route produces a
 * different hash and is re-asked rather than sliding through on a stale yes.
 */
export function actionHash(action: { operation: string; params: Record<string, unknown> }): string {
  const canonical = JSON.stringify([action.operation, sortDeep(action.params)]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, val]) => [k, sortDeep(val)]),
    );
  }
  return v;
}

export interface AskRow {
  id: string;
  agent_id: string;
  run_id: string | null;
  message_id: string | null;
  kind: string;
  prompt: string;
  options: string | null;
  evidence: string | null;
  action_hash: string | null;
  policy_version: string | null;
  run_version: number | null;
  gated: number;
  state: string;
  answer: string | null;
  answered_by: string | null;
  answered_at: number | null;
  expires_at: number | null;
  imported: number;
  created_at: number;
}

/** Write the question and its channel message in one transaction. */
export function ask(db: Db, input: AskInput): AskRow {
  return tx(db, () => {
    const agent = getAgent(db, input.agentId);
    if (!agent) throw new Error('no such agent');
    const askId = id();
    const msg = appendMessage(db, {
      agentId: input.agentId,
      kind: 'ask',
      author: `agent:${agent.slug}`,
      body: input.prompt,
      runId: input.runId,
      meta: { askId, options: input.options ?? [], gated: !!input.gated },
    });
    db.prepare(
      `INSERT INTO approval_requests(id,agent_id,run_id,message_id,kind,prompt,options,evidence,
         action_hash,policy_version,run_version,gated,state,expires_at,imported,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      askId,
      input.agentId,
      input.runId ?? null,
      msg.id,
      input.gated ? 'gated' : input.action ? 'approval' : 'question',
      input.prompt,
      input.options ? JSON.stringify(input.options) : null,
      input.evidence ? JSON.stringify(input.evidence) : null,
      input.action ? actionHash(input.action) : null,
      input.policyVersion ?? null,
      input.runVersion ?? null,
      input.gated ? 1 : 0,
      'PENDING',
      input.expiresAt ?? null,
      input.imported ? 1 : 0,
      now(),
    );
    // Everything an outbound hook needs to render the question and relay an
    // answer to POST /api/asks/:id/answer, binding included — never a secret.
    emit(db, 'ask.opened', `agent:${agent.slug}`, {
      askId, agent: agent.slug, prompt: input.prompt, options: input.options ?? [],
      gated: !!input.gated, actionHash: input.action ? actionHash(input.action) : null,
      policyVersion: input.policyVersion ?? null,
    }, input.agentId);
    return getAsk(db, askId)!;
  });
}

export function getAsk(db: Db, askId: string): AskRow | undefined {
  return db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(askId) as AskRow | undefined;
}

export function openAsks(db: Db): AskRow[] {
  return db
    .prepare(`SELECT * FROM approval_requests WHERE state = 'PENDING' ORDER BY created_at`)
    .all() as AskRow[];
}

export type AnswerResult =
  | { ok: true; ask: AskRow }
  | {
      ok: false;
      reason: 'not_found' | 'not_pending' | 'gated' | 'stale' | 'unknown_option' | 'unbindable' | 'empty';
      detail: string;
    };

/**
 * Record a human verdict.
 *
 * Three refusals, all deliberate:
 *  - a GATED ask is never answerable here; the workspace cannot mint that authority
 *  - a STALE binding is re-asked, never honoured — the world moved while it sat
 *  - an option that was not offered is not an answer
 *
 * On success the successor wake is bumped in the SAME transaction, so a blocked
 * agent cannot be left asleep with its work done.
 */
export function answer(
  db: Db,
  askId: string,
  a: {
    by: string;
    optionId?: string;
    text?: string;
    /** Re-supplied at answer time; a drift means the ask is stale. */
    currentActionHash?: string;
    currentPolicyVersion?: string;
  },
): AnswerResult {
  return tx(db, () => {
    const row = getAsk(db, askId);
    if (!row) return { ok: false, reason: 'not_found', detail: 'no such ask' };
    if (row.state !== 'PENDING') {
      return { ok: false, reason: 'not_pending', detail: `already ${row.state}` };
    }
    if (row.gated) {
      return {
        ok: false,
        reason: 'gated',
        detail:
          'Money-critical verbs require the signed owner channel. This workspace carries owner ' +
          'authority for everything else, but it holds no mint for verbs that move value. ' +
          'grant: none minted',
      };
    }
    // Bindings FAIL CLOSED. An earlier version only compared when the caller
    // happened to supply the current values, so omitting them skipped the check
    // entirely and a stale action sailed through — a security check that is
    // optional for the caller is not a check.
    if (row.action_hash && a.currentActionHash === undefined) {
      return {
        ok: false,
        reason: 'unbindable',
        detail:
          'This ask is bound to a specific action. Answering it requires the current action hash, ' +
          'so a plan that changed underneath it cannot be approved by omission.',
      };
    }
    if (row.action_hash && row.action_hash !== a.currentActionHash) {
      return {
        ok: false,
        reason: 'stale',
        detail: 'The proposed action changed while this sat. Re-asking rather than honouring it.',
      };
    }
    if (row.policy_version && a.currentPolicyVersion === undefined) {
      return {
        ok: false,
        reason: 'unbindable',
        detail: 'This ask is bound to a policy version. Answering it requires the current one.',
      };
    }
    if (row.policy_version && row.policy_version !== a.currentPolicyVersion) {
      return {
        ok: false,
        reason: 'stale',
        detail: 'Policy changed while this sat. Re-asking rather than honouring it.',
      };
    }

    // An empty submit is not an answer. Previously a bare {by} on an options ask
    // skipped validation, stored '' and set the row APPROVED — a blank click
    // approving whatever was pending.
    if (row.options) {
      const opts = JSON.parse(row.options) as Array<{ id: string }>;
      if (!a.optionId) {
        return { ok: false, reason: 'empty', detail: 'This ask offers options; pick one.' };
      }
      if (!opts.some((o) => o.id === a.optionId)) {
        return { ok: false, reason: 'unknown_option', detail: `no option ${a.optionId}` };
      }
    } else if (!a.text || !a.text.trim()) {
      return { ok: false, reason: 'empty', detail: 'An empty answer is not an answer.' };
    }

    const verdict = a.optionId ?? a.text ?? '';
    db.prepare(
      `UPDATE approval_requests SET state = 'APPROVED', answer = ?, answered_by = ?, answered_at = ?
       WHERE id = ?`,
    ).run(verdict, a.by, now(), askId);

    appendMessage(db, {
      agentId: row.agent_id,
      kind: 'verdict',
      author: a.by,
      body: verdict,
      runId: row.run_id ?? undefined,
      meta: { askId },
    });

    // Same transaction as the verdict. There is no second "bump" path to forget,
    // which is the bug that left agents asleep with their work done — and the
    // waiting run is released here too, or the bump wakes an agent the tick
    // then refuses to dispatch.
    releaseWaitingRun(db, row.agent_id);
    bumpWake(db, row.agent_id, 'human');

    emit(db, 'ask.answered', a.by, { askId, verdict }, row.agent_id);
    return { ok: true, ask: getAsk(db, askId)! };
  });
}

/**
 * The owner withdraws a question. Nothing is approved; the agent is woken to
 * carry on without the answer, which its capsule will not contain.
 */
export function cancelAsk(db: Db, askId: string, by: string): { ok: boolean; reason?: string } {
  return tx(db, () => {
    const row = getAsk(db, askId);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.state !== 'PENDING') return { ok: false, reason: 'not_pending' };
    db.prepare(
      `UPDATE approval_requests SET state = 'CANCELLED', answered_by = ?, answered_at = ? WHERE id = ?`,
    ).run(by, now(), askId);
    appendMessage(db, {
      agentId: row.agent_id, kind: 'event', author: by,
      body: `Ask withdrawn without an answer: "${row.prompt}". Nothing was approved.`,
      meta: { askId },
    });
    releaseWaitingRun(db, row.agent_id);
    if (getAgent(db, row.agent_id)?.status === 'ACTIVE') bumpWake(db, row.agent_id, 'human');
    emit(db, 'ask.cancelled', by, { askId }, row.agent_id);
    return { ok: true };
  });
}

/** Expiry pauses the agent and files a report. It NEVER auto-approves. */
export function expireAsks(db: Db, nowMs = now()): string[] {
  const due = db
    .prepare(
      `SELECT * FROM approval_requests WHERE state = 'PENDING' AND expires_at IS NOT NULL AND expires_at <= ?`,
    )
    .all(nowMs) as AskRow[];
  const expired: string[] = [];
  for (const row of due) {
    tx(db, () => {
      db.prepare(`UPDATE approval_requests SET state = 'EXPIRED' WHERE id = ?`).run(row.id);
      // Everyone but the orchestrator pauses: pausing the fleet's judge over
      // one unanswered question leaves nobody to ask for the next change.
      const orchestrator = getAgent(db, row.agent_id)?.slug === 'orchestrator';
      if (!orchestrator) {
        db.prepare(
          `UPDATE agents SET status = 'PAUSED', updated_at = ?, version = version + 1 WHERE id = ?`,
        ).run(nowMs, row.agent_id);
      }
      // The question is over; the run that waited for it must not keep the
      // agent undispatchable after a human resumes it.
      releaseWaitingRun(db, row.agent_id);
      appendMessage(db, {
        agentId: row.agent_id,
        kind: 'report',
        author: 'system',
        body: orchestrator
          ? `Ask expired unanswered: "${row.prompt}". Nothing was approved.`
          : `Ask expired unanswered: "${row.prompt}". The agent is paused; nothing was approved.`,
        meta: { askId: row.id, expired: true },
      });
      emit(db, 'ask.expired', 'system', { askId: row.id }, row.agent_id);
    });
    expired.push(row.id);
  }
  return expired;
}

/** What the next dispatch must carry so the agent resumes where it stopped. */
export function verdictsFor(db: Db, agentId: string): Array<{ prompt: string; answer: string }> {
  return db
    .prepare(
      `SELECT prompt, answer FROM approval_requests
       WHERE agent_id = ? AND state = 'APPROVED' AND answered_at IS NOT NULL AND consumed_at IS NULL
       ORDER BY answered_at DESC LIMIT 5`,
    )
    .all(agentId) as Array<{ prompt: string; answer: string }>;
}
