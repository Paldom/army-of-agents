/**
 * The orchestrator is always there, and mail moves it exactly once.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { open } from '../src/store/db.ts';
import { createAgent, getAgentBySlug, openRun, statusOf, succeed } from '../src/supervisor/repo.ts';
import { deliver, deliverAndWake, leaseFor, pending } from '../src/supervisor/messages.ts';
import { assembleCapsule, renderCapsule } from '../src/supervisor/memory.ts';
import { hasWork } from '../src/supervisor/precondition.ts';
import { type Dispatcher, tick } from '../src/supervisor/tick.ts';
import { ORCHESTRATOR_SLUG, ensureOrchestrator, fleetBriefing } from '../src/orchestrator/bootstrap.ts';
import { applyPlan, listPlans, proposePlan } from '../src/orchestrator/plan.ts';
import { answer, ask, cancelAsk, verdictsFor } from '../src/supervisor/hitl.ts';
import { gateVendor } from '../src/supervisor/tick.ts';
import { assembleCapsule as capsuleOf } from '../src/supervisor/memory.ts';

const WAKE = { kind: 'continuous' as const, minIntervalMs: 60_000, backoff: { baseMs: 60_000, maxMs: 3_600_000, factor: 2 } };

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'aoa-orch-'));
  return { db: open(join(dir, 's.db')), dir };
}

test('the orchestrator exists on a fresh store, once, and an owner pause survives a restart', () => {
  const { db, dir } = fresh();
  try {
    const first = ensureOrchestrator(db);
    const again = ensureOrchestrator(db);
    assert.equal(first.id, again.id);
    const created = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'agent.created' AND subject = ?`)
      .get(first.id) as { n: number };
    assert.equal(created.n, 1, 'one row, one event');
    assert.equal(first.status, 'ACTIVE');
    assert.equal(JSON.parse(first.wake).kind, 'on_message');
    assert.equal(statusOf(db, first).status, 'WAITING_EVENT', 'not DUE on the first tick');
    assert.ok(first.persona.includes('PROPOSE:'), 'its contract carries the plan vocabulary');

    db.prepare(`UPDATE agents SET status = 'PAUSED' WHERE id = ?`).run(first.id);
    assert.equal(ensureOrchestrator(db).status, 'PAUSED', 'never mutated back to life');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a human message wakes the orchestrator once; a completed turn acks it; a failed turn releases it', () => {
  const { db, dir } = fresh();
  try {
    const orch = ensureOrchestrator(db);
    assert.equal(hasWork(db, orch), false);

    const r = deliverAndWake(db, { to: orch, kind: 'human', author: 'human:owner', body: 'why is nothing merging?', wakeReason: 'human' });
    assert.equal(r.woke, true);
    let o = getAgentBySlug(db, ORCHESTRATOR_SLUG)!;
    assert.ok(o.next_due_at !== null, 'woken');
    assert.equal(hasWork(db, o), true);

    // Dispatch: the inbox is leased into the capsule.
    const run = openRun(db, o)!;
    const inbox = leaseFor(db, `agent:${ORCHESTRATOR_SLUG}`, run.id, 60_000);
    assert.equal(inbox.length, 1);
    const bound = db.prepare(`SELECT lease_run_id FROM message_deliveries WHERE message_id = ?`).get(inbox[0]!.id) as { lease_run_id: string };
    assert.equal(bound.lease_run_id, run.id, 'the lease names the run that took it');
    const cap = assembleCapsule(db, o.id);
    cap.inbox = inbox.map((m) => ({ author: m.author, kind: m.kind, body: m.body }));
    cap.briefing = fleetBriefing(db);
    const text = renderCapsule(cap);
    assert.ok(text.includes('## New messages for you') && text.includes('why is nothing merging?'));
    assert.ok(text.includes('## Fleet right now'));
    assert.ok(text.indexOf('<<<DATA') < text.indexOf('why is nothing merging?'), 'mail is data, not instructions');

    // The turn died: released at once, not stuck LEASED until the lease lapses —
    // but the error backoff stands, so a session that cannot start is not
    // retried three times in three ticks.
    const before = Date.now();
    succeed(db, run.id, 'RETRYABLE_ERROR', { toState: 'failed', nowMs: before });
    assert.equal(pending(db, `agent:${ORCHESTRATOR_SLUG}`).length, 1, 'redeliverable');
    assert.equal(hasWork(db, getAgentBySlug(db, ORCHESTRATOR_SLUG)!), true);
    assert.ok(getAgentBySlug(db, ORCHESTRATOR_SLUG)!.next_due_at! > before, 'released mail does not cancel the backoff');

    // The turn completed: acked, and the agent goes back to waiting for mail.
    const run2 = openRun(db, getAgentBySlug(db, ORCHESTRATOR_SLUG)!)!;
    leaseFor(db, `agent:${ORCHESTRATOR_SLUG}`, run2.id, 60_000);
    succeed(db, run2.id, 'WORK_DONE');
    o = getAgentBySlug(db, ORCHESTRATOR_SLUG)!;
    assert.equal(hasWork(db, o), false, 'no re-wake for mail already read');
    assert.equal(o.next_due_at, null);
    assert.equal(statusOf(db, o).status, 'WAITING_EVENT');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mail that arrives mid-turn is not lost under the settle', () => {
  const { db, dir } = fresh();
  try {
    const orch = ensureOrchestrator(db);
    db.prepare(`UPDATE agents SET next_due_at = ? WHERE id = ?`).run(Date.now(), orch.id);
    const run = openRun(db, getAgentBySlug(db, ORCHESTRATOR_SLUG)!)!;
    leaseFor(db, `agent:${ORCHESTRATOR_SLUG}`, run.id, 60_000); // nothing to lease yet
    deliverAndWake(db, { to: orch, kind: 'human', author: 'human:owner', body: 'and one more thing', wakeReason: 'human' });
    succeed(db, run.id, 'NO_WORK');
    const o = getAgentBySlug(db, ORCHESTRATOR_SLUG)!;
    assert.ok(o.next_due_at !== null, 'one more wake for an inbox that is not empty');
    assert.equal(hasWork(db, o), true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('three failed deliveries park agent mail, never a human\'s words', () => {
  const { db, dir } = fresh();
  try {
    const orch = ensureOrchestrator(db);
    deliver(db, { agentId: orch.id, kind: 'human', author: 'human:owner', body: 'from the owner', recipients: [`agent:${ORCHESTRATOR_SLUG}`] });
    deliver(db, { agentId: orch.id, kind: 'agent_to_agent', author: 'agent:scout', body: '@orchestrator cursed', recipients: [`agent:${ORCHESTRATOR_SLUG}`] });
    for (let i = 0; i < 3; i++) {
      const run = openRun(db, getAgentBySlug(db, ORCHESTRATOR_SLUG)!)!;
      assert.equal(leaseFor(db, `agent:${ORCHESTRATOR_SLUG}`, run.id, 60_000).length, 2, `attempt ${i + 1} is offered both`);
      succeed(db, run.id, 'RETRYABLE_ERROR', { toState: 'failed' });
    }
    const left = pending(db, `agent:${ORCHESTRATOR_SLUG}`);
    assert.deepEqual(left.map((m) => m.kind), ['human'], 'the human message is still queued; the agent one is parked');
    assert.equal(hasWork(db, getAgentBySlug(db, ORCHESTRATOR_SLUG)!), true);
    const dead = db.prepare(`SELECT COUNT(*) AS n FROM message_deliveries WHERE state = 'DEAD'`).get() as { n: number };
    assert.equal(dead.n, 1);
    assert.ok(
      db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE agent_id = ? AND kind = 'event' AND body LIKE '%parked%'`).get(orch.id) as { n: number },
      'said in the thread',
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rate-limited agent is due again when its lane reopens, not never', () => {
  const { db, dir } = fresh();
  try {
    const a = createAgent(db, { slug: 'scout', displayName: 'Scout', harness: 'codex', wake: WAKE, createdBy: 'h' });
    const run = openRun(db, a)!;
    const until = Date.now() + 45 * 60_000;
    gateVendor(db, 'codex', until, 'HTTP 429');
    succeed(db, run.id, 'RATE_LIMITED');
    const after = getAgentBySlug(db, 'scout')!;
    assert.equal(after.next_due_at, until, 'due exactly when the gate lifts');
    assert.equal(statusOf(db, after).status, 'WAITING_RESOURCE');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ask → answer → the real tick dispatches the agent with the verdict; a withdrawn ask resumes it too', async () => {
  const { db, dir } = fresh();
  try {
    const a = createAgent(db, { slug: 'scout', displayName: 'Scout', wake: WAKE, createdBy: 'h' });
    const run = openRun(db, a)!;
    const q = ask(db, { agentId: a.id, runId: run.id, prompt: 'Which one?', options: [{ id: 'x', label: 'X' }] });
    succeed(db, run.id, 'BLOCKED', { toState: 'waiting_human' });
    assert.equal(statusOf(db, getAgentBySlug(db, 'scout')!).status, 'WAITING_HUMAN');

    const carried: string[] = [];
    const d: Dispatcher = {
      precondition: (ag) => hasWork(db, ag),
      dispatch: async (ag) => {
        carried.push(...capsuleOf(db, ag.id).pendingVerdicts.map((v) => v.answer));
        return 'WORK_DONE';
      },
    };
    assert.equal((await tick(db, d)).dispatched, 0, 'blocked: nothing to do until a human moves it');

    assert.equal(answer(db, q.id, { by: 'human:owner', optionId: 'x' }).ok, true);
    const r = await tick(db, d);
    assert.equal(r.dispatched, 1, 'the answered agent runs on the next tick, not never');
    assert.deepEqual(carried, ['x'], 'and the turn carried the verdict');

    // Withdrawn: no verdict, but the agent is not left waiting for one.
    const run2 = openRun(db, getAgentBySlug(db, 'scout')!)!;
    const q2 = ask(db, { agentId: a.id, runId: run2.id, prompt: 'And this?' });
    succeed(db, run2.id, 'BLOCKED', { toState: 'waiting_human' });
    assert.equal(cancelAsk(db, q2.id, 'human:owner').ok, true);
    assert.equal(cancelAsk(db, q2.id, 'human:owner').ok, false, 'once');
    carried.length = 0;
    assert.equal((await tick(db, d)).dispatched, 1, 'resumed without an answer');
    assert.deepEqual(carried, [], 'nothing was approved');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a verdict stays owed until a completed run has carried it', () => {
  const { db, dir } = fresh();
  try {
    const a = createAgent(db, { slug: 'scout', displayName: 'Scout', wake: { kind: 'on_message' }, createdBy: 'h' });
    db.prepare(`UPDATE agents SET next_due_at = NULL, wake_reason = 'event' WHERE id = ?`).run(a.id);
    const q = ask(db, { agentId: a.id, prompt: 'which?', options: [{ id: 'x', label: 'X' }] });
    assert.equal(answer(db, q.id, { by: 'human:owner', optionId: 'x' }).ok, true);
    assert.equal(hasWork(db, getAgentBySlug(db, 'scout')!), true);

    // The turn that carried it failed: still owed, still work.
    const r1 = openRun(db, getAgentBySlug(db, 'scout')!)!;
    succeed(db, r1.id, 'RETRYABLE_ERROR', { toState: 'failed' });
    assert.equal(hasWork(db, getAgentBySlug(db, 'scout')!), true, 'a failed attempt does not consume the verdict');
    assert.equal(verdictsFor(db, a.id).length, 1);

    // A completed turn consumed it.
    const r2 = openRun(db, getAgentBySlug(db, 'scout')!)!;
    succeed(db, r2.id, 'WORK_DONE');
    assert.equal(hasWork(db, getAgentBySlug(db, 'scout')!), false);
    assert.equal(verdictsFor(db, a.id).length, 0, 'not carried twice');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a plan applies whole or not at all, and no plan retires the orchestrator', () => {
  const { db, dir } = fresh();
  try {
    ensureOrchestrator(db);
    createAgent(db, { slug: 'scout', displayName: 'Scout', wake: WAKE, createdBy: 'h' });
    const plan = proposePlan(db, 'pause scout', 'human:owner');
    // A hand-edited plan: one real effect, then one nobody registered.
    const raw = JSON.parse(
      (db.prepare(`SELECT value FROM meta WHERE key = 'orchestrator_plans'`).get() as { value: string }).value,
    ) as Array<{ id: string; effects: Array<{ kind: string; describe: string; args: Record<string, unknown> }> }>;
    raw.find((p) => p.id === plan.id)!.effects.push({ kind: 'launch_rockets', describe: '?', args: {} });
    raw.find((p) => p.id === plan.id)!.effects.push({ kind: 'retire_agent', describe: '?', args: { slug: 'orchestrator' } });
    db.prepare(`INSERT OR REPLACE INTO meta(key,value) VALUES ('orchestrator_plans', ?)`).run(JSON.stringify(raw));

    const res = applyPlan(db, plan.id, 'human:owner');
    assert.equal(res.ok, false);
    assert.equal(getAgentBySlug(db, 'scout')!.status, 'ACTIVE', 'nothing applied when any effect is unknown');
    assert.equal(listPlans(db)[0]!.state, 'PENDING');

    const retire = proposePlan(db, 'retire scout', 'human:owner');
    const raw2 = JSON.parse(
      (db.prepare(`SELECT value FROM meta WHERE key = 'orchestrator_plans'`).get() as { value: string }).value,
    ) as Array<{ id: string; effects: Array<{ kind: string; describe: string; args: Record<string, unknown> }> }>;
    raw2.find((p) => p.id === retire.id)!.effects.push({ kind: 'retire_agent', describe: '?', args: { slug: 'orchestrator' } });
    db.prepare(`INSERT OR REPLACE INTO meta(key,value) VALUES ('orchestrator_plans', ?)`).run(JSON.stringify(raw2));
    assert.equal(applyPlan(db, retire.id, 'human:owner').ok, true);
    assert.equal(getAgentBySlug(db, 'scout')!.status, 'RETIRED');
    assert.equal(getAgentBySlug(db, ORCHESTRATOR_SLUG)!.status, 'ACTIVE', 'the applier itself refuses');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a question to the orchestrator reaches its session; a command does not wake it', () => {
  const { db, dir } = fresh();
  try {
    const orch = ensureOrchestrator(db);
    createAgent(db, { slug: 'scout', displayName: 'Scout', wake: WAKE, createdBy: 'h' });
    proposePlan(db, 'pause scout', 'human:owner');
    assert.equal(hasWork(db, getAgentBySlug(db, ORCHESTRATOR_SLUG)!), false, 'a plan card needs no judgement turn');
    const q = proposePlan(db, 'what should we work on next?', 'human:owner');
    assert.equal(q.effects.length, 0);
    assert.equal(hasWork(db, getAgentBySlug(db, ORCHESTRATOR_SLUG)!), true, 'the question is in its inbox');
    assert.ok(getAgentBySlug(db, ORCHESTRATOR_SLUG)!.next_due_at !== null);
    assert.equal(orch.id, getAgentBySlug(db, ORCHESTRATOR_SLUG)!.id);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the orchestrator is considered first and keeps one slot beyond the in-flight cap', async () => {
  const { db, dir } = fresh();
  try {
    const orch = ensureOrchestrator(db);
    const w1 = createAgent(db, { slug: 'w1', displayName: 'W1', wake: WAKE, createdBy: 'h' });
    const w2 = createAgent(db, { slug: 'w2', displayName: 'W2', wake: WAKE, createdBy: 'h' });
    // Two turns already in flight, and the orchestrator has mail.
    openRun(db, w1);
    openRun(db, w2);
    deliverAndWake(db, { to: orch, kind: 'human', author: 'human:owner', body: 'status?', wakeReason: 'human' });

    const dispatched: string[] = [];
    const d: Dispatcher = {
      precondition: (a) => hasWork(db, a),
      dispatch: async (a) => {
        dispatched.push(a.slug);
        return 'WORK_DONE';
      },
    };
    const r = await tick(db, d, { maxInFlight: 2, reserved: [ORCHESTRATOR_SLUG] });
    assert.deepEqual(dispatched, [ORCHESTRATOR_SLUG], 'the judge does not wait behind the workers');
    assert.equal(r.dispatched, 1);

    deliverAndWake(db, { to: orch, kind: 'human', author: 'human:owner', body: 'again?', wakeReason: 'human' });
    const r2 = await tick(db, d, { maxInFlight: 2 });
    assert.equal(r2.dispatched, 0, 'without a reserved slot it waits like everyone else');

    // And its own turn takes no worker's slot: with one worker slot free and
    // the orchestrator mid-turn, the worker still runs.
    for (const s of ['w1', 'w2']) {
      const live = db.prepare(`SELECT id FROM runs WHERE agent_id = ? AND ended_at IS NULL`).get(getAgentBySlug(db, s)!.id) as { id: string };
      succeed(db, live.id, 'WORK_DONE');
    }
    db.prepare(`UPDATE agents SET next_due_at = ? WHERE slug = 'w1'`).run(Date.now() - 1);
    openRun(db, getAgentBySlug(db, ORCHESTRATOR_SLUG)!); // the judge is mid-turn
    dispatched.length = 0;
    const r3 = await tick(db, d, { maxInFlight: 1, reserved: [ORCHESTRATOR_SLUG] });
    assert.deepEqual(dispatched, ['w1'], 'the orchestrator is outside the ordinary accounting');
    assert.equal(r3.dispatched, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
