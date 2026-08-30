import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * M3 — per-agent isolation, and the degradations stated rather than hidden.
 *
 * The isolation unit degrades deliberately on a single host, because the vendor
 * CLIs are authenticated there. Putting an agent in a container leaves it with
 * no auth; mounting the credentials in makes the boundary decorative while
 * making theft easier. So: real isolation where it is real, and an honest label
 * where it is not.
 */

export interface Isolation {
  worktree: string;
  browserProfile: string;
  /** Sandbox read allowlist. Excluding other vendors' config dirs is Stage 2 of D19. */
  readPaths: string[];
  writePaths: string[];
  degradations: Array<{ dimension: string; state: string; why: string }>;
}

const VENDOR_CONFIG_DIRS = ['.claude', '.codex', '.gemini', '.grok', '.kimi', '.acpx'];

/**
 * Where agent worktrees live.
 *
 * Beside the project, never inside it. A `.worktrees/` directory in the repo
 * shows up in `git status` for every human working there, and the one thing an
 * agent fleet must not do is make the owner's own tree noisy.
 */
export function worktreeRoot(root: string): string {
  return process.env['AOA_WORKTREE_ROOT'] ?? join(dirname(root), `${basename(root)}-agents`);
}

export function isolationFor(
  agentSlug: string,
  opts: { root: string; home: string; assignedVendor: string | null },
): Isolation {
  const worktree = join(worktreeRoot(opts.root), agentSlug);
  const browserProfile = join(opts.root, '.browser-profiles', agentSlug);

  // Stage 2: an agent may read ONLY its own assigned vendor's config. That is
  // what turns a vendor lane from an accounting convention into a boundary.
  const ownVendorDir = opts.assignedVendor ? `.${opts.assignedVendor}` : null;
  const readPaths = [worktree, join(opts.root, 'docs'), join(opts.root, 'registry')];
  if (ownVendorDir) readPaths.push(join(opts.home, ownVendorDir));

  return {
    worktree,
    browserProfile,
    readPaths,
    writePaths: [worktree, browserProfile],
    degradations: [
      {
        dimension: 'network',
        state: 'shared',
        why: 'One host namespace: same egress IP, same DNS, same per-IP rate limit. Not isolated.',
      },
      {
        dimension: 'vendor credentials',
        state: 'shared per vendor on host',
        why: 'Subscription auth lives on the host, so one login serves the whole fleet for that vendor.',
      },
      {
        dimension: 'vendor working memory',
        state: 'shared per vendor',
        why: 'Agents on one vendor share that vendor\'s own on-host memory; working context can bleed.',
      },
    ],
  };
}

/**
 * Materialise the worktree. Computing the path is not the same as creating it:
 * an earlier version only computed it, so every dispatch pointed the harness at
 * a directory that did not exist and no agent could start at all.
 *
 * Returns the cwd to actually use, which is the project root when isolation is
 * not achievable — degraded, and said out loud rather than failing.
 */
export function ensureWorktree(iso: Isolation, root: string, slug: string): string {
  if (existsSync(iso.worktree)) return iso.worktree;
  mkdirSync(dirname(iso.worktree), { recursive: true });

  const git = (args: string[]): void => {
    execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  };
  try {
    // A branch per agent, so parallel work is reconcilable rather than a pile
    // of detached commits. `-b` and not `-B`: forcing the branch would discard
    // whatever a previous run of this agent committed.
    git(['worktree', 'add', '-b', `agents/${slug}`, iso.worktree, 'HEAD']);
    return iso.worktree;
  } catch {
    /* the branch already exists — reattach to it below */
  }
  try {
    git(['worktree', 'add', iso.worktree, `agents/${slug}`]);
    return iso.worktree;
  } catch {
    iso.degradations.push({
      dimension: 'worktree',
      state: 'shared with the project root',
      why: 'Not a git repository, or git refused the worktree. The agent works in the project root itself, so its writes are NOT isolated from other agents.',
    });
    return root;
  }
}

/** Which vendor config dirs this agent must NOT be able to read. */
export function deniedVendorDirs(home: string, assignedVendor: string | null): string[] {
  const own = assignedVendor ? `.${assignedVendor}` : null;
  return VENDOR_CONFIG_DIRS.filter((d) => d !== own).map((d) => join(home, d));
}

/**
 * A macOS Seatbelt profile. Generated per agent because a static profile with
 * fixed write paths cannot express "this agent, these paths".
 */
export function seatbeltProfile(iso: Isolation, denied: string[]): string {
  const lit = (p: string) => `(subpath "${p}")`;
  return [
    '(version 1)',
    '(allow default)',
    '; deny other vendors\' credentials — the lane is a boundary, not a convention',
    ...denied.map((d) => `(deny file-read* ${lit(d)})`),
    '; writes are confined to the agent\'s own worktree and browser profile',
    `(deny file-write* (subpath "/"))`,
    ...iso.writePaths.map((p) => `(allow file-write* ${lit(p)})`),
    '(allow file-write* (subpath "/tmp") (subpath "/private/tmp"))',
  ].join('\n');
}

/**
 * Take-the-wheel, for both the browser and the terminal.
 *
 * The detail everyone gets wrong: while a human is driving, agent actions are
 * REFUSED, not queued. Queued actions resume into a page or a shell that is no
 * longer where the agent thinks it is.
 */
export type ControlState = 'agent_driving' | 'help_requested' | 'control_taken';

export interface ControlSession {
  state: ControlState;
  reason?: string;
  since: number;
}

export function requestHelp(s: ControlSession, reason: string, nowMs: number): ControlSession {
  return { state: 'help_requested', reason, since: nowMs };
}

export function takeControl(s: ControlSession, nowMs: number): ControlSession {
  return { state: 'control_taken', since: nowMs, ...(s.reason ? { reason: s.reason } : {}) };
}

export function releaseControl(nowMs: number): ControlSession {
  return { state: 'agent_driving', since: nowMs };
}

/** The whole point: refusal, not queueing. */
export function agentMayAct(s: ControlSession): { allowed: boolean; refusal?: string } {
  if (s.state === 'control_taken') {
    return {
      allowed: false,
      refusal:
        'A human is driving. Agent actions are refused rather than queued — a queued action would ' +
        'resume into a page that is no longer where the agent thinks it is.',
    };
  }
  if (s.state === 'help_requested') {
    return { allowed: false, refusal: 'Paused, waiting for a human: ' + (s.reason ?? 'unspecified') };
  }
  return { allowed: true };
}
