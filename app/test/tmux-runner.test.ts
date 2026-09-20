/**
 * The tmux path, for real: a turn runs inside a pane, is readable while it
 * runs, and a stalled one is killed rather than waited on.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { tmuxRunner } from '../src/acp/tmux-runner.ts';
import { prompt, textStream } from '../src/acp/session.ts';
import { tmuxAvailable } from '../src/server/terminal.ts';

const frame = (text: string) =>
  JSON.stringify({
    jsonrpc: '2.0', method: 'session/update',
    params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
  });

// A fake acpx: reads the prompt, answers in two frames half a second apart.
const FAKE = `#!/bin/sh
cat >/dev/null
printf '%s\\n' '${frame('REPORT: one\n')}'
sleep 0.5
printf '%s\\n' '${frame('OUTCOME: WORK_DONE\n')}'
`;
const HANG = `#!/bin/sh
cat >/dev/null
sleep 60
`;

const skip = tmuxAvailable() ? false : 'tmux is not installed on this host';

function setup(script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'aoa-tmux-'));
  const bin = join(dir, 'acpx');
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  const session = `aoa-test-${process.pid}-${Math.random().toString(36).slice(2, 7)}`;
  const teardown = () => {
    try {
      execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, bin, session, teardown };
}

test('tmux proof: a turn runs in a real pane, streams while running, and finishes with its capture', { skip }, async () => {
  const { dir, bin, session, teardown } = setup(FAKE);
  try {
    const runner = tmuxRunner({ session, cwd: dir, env: { AOA_ACPX_BIN: bin }, pollMs: 50 });
    const seen: string[] = [];
    const res = await prompt(runner, { agent: 'fake', cwd: dir }, 'go', textStream((t) => seen.push(t)));
    assert.equal(res.ok, true);
    assert.equal(res.text, 'REPORT: one\nOUTCOME: WORK_DONE\n');
    assert.ok(seen.length >= 1 && seen[0] === 'REPORT: one\n', 'the first line was readable before the turn ended');
  } finally {
    teardown();
  }
});

test('tmux proof: a stalled turn is killed and named, not waited on until the deadline', { skip }, async () => {
  const { dir, bin, session, teardown } = setup(HANG);
  try {
    const runner = tmuxRunner({ session, cwd: dir, env: { AOA_ACPX_BIN: bin }, pollMs: 50, queuedMs: 1500 });
    const t0 = Date.now();
    const res = await runner.run(['x'], 'go');
    assert.equal(res.code, -1);
    assert.equal(res.stderr, 'queued behind an orphaned prompt');
    assert.ok(Date.now() - t0 < 15_000, 'fails fast');
  } finally {
    teardown();
  }
});
