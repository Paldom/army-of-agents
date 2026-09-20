import { spawn } from 'node:child_process';

import { onEvent } from '../store/db.ts';

/**
 * The outbound seam.
 *
 * `AOA_EVENT_HOOK` names a shell command; it receives one JSON event on stdin
 * for every event whose kind is listed in `AOA_EVENT_HOOK_KINDS`. A push
 * notification, an e-mail, or an agents-connect `aconn notify` plugs in here,
 * and this repo never learns which. Fire-and-forget: a hook that hangs or
 * fails cannot hold the loop.
 */
export const DEFAULT_HOOK_KINDS = [
  'ask.opened',
  'ask.answered',
  'ask.cancelled',
  'ask.expired',
  'agent.notify',
  'message.dead',
  'alarm.lost_wake',
  'lane.gated',
  'plan.proposed',
];

export const MAX_CONCURRENT_HOOKS = 4;
export const HOOK_TIMEOUT_MS = 10_000;

export function installEventHook(env: NodeJS.ProcessEnv = process.env): (() => void) | null {
  const cmd = env['AOA_EVENT_HOOK'];
  if (!cmd) return null;
  const kinds = new Set(
    (env['AOA_EVENT_HOOK_KINDS'] ?? DEFAULT_HOOK_KINDS.join(','))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  let running = 0;
  return onEvent((e) => {
    if (!kinds.has(e.kind)) return;
    // Deferred past the current tick of the event loop: emit() is called
    // inside store transactions, and a hook must see the fleet after the
    // commit, not while the write lock is held.
    setImmediate(() => {
      if (running >= MAX_CONCURRENT_HOOKS) {
        process.stderr.write(`event hook skipped (${running} already running): ${e.kind}\n`);
        return;
      }
      running++;
      const child = spawn('sh', ['-c', cmd], { stdio: ['pipe', 'ignore', 'inherit'] });
      const deadline = setTimeout(() => child.kill('SIGKILL'), HOOK_TIMEOUT_MS);
      child.on('error', (err) => process.stderr.write(`event hook failed: ${String(err)}\n`));
      child.on('close', () => {
        clearTimeout(deadline);
        running--;
      });
      child.stdin.on('error', () => undefined); // the hook may exit before reading
      child.stdin.end(`${JSON.stringify({ ...e, at: Date.now() })}\n`);
    });
  });
}
