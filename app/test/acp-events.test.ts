import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { interpret, parseNdjson } from '../src/acp/events.ts';
import { prompt, type Runner } from '../src/acp/session.ts';
import { scanEvents } from '../src/policy/vendor-guard.ts';

/**
 * These assert against the ACP wire shape as acpx actually emits it, captured
 * from a live claude session. Three readers previously each assumed a flatter
 * shape and each silently matched nothing: no text, no outcome, no vendor
 * violations, and a blank terminal pane while an agent was working. A shape
 * bug is invisible without a real sample, which is why the fixture exists.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const STREAM = readFileSync(join(HERE, 'fixtures', 'acp-stream.ndjson'), 'utf8');

test('assistant text is only meaningful concatenated across chunks', () => {
  const text = parseNdjson(STREAM)
    .map(interpret)
    .filter((u) => u.kind === 'text')
    .map((u) => (u.kind === 'text' ? u.text : ''))
    .join('');
  assert.match(text, /Checking the queue\./);
  assert.match(text, /OUTCOME: WORK_DONE/);
});

test('prompt() extracts text, usage and outcome from a real stream', async () => {
  const runner: Runner = { run: async () => ({ code: 0, stdout: STREAM, stderr: '' }) };
  const res = await prompt(runner, { agent: 'claude', cwd: '/tmp' }, 'go');
  assert.equal(res.ok, true);
  assert.match(res.text, /OUTCOME: WORK_DONE/);
  // Regression: this was 0 for every run, so budget was never settled.
  assert.equal(res.tokens, 24127);
});

test('the vendor guard sees commands nested under params.update', () => {
  const violations = scanEvents(parseNdjson(STREAM));
  assert.equal(violations.length, 1, 'the codex shell-out must be caught exactly once');
  assert.equal(violations[0]!.cli, 'codex');
});

test('a benign command is not flagged', () => {
  assert.equal(scanEvents([{ method: 'session/update', params: { update: {
    sessionUpdate: 'tool_call', rawInput: { command: 'ls -la' } } } }]).length, 0);
});

test('unknown frames are inert rather than noisy', () => {
  assert.equal(interpret({ method: 'session/update', params: { update: { sessionUpdate: 'brand_new' } } }).kind, 'other');
  assert.equal(interpret({}).kind, 'other');
});
