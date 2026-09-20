/**
 * Reading a turn while it runs: frames split anywhere reassemble into text.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { textStream } from '../src/acp/session.ts';

const frame = (kind: string, text: string) =>
  `${JSON.stringify({
    jsonrpc: '2.0', method: 'session/update',
    params: { sessionId: 's', update: { sessionUpdate: kind, content: { type: 'text', text } } },
  })}\n`;

test('textStream reassembles chunks split anywhere, including inside a multi-byte character', () => {
  const all = Buffer.from(
    frame('agent_message_chunk', 'REPORT: héllo ') +
      frame('agent_thought_chunk', 'NOTIFY: a private thought\n') +
      frame('agent_message_chunk', 'wörld\n') +
      frame('agent_message_chunk', 'OUTCOME: WORK_DONE\n'),
  );
  const seen: string[] = [];
  const feed = textStream((t) => seen.push(t));
  for (let i = 0; i < all.length; i += 3) feed(all.subarray(i, i + 3));
  assert.equal(seen.at(-1), 'REPORT: héllo wörld\nOUTCOME: WORK_DONE\n');
  assert.equal(seen.length, 2, 'fires once per completed line, not per fragment');
  assert.ok(!seen.join('').includes('private thought'), 'thoughts are not text the agent said');
});
