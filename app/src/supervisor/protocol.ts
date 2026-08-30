import { type Outcome } from './state.ts';

/**
 * The contract between the loop and the agent, in the only place the agent
 * actually reads: its prompt.
 *
 * Both halves of this were previously asserted on one side only. Dispatch
 * matched `/OUTCOME:/` against a marker nothing had ever asked for, so every
 * run fell through to NO_WORK and backed off as if idle. And `ask()` existed
 * with no caller but the importer, so a working agent had no way to reach a
 * human at all — which is the one thing this system is for.
 *
 * The markers are plain text rather than a tool call because they must work
 * identically on every harness acpx can drive, including ones with no tool
 * calling worth the name.
 */
export const PROTOCOL = `## How this loop works

You are one iteration of a continuous loop. You will be woken again with this
same contract and a summary of what you did; you are not expected to finish
everything now.

**End every turn with an outcome line.** It sets when you are woken next:

    OUTCOME: WORK_DONE        you moved the work forward
    OUTCOME: NO_WORK          there was nothing to do (you will be woken later)
    OUTCOME: BLOCKED          you need a human and have asked below
    OUTCOME: RETRYABLE_ERROR  something failed that may work next time

Omitting it is read as NO_WORK, which backs you off as if you were idle.

**To ask the owner something, write an ASK block and END YOUR TURN.** Do not
wait for an answer — nothing in this environment can deliver one mid-turn, and
a permission escalation is auto-answered with the reject option. The answer
arrives in your next wake, under "Decisions the owner made for you".

    ASK: Should the report include last quarter's figures?
    OPTIONS: yes | no | only if the source is cited

OPTIONS is optional; with it the owner picks one, without it they type a reply.
One ASK per line. Ask only what you genuinely cannot decide: every ask costs a
human their attention.`;

export interface ParsedAsk {
  prompt: string;
  options?: string[];
}

/**
 * Read the outcome the agent declared. Absent or unrecognised means NO_WORK:
 * an agent that did not say it made progress is not assumed to have made any.
 */
export function parseOutcome(text: string): Outcome {
  // The LAST occurrence wins — agents quote the menu above before choosing.
  const all = [...text.matchAll(/^\s*OUTCOME:\s*(WORK_DONE|NO_WORK|BLOCKED|RATE_LIMITED|RETRYABLE_ERROR)\s*$/gm)];
  return (all.at(-1)?.[1] as Outcome | undefined) ?? 'NO_WORK';
}

/** Read the questions the agent filed this turn. */
export function parseAsks(text: string): ParsedAsk[] {
  const out: ParsedAsk[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*ASK:\s*(.+?)\s*$/.exec(lines[i]!);
    if (!m) continue;
    const prompt = m[1]!;
    // Skip the example in the protocol block, echoed back verbatim often enough
    // to matter, and any ask with nothing in it.
    if (!prompt || prompt.startsWith('<') || prompt === 'Should the report include last quarter\'s figures?') continue;
    const ask: ParsedAsk = { prompt };
    const next = /^\s*OPTIONS:\s*(.+?)\s*$/.exec(lines[i + 1] ?? '');
    if (next) {
      const options = next[1]!.split('|').map((s) => s.trim()).filter(Boolean);
      if (options.length > 1) ask.options = options;
      i++;
    }
    out.push(ask);
  }
  return out;
}
