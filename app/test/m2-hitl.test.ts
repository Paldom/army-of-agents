/**
 * M2 proof: ask → restart → answer → the agent resumes carrying the verdict.
 *
 * Plus the three refusals that make a verdict mean something: gated asks are
 * not answerable here, stale bindings are re-asked, and expiry never approves.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { open } from '../src/store/db.ts';
import { createAgent, getAgentBySlug, openRun, succeed } from '../src/supervisor/repo.ts';
import { actionHash, answer, ask, expireAsks, openAsks, verdictsFor } from '../src/supervisor/hitl.ts';
import { deliver, leaseFor, ackAfterCommit, pending } from '../src/supervisor/messages.ts';

const WAKE = { kind: 'continuous' as const, minIntervalMs: 60_000, backoff: { baseMs: 60_000, maxMs: 3_600_000, factor: 2 } };

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aoa-m2-'));
  return { db: open(join(dir, 's.db')), path: join(dir, 's.db'), dir };
}

test('M2 PROOF: ask → restart → answer → resume with the verdict', () => {
  const { db, path, dir } = freshDb();
  try {
    const a = createAgent(db, { slug: 'scout', displayName: 'Scout', wake: WAKE, createdBy: 'human:owner' });
    const run = openRun(db, a)!;

    // The agent asks and releases its session. Nothing is parked.
    const q = ask(db, {
      agentId: a.id,
      runId: run.id,
      prompt: 'Two sources disagree on the fee schedule. Which do I trust?',
      options: [
        { id: 'official', label: 'Vendor official docs' },
        { id: 'live', label: 'Live adapter metadata' },
      ],
    });
    succeed(db, run.id, 'BLOCKED', { toState: 'waiting_human' });

    const blocked = getAgentBySlug(db, 'scout')!;
    assert.equal(blocked.next_due_at, null, 'a blocked agent holds no seat and costs nothing');
    db.close();

    // ── reboot ──────────────────────────────────────────────────────────────
    const db2 = open(path);
    const stillOpen = openAsks(db2);
    assert.equal(stillOpen.length, 1, 'the question survived the restart');
    assert.equal(stillOpen[0]!.id, q.id);

    // The human answers hours later.
    const res = answer(db2, q.id, { by: 'human:owner', optionId: 'official' });
    assert.equal(res.ok, true);

    // The wake bump happened in the SAME transaction as the verdict.
    const woken = getAgentBySlug(db2, 'scout')!;
    assert.ok(woken.next_due_at !== null, 'answering wakes the agent — no second path to forget');
    assert.equal(woken.wake_reason, 'human');

    // And the next dispatch carries the verdict.
    const carried = verdictsFor(db2, a.id);
    assert.equal(carried.length, 1);
    assert.equal(carried[0]!.answer, 'official');
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M2: a gated ask is refused in the workspace, with the reason stated', () => {
  const { db, dir } = freshDb();
  try {
    const a = createAgent(db, { slug: 'fleet', displayName: 'Fleet', wake: WAKE, createdBy: 'h' });
    const q = ask(db, {
      agentId: a.id,
      prompt: 'Requests: execute_order BTC/USD 0.02',
      gated: true,
      action: { operation: 'execute_order', params: { pair: 'BTC/USD', qty: 0.02 } },
    });
    const res = answer(db, q.id, { by: 'human:owner', text: 'yes' });
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.reason, 'gated');
    assert.match(res.ok === false ? res.detail : '', /none minted/);
    assert.equal(openAsks(db).length, 1, 'a refused answer leaves the ask open');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M2: a verdict binds the exact operation — a replan is re-asked, not honoured', () => {
  const { db, dir } = freshDb();
  try {
    const a = createAgent(db, { slug: 'a', displayName: 'A', wake: WAKE, createdBy: 'h' });
    const action = { operation: 'write_file', params: { path: 'a.txt', bytes: 10 } };
    const q = ask(db, { agentId: a.id, prompt: 'Write a.txt?', action, policyVersion: 'v3' });

    // The agent replanned: same intent, different parameters.
    const drifted = actionHash({ operation: 'write_file', params: { path: 'b.txt', bytes: 10 } });
    const stale = answer(db, q.id, { by: 'human:owner', text: 'ok', currentActionHash: drifted });
    assert.equal(stale.ok, false);
    assert.equal(stale.ok === false && stale.reason, 'stale');

    // Policy moved underneath it.
    const policyDrift = answer(db, q.id, {
      by: 'human:owner', text: 'ok',
      currentActionHash: actionHash(action), currentPolicyVersion: 'v4',
    });
    assert.equal(policyDrift.ok, false, 'a policy change also invalidates the binding');

    // The unchanged binding is honoured.
    const good = answer(db, q.id, {
      by: 'human:owner', text: 'ok',
      currentActionHash: actionHash(action), currentPolicyVersion: 'v3',
    });
    assert.equal(good.ok, true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M2: the action hash is stable under key order but not under value change', () => {
  const h1 = actionHash({ operation: 'x', params: { b: 1, a: { d: 2, c: 3 } } });
  const h2 = actionHash({ operation: 'x', params: { a: { c: 3, d: 2 }, b: 1 } });
  assert.equal(h1, h2, 'key order is not a semantic difference');
  const h3 = actionHash({ operation: 'x', params: { b: 2, a: { d: 2, c: 3 } } });
  assert.notEqual(h1, h3, 'a changed value is a different action');
});

test('M2: an option that was never offered is not an answer', () => {
  const { db, dir } = freshDb();
  try {
    const a = createAgent(db, { slug: 'a', displayName: 'A', wake: WAKE, createdBy: 'h' });
    const q = ask(db, {
      agentId: a.id, prompt: 'pick', options: [{ id: 'one', label: 'One' }],
    });
    const res = answer(db, q.id, { by: 'human:owner', optionId: 'three' });
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.reason, 'unknown_option');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M2: expiry pauses and reports — it never auto-approves', () => {
  const { db, dir } = freshDb();
  try {
    const a = createAgent(db, { slug: 'a', displayName: 'A', wake: WAKE, createdBy: 'h' });
    const q = ask(db, {
      agentId: a.id, prompt: 'decide', expiresAt: Date.now() - 1,
    });
    const expired = expireAsks(db);
    assert.deepEqual(expired, [q.id]);

    const row = db.prepare('SELECT state FROM approval_requests WHERE id = ?').get(q.id) as { state: string };
    assert.equal(row.state, 'EXPIRED', 'never APPROVED');
    assert.equal(getAgentBySlug(db, 'a')!.status, 'PAUSED', 'the agent stops rather than proceeding');

    const report = db
      .prepare(`SELECT body FROM messages WHERE agent_id = ? AND kind = 'report'`)
      .get(a.id) as { body: string };
    assert.match(report.body, /nothing was approved/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M2: delivery acks AFTER commit, so a crash redelivers rather than loses', () => {
  const { db, dir } = freshDb();
  try {
    const a = createAgent(db, { slug: 'a', displayName: 'A', wake: WAKE, createdBy: 'h' });
    const b = createAgent(db, { slug: 'b', displayName: 'B', wake: WAKE, createdBy: 'h' });

    const m = deliver(db, {
      agentId: b.id, kind: 'agent_to_agent', author: `agent:${a.slug}`,
      body: 'the fee is 0.26%', recipients: [`agent:${b.slug}`],
    });
    assert.equal(pending(db, `agent:${b.slug}`).length, 1);

    // Lease it, then simulate the crash: no ack was written.
    const leased = leaseFor(db, `agent:${b.slug}`, 'run-1', 30_000);
    assert.equal(leased.length, 1);
    assert.equal(leased[0]!.id, m.id);

    // After the lease expires the message is available again — at-least-once.
    const redelivered = leaseFor(db, `agent:${b.slug}`, 'run-2', 30_000, Date.now() + 60_000);
    assert.equal(redelivered.length, 1, 'a crash mid-processing redelivers');

    // Only an explicit ack, written after the receiver committed, retires it.
    ackAfterCommit(db, m.id, `agent:${b.slug}`);
    assert.equal(pending(db, `agent:${b.slug}`).length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M2: per-agent seq is gapless under repeated writes', () => {
  const { db, dir } = freshDb();
  try {
    const a = createAgent(db, { slug: 'a', displayName: 'A', wake: WAKE, createdBy: 'h' });
    const seqs: number[] = [];
    for (let i = 0; i < 25; i++) {
      seqs.push(
        deliver(db, { agentId: a.id, kind: 'agent', author: 'agent:a', body: `m${i}`, recipients: [] }).seq,
      );
    }
    assert.deepEqual(seqs, Array.from({ length: 25 }, (_, i) => i + 1), 'the counter row never collides');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
