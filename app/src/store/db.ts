import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { ADDITIVE_MIGRATIONS, SCHEMA, SCHEMA_VERSION } from './schema.ts';

export type Db = Database.Database;

export interface OpenOptions {
  /**
   * FULL when an acknowledged commit must survive power loss; NORMAL stays
   * consistent but can lose the most recent commit. Stated, not assumed.
   */
  synchronous?: 'FULL' | 'NORMAL';
  readonly?: boolean;
}

export function open(path: string, opts: OpenOptions = {}): Db {
  const db = new Database(path, opts.readonly ? { readonly: true } : {});
  db.pragma('journal_mode = WAL');
  db.pragma(`synchronous = ${opts.synchronous ?? 'FULL'}`);
  // WAL gives concurrent readers but keeps a single-writer boundary; a busy
  // timeout turns a lost race into a wait rather than an immediate SQLITE_BUSY.
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  if (!opts.readonly) {
    db.exec(SCHEMA);
    for (const stmt of ADDITIVE_MIGRATIONS) {
      try {
        db.exec(stmt);
      } catch {
        // Already present. SQLite has no ADD COLUMN IF NOT EXISTS, so the
        // duplicate error IS the idempotency check.
      }
    }
    db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run(
      'schema_version',
      String(SCHEMA_VERSION),
    );
  }
  return db;
}

export const now = (): number => Date.now();
export const id = (): string => randomUUID();

/**
 * Append to the authority. Everything consequential emits one of these, and
 * every projection is rebuildable from the stream.
 */
export function emit(
  db: Db,
  kind: string,
  actor: string,
  payload: unknown,
  subject?: string,
): number {
  const info = db
    .prepare('INSERT INTO events(ts,kind,subject,actor,payload) VALUES (?,?,?,?,?)')
    .run(now(), kind, subject ?? null, actor, JSON.stringify(payload ?? {}));
  return Number(info.lastInsertRowid);
}

/** Run `fn` in one IMMEDIATE transaction. Nested calls join the outer one. */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.inTransaction) return fn();
  return db.transaction(fn).immediate();
}

/**
 * Compare-and-swap on a `version` column. Returns false when another writer
 * won, which the caller must treat as "retry", never as "force".
 */
export function cas(
  db: Db,
  table: 'agents' | 'runs' | 'provider_gates' | 'budget_accounts',
  key: string,
  expectedVersion: number,
  set: Record<string, unknown>,
): boolean {
  const keyCol = table === 'provider_gates' ? 'vendor' : 'id';
  const cols = Object.keys(set);
  const assignments = [...cols.map((c) => `${c} = ?`), 'version = version + 1'].join(', ');
  const info = db
    .prepare(
      `UPDATE ${table} SET ${assignments} WHERE ${keyCol} = ? AND version = ?`,
    )
    .run(...cols.map((c) => set[c] as never), key, expectedVersion);
  return info.changes === 1;
}

/**
 * Append a message and bump the per-agent cursor in the same transaction.
 * `MAX(seq)+1` races two writers into an IntegrityError; a counter row does not.
 */
export function appendMessage(
  db: Db,
  msg: {
    agentId: string;
    kind: string;
    author: string;
    body: string;
    runId?: string | undefined;
    threadId?: string | undefined;
    meta?: unknown;
  },
): { id: string; seq: number } {
  return tx(db, () => {
    db.prepare(
      'INSERT OR IGNORE INTO message_seq(agent_id, next_seq) VALUES (?, 1)',
    ).run(msg.agentId);
    const row = db
      .prepare('SELECT next_seq FROM message_seq WHERE agent_id = ?')
      .get(msg.agentId) as { next_seq: number };
    const seq = row.next_seq;
    db.prepare('UPDATE message_seq SET next_seq = next_seq + 1 WHERE agent_id = ?').run(
      msg.agentId,
    );
    const mid = id();
    db.prepare(
      `INSERT INTO messages(id,agent_id,thread_id,run_id,seq,author,kind,body,meta,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      mid,
      msg.agentId,
      msg.threadId ?? null,
      msg.runId ?? null,
      seq,
      msg.author,
      msg.kind,
      msg.body,
      msg.meta === undefined ? null : JSON.stringify(msg.meta),
      now(),
    );
    emit(db, `message.${msg.kind}`, msg.author, { messageId: mid, seq }, msg.agentId);
    return { id: mid, seq };
  });
}
