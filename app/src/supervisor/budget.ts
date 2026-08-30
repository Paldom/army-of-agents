import { type Db, emit, id, now, tx } from '../store/db.ts';

/**
 * Budget is a ledger, not a JSON blob.
 *
 * An in-memory concurrency counter rebuilds empty on every process start, so
 * nothing records "remaining" and concurrent approvals each read the same
 * capacity and overcommit it. It is also the only backstop against a poison
 * mission — an agent that always reports WORK_DONE and never finishes has no
 * idle streak to back it off, and only exhausting its allowance stops it.
 */
export interface Account {
  id: string;
  agent_id: string | null;
  window: string;
  allowance: number;
  reserved: number;
  spent: number;
  version: number;
}

export function ensureAccount(
  db: Db,
  agentId: string,
  allowance: number,
  window = 'day',
): Account {
  return tx(db, () => {
    const found = db
      .prepare('SELECT * FROM budget_accounts WHERE agent_id = ? AND window = ?')
      .get(agentId, window) as Account | undefined;
    if (found) return found;
    const accountId = id();
    db.prepare(
      'INSERT INTO budget_accounts(id,agent_id,window,allowance) VALUES (?,?,?,?)',
    ).run(accountId, agentId, window, allowance);
    return db.prepare('SELECT * FROM budget_accounts WHERE id = ?').get(accountId) as Account;
  });
}

/**
 * CAS debit in the same transaction that materialises the run. Returns false
 * when there is no capacity — the caller must not dispatch.
 *
 * An agent with no account is unmetered by design (the orchestrator itself);
 * that is a deliberate choice, not an oversight.
 */
export function reserve(db: Db, agentId: string, units: number, runId?: string): boolean {
  return tx(db, () => {
    const acct = db
      .prepare(`SELECT * FROM budget_accounts WHERE agent_id = ? AND window = 'day'`)
      .get(agentId) as Account | undefined;
    if (!acct) return true;
    if (acct.reserved + acct.spent + units > acct.allowance) {
      emit(db, 'budget.exhausted', 'system', { agentId, allowance: acct.allowance }, agentId);
      return false;
    }
    const info = db
      .prepare(
        'UPDATE budget_accounts SET reserved = reserved + ?, version = version + 1 WHERE id = ? AND version = ?',
      )
      .run(units, acct.id, acct.version);
    if (info.changes !== 1) return false;
    db.prepare(
      'INSERT INTO usage_ledger(id,account_id,run_id,delta,reason,at) VALUES (?,?,?,?,?,?)',
    ).run(id(), acct.id, runId ?? null, units, 'reserve', now());
    return true;
  });
}

/** Convert a reservation into spend once the run has actually happened. */
export function settle(db: Db, agentId: string, units: number, runId?: string): void {
  tx(db, () => {
    const acct = db
      .prepare(`SELECT * FROM budget_accounts WHERE agent_id = ? AND window = 'day'`)
      .get(agentId) as Account | undefined;
    if (!acct) return;
    db.prepare(
      `UPDATE budget_accounts SET reserved = MAX(0, reserved - ?), spent = spent + ?,
         version = version + 1 WHERE id = ?`,
    ).run(units, units, acct.id);
    db.prepare(
      'INSERT INTO usage_ledger(id,account_id,run_id,delta,reason,at) VALUES (?,?,?,?,?,?)',
    ).run(id(), acct.id, runId ?? null, units, 'settle', now());
  });
}

export function remaining(db: Db, agentId: string): number | null {
  const acct = db
    .prepare(`SELECT * FROM budget_accounts WHERE agent_id = ? AND window = 'day'`)
    .get(agentId) as Account | undefined;
  return acct ? acct.allowance - acct.reserved - acct.spent : null;
}
