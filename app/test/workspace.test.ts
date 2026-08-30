import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { dbPathFor, namespaceFor, paneName, stateDir } from '../src/supervisor/workspace.ts';

/**
 * The skill is generic; a fleet is not. Everything about "this skill operating
 * on THAT project" is derived from the project root, so one checkout drives
 * any number of projects and an upgrade cannot delete a fleet's memory.
 */

const clean = <T>(fn: () => T): T => {
  const saved = { ...process.env };
  for (const k of ['AOA_STATE_DIR', 'AOA_WORKTREE_ROOT', 'AOA_DB', 'AOA_NAMESPACE']) delete process.env[k];
  try {
    return fn();
  } finally {
    Object.assign(process.env, saved);
  }
};

test('state lives beside the project, never inside it or inside the skill', () => {
  clean(() => {
    assert.equal(stateDir('/home/o/work/ledger'), '/home/o/work/ledger-agents');
    assert.equal(dbPathFor('/home/o/work/ledger'), '/home/o/work/ledger-agents/aoa.db');
    // Inside the project would dirty the owner's `git status`; inside the skill
    // would be destroyed by reinstalling it.
    assert.ok(!dbPathFor('/home/o/work/ledger').startsWith('/home/o/work/ledger/'));
  });
});

test('two projects never share an agent terminal', () => {
  clean(() => {
    assert.notEqual(
      paneName('/home/o/work/ledger', 'orchestrator'),
      paneName('/home/o/work/shop', 'orchestrator'),
    );
    assert.equal(paneName('/home/o/work/ledger', 'orchestrator'), 'ledger-orchestrator');
  });
});

test('the namespace is safe for tmux, which reserves . and :', () => {
  clean(() => {
    const ns = namespaceFor('/home/o/My Project.v2');
    assert.ok(!/[.:]/.test(ns), `tmux would reject ${ns}`);
    assert.equal(ns, 'my-project-v2');
  });
});

test('an explicit state dir wins, so a fleet can live anywhere', () => {
  const saved = process.env['AOA_STATE_DIR'];
  process.env['AOA_STATE_DIR'] = '/srv/fleets/ledger';
  try {
    assert.equal(dbPathFor('/home/o/work/ledger'), '/srv/fleets/ledger/aoa.db');
  } finally {
    if (saved === undefined) delete process.env['AOA_STATE_DIR']; else process.env['AOA_STATE_DIR'] = saved;
  }
});
