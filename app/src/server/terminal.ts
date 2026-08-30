import { spawn as ptySpawn } from 'node-pty';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * A view onto an agent's tmux session.
 *
 * tmux owns the session; this attaches to it. That is the whole reason it is
 * tmux and not a bare pty — a pty dies with the process that spawned it, so a
 * server restart would take every agent's terminal with it, and the scrollback
 * a human is halfway through reading.
 *
 * `attach -r` (read-only) is the default. Control is granted per client and
 * revoked on release; while a human drives, the agent's input is refused
 * upstream rather than queued.
 */

/**
 * node-pty's prebuilt `spawn-helper` ships without the executable bit, so every
 * pty spawn fails with `posix_spawnp failed` — a message that names neither the
 * file nor the permission. A fresh `npm ci` reproduces it on any machine, so
 * repairing it here is more useful than documenting it.
 */
function ensureHelperExecutable(): void {
  try {
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve('node-pty/package.json'));
    for (const p of [
      join(root, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      join(root, 'build', 'Release', 'spawn-helper'),
    ]) {
      if (!existsSync(p)) continue;
      if ((statSync(p).mode & 0o111) === 0) chmodSync(p, 0o755);
    }
  } catch {
    /* best effort: if this fails, attach() reports it rather than crashing */
  }
}
let helperChecked = false;

export function tmuxAvailable(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function sessionExists(name: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the session if it is not there. Idempotent, so the supervisor can call
 * it before every dispatch without tracking what exists.
 */
export function ensureSession(name: string, cwd: string): boolean {
  if (!tmuxAvailable()) return false;
  if (sessionExists(name)) return true;
  try {
    execFileSync('tmux', ['new-session', '-d', '-s', name, '-c', cwd], { stdio: 'ignore' });
    // A generous history, because the interesting part of an agent run is
    // usually several hundred lines above where you land.
    execFileSync('tmux', ['set-option', '-t', name, 'history-limit', '10000'], { stdio: 'ignore' });
    // Don't let viewers resize the agent's terminal. With the default
    // ('latest'), whichever browser attached most recently dictates the pane
    // size for everyone, so a phone opening the tab reflows the session a
    // person on a laptop is reading.
    execFileSync('tmux', ['set-option', '-t', name, 'window-size', 'manual'], { stdio: 'ignore' });
    execFileSync('tmux', ['resize-window', '-t', name, '-x', '120', '-y', '34'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function listSessions(): string[] {
  try {
    const out = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The scrollback ABOVE the visible screen.
 *
 * A client that only attaches sees the current screen and nothing else, so
 * reconnecting mid-run looks like the agent just started. This replays what
 * came before — and deliberately stops at line -1, because attaching redraws
 * the visible screen itself and capturing it here would print it twice.
 */
export function history(session: string, lines = 2000): string {
  if (!sessionExists(session)) return '';
  try {
    const out = execFileSync(
      'tmux',
      ['capture-pane', '-p', '-e', '-t', session, '-S', `-${lines}`, '-E', '-1'],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    return out.replace(/\n/g, '\r\n');
  } catch {
    return '';
  }
}

export interface Attachment {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  grantControl(on: boolean): void;
  close(): void;
}

/**
 * Attach one websocket client. Each client gets its own tmux client, so several
 * humans can watch the same session and only one needs write access.
 */
export function attach(
  session: string,
  onData: (chunk: string) => void,
  opts: { cols?: number; rows?: number } = {},
): Attachment | null {
  if (!tmuxAvailable() || !sessionExists(session)) return null;
  if (!helperChecked) {
    ensureHelperExecutable();
    helperChecked = true;
  }

  let writable = false;
  let term: ReturnType<typeof ptySpawn>;
  try {
    term = ptySpawn(
      'tmux',
      // -r attaches read-only. Control is a client property, so granting it
      // means re-attaching rather than trusting the browser not to type.
      ['attach-session', '-t', session, '-r'],
      {
        name: 'xterm-256color',
        cols: opts.cols ?? 100,
        rows: opts.rows ?? 30,
        cwd: process.cwd(),
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      },
    );
  } catch (err) {
    // A terminal view that cannot open must never take the workspace with it.
    // This threw straight through the websocket handler and killed the server
    // for every other viewer.
    onData(`\r\n[terminal unavailable: ${String(err).slice(0, 160)}]\r\n`);
    return null;
  }
  term.onData(onData);

  return {
    write(data: string) {
      if (!writable) return; // refused, not queued
      term.write(data);
    },
    resize(cols: number, rows: number) {
      try {
        term.resize(Math.max(20, cols), Math.max(5, rows));
      } catch {
        /* a resize race is not worth killing the attachment for */
      }
    },
    grantControl(on: boolean) {
      writable = on;
    },
    close() {
      try {
        term.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
