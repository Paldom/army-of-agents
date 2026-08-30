/**
 * M1: the session layer and the guards around it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Runner, detectRateLimit, ensureSession, prompt } from '../src/acp/session.ts';
import { capabilityOf, refuseIfUnsupported } from '../src/acp/capabilities.ts';
import { allowedToolsFor, inspectCommand, scanEvents } from '../src/policy/vendor-guard.ts';

function fakeRunner(script: Record<string, { code: number; stdout: string; stderr: string }>): {
  runner: Runner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: Runner = {
    async run(args) {
      calls.push(args);
      const key = args.find((a) => a === 'ensure') ? 'ensure' : 'prompt';
      return script[key] ?? { code: 0, stdout: '', stderr: '' };
    },
  };
  return { runner, calls };
}

test('the contract is passed as a persisted system prompt', async () => {
  const { runner, calls } = fakeRunner({});
  await ensureSession(runner, {
    name: 'scout',
    agent: 'claude',
    cwd: '/tmp/x',
    systemPrompt: 'You may read A. You may write B.',
  });
  const args = calls[0]!;
  assert.ok(args.includes('--system-prompt'), 'the contract travels as the system prompt');
  assert.ok(args.includes('ensure'), 'session creation is idempotent');
  assert.ok(args.includes('--name') && args.includes('scout'));
});

test('prompts stream structured NDJSON rather than scraped text', async () => {
  // The real acpx wire format: ACP JSON-RPC, with the discriminator nested at
  // params.update.sessionUpdate and assistant text split across chunks. An
  // earlier version of this test asserted an invented flat shape and so passed
  // while the parser matched nothing on every real run.
  const u = (update: unknown) =>
    JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update } });
  const stdout = [
    u({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello ' } }),
    'not json — a banner line',
    u({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } }),
    u({ sessionUpdate: 'usage_update', used: 15, size: 1000 }),
  ].join('\n');
  const { runner } = fakeRunner({ prompt: { code: 0, stdout, stderr: '' } });
  const res = await prompt(runner, { agent: 'codex', cwd: '/tmp/x' }, 'go');
  assert.equal(res.ok, true);
  assert.equal(res.text, 'hello world');
  assert.equal(res.tokens, 15);
  assert.equal(res.events.length, 3, 'a partial line does not fail the run');
});

test('acpx escalation is surfaced as a denial, never mistaken for a pending question', async () => {
  // acpx answers escalations with the reject option when there is no TTY.
  // Recording it as an event is right; treating it as "a human will answer"
  // would hang the agent forever.
  const stdout = JSON.stringify({
    jsonrpc: '2.0', id: 7, method: 'session/request_permission',
    params: { toolCall: { title: 'Write' }, options: [{ optionId: 'reject', kind: 'reject_once' }] },
  });
  const { runner } = fakeRunner({ prompt: { code: 0, stdout, stderr: '' } });
  const res = await prompt(runner, { agent: 'claude', cwd: '/tmp/x' }, 'go');
  assert.equal(res.escalations.length, 1);
  assert.equal(res.escalations[0]!['method'], 'session/request_permission');
});

test('vendor refusals are classified so the lane backs off, not the agent', () => {
  const cases: Array<[string, boolean]> = [
    ['Error: You have hit your session limit', true],
    ['API error (status 402 Payment Required): balance exhausted', true],
    ['403 usage limit for this billing cycle', true],
    ['Individual quota reached. Resets in 96h', true],
    ['TypeError: undefined is not a function', false],
  ];
  for (const [stderr, expected] of cases) {
    const r = detectRateLimit({
      ok: false, events: [], text: '', escalations: [], exitCode: 1, stderr,
    });
    assert.equal(r.limited, expected, stderr);
  }
  const withReset = detectRateLimit({
    ok: false, events: [], text: '', escalations: [], exitCode: 1,
    stderr: 'Individual quota reached. Resets in 96h21m',
  });
  assert.equal(withReset.retryAfterMs, 96 * 3_600_000, 'the stated reset window is honoured');
});

test('capability is declared, and an unsupported plan is refused rather than hung', () => {
  assert.equal(capabilityOf('claude')!.effortConfig, false, 'verified against the adapter');
  assert.equal(capabilityOf('codex')!.effortConfig, true);

  assert.equal(refuseIfUnsupported('codex', { interrupt: true }), null);
  const refusal = refuseIfUnsupported('codex', { subagents: true });
  assert.match(String(refusal), /cannot subagents/);
  assert.match(String(refuseIfUnsupported('nope', {})), /unknown harness/);
});

test('vendor-CLI policing catches a confused agent without false-positiving on paths', () => {
  assert.equal(inspectCommand('uv run pytest -q'), null);
  assert.equal(inspectCommand('cat docs/claude-notes.md'), null, 'a path is not an invocation');
  assert.equal(inspectCommand('grep claude README.md')?.cli, undefined, 'an argument is not an invocation');

  const v = inspectCommand('cd /tmp && codex exec "check the fee"');
  assert.equal(v?.cli, 'codex');
  assert.match(String(v?.reason), /bypasses the vendor lane/);

  assert.equal(inspectCommand('claude -p "hi"')?.cli, 'claude');
  assert.equal(inspectCommand('npx acpx codex sessions list')?.cli, 'acpx');
});

test('agents with no need for a shell simply do not get one', () => {
  assert.equal(allowedToolsFor(true), undefined, 'no restriction; detection applies');
  const tools = allowedToolsFor(false)!;
  assert.ok(!tools.includes('Bash'), 'prevention beats detection where it is free');
  assert.ok(tools.includes('Read'));
});

test('the event scanner finds shell invocations in an acpx stream', () => {
  const tool = (command: string) => ({
    method: 'session/update',
    params: { update: { sessionUpdate: 'tool_call', rawInput: { command } } },
  });
  const violations = scanEvents([
    tool('ls -la'),
    tool('grok agent stdio'),
    { method: 'session/update', params: { update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'thinking about claude' } } } },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.cli, 'grok');
});
