import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { open } from '../src/store/db.ts';
import { attachJobDir, createAgent, openRun, unfinishedRuns } from '../src/supervisor/repo.ts';
import { reconcile } from '../src/supervisor/reconcile.ts';
import { isAlive, readHeartbeat, readStarted } from '../src/acp/tmux-runner.ts';
import { DEFAULT_CONTINUOUS } from '../src/supervisor/wake.ts';

/**
 * A turn outlives the process that started it. Observed live: 25 of 81 runs
 * blew the deadline because an abandoned prompt kept acpx's per-session queue,
 * so the next turn blocked behind it with zero bytes and no error.
 */

function db() {
  const dir = mkdtempSync(join(tmpdir(), 'aoa-reconcile-'));
  const d = open(join(dir, 'test.db'));
  const agent = createAgent(d, {
    slug: 'scout', displayName: 'Scout', wake: DEFAULT_CONTINUOUS, createdBy: 'human:owner',
  });
  return { d, agent, dir };
}

function jobDir(hb: { phase: string; bytes: number; ts: number } | null): string {
  const job = mkdtempSync(join(tmpdir(), 'aoa-job-'));
  // A pgid that is certainly not a live process group of ours.
  writeFileSync(join(job, 'started.json'),
    JSON.stringify({ wrapperPid: 2 ** 30, acpxPid: 2 ** 30, pgid: 2 ** 30, startedAt: Date.now() }));
  if (hb) writeFileSync(join(job, 'heartbeat'), JSON.stringify({ ...hb, pid: 2 ** 30 }));
  return job;
}

test('a run whose executor is still beating is ADOPTED, not killed', () => {
  const { d, agent, dir } = db();
  try {
    const run = openRun(d, agent)!;
    const job = jobDir({ phase: 'streaming', bytes: 4096, ts: Date.now() });
    attachJobDir(d, run.id, job);

    const r = reconcile(d);
    assert.deepEqual(r.adopted, [run.id], 'live work must survive a supervisor restart');
    assert.equal(r.killed.length, 0);
    // Still open, so the one-live-run index keeps the scheduler off it.
    assert.equal(unfinishedRuns(d).length, 1, 'an adopted run stays open');
    rmSync(job, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run whose executor stopped beating is KILLED and settled', () => {
  const { d, agent, dir } = db();
  try {
    const run = openRun(d, agent)!;
    const job = jobDir({ phase: 'submitted', bytes: 0, ts: Date.now() - 60_000 });
    attachJobDir(d, run.id, job);

    const r = reconcile(d);
    assert.deepEqual(r.killed, [run.id], 'a stale orphan is what silences the next turn');
    assert.equal(unfinishedRuns(d).length, 0, 'the agent must be dispatchable again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run with no executor at all is settled rather than left open forever', () => {
  const { d, agent, dir } = db();
  try {
    const run = openRun(d, agent)!;
    const r = reconcile(d);
    assert.deepEqual(r.settled, [run.id]);
    assert.equal(unfinishedRuns(d).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run that finished unwatched is FINALISED from its capture, asks included', () => {
  const { d, agent, dir } = db();
  try {
    const run = openRun(d, agent)!;
    const job = jobDir(null);
    // The wrapper completed: sentinel plus the capture it left behind.
    const chunk = (text: string) => JSON.stringify({
      jsonrpc: '2.0', method: 'session/update',
      params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
    });
    writeFileSync(join(job, 'stdout.ndjson'),
      [chunk('ASK: Which region first?\n'), chunk('OPTIONS: eu | us\n'), chunk('OUTCOME: BLOCKED')].join('\n'));
    writeFileSync(join(job, 'exit'), '0');
    attachJobDir(d, run.id, job);

    const r = reconcile(d);
    assert.deepEqual(r.finalised, [run.id]);
    assert.equal(unfinishedRuns(d).length, 0, 'the agent must not stay wedged');

    // The whole point: an interrupted turn's question still reaches the owner.
    const asks = d.prepare('SELECT prompt, options FROM approval_requests').all() as
      Array<{ prompt: string; options: string }>;
    assert.equal(asks.length, 1, 'a question filed by an unwatched run is not dropped');
    assert.match(asks[0]!.prompt, /Which region first\?/);
    assert.deepEqual(JSON.parse(asks[0]!.options).map((o: { label: string }) => o.label), ['eu', 'us']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('liveness is the heartbeat, never the capture file', () => {
  const nowMs = 1_000_000;
  // The state that used to be invisible: submitted, zero bytes, alive. An
  // output-based check calls this dead and kills real work.
  assert.equal(isAlive({ phase: 'submitted', bytes: 0, ts: nowMs - 1000, pid: 1 }, nowMs), true);
  assert.equal(isAlive({ phase: 'streaming', bytes: 99, ts: nowMs - 60_000, pid: 1 }, nowMs), false);
  assert.equal(isAlive(null, nowMs), false, 'no heartbeat is not alive');
});

test('a corrupt or half-written heartbeat reads as absent, not as alive', () => {
  const job = mkdtempSync(join(tmpdir(), 'aoa-job-'));
  try {
    writeFileSync(join(job, 'heartbeat'), '{"phase":"stream');
    assert.equal(readHeartbeat(job), null);
    assert.equal(readStarted(job), null);
  } finally {
    rmSync(job, { recursive: true, force: true });
  }
});

