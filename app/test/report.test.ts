/**
 * Continuous reporting: what an agent says is filed while it says it, once.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { open } from '../src/store/db.ts';
import { createAgent, getAgentBySlug, openRun } from '../src/supervisor/repo.ts';
import { deliver, leaseFor, pending, thread } from '../src/supervisor/messages.ts';
import { PROTOCOL, parseMarkers, parseOutcome, stripMarkers } from '../src/supervisor/protocol.ts';
import { reconcile } from '../src/supervisor/reconcile.ts';
import { attachJobDir } from '../src/supervisor/repo.ts';
import { mkdtempSync as mkjob, writeFileSync } from 'node:fs';
import { fileTurnReport, ingestMarkers } from '../src/supervisor/report.ts';
import { hasWork } from '../src/supervisor/precondition.ts';
import { ORCHESTRATOR_CONTRACT, ensureOrchestrator } from '../src/orchestrator/bootstrap.ts';
import { listPlans, proposePlan } from '../src/orchestrator/plan.ts';

const WAKE = { kind: 'continuous' as const, minIntervalMs: 60_000, backoff: { baseMs: 60_000, maxMs: 3_600_000, factor: 2 } };

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'aoa-report-'));
  return { db: open(join(dir, 's.db')), dir };
}

test('markers: fenced blocks, the protocol\'s own examples and placeholders are not markers', () => {
  const text = [
    'REPORT: real progress',
    '```',
    'NOTIFY: quoted from a file the agent read',
    '```',
    '~~~',
    'SEND: @scout quoted from a log',
    '~~~',
    '    REPORT: Closed 2 duplicate issues; starting on #112.',
    '    PROPOSE: pause example-agent',
    'ASK: <your question here>',
    'OUTCOME: WORK_DONE',
  ].join('\n');
  assert.deepEqual(
    parseMarkers(text).map((m) => `${m.marker}:${m.text}`),
    ['REPORT:real progress', 'OUTCOME:WORK_DONE'],
  );
  assert.equal(parseMarkers(PROTOCOL).length, 0, 'the protocol echoed back yields nothing');
  assert.equal(parseMarkers(ORCHESTRATOR_CONTRACT).length, 0, 'the orchestrator contract echoed back files no plan');
  assert.equal(stripMarkers('a\nREPORT: x\n\n\n\nb\nOUTCOME: NO_WORK\n'), 'a\n\nb');
  assert.equal(stripMarkers('```\nREPORT: kept, it is quoted\n```'), '```\nREPORT: kept, it is quoted\n```');
  assert.equal(parseOutcome('```\nOUTCOME: BLOCKED\n```\nOUTCOME: WORK_DONE'), 'WORK_DONE', 'a fenced outcome is quoted');
  assert.equal(parseOutcome('OUTCOME: WORK_DONE\n```\nOUTCOME: BLOCKED\n```'), 'WORK_DONE');
});

test('a turn that did not succeed informs but does not act', () => {
  const { db, dir } = fresh();
  try {
    const orch = ensureOrchestrator(db);
    createAgent(db, { slug: 'scout', displayName: 'Scout', wake: WAKE, createdBy: 'h' });
    const run = openRun(db, orch)!;
    const n = ingestMarkers(db, orch, run.id, 'REPORT: got this far\nSEND: @scout go\nPROPOSE: pause scout\n', { actions: false });
    assert.deepEqual(n, { reports: 1, notifies: 0, sends: 0, proposals: 0 });
    assert.equal(pending(db, 'agent:scout').length, 0);
    assert.equal(listPlans(db).length, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run adopted after a restart keeps reporting', () => {
  const { db, dir } = fresh();
  try {
    const a = createAgent(db, { slug: 'scout', displayName: 'Scout', wake: WAKE, createdBy: 'h' });
    const run = openRun(db, a)!;
    const job = mkjob(join(tmpdir(), 'aoa-job-'));
    attachJobDir(db, run.id, job);
    writeFileSync(join(job, 'heartbeat'), JSON.stringify({ phase: 'streaming', bytes: 10, ts: Date.now(), pid: 1 }));
    const frame = (text: string) =>
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })}\n`;
    writeFileSync(join(job, 'stdout.ndjson'), frame('REPORT: still going\n') + frame('REPORT: half a li'));

    const r = reconcile(db);
    assert.deepEqual(r.adopted, [run.id]);
    reconcile(db);
    const reports = thread(db, a.id).filter((m) => m.kind === 'report').map((m) => m.body);
    assert.deepEqual(reports, ['still going'], 'the complete line landed once; the partial one waits');
    rmSync(job, { recursive: true, force: true });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mid-turn only REPORT and NOTIFY land; SEND and PROPOSE wait for the end of the turn', () => {
  const { db, dir } = fresh();
  try {
    const orch = ensureOrchestrator(db);
    const scout = createAgent(db, { slug: 'scout', displayName: 'Scout', wake: { kind: 'on_message' }, createdBy: 'h' });
    db.prepare(`UPDATE agents SET next_due_at = NULL, wake_reason = 'event' WHERE id = ?`).run(scout.id);
    const run = openRun(db, orch)!;
    const text = 'REPORT: looking\nSEND: @scout go\nPROPOSE: pause scout\nPROPOSE: dance\nPROPOSE: dance\n';
    const mid = ingestMarkers(db, orch, run.id, text, { partial: true });
    assert.deepEqual(mid, { reports: 1, notifies: 0, sends: 0, proposals: 0 });
    assert.equal(pending(db, 'agent:scout').length, 0, 'nobody is woken by a turn that may still be rejected');
    assert.equal(listPlans(db).length, 0);
    const end = ingestMarkers(db, orch, run.id, text);
    assert.deepEqual(end, { reports: 0, notifies: 0, sends: 1, proposals: 1 });
    ingestMarkers(db, orch, run.id, text);
    const refusals = thread(db, orch.id).filter((m) => m.kind === 'event' && /not understood/.test(m.body));
    assert.equal(refusals.length, 1, 'an unparsed line is refused once, not once per read');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REPORT lines land while the turn runs, once each; the final flush files the rest, once', () => {
  const { db, dir } = fresh();
  try {
    const a = createAgent(db, { slug: 'scout', displayName: 'Scout', wake: WAKE, createdBy: 'h' });
    const run = openRun(db, a)!;

    // Streamed: the second line is still arriving.
    let n = ingestMarkers(db, a, run.id, 'REPORT: step one\nREPORT: step tw', { partial: true });
    assert.equal(n.reports, 1);
    n = ingestMarkers(db, a, run.id, 'REPORT: step one\nREPORT: step two\n', { partial: true });
    assert.equal(n.reports, 1, 'only the newly completed line');

    // Final: the whole text again, plus the prose.
    const full = 'REPORT: step one\nREPORT: step two\nI looked at the queue.\nOUTCOME: WORK_DONE\n';
    n = ingestMarkers(db, a, run.id, full);
    assert.equal(n.reports, 0, 'idempotent across the stream and the final pass');
    assert.equal(fileTurnReport(db, a, run.id, full), true);
    assert.equal(fileTurnReport(db, a, run.id, full), false, 'the turn report is filed once');

    const t = thread(db, a.id);
    assert.deepEqual(
      t.filter((m) => m.kind === 'report').map((m) => m.body),
      ['step one', 'step two', 'I looked at the queue.'],
    );
    assert.ok(t.every((m) => m.run_id === run.id), 'every message links to its run');
    assert.equal(fileTurnReport(db, a, run.id, 'OUTCOME: NO_WORK\n'), false, 'a turn of only markers leaves no empty report');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NOTIFY is a thread message and an event, never an ask', () => {
  const { db, dir } = fresh();
  try {
    const a = createAgent(db, { slug: 'scout', displayName: 'Scout', wake: WAKE, createdBy: 'h' });
    const run = openRun(db, a)!;
    const n = ingestMarkers(db, a, run.id, 'NOTIFY: the release branch has a failing test\n');
    assert.equal(n.notifies, 1);
    assert.equal(thread(db, a.id).filter((m) => m.kind === 'notify').length, 1);
    const ev = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'agent.notify'`).get() as { n: number };
    assert.equal(ev.n, 1);
    const asks = db.prepare(`SELECT COUNT(*) AS n FROM approval_requests`).get() as { n: number };
    assert.equal(asks.n, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SEND delivers to the named agent and wakes it; not to itself, not to nobody; a deep relay is killed', () => {
  const { db, dir } = fresh();
  try {
    const a = createAgent(db, { slug: 'a', displayName: 'A', wake: { kind: 'on_message' }, createdBy: 'h' });
    const b = createAgent(db, { slug: 'b', displayName: 'B', wake: { kind: 'on_message' }, createdBy: 'h' });
    db.prepare(`UPDATE agents SET next_due_at = NULL, wake_reason = 'event' WHERE id IN (?, ?)`).run(a.id, b.id);

    const runA = openRun(db, a)!;
    const n = ingestMarkers(db, a, runA.id, 'SEND: @b please review the auth section\nSEND: @nobody hi\nSEND: @a talking to myself\n');
    assert.equal(n.sends, 1);
    assert.equal(pending(db, 'agent:b').length, 1);
    const woken = getAgentBySlug(db, 'b')!;
    assert.ok(woken.next_due_at !== null && hasWork(db, woken), 'a named agent is woken and has work');
    assert.equal(pending(db, 'agent:a').length, 0, 'no self-delivery');
    assert.equal(ingestMarkers(db, a, runA.id, 'SEND: @b please review the auth section\n').sends, 0, 'idempotent');

    // b is holding a hop-4 message; its reply would be hop 5.
    deliver(db, { agentId: b.id, kind: 'agent_to_agent', author: 'agent:x', body: '@b deep', recipients: ['agent:b'], meta: { hops: 4 } });
    const runB = openRun(db, getAgentBySlug(db, 'b')!)!;
    leaseFor(db, 'agent:b', runB.id, 60_000);
    const m = ingestMarkers(db, getAgentBySlug(db, 'b')!, runB.id, 'SEND: @a and so on forever\n');
    assert.equal(m.sends, 0);
    assert.equal(pending(db, 'agent:a').length, 0, 'the chain is killed, not degraded');
    const killed = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'message.relay_killed'`).get() as { n: number };
    assert.equal(killed.n, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PROPOSE from the orchestrator files a plan that waits for Apply; from anyone else it is refused', () => {
  const { db, dir } = fresh();
  try {
    const orch = ensureOrchestrator(db);
    createAgent(db, { slug: 'scout', displayName: 'Scout', wake: WAKE, createdBy: 'h' });
    const run = openRun(db, orch)!;

    const n = ingestMarkers(db, orch, run.id, 'PROPOSE: pause scout\nPROPOSE: dance wildly\n');
    assert.equal(n.proposals, 1, 'a line outside the vocabulary files nothing');
    const plans = listPlans(db);
    assert.equal(plans.length, 1);
    assert.equal(plans[0]!.state, 'PENDING');
    assert.equal(plans[0]!.effects[0]!.kind, 'pause_agent');
    assert.equal(getAgentBySlug(db, 'scout')!.status, 'ACTIVE', 'nothing is applied by proposing');
    assert.equal(ingestMarkers(db, orch, run.id, 'PROPOSE: pause scout\n').proposals, 0, 'idempotent');
    assert.equal(pending(db, 'agent:orchestrator').length, 0, 'proposing never wakes the proposer');
    assert.ok(
      thread(db, orch.id).some((m) => m.kind === 'event' && /not understood/.test(m.body)),
      'the unparsed line is said back in the thread',
    );

    const scout = getAgentBySlug(db, 'scout')!;
    const scoutRun = openRun(db, scout)!;
    assert.equal(ingestMarkers(db, scout, scoutRun.id, 'PROPOSE: retire orchestrator\n').proposals, 0);
    assert.equal(listPlans(db).length, 1, 'only the orchestrator proposes');

    const p = proposePlan(db, 'retire orchestrator', 'human:owner');
    assert.equal(p.effects.length, 0, 'the orchestrator cannot be retired, by anyone');
    assert.match(p.summary, /cannot be retired/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
