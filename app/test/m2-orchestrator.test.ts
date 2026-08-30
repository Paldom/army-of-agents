/**
 * The orchestrator command surface: investigations run immediately, changes
 * never do. That asymmetry is the safety property of the whole screen.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { open } from '../src/store/db.ts';
import { createAgent, getAgentBySlug } from '../src/supervisor/repo.ts';
import { applyPlan, listPlans, proposePlan, rejectPlan } from '../src/orchestrator/plan.ts';
import { addBacklogItem, listBacklog, promoteBacklogItem, demoteToBacklog, listAccounts, registerDictionary, upsertAccount, setChannels } from '../src/server/api.ts';
import { ask, expireAsks } from '../src/supervisor/hitl.ts';

const WAKE = { kind: 'continuous' as const, minIntervalMs: 60_000, backoff: { baseMs: 60_000, maxMs: 3_600_000, factor: 2 } };

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), 'aoa-orc-'));
  const db = open(join(dir, 's.db'));
  createAgent(db, { slug: 'orchestrator', displayName: 'Orchestrator', wake: WAKE, createdBy: 'human:owner' });
  createAgent(db, { slug: 'scout', displayName: 'Scout', wake: WAKE, createdBy: 'human:owner', docsRef: 'wiki/research' });
  createAgent(db, { slug: 'reviewer', displayName: 'Reviewer', wake: WAKE, createdBy: 'human:owner', docsRef: 'wiki/research' });
  // Channels are data. The orchestrator resolves selectors against these, not
  // against a vocabulary baked into its own source.
  setChannels(db, [
    { name: 'research', members: ['scout', 'reviewer'] },
    { name: 'root', members: ['orchestrator'] },
  ]);
  return { db, dir };
}

test('an investigation answers immediately and changes nothing', () => {
  const { db, dir } = seeded();
  try {
    const plan = proposePlan(db, 'why is scout blocked?', 'human:owner');
    assert.equal(plan.effects.length, 0, 'a question is not a change');
    assert.ok(plan.investigation, 'it answers on the spot');
    assert.match(plan.investigation!, /scout is/);
    assert.equal(getAgentBySlug(db, 'scout')!.status, 'ACTIVE', 'nothing moved');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fleet change returns a plan and waits — nothing happens before Apply', () => {
  const { db, dir } = seeded();
  try {
    const plan = proposePlan(db, 'pause every research agent until the trust order is settled', 'human:owner');
    assert.ok(plan.effects.length >= 2, 'the channel selector resolved to real agents');
    assert.equal(plan.state, 'PENDING');
    // Crucially: still running.
    assert.equal(getAgentBySlug(db, 'scout')!.status, 'ACTIVE', 'a sentence does not change the fleet');

    // Each effect is checkable by a human, in words.
    for (const e of plan.effects) {
      assert.match(e.describe, /stops after its current run/);
    }

    const applied = applyPlan(db, plan.id, 'human:owner');
    assert.equal(applied.ok, true);
    assert.equal(getAgentBySlug(db, 'scout')!.status, 'PAUSED');
    assert.equal(getAgentBySlug(db, 'reviewer')!.status, 'PAUSED');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a plan applies once; a rejected plan never applies', () => {
  const { db, dir } = seeded();
  try {
    const p1 = proposePlan(db, 'pause scout', 'human:owner');
    assert.equal(applyPlan(db, p1.id, 'human:owner').ok, true);
    assert.equal(applyPlan(db, p1.id, 'human:owner').ok, false, 'no double application');

    const p2 = proposePlan(db, 'retire reviewer', 'human:owner');
    assert.equal(rejectPlan(db, p2.id, 'human:owner').ok, true);
    assert.equal(getAgentBySlug(db, 'reviewer')!.status, 'ACTIVE', 'rejection changes nothing');
    assert.equal(applyPlan(db, p2.id, 'human:owner').ok, false, 'a rejected plan cannot be applied');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('creating an agent proposes it — it never starts one', () => {
  const { db, dir } = seeded();
  try {
    const plan = proposePlan(db, 'create an agent called fee-watcher that watches vendor fee changes', 'human:owner');
    assert.equal(plan.effects[0]!.kind, 'create_agent');
    assert.match(plan.effects[0]!.describe, /does not run until you activate it/);
    applyPlan(db, plan.id, 'human:owner');

    const made = getAgentBySlug(db, 'fee-watcher')!;
    assert.equal(made.status, 'DRAFT', 'propose, do not activate');
    assert.equal(made.created_by, 'agent:orchestrator');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('retiring an agent cascades to its children', () => {
  const { db, dir } = seeded();
  try {
    const parent = getAgentBySlug(db, 'scout')!;
    createAgent(db, {
      slug: 'child', displayName: 'Child', wake: WAKE, createdBy: 'agent:orchestrator',
      parentAgentId: parent.id,
    });
    const plan = proposePlan(db, 'retire scout', 'human:owner');
    applyPlan(db, plan.id, 'human:owner');
    assert.equal(getAgentBySlug(db, 'scout')!.status, 'RETIRED');
    assert.equal(getAgentBySlug(db, 'child')!.status, 'RETIRED', 'descendants do not outlive the parent');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the backlog is authorable both ways and the machine sets the rank', () => {
  const { db, dir } = seeded();
  try {
    // Directly, by the owner.
    addBacklogItem(db, { title: 'Retention policy', question: 'How long do we keep raw capture?', raisedBy: 'human:owner' });
    // And through the orchestrator.
    const plan = proposePlan(db, 'add a backlog item: decide the paid-source ceiling', 'human:owner');
    assert.equal(plan.effects[0]!.kind, 'add_backlog_item');
    assert.match(plan.effects[0]!.describe, /Nothing is stopped/);
    applyPlan(db, plan.id, 'human:owner');

    const before = listBacklog(db);
    assert.equal(before.items.length, 2);
    assert.equal(before.rankedAt, null, 'unranked until the orchestrator ranks it');

    const rerank = proposePlan(db, 're-rank the backlog', 'human:owner');
    applyPlan(db, rerank.id, 'human:owner');
    const after = listBacklog(db);
    assert.ok(after.rankedAt !== null, 'the machine ranks, the owner does not sort');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backlog promotes to Needs you, and an expired ask demotes back rather than being lost', () => {
  const { db, dir } = seeded();
  try {
    const scout = getAgentBySlug(db, 'scout')!;
    const item = addBacklogItem(db, {
      title: 'Fee source', question: 'Which fee source is canonical?', raisedBy: 'human:owner',
    });
    const askId = promoteBacklogItem(db, item.id, scout.id);
    assert.ok(askId, 'promotion creates a durable ask');
    assert.equal(listBacklog(db).items.length, 0, 'it left the standing queue');

    // Now let it expire unanswered.
    db.prepare('UPDATE approval_requests SET expires_at = ? WHERE id = ?').run(Date.now() - 1, askId);
    expireAsks(db);
    demoteToBacklog(db, askId);
    const back = listBacklog(db);
    assert.equal(back.items.length, 1, 'an expired ask returns here rather than vanishing');
    assert.match(back.items[0]!.rationale ?? '', /nothing was approved/i);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('accounts merge across dictionaries and never expose a secret', () => {
  const { db, dir } = seeded();
  try {
    const core = registerDictionary(db, { name: 'persona-core', location: 'drive://identities/accounts.json', registeredBy: 'human:owner' });
    // An agent may register another dictionary; the list is their union.
    const shared = registerDictionary(db, { name: 'research-shared', location: 'drive://fleet/research.json', registeredBy: 'agent:orchestrator' });

    upsertAccount(db, { dictionaryId: core, platform: 'GitHub', handle: 'ada-labs', keychainRef: 'dp-ada/github', allowedAgents: ['scout'] });
    upsertAccount(db, { dictionaryId: shared, platform: 'DataVendor', handle: 'research-readonly', keychainRef: 'dp-ada/vendor' });

    const out = listAccounts(db);
    assert.equal(out.dictionaries.length, 2, 'both dictionaries are visible');
    assert.equal(out.accounts.length, 2, 'the list is their union');

    const serialized = JSON.stringify(out);
    assert.ok(!/password|secret|token|nsec/i.test(serialized), 'no credential material is ever returned');
    for (const a of out.accounts) {
      assert.ok(a.hasCredential, 'the row confirms a credential exists');
      assert.match(String(a.keychainRef), /^dp-/, 'and names its keychain item, not its value');
      assert.ok(!('value' in a), 'there is no value field to leak');
    }

    // Search is what makes hundreds of rows usable.
    assert.equal(listAccounts(db, { search: 'github' }).accounts.length, 1);
    assert.equal(listAccounts(db, { dictionary: 'research-shared' }).accounts.length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plans are listed newest first for the orchestrator screen', () => {
  const { db, dir } = seeded();
  try {
    proposePlan(db, 'pause scout', 'human:owner');
    proposePlan(db, 'pause reviewer', 'human:owner');
    const plans = listPlans(db);
    assert.equal(plans.length, 2);
    assert.match(plans[0]!.request, /reviewer/, 'newest first');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the channel selector resolves against real channels, not a hardcoded list', () => {
  const { db, dir } = seeded();
  try {
    // A fleet whose channels did not exist when the orchestrator was written.
    setChannels(db, [{ name: 'research', members: ['scout', 'reviewer'] }]);
    const plan = proposePlan(db, 'pause every research agent', 'human:owner');
    assert.equal(plan.effects.length, 2, 'it resolved a channel it had never seen');
    applyPlan(db, plan.id, 'human:owner');
    assert.equal(getAgentBySlug(db, 'scout')!.status, 'PAUSED');
    assert.equal(getAgentBySlug(db, 'reviewer')!.status, 'PAUSED');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
