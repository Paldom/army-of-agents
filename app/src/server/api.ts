import { type Db, appendMessage, emit, id, now, tx } from '../store/db.ts';
import {
  type AgentRow,
  createAgent,
  getAgent,
  getAgentBySlug,
  listAgents,
  liveRun,
  lostWakeScan,
  statusOf,
} from '../supervisor/repo.ts';
import { answer, ask, openAsks } from '../supervisor/hitl.ts';
import { latestReport, thread } from '../supervisor/messages.ts';
import { isBlockingHuman } from '../supervisor/derived.ts';
import { HARNESSES } from '../acp/capabilities.ts';
import { paneName } from '../supervisor/workspace.ts';

/**
 * The API is the product surface, not a convenience layer over it. Everything
 * the workspace can do is an API call, and nothing the workspace does has a
 * privileged path the API lacks.
 *
 * Every response is DATA. The client renders whatever it finds — there is no
 * hardcoded agent list, channel list or tab set anywhere, so an agent the
 * orchestrator creates at 3am appears complete with no code change.
 */

export interface Ctx {
  db: Db;
  /** Where the project being orchestrated lives; the file browser is rooted here. */
  projectRoot: string;
}

/**
 * The first sentence of the agent's mission, or of its charter.
 *
 * Deliberately derived rather than a separate field: a responsibility that can
 * drift from the contract is worse than none, because it reads as authoritative.
 */
function responsibilityOf(a: AgentRow): string | null {
  if (a.mission) return firstSentence(a.mission);
  if (a.persona) {
    const m = /\*\*Mission\.?\*\*\s*([\s\S]{10,400}?)(?:\n\n|\*\*)/.exec(a.persona);
    if (m) return firstSentence(m[1]!);
    // Skip the charter preamble. Falling through to the first non-heading line
    // put "Authority: HIGH. Source: docs/... Status: active" in the slot meant
    // for a plain description of what this agent is responsible for.
    const line = a.persona
      .split('\n')
      .map((l) => l.trim())
      .find(
        (l) =>
          l &&
          !l.startsWith('#') &&
          !l.startsWith('<!--') &&
          !l.startsWith('|') &&
          !l.startsWith('-') &&
          !/^\*?\*?[A-Z][A-Za-z ]{2,24}\*?\*?:/.test(l),
      );
    if (line) return firstSentence(line);
  }
  return null;
}

function firstSentence(s: string): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  const stop = clean.search(/\.\s|\.$/);
  // Word boundary, not a hard slice: cutting at 220 left descriptions ending
  // mid-word, which reads as a rendering bug rather than as a summary.
  return clip(stop > 20 ? clean.slice(0, stop + 1) : clean, 220);
}

export function agentView(db: Db, a: AgentRow) {
  const d = statusOf(db, a);
  const report = latestReport(db, a.id);
  const run = liveRun(db, a.id);
  return {
    id: a.id,
    slug: a.slug,
    displayName: a.display_name,
    title: a.title,
    harness: a.harness,
    lifecycle: a.status,
    status: d.status,
    why: d.why,
    blocksHuman: isBlockingHuman(d.status),
    nextDueAt: a.next_due_at,
    wakeReason: a.wake_reason,
    idleStreak: a.idle_streak,
    lastOutcome: a.last_outcome,
    docsRef: a.docs_ref,
    // One line of what this agent is for, taken from its contract. The reader
    // should not have to open the charter to know why an agent exists.
    responsibility: responsibilityOf(a),
    parentAgentId: a.parent_agent_id,
    depth: a.depth,
    // tmux session, when the supervisor has created one.
    // What tmux actually calls this agent's session — namespaced by project,
    // so the label a human copies into `tmux attach` is the real one.
    sessionName: paneName(process.env['AOA_PROJECT_ROOT'] ?? process.cwd(), a.slug),
    liveRun: run ? { id: run.id, state: run.state, startedAt: run.started_at } : null,
    latestReport: report
      ? { body: report.body, at: report.created_at, runId: report.run_id, seq: report.seq }
      : null,
    createdBy: a.created_by,
  };
}

