/**
 * The store is the system.
 *
 * One SQLite database in WAL mode. `events` is append-only and is the
 * authority; every other table is a projection that can be rebuilt from it.
 *
 * Two conventions, held everywhere:
 *   - timestamps are INTEGER epoch milliseconds
 *   - `version` columns are CAS fences; a write that does not advance the
 *     version it read has lost a race and must be retried, not forced
 */
export const SCHEMA_VERSION = 1;

export const SCHEMA = /* sql */ `
-- ── the authority ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  subject    TEXT,
  actor      TEXT    NOT NULL,          -- 'human:<id>' | 'agent:<slug>' | 'system'
  payload    TEXT    NOT NULL           -- JSON
);
CREATE INDEX IF NOT EXISTS events_subject ON events(subject, seq);
CREATE INDEX IF NOT EXISTS events_kind    ON events(kind, seq);

-- ── who exists ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
  id                  TEXT PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE,
  display_name        TEXT NOT NULL,
  title               TEXT,
  persona             TEXT NOT NULL DEFAULT '',
  mission             TEXT NOT NULL DEFAULT '',
  harness             TEXT,                       -- NULL = router picks
  wake                TEXT NOT NULL,              -- JSON wake policy
  status              TEXT NOT NULL,              -- DRAFT|ACTIVE|PAUSED|RETIRED

  -- scheduler state. The tick cannot be written without these.
  next_due_at         INTEGER,                    -- NULL = not scheduled
  wake_reason         TEXT,                       -- schedule|backoff|event|manual|human
  idle_streak         INTEGER NOT NULL DEFAULT 0,
  error_streak        INTEGER NOT NULL DEFAULT 0, -- survives runs; run.attempt does not
  last_outcome        TEXT,

  current_revision_id TEXT,

  -- lineage; used by the fan-out cap and cascade retire
  parent_agent_id     TEXT REFERENCES agents(id),
  root_agent_id       TEXT REFERENCES agents(id),
  depth               INTEGER NOT NULL DEFAULT 0,
  expires_at          INTEGER,
  created_by          TEXT NOT NULL,

  workspace           TEXT,                       -- git worktree path
  browser_profile     TEXT,                       -- profile dir / storage partition
  docs_ref            TEXT,                       -- path prefix this agent owns

  version             INTEGER NOT NULL DEFAULT 0,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agents_due ON agents(status, next_due_at);

-- Immutable definition snapshots. Every run pins the revision it ran under, so
-- editing an agent never rewrites the meaning of its own history.
CREATE TABLE IF NOT EXISTS agent_revisions (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id),
  rev        INTEGER NOT NULL,
  definition TEXT NOT NULL,              -- full JSON snapshot
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (agent_id, rev)
);

-- ── iterations ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents(id),
  revision_id  TEXT REFERENCES agent_revisions(id),
  state        TEXT NOT NULL,            -- see state.ts
  outcome      TEXT,                     -- WORK_DONE|NO_WORK|RATE_LIMITED|BLOCKED|RETRYABLE_ERROR
  attempt      INTEGER NOT NULL DEFAULT 0,
  session_name TEXT,
  wake_reason  TEXT,
  vendor       TEXT,
  tokens       INTEGER,
  cost_usd     REAL,
  -- Where this run's executor published itself. Without it a restarted
  -- supervisor knows a run was in flight but not what to adopt or kill, so
  -- the orphan survives and blocks every later turn for that agent.
  job_dir      TEXT,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  version      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id, started_at DESC);

-- One live run per agent, enforced in the schema rather than in the supervisor,
-- which makes double-dispatch after a crash structurally impossible.
-- 'paused' is deliberately INSIDE the index: pausing a run must stop the agent,
-- and letting a resumed run rejoin the index alongside a newer one is an
-- IntegrityError waiting to happen.
CREATE UNIQUE INDEX IF NOT EXISTS one_live_run_per_agent
  ON runs(agent_id)
  WHERE state NOT IN ('continue','completed','failed');

-- ── the channel: one substrate for human<->agent and agent<->agent ─────────
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id),   -- the channel this belongs to
  thread_id  TEXT,
  run_id     TEXT REFERENCES runs(id),
  seq        INTEGER NOT NULL,                      -- monotonic per agent: the cursor
  author     TEXT NOT NULL,
  kind       TEXT NOT NULL,   -- human|agent|agent_to_agent|ask|verdict|report|event
  body       TEXT NOT NULL,
  meta       TEXT,                                  -- JSON
  created_at INTEGER NOT NULL,
  UNIQUE (agent_id, seq)
);
CREATE INDEX IF NOT EXISTS messages_agent_seq ON messages(agent_id, seq);
CREATE INDEX IF NOT EXISTS messages_kind      ON messages(kind, created_at DESC);

-- Per-agent sequence counter, bumped inside the insert transaction.
-- MAX(seq)+1 races two writers into an IntegrityError; this does not.
CREATE TABLE IF NOT EXISTS message_seq (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  next_seq INTEGER NOT NULL DEFAULT 1
);

-- Delivery is separate from ordering: "has this agent seen it" and "has it
-- finished acting on it" are different questions. The ack is written AFTER the
-- receiver commits, so a crash mid-processing redelivers rather than loses.
CREATE TABLE IF NOT EXISTS message_deliveries (
  message_id   TEXT NOT NULL REFERENCES messages(id),
  recipient    TEXT NOT NULL,
  state        TEXT NOT NULL,            -- QUEUED|LEASED|ACKED|DEAD
  available_at INTEGER NOT NULL,
  lease_until  INTEGER,
  lease_run_id TEXT,                      -- the run that holds the lease; settled by that run only
  attempts     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, recipient)
);

-- ── human decisions ────────────────────────────────────────────────────────
-- A free-text "yes" never authorizes an effect. A verdict binds the action
-- hash, the policy version and the run version it was asked at; if any drifted
-- while it sat, the ask is re-asked rather than honoured.
CREATE TABLE IF NOT EXISTS approval_requests (
  id             TEXT PRIMARY KEY,
  agent_id       TEXT NOT NULL REFERENCES agents(id),
  run_id         TEXT REFERENCES runs(id),
  message_id     TEXT REFERENCES messages(id),
  kind           TEXT NOT NULL,          -- question|approval|gated
  prompt         TEXT NOT NULL,
  options        TEXT,                   -- JSON array
  evidence       TEXT,                   -- JSON array
  action_hash    TEXT,
  policy_version TEXT,
  run_version    INTEGER,
  gated          INTEGER NOT NULL DEFAULT 0,  -- 1 = not answerable in the workspace
  state          TEXT NOT NULL,          -- PENDING|APPROVED|DENIED|EXPIRED|CANCELLED
  answer         TEXT,
  answered_by    TEXT,
  answered_at    INTEGER,
  -- Set when a run that was dispatched with this verdict completed. Until
  -- then the verdict is work the agent still owes a turn to.
  consumed_at    INTEGER,
  expires_at     INTEGER,
  -- 1 when this came from a file with no per-item timestamp, so its age is
  -- unknown rather than zero. Showing seconds for a question open since July
  -- makes the primary sort key a lie.
  imported       INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_open ON approval_requests(state, created_at);

-- ── standing decisions that block nobody ───────────────────────────────────
CREATE TABLE IF NOT EXISTS backlog_items (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  question    TEXT NOT NULL,
  rationale   TEXT,
  tier        INTEGER NOT NULL DEFAULT 2,
  rank        REAL NOT NULL DEFAULT 0,
  raised_by   TEXT NOT NULL,
  agent_id    TEXT REFERENCES agents(id),
  run_id      TEXT REFERENCES runs(id),
  state       TEXT NOT NULL,             -- OPEN|PROMOTED|RESOLVED|DROPPED
  promoted_to TEXT REFERENCES approval_requests(id),
  created_at  INTEGER NOT NULL,
  ranked_at   INTEGER
);

-- ── capacity ───────────────────────────────────────────────────────────────
-- Durable, shared by every agent. An in-memory cooldown is erased by a restart,
-- and after a crash every agent on a limited vendor becomes due at once, which
-- is the exact spin the outcome model exists to prevent.
CREATE TABLE IF NOT EXISTS provider_gates (
  vendor        TEXT PRIMARY KEY,
  blocked_until INTEGER NOT NULL,
  reason        TEXT,
  max_lanes     INTEGER NOT NULL DEFAULT 1,
  version       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS budget_accounts (
  id        TEXT PRIMARY KEY,
  agent_id  TEXT REFERENCES agents(id),
  window    TEXT NOT NULL,               -- day|total
  allowance INTEGER NOT NULL,
  reserved  INTEGER NOT NULL DEFAULT 0,
  spent     INTEGER NOT NULL DEFAULT 0,
  version   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS budget_agent ON budget_accounts(agent_id, window);

CREATE TABLE IF NOT EXISTS usage_ledger (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES budget_accounts(id),
  run_id     TEXT,
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  at         INTEGER NOT NULL
);

-- ── external effects ───────────────────────────────────────────────────────
-- The intent is written BEFORE the effect and the receipt after. Recovery that
-- finds an unresolved intent reconciles against the destination before
-- retrying. The key is semantic and stable — derived from (logical run, step) —
-- so a replan does not mint a new one and double-execute.
CREATE TABLE IF NOT EXISTS effects (
  idem_key    TEXT PRIMARY KEY,
  run_id      TEXT REFERENCES runs(id),
  agent_id    TEXT REFERENCES agents(id),
  kind        TEXT NOT NULL,
  intent      TEXT NOT NULL,
  state       TEXT NOT NULL,             -- INTENT|CONFIRMED|UNKNOWN|ABANDONED
  receipt     TEXT,
  created_at  INTEGER NOT NULL,
  settled_at  INTEGER
);

-- ── accounts: capacity is vendor lanes, identity is website accounts ───────
-- Registered at runtime. The account list is the union of every dictionary,
-- and an agent may register another one.
CREATE TABLE IF NOT EXISTS account_dictionaries (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  location     TEXT NOT NULL,            -- where the dictionary lives
  registered_by TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

-- No secret value is ever stored here. 'keychain_ref' names the OS keychain
-- item; the value is read at point of use and never enters the database, the
-- transcript or the UI.
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  dictionary_id TEXT NOT NULL REFERENCES account_dictionaries(id),
  platform      TEXT NOT NULL,
  handle        TEXT NOT NULL,
  status        TEXT NOT NULL,           -- active|paused|review_due|retired
  allowed_agents TEXT,                   -- JSON array of slugs
  keychain_ref  TEXT,
  last_used_at  INTEGER,
  created_at    INTEGER NOT NULL,
  UNIQUE (dictionary_id, platform, handle)
);

-- ── meta ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;


/**
 * Additive migrations for databases created before a column existed.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so a new
 * column in SCHEMA never reaches a database that already has that table — the
 * first write to it fails with "no such column" on somebody's running fleet.
 *
 * Additive only, and each is idempotent: SQLite rejects a duplicate ADD COLUMN
 * and that rejection is the check. Anything that needs to drop or rewrite a
 * column needs a real migration, not this list.
 */
export const ADDITIVE_MIGRATIONS: string[] = [
  'ALTER TABLE runs ADD COLUMN job_dir TEXT',
  'ALTER TABLE approval_requests ADD COLUMN imported INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE message_deliveries ADD COLUMN lease_run_id TEXT',
  'ALTER TABLE approval_requests ADD COLUMN consumed_at INTEGER',
];
