/**
 * The optional integrations say what they are: the doctor, the browser
 * endpoint, and the outbound event hook.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { emit, open } from '../src/store/db.ts';
import { doctor } from '../src/server/doctor.ts';
import { discoverCdp, stealthAvailable } from '../src/server/browser.ts';
import { tmuxAvailable } from '../src/server/terminal.ts';
import { installEventHook } from '../src/supervisor/hooks.ts';
import { HARNESSES, loadHarnessOverrides } from '../src/acp/capabilities.ts';

test('the doctor reports every integration with a reason and never throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aoa-doc-'));
  try {
    const checks = await doctor({ projectRoot: dir, stateDir: join(dir, 'state'), orchestratorHarness: 'claude', env: { AOA_ORCHESTRATOR_HARNESS: 'codex' } });
    const byId = new Map(checks.map((c) => [c.id, c]));
    for (const id of ['node', 'acpx', 'tmux', 'git', 'state', 'browser', 'event-hook', 'orchestrator']) {
      assert.ok(byId.has(id), `check ${id}`);
      assert.ok(byId.get(id)!.detail.length > 0, `${id} says something`);
    }
    assert.equal(byId.get('tmux')!.ok, tmuxAvailable());
    assert.equal(byId.get('git')!.ok, false, 'a temp dir is not a repo');
    assert.equal(byId.get('event-hook')!.ok, false);
    assert.equal(byId.get('orchestrator')!.ok, false, 'a changed harness env var is reported, not silently ignored');
    assert.match(byId.get('orchestrator')!.detail, /only applies to a fresh store/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a browser endpoint comes from env, then a published cdp.json, then DevToolsActivePort', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aoa-cdp-'));
  try {
    assert.equal(discoverCdp([dir], {}), null);
    assert.equal(stealthAvailable(dir).ok, false);
    assert.match(stealthAvailable(dir).detail, /npx skills add/);

    const ident = join(dir, '.stealth', 'acme');
    mkdirSync(join(ident, 'user-data'), { recursive: true });
    assert.equal(stealthAvailable(dir).ok, true);
    writeFileSync(join(ident, 'user-data', 'DevToolsActivePort'), '9333\n/devtools/browser/abc\n');
    assert.deepEqual(discoverCdp([dir], {}), { host: '127.0.0.1', port: 9333 });
    writeFileSync(join(ident, 'cdp.json'), JSON.stringify({ host: '127.0.0.1', port: 9444 }));
    assert.deepEqual(discoverCdp([dir], {}), { host: '127.0.0.1', port: 9444 }, 'a published endpoint wins over Chromium\'s file');
    assert.deepEqual(discoverCdp([dir], { AOA_BROWSER_CDP: 'localhost:9555' }), { host: 'localhost', port: 9555 });

    // Two identities in a shared root: the one named after the agent is its own.
    const mine = join(dir, '.stealth', 'scout');
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, 'cdp.json'), JSON.stringify({ host: '127.0.0.1', port: 9666 }));
    assert.deepEqual(discoverCdp([dir], {}, 'scout'), { host: '127.0.0.1', port: 9666 }, 'not another agent\'s browser');
    assert.deepEqual(discoverCdp([dir], {}, 'librarian'), { host: '127.0.0.1', port: 9444 }, 'a shared identity when it has none of its own');
    assert.deepEqual(discoverCdp([dir], { AOA_BROWSER_CDP_LIBRARIAN: '[::1]:9777' }, 'librarian'), { host: '[::1]', port: 9777 }, 'a per-agent endpoint, IPv6 included');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the event hook receives the kinds it subscribed to and nothing else', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aoa-hook-'));
  const db = open(join(dir, 's.db'));
  const out = join(dir, 'events.ndjson');
  const off = installEventHook({ AOA_EVENT_HOOK: `cat >> '${out}'`, AOA_EVENT_HOOK_KINDS: 'ask.opened' });
  try {
    assert.ok(off, 'installed');
    emit(db, 'run.opened', 'system', { runId: 'r1' });
    emit(db, 'ask.opened', 'agent:scout', { askId: 'q1', prompt: 'which one?' }, 'a1');
    for (let i = 0; i < 40 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const e = JSON.parse(lines[0]!) as { kind: string; payload: { askId: string }; subject: string };
    assert.equal(e.kind, 'ask.opened');
    assert.equal(e.payload.askId, 'q1');
    assert.equal(e.subject, 'a1');
  } finally {
    off?.();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('harnesses are rows: a file adds one, conservatively, and can correct a seeded one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aoa-h-'));
  try {
    const f = join(dir, 'harnesses.json');
    writeFileSync(f, JSON.stringify({ opencode: { acpxAgent: 'opencode', vendor: 'opencode', interrupt: true }, kimi: { steering: true } }));
    assert.deepEqual(loadHarnessOverrides(f), ['opencode', 'kimi']);
    assert.equal(HARNESSES['opencode']!.interrupt, true);
    assert.equal(HARNESSES['opencode']!.subagents, false, 'unstated means false');
    assert.equal(HARNESSES['kimi']!.steering, true);
    assert.equal(HARNESSES['kimi']!.acpxAgent, 'kimi', 'a patch keeps what it did not say');
    assert.deepEqual(loadHarnessOverrides(join(dir, 'missing.json')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
