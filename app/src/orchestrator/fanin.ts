import { type Db, emit, id, now, tx } from '../store/db.ts';

/**
 * M6 — fan-in. The part nobody builds, and the reason the rest is worth having.
 *
 * Fan-out is easy and increasingly commoditised; every multi-agent flow ends at
 * N worktrees, N diffs, one repo, and a human reconciling them in a terminal.
 *
 * Git supplies the diffs. This screen supplies the thing git cannot: for every
 * change, WHICH AGENT produced it, ON WHICH HARNESS, AT WHAT COST, and WHETHER
 * ITS TESTS PASSED. Without that provenance a fan-in view is git with a UI.
 *
 * And: never ship fan-out without fan-in. Losers are archived, not abandoned,
 * and worktrees are reaped — otherwise they accumulate until the disk fills and
 * nobody remembers which branch was the good one.
 */

export interface ChangeProvenance {
  path: string;
  insertions: number;
  deletions: number;
  agentSlug: string;
  harness: string;
  worktree: string;
  runId: string | null;
  /** Tokens or metered spend — whichever the lane reports. */
  costTokens: number | null;
  costUsd: number | null;
  testsPassed: boolean | null;
  testSummary: string | null;
}

export interface FanIn {
  id: string;
  target: string;
  base: string;
  changes: ChangeProvenance[];
  selected: string[];
  state: 'REVIEW' | 'APPROVED' | 'MERGED' | 'ABANDONED';
  createdAt: number;
  approvedBy?: string;
}

const KEY = 'fanins';

function load(db: Db): FanIn[] {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as FanIn[]) : [];
}
function save(db: Db, list: FanIn[]): void {
  db.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run(KEY, JSON.stringify(list.slice(-50)));
}

export function listFanIns(db: Db): FanIn[] {
  return load(db).slice().reverse();
}

export function openFanIn(
  db: Db,
  f: { target: string; base: string; changes: ChangeProvenance[] },
): FanIn {
  const rec: FanIn = {
    id: id(),
    target: f.target,
    base: f.base,
    changes: f.changes,
    selected: f.changes.map((c) => c.path),
    state: 'REVIEW',
    createdAt: now(),
  };
  const list = load(db);
  list.push(rec);
  save(db, list);
  emit(db, 'fanin.opened', 'agent:orchestrator', { id: rec.id, changes: f.changes.length });
  return rec;
}

/**
 * A change with no provenance cannot be selected. That is the whole point of
 * the screen: if we cannot say which agent produced it, on what, at what cost,
 * and whether it passed, then merging it is a guess.
 */
export function selectable(c: ChangeProvenance): { ok: boolean; reason?: string } {
  if (!c.agentSlug || !c.harness) {
    return { ok: false, reason: 'no agent/harness provenance — refusing to merge an anonymous change' };
  }
  if (c.testsPassed === null) {
    return { ok: false, reason: 'test result unknown — evidence, not "trust me"' };
  }
  if (c.testsPassed === false) {
    return { ok: false, reason: 'tests failed for this change' };
  }
  return { ok: true };
}

export function setSelection(db: Db, fanInId: string, paths: string[]): { ok: boolean; refused: string[] } {
  return tx(db, () => {
    const list = load(db);
    const f = list.find((x) => x.id === fanInId);
    if (!f) return { ok: false, refused: [] };
    const refused: string[] = [];
    const ok: string[] = [];
    for (const p of paths) {
      const c = f.changes.find((x) => x.path === p);
      if (!c) { refused.push(p); continue; }
      const s = selectable(c);
      (s.ok ? ok : refused).push(p);
    }
    f.selected = ok;
    save(db, list);
    return { ok: true, refused };
  });
}

export interface MergePlan {
  steps: Array<{ n: number; label: string; gate: boolean }>;
  archive: Array<{ worktree: string; why: string }>;
  reap: string[];
}

/** Conflict order and test gates are explicit, not implied. */
export function mergePlan(f: FanIn): MergePlan {
  const chosen = f.changes.filter((c) => f.selected.includes(c.path));
  const worktrees = [...new Set(chosen.map((c) => c.worktree))];
  const losers = [...new Set(f.changes.map((c) => c.worktree))].filter((w) => !worktrees.includes(w));
  return {
    steps: [
      { n: 1, label: `Apply ${chosen.length} selected change(s) to an integration worktree`, gate: false },
      { n: 2, label: 'Run the repository gate', gate: true },
      { n: 3, label: `Fast-forward ${f.target} and write the provenance manifest`, gate: false },
    ],
    archive: losers.map((w) => ({
      worktree: w,
      why: 'Not selected. Archived as a bundle and kept inspectable — losing branches are not deleted blind.',
    })),
    reap: worktrees,
  };
}

export function approve(db: Db, fanInId: string, by: string): { ok: boolean; error?: string } {
  return tx(db, () => {
    const list = load(db);
    const f = list.find((x) => x.id === fanInId);
    if (!f) return { ok: false, error: 'no such fan-in' };
    if (f.state !== 'REVIEW') return { ok: false, error: `already ${f.state}` };
    if (f.selected.length === 0) return { ok: false, error: 'nothing selected' };
    f.state = 'APPROVED';
    f.approvedBy = by;
    save(db, list);
    emit(db, 'fanin.approved', by, { id: fanInId, selected: f.selected.length });
    return { ok: true };
  });
}

/** The manifest is the durable answer to "where did this line come from?". */
export function provenanceManifest(f: FanIn): string {
  const chosen = f.changes.filter((c) => f.selected.includes(c.path));
  const lines = [
    `# fan-in ${f.id}`,
    `target: ${f.target}`,
    `base: ${f.base}`,
    `approved_by: ${f.approvedBy ?? '(unapproved)'}`,
    '',
    '| path | agent | harness | cost | tests |',
    '| --- | --- | --- | --- | --- |',
    ...chosen.map(
      (c) =>
        `| ${c.path} | ${c.agentSlug} | ${c.harness} | ${
          c.costUsd != null ? `$${c.costUsd.toFixed(2)}` : c.costTokens != null ? `${c.costTokens} tok` : '—'
        } | ${c.testsPassed ? 'passed' : 'unknown'} |`,
    ),
  ];
  return lines.join('\n');
}
