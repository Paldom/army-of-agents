/**
 * The ACP wire format, normalised once.
 *
 * `acpx --format json` does not emit a friendly event stream — it emits the raw
 * ACP JSON-RPC traffic. Everything interesting arrives as `session/update`
 * notifications with the real discriminator at `params.update.sessionUpdate`,
 * and assistant text arrives as CHUNKS that only mean something concatenated.
 *
 * Three separate readers each guessed a flatter shape and each silently matched
 * nothing: the outcome parser saw empty text and classified every run NO_WORK,
 * the vendor guard scanned a `rawInput` key that is one level down and so never
 * fired, and the terminal pane rendered a blank screen while a real agent was
 * working. One parser, verified against a captured stream, is what stops that
 * class of bug recurring per-consumer.
 */

export interface AcpEvent {
  [k: string]: unknown;
}

export type AcpUpdate =
  | { kind: 'text'; text: string }
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; toolName: string; status: string; command: string }
  | { kind: 'usage'; used: number; size: number }
  | { kind: 'permission'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'other' };

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/** Normalise one NDJSON frame. Unknown frames become `other` rather than noise. */
export function interpret(e: AcpEvent): AcpUpdate {
  const method = String(e['method'] ?? '');

  // A permission request that reaches us at all means the policy escalated;
  // with --approve-all acpx answers these itself and they never appear.
  if (method === 'session/request_permission') {
    return { kind: 'permission', text: JSON.stringify(e['params'] ?? {}).slice(0, 300) };
  }
  if (e['error']) return { kind: 'error', text: JSON.stringify(e['error']).slice(0, 300) };
  if (method !== 'session/update') return { kind: 'other' };

  const u = obj(obj(e['params'])['update']);
  switch (String(u['sessionUpdate'] ?? '')) {
    case 'agent_message_chunk':
      return { kind: 'text', text: String(obj(u['content'])['text'] ?? '') };
    case 'agent_thought_chunk':
      return { kind: 'thought', text: String(obj(u['content'])['text'] ?? '') };
    case 'tool_call':
    case 'tool_call_update': {
      const raw = obj(u['rawInput']);
      return {
        kind: 'tool',
        toolName: String(obj(obj(u['_meta'])['claudeCode'])['toolName'] ?? u['title'] ?? 'tool'),
        status: String(u['status'] ?? ''),
        command: String(raw['command'] ?? ''),
      };
    }
    case 'usage_update':
      return { kind: 'usage', used: Number(u['used'] ?? 0), size: Number(u['size'] ?? 0) };
    default:
      return { kind: 'other' };
  }
}

/** Parse an NDJSON buffer into frames, tolerating partial trailing lines. */
export function parseNdjson(text: string): AcpEvent[] {
  const out: AcpEvent[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      out.push(JSON.parse(t) as AcpEvent);
    } catch {
      /* a partial line is not a failure of the run */
    }
  }
  return out;
}
