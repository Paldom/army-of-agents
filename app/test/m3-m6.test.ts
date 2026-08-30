/**
 * Proofs for M3 (isolation), M4 (memory continuity), M5 (spawn + join) and
 * M6 (fan-in).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { open } from '../src/store/db.ts';
import { createAgent, getAgentBySlug, openRun, succeed } from '../src/supervisor/repo.ts';
import { ensureAccount } from '../src/supervisor/budget.ts';
import { ask, answer } from '../src/supervisor/hitl.ts';
import { appendMessage } from '../src/store/db.ts';
import {
  agentMayAct, deniedVendorDirs, isolationFor, releaseControl, requestHelp, seatbeltProfile, takeControl,
} from '../src/supervisor/isolation.ts';
import {
  approvePromotion, assembleCapsule, mayAgentWrite, pendingPromotion, proposePromotion, renderCapsule, rejectPromotion,
} from '../src/supervisor/memory.ts';
import { LIMITS, activate, listProposals, propose, reapExpired } from '../src/orchestrator/spawn.ts';
import { grantJoin, joinerMayAnswerAsk, submitResult } from '../src/orchestrator/join.ts';
import { approve, mergePlan, openFanIn, provenanceManifest, selectable, setSelection } from '../src/orchestrator/fanin.ts';

const WAKE = { kind: 'continuous' as const, minIntervalMs: 60_000, backoff: { baseMs: 60_000, maxMs: 3_600_000, factor: 2 } };
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aoa-m36-'));
  return { db: open(join(dir, 's.db')), dir };
}

// ── M3 ─────────────────────────────────────────────────────────────────────
test('M3 PROOF: agent A cannot read agent B\'s vendor config', () => {
  const isoA = isolationFor('a', { root: '/proj', home: '/home/o', assignedVendor: 'claude' });
  const denied = deniedVendorDirs('/home/o', 'claude');

  assert.ok(isoA.readPaths.some((p) => p.endsWith('/.claude')), 'it can read its OWN vendor config');
  assert.ok(denied.some((d) => d.endsWith('/.codex')), 'and not another vendor\'s');
  assert.ok(!denied.some((d) => d.endsWith('/.claude')), 'its own is never denied');

  const profile = seatbeltProfile(isoA, denied);
  assert.match(profile, /deny file-read\* \(subpath "\/home\/o\/\.codex"\)/);
  assert.ok(!/deny file-read\* \(subpath "\/home\/o\/\.claude"\)/.test(profile));
  // Writes are confined to its own worktree.
  // Beside the project, not inside it: a .worktrees/ dir in the repo shows
  // up in the owner's own `git status`.
  assert.match(profile, /allow file-write\* \(subpath "\/proj-agents\/a"\)/);
});

test('M3: worktree and browser profile are per agent', () => {
  const a = isolationFor('a', { root: '/p', home: '/h', assignedVendor: null });
  const b = isolationFor('b', { root: '/p', home: '/h', assignedVendor: null });
  assert.notEqual(a.worktree, b.worktree);
  assert.notEqual(a.browserProfile, b.browserProfile);
});

test('M3: the degradations are stated, not hidden', () => {
  const iso = isolationFor('a', { root: '/p', home: '/h', assignedVendor: 'codex' });
  const dims = iso.degradations.map((d) => d.dimension);
  assert.ok(dims.includes('network'), 'shared network is admitted');
  assert.ok(dims.includes('vendor credentials'), 'shared credentials are admitted');
  for (const d of iso.degradations) assert.ok(d.why.length > 20, 'each degradation says why');
});

test('M3: while a human drives, agent actions are REFUSED, not queued', () => {
  let s = releaseControl(0);
  assert.equal(agentMayAct(s).allowed, true);

  s = requestHelp(s, 'CAPTCHA', 1);
  assert.equal(agentMayAct(s).allowed, false, 'paused while asking for help');

  s = takeControl(s, 2);
  const r = agentMayAct(s);
  assert.equal(r.allowed, false);
  assert.match(String(r.refusal), /refused rather than queued/);

  s = releaseControl(3);
  assert.equal(agentMayAct(s).allowed, true, 'control returns cleanly');
});

// ── M4 ─────────────────────────────────────────────────────────────────────
test('M4 PROOF: a fresh body resumes a mission it never saw the transcript of', () => {
  const { db, dir } = freshDb();
  try {
    const a = createAgent(db, {
      slug: 'scout', displayName: 'Scout', wake: WAKE, createdBy: 'h',
      persona: 'You may read docs/. You may write reports/.', mission: 'Track rate-table drift.',
      docsRef: 'docs/scout',
    });
    const run = openRun(db, a)!;
    appendMessage(db, { agentId: a.id, kind: 'agent', author: 'agent:scout', body: 'checked 38 sources' });
    const q = ask(db, { agentId: a.id, runId: run.id, prompt: 'Which source is canonical?' });
    succeed(db, run.id, 'BLOCKED');
    answer(db, q.id, { by: 'human:owner', text: 'the official one' });
    proposePromotion(db, a.id, ['Official docs outrank the live adapter for rate tables.']);
    approvePromotion(db, a.id, 'human:owner');

    // A brand-new body, with no transcript at all.
    const capsule = assembleCapsule(db, a.id);
    assert.match(capsule.contract, /You may read docs/);
    assert.equal(capsule.mission, 'Track rate-table drift.');
    assert.equal(capsule.pendingVerdicts[0]!.answer, 'the official one', 'it carries the decision made for it');
    assert.equal(capsule.learnedNotes.length, 1, 'and what it learned');
    assert.ok(capsule.lastRunSummary, 'and how it left off');

    const prompt = renderCapsule(capsule);
    assert.match(prompt, /Decisions the owner made for you/);
    assert.match(prompt, /the official one/);
    // Channel history is fenced as data, not instructions.
    assert.match(prompt, /<<<DATA/);
    assert.match(prompt, /never carries authority/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M4: memory promotion is copy-on-write and needs a human', () => {
  const { db, dir } = freshDb();
  try {
    const a = createAgent(db, { slug: 'a', displayName: 'A', wake: WAKE, createdBy: 'h' });
    proposePromotion(db, a.id, ['note one', 'note two']);

    // The live store is untouched until a human approves.
    assert.equal(assembleCapsule(db, a.id).learnedNotes.length, 0, 'candidate is not live');
    const diff = pendingPromotion(db, a.id)!;
    assert.deepEqual(diff.added, ['note one', 'note two'], 'the diff is reviewable');

    rejectPromotion(db, a.id, 'human:owner');
    assert.equal(pendingPromotion(db, a.id), null);
    assert.equal(assembleCapsule(db, a.id).learnedNotes.length, 0, 'a rejected promotion changes nothing');

    proposePromotion(db, a.id, ['kept note']);
    approvePromotion(db, a.id, 'human:owner');
    assert.deepEqual(assembleCapsule(db, a.id).learnedNotes, ['kept note']);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M4: an agent may never write what it is judged by', () => {
  assert.equal(mayAgentWrite('docs/notes.md').allowed, true);
  assert.equal(mayAgentWrite('reports/2026.md').allowed, true);
  for (const p of ['policies/risk.yaml', 'evals/evals.json', 'policies/risk.yaml.sha256', '.github/workflows/ci.yml']) {
    const r = mayAgentWrite(p);
    assert.equal(r.allowed, false, p);
    assert.match(String(r.reason), /judged against/);
  }
});

// ── M5 ─────────────────────────────────────────────────────────────────────
test('M5: spawning proposes — a human activates, and budget comes from the parent', () => {
  const { db, dir } = freshDb();
  try {
    const parent = createAgent(db, { slug: 'p', displayName: 'P', wake: WAKE, createdBy: 'h' });
    ensureAccount(db, parent.id, 100);

    const over = propose(db, { parent, slug: 'too-big', mission: 'm', budget: 500 });
    assert.equal(over.ok, false, 'creating an agent cannot conjure capacity');
    assert.match(String(over.ok === false && over.reason), /cannot conjure capacity/);

    const p = propose(db, { parent, slug: 'child', mission: 'watch things', budget: 40 });
    assert.equal(p.ok, true);
    assert.equal(getAgentBySlug(db, 'child'), undefined, 'proposing does not create');

    activate(db, p.ok ? p.proposal.id : '', 'human:owner');
    const child = getAgentBySlug(db, 'child')!;
    assert.equal(child.depth, 1);
    assert.ok(child.expires_at, 'a spawned agent gets a TTL');

    // The parent's allowance actually shrank — self-replication starves itself.
    const pa = db.prepare(`SELECT allowance FROM budget_accounts WHERE agent_id=? AND window='day'`)
      .get(parent.id) as { allowance: number };
    assert.equal(pa.allowance, 60);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M5: depth and fan-out caps make runaway replication structurally impossible', () => {
  const { db, dir } = freshDb();
  try {
    const root = createAgent(db, { slug: 'r', displayName: 'R', wake: WAKE, createdBy: 'h' });
    for (let i = 0; i < LIMITS.maxChildrenPerParent; i++) {
      const p = propose(db, { parent: root, slug: `c${i}`, mission: 'm', budget: 1 });
      assert.equal(p.ok, true);
      activate(db, p.ok ? p.proposal.id : '', 'human:owner');
    }
    const extra = propose(db, { parent: root, slug: 'c9', mission: 'm', budget: 1 });
    assert.equal(extra.ok, false, 'fan-out cap holds');

    const child = getAgentBySlug(db, 'c0')!;
    const grand = propose(db, { parent: child, slug: 'g', mission: 'm', budget: 1 });
    assert.equal(grand.ok, false, 'a child may not create grandchildren');
    assert.match(String(grand.ok === false && grand.reason), /depth cap/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M5: an expired child is reaped with its descendants', () => {
  const { db, dir } = freshDb();
  try {
    const root = createAgent(db, { slug: 'r', displayName: 'R', wake: WAKE, createdBy: 'h' });
    const p = propose(db, { parent: root, slug: 'temp', mission: 'm', budget: 1, ttlMs: 1 });
    activate(db, p.ok ? p.proposal.id : '', 'human:owner');
    const reaped = reapExpired(db, Date.now() + 10_000);
    assert.ok(reaped.includes('temp'));
    assert.equal(getAgentBySlug(db, 'temp')!.status, 'RETIRED');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M5: a joined session gets a scoped package and no authority', () => {
  const { db, dir } = freshDb();
  try {
    createAgent(db, { slug: 'orchestrator', displayName: 'O', wake: WAKE, createdBy: 'h' });
    const s = createAgent(db, {
      slug: 'scout', displayName: 'S', wake: WAKE, createdBy: 'h', persona: 'reads docs/, writes reports/',
    });
    ask(db, { agentId: s.id, prompt: 'Which source is canonical?' });

    const pkg = grantJoin(db, { role: 'reviewer', agentSlug: 'scout', identity: 'codex-cli' });
    assert.equal(pkg.trust, 'untrusted');
    assert.equal(pkg.artifact, 'Which source is canonical?', 'it gets the artifact');
    assert.match(String(pkg.contract), /reads docs/, 'and the contract');
    assert.ok(pkg.criteria.length >= 2, 'and the review criteria');
    assert.ok(pkg.rules.some((r) => /never satisfies an approval gate/.test(r)));
    // It does NOT get the store.
    assert.ok(!('agents' in (pkg as object)) && !('db' in (pkg as object)));

    assert.equal(joinerMayAnswerAsk().allowed, false, 'a joiner can never resolve an ask');

    const r1 = submitResult(db, pkg.token, 'The official source wins.', 'codex-cli');
    assert.equal(r1.ok, true);
    const r2 = submitResult(db, pkg.token, 'again', 'codex-cli');
    assert.equal(r2.ok, false, 'a join grant is single-use');

    const msg = db.prepare(`SELECT author, meta FROM messages WHERE agent_id=? ORDER BY seq DESC LIMIT 1`)
      .get(s.id) as { author: string; meta: string };
    assert.match(msg.author, /^joined:/, 'the result is attributable');
    assert.match(msg.meta, /untrusted/, 'and marked untrusted');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── M6 ─────────────────────────────────────────────────────────────────────
test('M6 PROOF: three agents finish and the human integrates without a terminal', () => {
  const { db, dir } = freshDb();
  try {
    const f = openFanIn(db, {
      target: 'main', base: 'abc1234',
      changes: [
        { path: 'src/a.ts', insertions: 46, deletions: 11, agentSlug: 'mechanic', harness: 'codex',
          worktree: 'wt/mechanic', runId: 'r1', costTokens: 12480, costUsd: null, testsPassed: true, testSummary: '18 passed' },
        { path: 'src/b.ts', insertions: 83, deletions: 4, agentSlug: 'archivist', harness: 'claude',
          worktree: 'wt/archivist', runId: 'r2', costTokens: 21104, costUsd: null, testsPassed: true, testSummary: '27 passed' },
        { path: 'docs/c.md', insertions: 61, deletions: 0, agentSlug: 'scribe', harness: 'gemini',
          worktree: 'wt/scribe', runId: 'r3', costTokens: null, costUsd: 0.03, testsPassed: false, testSummary: '1 failed' },
      ],
    });

    // A failing change cannot be selected — evidence, not "trust me".
    const sel = setSelection(db, f.id, ['src/a.ts', 'src/b.ts', 'docs/c.md']);
    assert.deepEqual(sel.refused, ['docs/c.md'], 'the failing change is refused');

    const plan = mergePlan({ ...f, selected: ['src/a.ts', 'src/b.ts'] });
    assert.ok(plan.steps.some((s) => s.gate), 'the repository gate is an explicit step');
    assert.equal(plan.archive.length, 1, 'the loser is archived, not abandoned');
    assert.match(plan.archive[0]!.why, /kept inspectable/);
    assert.equal(plan.reap.length, 2, 'merged worktrees are reaped');

    assert.equal(approve(db, f.id, 'human:owner').ok, true);

    // The manifest is what git cannot give you.
    const manifest = provenanceManifest({ ...f, selected: ['src/a.ts', 'src/b.ts'], approvedBy: 'human:owner' });
    assert.match(manifest, /mechanic \| codex/);
    assert.match(manifest, /archivist \| claude/);
    assert.match(manifest, /12480 tok/);
    assert.match(manifest, /passed/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M6: an anonymous or untested change is never selectable', () => {
  const base = {
    path: 'x', insertions: 1, deletions: 0, worktree: 'w', runId: null,
    costTokens: null, costUsd: null, testSummary: null,
  };
  assert.equal(selectable({ ...base, agentSlug: '', harness: '', testsPassed: true }).ok, false);
  assert.match(
    String(selectable({ ...base, agentSlug: '', harness: '', testsPassed: true }).reason),
    /anonymous change/,
  );
  assert.equal(selectable({ ...base, agentSlug: 'a', harness: 'codex', testsPassed: null }).ok, false);
  assert.equal(selectable({ ...base, agentSlug: 'a', harness: 'codex', testsPassed: true }).ok, true);
});
