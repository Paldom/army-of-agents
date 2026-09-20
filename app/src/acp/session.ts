import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import { type AcpEvent, interpret, parseNdjson } from './events.ts';

/**
 * The session layer: acpx drives every harness.
 *
 * 🔴 The constraint that shapes the whole HITL design, verified by reading
 * acpx's own `src/permissions.ts`: the `escalate` policy action does NOT wait
 * for a human. With no TTY — which is always true for a headless supervisor —
 * it emits a `permission_escalation` event and immediately answers with the
 * REJECT option. Escalation is "deny now, loudly", not "ask and wait".
 *
 * Therefore HITL here is AGENT-INITIATED, never permission-initiated: the agent
 * writes a question record and ENDS ITS TURN; the answer arrives in the next
 * prompt to that named session. ACP permissions are used only as a fail-closed
 * tool boundary (autoApprove / autoDeny), never as a question channel.
 */

export interface SessionSpec {
  /** Stable name. Named sessions are addressable and survive; unnamed are disposable. */
  name?: string;
  agent: string;          // acpx agent token
  cwd: string;
  /** The contract. Persisted by acpx in session_options.system_prompt on adapters that support it. */
  systemPrompt?: string;
  model?: string;
  effort?: string;
  allowedTools?: string[];
  timeoutSec?: number;
}

export type { AcpEvent } from './events.ts';

export interface PromptResult {
  ok: boolean;
  events: AcpEvent[];
  text: string;
  tokens?: number;
  /** Set when acpx reported a permission escalation — see the note above. */
  escalations: AcpEvent[];
  exitCode: number;
  stderr: string;
}

export interface Runner {
  /**
   * `onOutput` receives stdout as it arrives, so a turn can be read while it
   * is still running. Raw bytes, not lines: a chunk boundary can fall inside
   * a multi-byte character, and only the consumer knows how to reassemble.
   */
  run(
    args: string[],
    input?: string,
    onOutput?: (chunk: Buffer) => void,
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

/**
 * Reassemble the text an agent is writing, frame by frame, as it streams.
 * `onText` fires with the whole text so far whenever a complete new line has
 * arrived — which is exactly when a REPORT line becomes a line.
 */
export function textStream(onText: (textSoFar: string) => void): (chunk: Buffer) => void {
  const decoder = new StringDecoder('utf8');
  let carry = '';
  let text = '';
  let newlines = 1; // fire on the first completed line, not the first fragment
  return (chunk) => {
    carry += decoder.write(chunk);
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        const u = interpret(JSON.parse(t) as AcpEvent);
        if (u.kind === 'text') text += u.text;
      } catch {
        /* a partial or malformed frame is not worth losing the stream over */
      }
    }
    const count = text.split('\n').length;
    if (count > newlines) {
      newlines = count;
      onText(text);
    }
  };
}

/** The one place the binary is named; the pane and the doctor read the same setting. */
export const acpxBin = (): string => process.env['AOA_ACPX_BIN'] ?? 'acpx';

/** Real acpx. Injected so the dispatcher is testable without spawning a harness. */
export const acpxRunner: Runner = {
  run(args, input, onOutput) {
    return new Promise((resolve) => {
      const child = spawn(acpxBin(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
      // Concatenated as bytes and decoded once: appending chunk by chunk
      // decodes each on its own, and a multi-byte character split across two
      // chunks came out as two replacement characters.
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => {
        out.push(d);
        onOutput?.(d);
      });
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.on('close', (code) =>
        resolve({
          code: code ?? -1,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
        }),
      );
      if (input !== undefined) child.stdin.write(input);
      child.stdin.end();
    });
  },
};

function baseArgs(spec: SessionSpec): string[] {
  const a = ['--cwd', spec.cwd];
  if (spec.systemPrompt) a.push('--system-prompt', spec.systemPrompt);
  if (spec.model) a.push('--model', spec.model);
  if (spec.allowedTools) a.push('--allowed-tools', spec.allowedTools.join(','));
  if (spec.timeoutSec) a.push('--timeout', String(spec.timeoutSec));
  return a;
}

/**
 * Idempotent. Safe to call before every prompt, which is what makes a named
 * session a durable property of an agent rather than something to track.
 */
export async function ensureSession(r: Runner, spec: SessionSpec): Promise<boolean> {
  if (!spec.name) return true;
  const res = await r.run([
    ...baseArgs(spec),
    spec.agent,
    'sessions',
    'ensure',
    '--name',
    spec.name,
  ]);
  if (res.code !== 0) return false;
  if (spec.effort) {
    // Only meaningful where the adapter advertises it; failure is not fatal.
    await r.run([...baseArgs(spec), spec.agent, 'set', 'reasoning_effort', spec.effort, '-s', spec.name]);
  }
  return true;
}

/** Structured NDJSON so the workspace can stream a run live rather than scrape it. */
export async function prompt(
  r: Runner,
  spec: SessionSpec,
  text: string,
  onOutput?: (chunk: Buffer) => void,
): Promise<PromptResult> {
  const args = [
    ...baseArgs(spec),
    '--approve-all',
    '--format',
    'json',
    '--json-strict',
    '--suppress-reads',
    spec.agent,
  ];
  if (spec.name) args.push('-s', spec.name);
  args.push('-f', '-');

  const res = await r.run(args, text, onOutput);
  return parsePromptOutput(res.stdout, res.code, res.stderr);
}

/**
 * Turn a raw NDJSON capture into a result.
 *
 * Split out from `prompt()` because a turn can outlive the process that
 * launched it: after a supervisor restart the capture file is all that is
 * left of a run, and finalising it must produce exactly the same result as if
 * the original poll had seen it.
 */
export function parsePromptOutput(stdout: string, code: number, stderr = ''): PromptResult {
  const events = parseNdjson(stdout);

  // Text arrives in chunks; a single chunk is a fragment of a word, so only the
  // concatenation is meaningful. Usage reports context occupancy, which is the
  // number the workspace shows and the only one the adapter gives us.
  let textOut = '';
  let tokens = 0;
  const escalations: AcpEvent[] = [];
  for (const e of events) {
    const u = interpret(e);
    if (u.kind === 'text') textOut += u.text;
    else if (u.kind === 'usage') tokens = u.used;
    else if (u.kind === 'permission') escalations.push(e);
  }

  return {
    ok: code === 0,
    events,
    text: textOut,
    ...(tokens > 0 ? { tokens } : {}),
    escalations,
    exitCode: code,
    stderr,
  };
}

/**
 * A disposable, unnamed session: review, cross-check, alternative generation.
 * No name, no memory — which is exactly how "grade it by something it cannot
 * edit" is implemented, since the reviewer is a different session under a
 * different contract that cannot write what it reviews.
 */
export async function execOnce(
  r: Runner,
  spec: Omit<SessionSpec, 'name'>,
  text: string,
): Promise<PromptResult> {
  return prompt(r, { ...spec }, text);
}

/** Classify a vendor refusal so the lane, not the agent, takes the backoff. */
export function detectRateLimit(res: PromptResult): { limited: boolean; retryAfterMs?: number } {
  const hay = `${res.stderr}\n${res.text}`.toLowerCase();
  const limited =
    /usage limit|quota reached|rate limit|429|402|balance exhausted|session limit|billing cycle/.test(
      hay,
    );
  if (!limited) return { limited: false };
  const hours = /resets? in (\d+)\s*h/.exec(hay);
  if (hours?.[1]) return { limited: true, retryAfterMs: Number(hours[1]) * 3_600_000 };
  return { limited: true, retryAfterMs: 3_600_000 };
}
