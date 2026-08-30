import { basename, dirname, join } from 'node:path';

/**
 * Where one project's fleet lives.
 *
 * The skill is generic and installable; a fleet is not. Everything that
 * belongs to "this skill operating on THAT project" — the store, the config,
 * the worktrees, the terminal names — is derived from the project root, so one
 * checkout of the skill drives any number of projects and reinstalling it
 * destroys nothing.
 *
 * State sits BESIDE the project, in the same directory the worktrees already
 * use, for the same reason: a state directory inside the repo shows up in the
 * owner's `git status`, and one inside the skill would be deleted by an
 * upgrade.
 */

/** `<parent>/<name>-agents` — worktrees, store and config for this project. */
export function stateDir(projectRoot: string): string {
  return (
    process.env['AOA_STATE_DIR'] ??
    process.env['AOA_WORKTREE_ROOT'] ??
    join(dirname(projectRoot), `${basename(projectRoot)}-agents`)
  );
}

export function dbPathFor(projectRoot: string): string {
  return process.env['AOA_DB'] ?? join(stateDir(projectRoot), 'aoa.db');
}

/**
 * A short, filesystem- and tmux-safe key for this project.
 *
 * tmux session names are global per user, so two projects each with an
 * `orchestrator` would otherwise attach to the same terminal — one fleet
 * watching another fleet's agent.
 */
export function namespaceFor(projectRoot: string): string {
  const explicit = process.env['AOA_NAMESPACE'];
  if (explicit) return explicit;
  const derived = basename(projectRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  return derived || 'aoa';
}

/**
 * The tmux session for one agent. `.` and `:` are reserved by tmux, so the
 * separator is a dash.
 */
export function paneName(projectRoot: string, slug: string): string {
  return `${namespaceFor(projectRoot)}-${slug}`;
}
