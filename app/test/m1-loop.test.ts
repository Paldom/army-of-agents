/**
 * M1 proof: an agent wakes, finds nothing to do, backs off exponentially, and
 * is still alive and cheap after a reboot.
 *
 * Plus the invariants that make the loop survivable: one live run per agent,
 * atomic succession, a durable vendor gate, and the lost-wake alarm.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { open } from '../src/store/db.ts';
import { createAgent, getAgentBySlug, liveRun, lostWakeScan, openRun, succeed } from '../src/supervisor/repo.ts';
import { type Dispatcher, gateVendor, tick } from '../src/supervisor/tick.ts';
import { computeNextWake } from '../src/supervisor/wake.ts';
import { derive } from '../src/supervisor/derived.ts';
import { ensureAccount, remaining } from '../src/supervisor/budget.ts';

const CONTINUOUS = {
  kind: 'continuous' as const,
  minIntervalMs: 60_000,
  backoff: { baseMs: 60_000, maxMs: 3_600_000, factor: 2 },
};

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aoa-'));
  const path = join(dir, 'store.db');
  return { db: open(path), path, dir };
}

const idleDispatcher: Dispatcher = {
  precondition: () => false, // nothing to do, ever — and it costs no vendor turn
  dispatch: async () => 'WORK_DONE',
};

test('M1: idle agent backs off exponentially and never spends a vendor turn', async () => {
  const { db, dir } = freshDb();
  try {
    createAgent(db, {
      slug: 'scout',
      displayName: 'Scout',
      wake: CONTINUOUS,
      createdBy: 'human:owner',
    });

    let dispatches = 0;
    const counting: Dispatcher = {
      precondition: () => false,
      dispatch: async () => {
        dispatches++;
        return 'WORK_DONE';
      },
    };

    // Six ticks, each at the moment the agent becomes due.
    const delays: number[] = [];
    let clock = Date.now();
    for (let i = 0; i < 6; i++) {
      const r = await tick(db, counting, { nowMs: clock, jitter: 0 });
      assert.equal(r.skippedPrecondition, 1, `tick ${i} should skip on precondition`);
      const a = getAgentBySlug(db, 'scout')!;
      assert.ok(a.next_due_at !== null, 'an idle agent still has a next wake');
      delays.push(a.next_due_at - clock);
      clock = a.next_due_at;
    }

    // The precondition is LLM-free, so no dispatch ever happened.
    assert.equal(dispatches, 0, 'idle agent must not cost a vendor turn');

    // Exponential, and monotonically increasing until the cap.
    assert.deepEqual(delays.slice(0, 5), [60_000, 120_000, 240_000, 480_000, 960_000]);
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i]! >= delays[i - 1]!, 'backoff must not decrease');
    }

    const a = getAgentBySlug(db, 'scout')!;
    assert.equal(a.idle_streak, 6);
    assert.equal(a.last_outcome, 'NO_WORK');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M1: backoff caps and survives a reboot', async () => {
  const { db, path, dir } = freshDb();
  try {
    createAgent(db, { slug: 'scout', displayName: 'Scout', wake: CONTINUOUS, createdBy: 'human:owner' });
    let clock = Date.now();
    for (let i = 0; i < 12; i++) {
      await tick(db, idleDispatcher, { nowMs: clock, jitter: 0 });
      clock = getAgentBySlug(db, 'scout')!.next_due_at!;
    }
    const before = getAgentBySlug(db, 'scout')!;
    assert.ok(before.idle_streak >= 12);
    db.close();

    // Reboot: reopen the same file. State is rows, so nothing was in memory.
    const db2 = open(path);
    const after = getAgentBySlug(db2, 'scout')!;
    assert.equal(after.idle_streak, before.idle_streak, 'streak survives restart');
    assert.equal(after.next_due_at, before.next_due_at, 'next wake survives restart');

    // And the cap holds: never more than maxMs plus jitter headroom.
    const r = await tick(db2, idleDispatcher, { nowMs: after.next_due_at!, jitter: 0 });
    assert.equal(r.skippedPrecondition, 1);
    const capped = getAgentBySlug(db2, 'scout')!;
    assert.ok(
      capped.next_due_at! - after.next_due_at! <= 3_600_000 * 1.1,
      'backoff is capped at maxMs',
    );
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M1: one live run per agent is structural, not advisory', () => {
  const { db, dir } = freshDb();
  try {
    const a = createAgent(db, { slug: 'a', displayName: 'A', wake: CONTINUOUS, createdBy: 'h' });
    const first = openRun(db, a);
    assert.ok(first, 'first run opens');
    const second = openRun(db, a);
    assert.equal(second, undefined, 'a second live run is refused by the index');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M1: succession is atomic — settling a run always writes the successor wake', () => {
  const { db, dir } = freshDb();
  try {
    const a = createAgent(db, { slug: 'a', displayName: 'A', wake: CONTINUOUS, createdBy: 'h' });
    const run = openRun(db, a)!;
    const t = Date.now();
    const next = succeed(db, run.id, 'WORK_DONE', { nowMs: t, jitter: 0 });
    assert.equal(next.nextDueAt, t + 60_000);

    const after = getAgentBySlug(db, 'a')!;
    assert.equal(after.next_due_at, t + 60_000, 'the agent row was bumped in the same txn');
    assert.equal(after.last_outcome, 'WORK_DONE');
    assert.equal(liveRun(db, a.id), undefined, 'the run is terminal');

    // Replaying the same settle must be a no-op, not a second iteration.
    const replay = succeed(db, run.id, 'WORK_DONE', { nowMs: t + 999, jitter: 0 });
    assert.equal(replay.nextDueAt, t + 60_000, 'replay does not re-advance the wake');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M1: BLOCKED parks with no wake at all, and only an insert moves it', () => {
  const { db, dir } = freshDb();
  try {
    const a = createAgent(db, { slug: 'a', displayName: 'A', wake: CONTINUOUS, createdBy: 'h' });
    const run = openRun(db, a)!;
    const r = succeed(db, run.id, 'BLOCKED', { nowMs: Date.now() });
    assert.equal(r.nextDueAt, null, 'a blocked agent has no next wake — it costs nothing');

    const after = getAgentBySlug(db, 'a')!;
    const d = derive({
      status: after.status,
      wakeKind: 'continuous',
      nextDueAt: after.next_due_at,
      wakeReason: after.wake_reason,
      idleStreak: after.idle_streak,
      liveRunState: 'waiting_human',
      laneBlockedUntil: null,
      nowMs: Date.now(),
    });
    assert.equal(d.status, 'WAITING_HUMAN');
    assert.match(d.why, /released its session/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M1: a gated vendor lane holds every agent on it, durably', async () => {
  const { db, path, dir } = freshDb();
  try {
    createAgent(db, {
      slug: 'a', displayName: 'A', wake: CONTINUOUS, createdBy: 'h', harness: 'claude',
    });
    createAgent(db, {
      slug: 'b', displayName: 'B', wake: CONTINUOUS, createdBy: 'h', harness: 'claude',
    });
    const until = Date.now() + 3_600_000;
    gateVendor(db, 'claude', until, '402 balance exhausted');

    const r = await tick(db, { precondition: () => true, dispatch: async () => 'WORK_DONE' });
    assert.equal(r.skippedResource, 2, 'both agents on the lane wait together');
    assert.equal(r.dispatched, 0);
    db.close();

    // The gate must survive a restart, or after a crash every agent on an
    // exhausted vendor is immediately due — the exact spin this prevents.
    const db2 = open(path);
    const r2 = await tick(db2, { precondition: () => true, dispatch: async () => 'WORK_DONE' });
    assert.equal(r2.skippedResource, 2, 'the gate is durable across restart');
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M1: budget exhaustion pauses rather than spinning', async () => {
  const { db, dir } = freshDb();
  try {
    const a = createAgent(db, { slug: 'a', displayName: 'A', wake: CONTINUOUS, createdBy: 'h' });
    ensureAccount(db, a.id, 2);
    const busy: Dispatcher = { precondition: () => true, dispatch: async () => 'WORK_DONE' };

    let clock = Date.now();
    for (let i = 0; i < 4; i++) {
      await tick(db, busy, { nowMs: clock });
      const cur = getAgentBySlug(db, 'a')!;
      if (cur.status === 'PAUSED') break;
      clock = cur.next_due_at ?? clock + 60_000;
    }
    const after = getAgentBySlug(db, 'a')!;
    assert.equal(after.status, 'PAUSED', 'a poison mission is stopped by the ledger');
    assert.ok(remaining(db, a.id)! <= 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M1: the lost-wake scan surfaces a silently stalled agent', () => {
  const { db, dir } = freshDb();
  try {
    const a = createAgent(db, { slug: 'a', displayName: 'A', wake: CONTINUOUS, createdBy: 'h' });
    assert.equal(lostWakeScan(db).length, 0, 'a healthy agent does not alarm');

    // Simulate the failure the alarm exists for: terminal run, no next wake,
    // and a wake_reason that is not a deliberate park.
    db.prepare(
      `UPDATE agents SET next_due_at = NULL, wake_reason = 'schedule' WHERE id = ?`,
    ).run(a.id);
    const lost = lostWakeScan(db);
    assert.equal(lost.length, 1, 'a lost bump becomes visible, not silent');
    assert.equal(lost[0]!.slug, 'a');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('M1: missed ticks coalesce — fourteen hours down fires once', async () => {
  const { db, dir } = freshDb();
  try {
    createAgent(db, { slug: 'a', displayName: 'A', wake: CONTINUOUS, createdBy: 'h' });
    let dispatches = 0;
    const d: Dispatcher = {
      precondition: () => true,
      dispatch: async () => {
        dispatches++;
        return 'WORK_DONE';
      },
    };
    // The box was off for 14 hours; the agent was due ~840 times at a 1m floor.
    await tick(db, d, { nowMs: Date.now() + 14 * 3_600_000 });
    assert.equal(dispatches, 1, 'a backlog of missed occurrences fires once');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wake policy: RATE_LIMITED parks the agent for the lane, not per-agent retry', () => {
  const t = Date.now();
  const r = computeNextWake(CONTINUOUS, 'RATE_LIMITED', { idleStreak: 3, errorStreak: 0 }, t);
  assert.equal(r.nextDueAt, null);
  assert.equal(r.wakeReason, 'event');
  assert.equal(r.idleStreak, 3, 'a vendor limit is not the agent being idle');
});

test('wake policy: RETRYABLE_ERROR is bounded by error_streak, which survives runs', () => {
  const t = Date.now();
  const a = computeNextWake(CONTINUOUS, 'RETRYABLE_ERROR', { idleStreak: 0, errorStreak: 0 }, t);
  const b = computeNextWake(CONTINUOUS, 'RETRYABLE_ERROR', { idleStreak: 0, errorStreak: 4 }, t);
  assert.ok(b.nextDueAt! - t > a.nextDueAt! - t, 'repeated errors back off further');
  assert.ok(b.nextDueAt! - t <= 900_000, 'error backoff is capped');
});
