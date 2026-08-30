import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { PROTOCOL, parseAsks, parseOutcome } from '../src/supervisor/protocol.ts';
import { renderCapsule } from '../src/supervisor/memory.ts';

/**
 * Both halves of this contract were once asserted on one side only: dispatch
 * matched an OUTCOME marker no prompt requested, and a working agent had no
 * way to reach a human. These pin the contract to the prompt that carries it.
 */

test('the capsule states the protocol it will be judged by', () => {
  const capsule = renderCapsule({
    contract: 'do the thing', mission: '', lastRunSummary: '',
    pendingVerdicts: [], learnedNotes: [], recentHistory: [], docsRef: '', inboxCursor: 0,
  });
  assert.ok(capsule.includes('OUTCOME: WORK_DONE'), 'the outcome vocabulary must be in the prompt');
  assert.ok(capsule.includes('ASK:'), 'the agent must be told how to reach a human');
  assert.ok(/END YOUR TURN/i.test(capsule), 'asking without ending the turn would hang the agent');
});

test('a declared outcome is read; an undeclared one backs off', () => {
  assert.equal(parseOutcome('did some work\n\nOUTCOME: WORK_DONE'), 'WORK_DONE');
  assert.equal(parseOutcome('OUTCOME: BLOCKED\n'), 'BLOCKED');
  assert.equal(parseOutcome('I finished everything!'), 'NO_WORK');
  assert.equal(parseOutcome('OUTCOME: SOMETHING_ELSE'), 'NO_WORK');
});

test('the last outcome wins, because agents quote the menu before choosing', () => {
  assert.equal(parseOutcome(`${PROTOCOL}\n\nOUTCOME: WORK_DONE`), 'WORK_DONE');
});

test('an ASK becomes a question, with or without options', () => {
  const asks = parseAsks(
    'Some reasoning.\n' +
      'ASK: Should I include the draft section?\n' +
      'OPTIONS: yes | no | only with a citation\n' +
      'ASK: Which region takes priority?\n' +
      'OUTCOME: BLOCKED',
  );
  assert.equal(asks.length, 2);
  assert.deepEqual(asks[0]!.options, ['yes', 'no', 'only with a citation']);
  assert.equal(asks[1]!.prompt, 'Which region takes priority?');
  assert.equal(asks[1]!.options, undefined, 'no OPTIONS line means a free-text answer');
});

test('the protocol block echoed back does not file its own example as a question', () => {
  assert.equal(parseAsks(PROTOCOL).length, 0);
});

test('a single option is a free-text answer, not a one-item menu', () => {
  const asks = parseAsks('ASK: Proceed?\nOPTIONS: yes');
  assert.equal(asks[0]!.options, undefined);
});
