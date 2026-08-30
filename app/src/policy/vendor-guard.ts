import { type AcpEvent, interpret } from '../acp/events.ts';

/**
 * Stage-1 cross-vendor credential policing.
 *
 * Vendor CLIs are logged in on the host, so any agent's shell can invoke any
 * vendor's CLI — walking around the lane gate, the budget ledger and the
 * router's vendor choice. A lane a confused agent can walk around is not a
 * lane, it is a comment.
 *
 * The dominant threat here is a CONFUSED agent, not a hostile one: an LLM that
 * decides to shell out to another vendor to check something. Detection catches
 * that reliably and costs almost nothing. Stage 2 (per-agent sandbox read_paths
 * excluding other vendors' config directories) is real prevention and lands
 * with the rest of the isolation work.
 */

/** Executables that must only ever be invoked by the supervisor, never by an agent. */
const VENDOR_CLIS = [
  'claude', 'codex', 'gemini', 'grok', 'kimi', 'agy', 'cursor-agent',
  'copilot', 'droid', 'opencode', 'qwen', 'acpx',
];

export interface Violation {
  cli: string;
  command: string;
  reason: string;
}

/**
 * Wrappers that delegate to the real command, so the interesting token is the
 * next one along rather than the first.
 */
const PASSTHROUGH = ['sudo', 'env', 'time', 'nohup', 'exec', 'command', 'npx', 'bunx', 'pnpm', 'dlx', 'uvx'];

/**
 * Inspect a shell command an agent is about to run.
 *
 * Only the COMMAND POSITION counts. Scanning every token flags `grep claude
 * README.md` and `cat docs/claude-notes.md`, which trains the operator to
 * ignore the alarm — and an alarm that is ignored is worse than no alarm.
 */
export function inspectCommand(command: string): Violation | null {
  // Split into command segments on shell separators, then look only at the head
  // of each one.
  for (const segment of command.split(/(?:;|\|\||&&|\||\n)+/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    // Skip leading VAR=value assignments and passthrough wrappers.
    while (i < tokens.length) {
      const raw = tokens[i]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) { i++; continue; }
      const base = raw.replace(/^.*\//, '');
      if (PASSTHROUGH.includes(base)) { i++; continue; }
      break;
    }
    const head = tokens[i];
    if (!head) continue;
    const base = head.replace(/^.*\//, '');
    if (VENDOR_CLIS.includes(base)) {
      return {
        cli: base,
        command,
        reason:
          `Agent shelled out to the '${base}' CLI directly. That bypasses the vendor lane, ` +
          `the budget ledger and the router's harness choice. Dispatch goes through the supervisor.`,
      };
    }
  }
  return null;
}

/**
 * The tool whitelist for an agent that has no legitimate need for a shell.
 * acpx enforces this at the ACP layer: an agent that cannot run Bash cannot
 * invoke another vendor at all, which is prevention rather than detection and
 * costs one flag.
 */
export function allowedToolsFor(needsShell: boolean): string[] | undefined {
  if (needsShell) return undefined; // no restriction; detection applies instead
  return ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];
}

/**
 * Scan a stream of acpx NDJSON events for shell invocations worth halting on.
 *
 * Goes through the shared interpreter: an earlier version read `rawInput` off
 * the top level of the frame, where it never appears, so this control reported
 * clean on every run without ever having inspected a command.
 */
export function scanEvents(events: unknown[]): Violation[] {
  const out: Violation[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    const u = interpret((ev ?? {}) as AcpEvent);
    if (u.kind !== 'tool' || !u.command) continue;
    // tool_call and tool_call_update repeat the same command; report it once.
    if (seen.has(u.command)) continue;
    seen.add(u.command);
    const v = inspectCommand(u.command);
    if (v) out.push(v);
  }
  return out;
}
