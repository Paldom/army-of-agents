import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { open } from '../src/store/db.ts';
import { createAgent, getAgentBySlug } from '../src/supervisor/repo.ts';
import { tick } from '../src/supervisor/tick.ts';
import { DEFAULT_CONTINUOUS } from '../src/supervisor/wake.ts';

/**
 * Liveness of the SCHEDULER, as distinct from liveness of a turn.
 *
 * Both of these were found by asking the live database a question the tests
 * never asked: which agents have never run at all? Five of twenty-two, for a
 * day, with no alarm — because "never started" looks exactly like "idle".
 */

function seeded(wake: unknown, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aoa-sched-'));
  const d = open(join(dir, 'test.db'));
  const agent = createAgent(d, {
    slug: 'scout', displayName: 'Scout', wake: wake as never, createdBy: 'human:owner',
  });
  const sets = Object.entries(extra);
  if (sets.length) {
    d.prepare(`UPDATE agents SET ${sets.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...sets.map(([, v]) => v), agent.id);
  }
  return { d, agent, dir };
}

test('a continuous agent is dispatched — being due is its only possible signal', async () => {
  const { d, dir } = seeded(DEFAULT_CONTINUOUS, { next_due_at: Date.now() - 1000 });
  try {
    const r = await tick(d, {
      // The real precondition's rule, isolated: due is enough for continuous.
      precondition: (a) => ['schedule', 'manual', 'continuous'].includes(JSON.parse(a.wake).kind),
      dispatch: async () => 'NO_WORK',
    });
    assert.equal(r.dispatched, 1, 'a continuous agent with no inbound signal must still start');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a precondition-false tick always advances the wake, even after a human bump', async () => {
  const nowMs = Date.now();
  const { d, dir } = seeded(DEFAULT_CONTINUOUS, { next_due_at: nowMs - 1000, wake_reason: 'human' });
  try {
    const r = await tick(d, { precondition: () => false, dispatch: async () => 'NO_WORK' }, { nowMs });
    assert.equal(r.skippedPrecondition, 1);

    const after = getAgentBySlug(d, 'scout')!;
    // Without this the agent stays overdue forever: reconsidered every tick,
    // never dispatched, and invisible to the lost-wake alarm because
    // next_due_at is not NULL.
    assert.ok(after.next_due_at! > nowMs, 'the wake must move forward or the agent stalls permanently');
    assert.equal(after.idle_streak, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dispatches run concurrently, not one agent at a time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aoa-conc-'));
  const d = open(join(dir, 'test.db'));
  try {
    for (const slug of ['a', 'b', 'c']) {
      const ag = createAgent(d, { slug, displayName: slug, wake: DEFAULT_CONTINUOUS, createdBy: 'human:owner' });
      d.prepare('UPDATE agents SET next_due_at = ? WHERE id = ?').run(Date.now() - 1000, ag.id);
    }
    let inFlight = 0;
    let peak = 0;
    const r = await tick(d, {
      precondition: () => true,
      dispatch: async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((res) => setTimeout(res, 40));
        inFlight--;
        return 'WORK_DONE';
      },
    }, { maxDispatch: 3 });

    assert.equal(r.dispatched, 3);
    // Serial dispatch was the fleet's real throughput ceiling: one slow agent
    // held the only slot while everyone else waited for the next tick.
    assert.equal(peak, 3, 'maxDispatch is a concurrency cap, not a queue depth');
  } finally {
    d.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('in-flight turns are capped across ticks, not just per tick', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aoa-cap-'));
  const d = open(join(dir, 'test.db'));
  try {
    for (const slug of ['a', 'b', 'c', 'd', 'e']) {
      const ag = createAgent(d, { slug, displayName: slug, wake: DEFAULT_CONTINUOUS, createdBy: 'human:owner' });
      d.prepare('UPDATE agents SET next_due_at = ? WHERE id = ?').run(Date.now() - 1000, ag.id);
    }
    // Turns that never finish, exactly like real ones spanning many ticks.
    const forever = { precondition: () => true, dispatch: () => new Promise<never>(() => {}) };
    void tick(d, forever as never, { maxDispatch: 4, maxInFlight: 2 });
    await new Promise((r) => setTimeout(r, 60));

    const live = (d.prepare("SELECT COUNT(*) n FROM runs WHERE state NOT IN ('continue','completed','failed')")
      .get() as { n: number }).n;
    // Without a global cap, seconds-apart ticks starting turns that run for
    // tens of minutes accumulate until every agent is on a vendor at once.
    assert.equal(live, 2, 'the quota cap is total in-flight, not starts per tick');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
