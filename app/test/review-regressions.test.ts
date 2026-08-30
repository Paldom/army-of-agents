/**
 * Regressions from the adversarial cross-check (see
 * .claude/curator-reports/skill-split-and-invariants.md).
 *
 * Two independent reviewers found the same class of defect: guards that were
 * optional for the caller, and a wake that could be silently overwritten. All
 * four reproduced before the fix.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { open } from '../src/store/db.ts';
import { createAgent, getAgentBySlug, openRun, succeed } from '../src/supervisor/repo.ts';
import { actionHash, answer, ask, getAsk } from '../src/supervisor/hitl.ts';
import { type Dispatcher, tick } from '../src/supervisor/tick.ts';

const WAKE = { kind: 'continuous' as const, minIntervalMs: 60_000, backoff: { baseMs: 60_000, maxMs: 3_600_000, factor: 2 } };
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'aoa-reg-'));
  return { db: open(join(dir, 's.db')), dir };
}

test('REGRESSION: a bound ask cannot be approved by omitting the binding', () => {
  const { db, dir } = freshDb();
  try {
    const a = createAgent(db, { slug: 'a', displayName: 'A', wake: WAKE, createdBy: 'h' });
    const action = { operation: 'write', params: { path: 'x' } };
    const q = ask(db, { agentId: a.id, prompt: 'do it?', action, policyVersion: 'v1' });

    // Previously this approved: the comparison was skipped when the caller
    // supplied nothing, so a security check was optional for its caller.
    const omitted = answer(db, q.id, { by: 'human:owner', text: 'yes' });
    assert.equal(omitted.ok, false);
    assert.equal(omitted.ok === false && omitted.reason, 'unbindable');
    assert.equal(getAsk(db, q.id)!.state, 'PENDING', 'and it stays open');

    // Supplying the action but not the policy is still not enough.
    const halfway = answer(db, q.id, {
      by: 'human:owner', text: 'yes', currentActionHash: actionHash(action),
    });
    assert.equal(halfway.ok === false && halfway.reason, 'unbindable');

    const full = answer(db, q.id, {
      by: 'human:owner', text: 'yes',
      currentActionHash: actionHash(action), currentPolicyVersion: 'v1',
    });
    assert.equal(full.ok, true, 'a fully bound answer is honoured');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REGRESSION: a blank submit does not approve', () => {
  const { db, dir } = freshDb();
  try {
    const a = createAgent(db, { slug: 'a', displayName: 'A', wake: WAKE, createdBy: 'h' });
    const q = ask(db, { agentId: a.id, prompt: 'pick', options: [{ id: 'one', label: 'One' }] });

    // Previously stored '' and set the row APPROVED.
    const blank = answer(db, q.id, { by: 'human:owner' });
    assert.equal(blank.ok, false);
    assert.equal(blank.ok === false && blank.reason, 'empty');
    assert.equal(getAsk(db, q.id)!.state, 'PENDING');

    // A free-text ask with whitespace only is equally not an answer.
    const t = ask(db, { agentId: a.id, prompt: 'say something' });
    assert.equal(answer(db, t.id, { by: 'human:owner', text: '   ' }).ok, false);
    assert.equal(answer(db, t.id, { by: 'human:owner', text: 'a real answer' }).ok, true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REGRESSION: a fast verdict is not erased when the run settles afterwards', () => {
  const { db, dir } = freshDb();
  try {
    const a = createAgent(db, { slug: 'a', displayName: 'A', wake: WAKE, createdBy: 'h' });
    const run = openRun(db, a)!;
    const q = ask(db, { agentId: a.id, runId: run.id, prompt: 'pick', options: [{ id: 'one', label: 'One' }] });

    // The human answers while dispatch is still in flight.
    assert.equal(answer(db, q.id, { by: 'human:owner', optionId: 'one' }).ok, true);
    const bumped = getAgentBySlug(db, 'a')!.next_due_at;
    assert.ok(bumped !== null, 'the verdict woke the agent');

    // Dispatch then returns BLOCKED and settles the run. Previously this
    // blind-wrote next_due_at = NULL and the agent slept forever.
    succeed(db, run.id, 'BLOCKED');
    const after = getAgentBySlug(db, 'a')!;
    assert.ok(after.next_due_at !== null, 'a human bump outranks a scheduler-computed wake');
    assert.equal(after.wake_reason, 'human');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REGRESSION: a precondition-false tick leaves no run in the agent history', async () => {
  const { db, dir } = freshDb();
  try {
    const a = createAgent(db, { slug: 'a', displayName: 'A', wake: WAKE, createdBy: 'h' });
    const idle: Dispatcher = { precondition: () => false, dispatch: async () => 'WORK_DONE' };

    let clock = Date.now();
    for (let i = 0; i < 4; i++) {
      await tick(db, idle, { nowMs: clock, jitter: 0 });
      clock = getAgentBySlug(db, 'a')!.next_due_at!;
    }

    const runs = db.prepare('SELECT COUNT(*) AS n FROM runs WHERE agent_id = ?').get(a.id) as { n: number };
    assert.equal(runs.n, 0, 'no phantom iterations — the agent never woke in any meaningful sense');
    assert.equal(getAgentBySlug(db, 'a')!.idle_streak, 4, 'but the backoff still advanced');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