/** Channels are data too — derived from membership, not a fixed list. */
export interface ChannelView {
  name: string;
  members: string[];
  responsibility: string | null;
  docsRef: string | null;
}

/**
 * A channel is a group of agents with a shared responsibility, so it carries
 * one — derived from its members' docs root, which is where a reader goes next.
 */
/** Trim to a word boundary. A hard slice ends sentences mid-word. */
function clip(s: string, max = 120): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '')}…`;
}

function decorate(db: Db, c: { name: string; members: string[] }): ChannelView {
  const members = c.members
    .map((s) => getAgentBySlug(db, s))
    .filter((a): a is AgentRow => !!a);
  const refs = members.map((m) => m.docs_ref).filter((r): r is string => !!r);
  // The deepest shared prefix of the members' docs is this channel's entry point.
  const docsRef = refs.length ? commonPrefix(refs) : null;
  const titles = [...new Set(members.map((m) => m.title).filter(Boolean))];
  return {
    name: c.name,
    members: c.members,
    responsibility: members.length
      ? `${members.length} agent${members.length === 1 ? '' : 's'}${titles.length === 1 ? ` in ${titles[0]}` : ''}. ` +
        (clip(members.find((m) => m.mission)?.mission?.split('.')[0] ?? '') || 'Grouped by area of work.')
      : null,
    docsRef,
  };
}

function commonPrefix(paths: string[]): string | null {
  const split = paths.map((p) => p.split('/'));
  const first = split[0]!;
  const out: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i]!;
    if (split.every((p) => p[i] === seg)) out.push(seg);
    else break;
  }
  return out.length ? out.join('/') : null;
}

export function channels(db: Db): ChannelView[] {
  const rows = db
    .prepare(`SELECT value FROM meta WHERE key = 'channels'`)
    .get() as { value: string } | undefined;
  const defined = rows ? (JSON.parse(rows.value) as Array<{ name: string; members: string[] }>) : [];
  if (defined.length > 0) return defined.map((c) => decorate(db, c));
  // No channels configured: every agent is its own room. Honest, and it means
  // the workspace works on a fresh install with nothing set up.
  return listAgents(db).map((a) => decorate(db, { name: a.slug, members: [a.slug] }));
}

export function setChannels(db: Db, chans: Array<{ name: string; members: string[] }>): void {
  db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run(
    'channels',
    JSON.stringify(chans),
  );
}

export function needsYou(db: Db) {
  const asks = openAsks(db);
  return asks
    .map((q) => {
      const a = getAgent(db, q.agent_id)!;
      return {
        askId: q.id,
        agent: a.slug,
        agentTitle: a.title,
        prompt: q.prompt,
        options: q.options ? JSON.parse(q.options) : [],
        evidence: q.evidence ? JSON.parse(q.evidence) : [],
        gated: q.gated === 1,
        actionHash: q.action_hash,
        policyVersion: q.policy_version,
        // An imported ask has no real age: the source file carried no per-item
        // timestamp. Saying "unknown" is honest; showing seconds is a lie that
        // breaks the primary sort key.
        blockedForMs: q.imported ? null : now() - q.created_at,
        ageUnknown: Boolean(q.imported),
        createdAt: q.created_at,
      };
    })
    // Blocking longest first; unknown ages sort last rather than pretending to
    // be either extreme.
    .sort((x, y) => (y.blockedForMs ?? -1) - (x.blockedForMs ?? -1));
}

export function fleetStatus(db: Db) {
  const agents = listAgents(db).map((a) => agentView(db, a));
  const lanes = db
    .prepare('SELECT vendor, blocked_until, reason, max_lanes FROM provider_gates')
    .all() as Array<{ vendor: string; blocked_until: number; reason: string | null; max_lanes: number }>;
  const known = new Set(lanes.map((l) => l.vendor));
  for (const h of Object.values(HARNESSES)) {
    if (!known.has(h.vendor)) {
      lanes.push({ vendor: h.vendor, blocked_until: 0, reason: null, max_lanes: 1 });
    }
  }
  return {
    agents,
    lanes: lanes.map((l) => ({
      vendor: l.vendor,
      blockedUntil: l.blocked_until,
      exhausted: l.blocked_until > now(),
      reason: l.reason,
      inUse: agents.filter((a) => a.harness === l.vendor && a.status === 'RUNNING').length,
      maxLanes: l.max_lanes,
      waiting: agents.filter((a) => a.harness === l.vendor && a.status === 'WAITING_RESOURCE').length,
    })),
    // The lost-wake alarm. A silently stalled agent must be visible.
    lostWake: lostWakeScan(db).map((a) => a.slug),
    counts: {
      blocksHuman: agents.filter((a) => a.blocksHuman).length,
      running: agents.filter((a) => a.status === 'RUNNING').length,
      fine: agents.filter((a) => !a.blocksHuman && a.status !== 'RUNNING').length,
    },
  };
}

// ── backlog ────────────────────────────────────────────────────────────────
export interface BacklogRow {
  id: string; title: string; question: string; rationale: string | null;
  tier: number; rank: number; raised_by: string; agent_id: string | null;
  run_id: string | null; state: string; promoted_to: string | null;
  created_at: number; ranked_at: number | null;
}

export function listBacklog(db: Db) {
  const rows = db
    .prepare(`SELECT * FROM backlog_items WHERE state = 'OPEN' ORDER BY tier, rank DESC, created_at`)
    .all() as BacklogRow[];
  const rankedAt = rows.reduce<number | null>((m, r) => (r.ranked_at && (!m || r.ranked_at > m) ? r.ranked_at : m), null);
  return {
    rankedAt,
    items: rows.map((r) => ({
      id: r.id, title: r.title, question: r.question, rationale: r.rationale,
      tier: r.tier, rank: r.rank, raisedBy: r.raised_by,
      agent: r.agent_id ? getAgent(db, r.agent_id)?.slug ?? null : null,
      runId: r.run_id, sittingMs: now() - r.created_at, createdAt: r.created_at,
    })),
  };
}

export function addBacklogItem(
  db: Db,
  b: { title: string; question: string; rationale?: string; tier?: number; raisedBy: string; agentId?: string },
): BacklogRow {
  const rowId = id();
  db.prepare(
    `INSERT INTO backlog_items(id,title,question,rationale,tier,rank,raised_by,agent_id,state,created_at)
     VALUES (?,?,?,?,?,?,?,?,'OPEN',?)`,
  ).run(rowId, b.title, b.question, b.rationale ?? null, b.tier ?? 2, 0, b.raisedBy, b.agentId ?? null, now());
  emit(db, 'backlog.added', b.raisedBy, { id: rowId, title: b.title });
  return db.prepare('SELECT * FROM backlog_items WHERE id = ?').get(rowId) as BacklogRow;
}

/**
 * The orchestrator re-ranks by expected value ÷ time-to-unblock. The owner does
 * not sort this list; if the order looks wrong the input is wrong.
 */
export function rerankBacklog(db: Db, scores: Record<string, number>): void {
  tx(db, () => {
    const stmt = db.prepare('UPDATE backlog_items SET rank = ?, ranked_at = ? WHERE id = ?');
    const t = now();
    for (const [itemId, score] of Object.entries(scores)) stmt.run(score, t, itemId);
    emit(db, 'backlog.reranked', 'agent:orchestrator', { count: Object.keys(scores).length });
  });
}

/** Backlog → Needs you. Promotion creates a durable ask against the agent. */
export function promoteBacklogItem(db: Db, itemId: string, agentId: string): string {
  return tx(db, () => {
    const item = db.prepare('SELECT * FROM backlog_items WHERE id = ?').get(itemId) as BacklogRow | undefined;
    if (!item) throw new Error('no such backlog item');
    const q = ask(db, { agentId, prompt: item.question });
    db.prepare(`UPDATE backlog_items SET state = 'PROMOTED', promoted_to = ? WHERE id = ?`).run(q.id, itemId);
    emit(db, 'backlog.promoted', 'human:owner', { itemId, askId: q.id }, agentId);
    return q.id;
  });
}

/** An expired ask comes back here rather than being lost. */
export function demoteToBacklog(db: Db, askId: string, raisedBy = 'system'): string {
  return tx(db, () => {
    const q = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(askId) as
      | { id: string; agent_id: string; prompt: string }
      | undefined;
    if (!q) throw new Error('no such ask');
    const row = addBacklogItem(db, {
      title: q.prompt.slice(0, 80),
      question: q.prompt,
      rationale: 'Returned from Needs you after expiring unanswered. Nothing was approved.',
      raisedBy,
      agentId: q.agent_id,
    });
    return row.id;
  });
}

// ── accounts ───────────────────────────────────────────────────────────────
/**
 * Vendor lanes are capacity. Website accounts are identity. They are different
 * records and share no credential material.
 *
 * 🔴 No credential value is ever returned by this API. A row confirms that a
 * credential exists and names its OS keychain item; there is no value field, no
 * copy endpoint and no reveal.
 */
export function registerDictionary(
  db: Db,
  d: { name: string; location: string; registeredBy: string },
): string {
  const dictId = id();
  db.prepare(
    'INSERT INTO account_dictionaries(id,name,location,registered_by,created_at) VALUES (?,?,?,?,?)',
  ).run(dictId, d.name, d.location, d.registeredBy, now());
  emit(db, 'dictionary.registered', d.registeredBy, { name: d.name, location: d.location });
  return dictId;
}

export function upsertAccount(
  db: Db,
  a: {
    dictionaryId: string; platform: string; handle: string; status?: string;
    allowedAgents?: string[]; keychainRef?: string; lastUsedAt?: number;
  },
): void {
  db.prepare(
    `INSERT INTO accounts(id,dictionary_id,platform,handle,status,allowed_agents,keychain_ref,last_used_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(dictionary_id,platform,handle) DO UPDATE SET
       status = excluded.status,
       allowed_agents = excluded.allowed_agents,
       keychain_ref = excluded.keychain_ref,
       last_used_at = excluded.last_used_at`,
  ).run(
    id(), a.dictionaryId, a.platform, a.handle, a.status ?? 'active',
    JSON.stringify(a.allowedAgents ?? []), a.keychainRef ?? null, a.lastUsedAt ?? null, now(),
  );
}

export function listAccounts(db: Db, q?: { search?: string; status?: string; dictionary?: string }) {
  const dicts = db.prepare('SELECT * FROM account_dictionaries ORDER BY name').all() as Array<{
    id: string; name: string; location: string; registered_by: string;
  }>;
  let rows = db
    .prepare(
      `SELECT a.*, d.name AS dictionary FROM accounts a
       JOIN account_dictionaries d ON d.id = a.dictionary_id ORDER BY a.platform, a.handle`,
    )
    .all() as Array<Record<string, unknown>>;

  if (q?.search) {
    const s = q.search.toLowerCase();
    rows = rows.filter((r) =>
      [r['platform'], r['handle'], r['keychain_ref'], r['dictionary']]
        .some((v) => String(v ?? '').toLowerCase().includes(s)),
    );
  }
  if (q?.status) rows = rows.filter((r) => r['status'] === q.status);
  if (q?.dictionary) rows = rows.filter((r) => r['dictionary'] === q.dictionary);

  return {
    dictionaries: dicts.map((d) => ({
      id: d.id, name: d.name, location: d.location, registeredBy: d.registered_by,
      rows: rows.filter((r) => r['dictionary'] === d.name).length,
    })),
    accounts: rows.map((r) => ({
      platform: r['platform'],
      handle: r['handle'],
      status: r['status'],
      allowedAgents: JSON.parse(String(r['allowed_agents'] ?? '[]')) as string[],
      lastUsedAt: r['last_used_at'],
      dictionary: r['dictionary'],
      // The reference, never the secret.
      keychainRef: r['keychain_ref'],
      hasCredential: Boolean(r['keychain_ref']),
    })),
  };
}

export { listAgents, getAgentBySlug, getAgent, thread, answer, ask, createAgent, appendMessage };
