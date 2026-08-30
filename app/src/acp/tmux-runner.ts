import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { type Runner } from './session.ts';
import { ensureSession as ensureTmux, tmuxAvailable } from '../server/terminal.ts';

/**
 * A Runner that executes acpx inside the agent's own tmux pane.
 *
 * The default Runner spawns acpx with piped stdio, which works but is
 * invisible: the workspace's terminal tab attaches to tmux, and nothing ever
 * ran there, so every agent looked idle while it was in fact working. Routing
 * dispatch through tmux is what makes "watch this agent" mean the real
 * session instead of a transcript replayed after the fact.
 *
 * The pane runs one command with one argument — a job directory. Prompt text,
 * arguments and output all move as files, so nothing an agent produces is ever
 * interpolated into a shell line.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PANE = join(HERE, 'pane.ts');

/** What the wrapper publishes about itself. See pane.ts. */
export interface Heartbeat {
  phase: 'spawning' | 'submitted' | 'streaming' | 'done';
  bytes: number;
  ts: number;
  pid: number;
}

export interface Started {
  wrapperPid: number;
  acpxPid: number;
  pgid: number;
  startedAt: number;
}

export function readHeartbeat(job: string): Heartbeat | null {
  try {
    return JSON.parse(readFileSync(join(job, 'heartbeat'), 'utf8')) as Heartbeat;
  } catch {
    return null;
  }
}

export function readStarted(job: string): Started | null {
  try {
    return JSON.parse(readFileSync(join(job, 'started.json'), 'utf8')) as Started;
  } catch {
    return null;
  }
}

/**
 * Kill a turn and everything it spawned.
 *
 * The process GROUP, not the pid: acpx spawns the real harness
 * (`claude-agent-acp`, itself spawning the vendor binary), and killing acpx
 * alone leaves that harness running and still holding the session's prompt
 * queue — which is the orphan this whole mechanism exists to prevent.
 */
export function killTurn(job: string): boolean {
  const started = readStarted(job);
  if (!started) return false;
  let killed = false;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      process.kill(-started.pgid, signal);
      killed = true;
    } catch {
      /* already gone, which is the outcome we wanted */
    }
    if (signal === 'SIGTERM') break; // give SIGTERM the chance; SIGKILL is the reconciler's job
  }
  try {
    process.kill(started.wrapperPid, 'SIGTERM');
  } catch {
    /* fine */
  }
  return killed;
}

/** Alive if it beat recently. Two missed beats is dead; the interval is 2s. */
export function isAlive(hb: Heartbeat | null, nowMs = Date.now(), staleMs = 10_000): boolean {
  return !!hb && nowMs - hb.ts < staleMs;
}

export interface TmuxRunnerOptions {
  /** tmux session name; the workspace uses the agent slug. */
  session: string;
  cwd: string;
  /** Hard backstop. Reached only when the turn is genuinely long, not stalled. */
  timeoutMs?: number;
  pollMs?: number;
  /**
   * How long `submitted` with zero bytes is tolerated before the turn is
   * declared queued behind something. This is the fast path that replaces a
   * 30-minute silence, so it must be well under the hard deadline.
   */
  queuedMs?: number;
  /** Called with the job dir as soon as it exists, so a crash can reconcile it. */
  onJob?: (job: string) => void;
}

export type RunFailure = 'pane timed out' | 'queued behind an orphaned prompt' | 'wrapper died';

export function tmuxRunner(opts: TmuxRunnerOptions): Runner {
  return {
    async run(args, input) {
      if (!ensureTmux(opts.session, opts.cwd)) {
        return { code: -1, stdout: '', stderr: 'tmux session unavailable' };
      }
      const job = mkdtempSync(join(tmpdir(), `aoa-${opts.session}-`));
      let wrapperLive = false;
      try {
        writeFileSync(join(job, 'argv.json'), JSON.stringify(args));
        writeFileSync(join(job, 'input.txt'), input ?? '');
        opts.onJob?.(job);

        // Single-quoted paths from mkdtemp: no metacharacters, but quoted so a
        // future change to the naming cannot turn into shell injection.
        const cmd = `${process.execPath} --experimental-strip-types '${PANE}' '${job}'`;
        execFileSync('tmux', ['send-keys', '-t', opts.session, cmd, 'Enter'], { stdio: 'ignore' });

        const exitFile = join(job, 'exit');
        const startedAt = Date.now();
        const deadline = startedAt + (opts.timeoutMs ?? 1_800_000);
        const queuedMs = opts.queuedMs ?? 90_000;
        const pollMs = opts.pollMs ?? 250;

        const fail = (stderr: RunFailure) => {
          // Kill, do not abandon. An abandoned prompt keeps running and keeps
          // the session's queue, so the NEXT turn blocks behind it — which is
          // how one slow turn became a permanent stall.
          killTurn(job);
          wrapperLive = false;
          return { code: -1, stdout: '', stderr };
        };

        while (!existsSync(exitFile)) {
          const now = Date.now();
          const hb = readHeartbeat(job);
          wrapperLive = isAlive(hb, now);

          if (hb) {
            // Distinguishable within seconds, where previously all three of
            // these produced an identical thirty minutes of nothing.
            if (!wrapperLive) return fail('wrapper died');
            if (hb.phase === 'submitted' && hb.bytes === 0 && now - startedAt > queuedMs) {
              return fail('queued behind an orphaned prompt');
            }
          } else if (now - startedAt > 30_000) {
            // No heartbeat at all: send-keys never landed, or the pane's shell
            // ate the command.
            return fail('wrapper died');
          }

          if (now > deadline) return fail('pane timed out');
          await new Promise((r) => setTimeout(r, pollMs));
        }
        const code = Number(readFileSync(exitFile, 'utf8').trim());
        const stdout = existsSync(join(job, 'stdout.ndjson'))
          ? readFileSync(join(job, 'stdout.ndjson'), 'utf8')
          : '';
        wrapperLive = false;
        return { code, stdout, stderr: '' };
      } finally {
        // Never delete a job dir out from under a live wrapper: it writes its
        // capture, heartbeat and exit sentinel there, and removing it turns a
        // recoverable turn into one that can never report anything.
        if (!wrapperLive) rmSync(job, { recursive: true, force: true });
      }
    },
  };
}

/** Is a visible pane possible on this host? Falls back to piped stdio if not. */
export const paneAvailable = tmuxAvailable;
