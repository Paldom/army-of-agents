import { type Outcome, isOutcome } from './state.ts';

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
 * calling worth the name. One table of markers, one parser: a new verb is a
 * row here and a case in `report.ts`, nowhere else.
 */
export const MARKERS = ['OUTCOME', 'ASK', 'OPTIONS', 'REPORT', 'NOTIFY', 'SEND', 'PROPOSE'] as const;
export type Marker = (typeof MARKERS)[number];

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

**Report progress as you go.** A REPORT line is posted to your thread the moment
you write it, while you are still working, so the owner can follow along without
waiting for the turn to end. One line per step; keep it factual.

    REPORT: Closed 2 duplicate issues; starting on #112.

**Alert the owner without waiting** for something they should see but need not
answer. It never blocks you and it is not an ask:

    NOTIFY: The release branch has a failing test that predates my change.

**Message another agent** by slug. It lands in that agent's inbox and wakes it
because you named it. Say what you need; do not relay a message you merely
received.

    SEND: @docs-librarian The auth section needs the new token flow.

**To ask the owner something, write an ASK block and END YOUR TURN.** Do not
wait for an answer — nothing in this environment can deliver one mid-turn, and
a permission escalation is auto-answered with the reject option. The answer
arrives in your next wake, under "Decisions the owner made for you".

    ASK: Should the report include last quarter's figures?
    OPTIONS: yes | no | only if the source is cited

OPTIONS is optional; with it the owner picks one, without it they type a reply.
One ASK per line. Ask only what you genuinely cannot decide: every ask costs a
human their attention.

Everything else you write is kept as this turn's report. Never put a secret —
a token, a password, a key — in any line; the thread is read by people and by
other agents.`;

export interface MarkerLine {
  marker: Marker;
  text: string;
  /** Zero-based line number in the text it was parsed from. */
  line: number;
}

/** Built from the table, so a new marker is one entry above and one case in report.ts. */
const MARKER_RE = new RegExp(`^\\s*(${MARKERS.join('|')}):\\s*(.*?)\\s*$`);
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * The orchestrator's plan vocabulary, shown in its contract. A fictional slug
 * on purpose: these lines are recognised as examples and never filed, so a
 * real agent must not share the name.
 */
export const PROPOSE_EXAMPLES = [
  'pause example-agent',
  'resume example-agent',
  'retire example-agent',
  'create an agent called example-agent that drafts release notes daily',
  'backlog: pin the test runner version',
  're-rank the backlog',
];

/** Walk the lines, skipping fenced blocks; `each` sees only quotable lines. */
function scan(text: string, each: (line: string, i: number) => void): void {
  // Inside a fence an agent is quoting something — a file it read, a log —
  // and a NOTIFY: in there is not the agent notifying anyone.
  let fenced = false;
  text.split('\n').forEach((l, i) => {
    if (FENCE_RE.test(l)) {
      fenced = !fenced;
      return;
    }
    if (!fenced) each(l, i);
  });
}

function rawLines(text: string): MarkerLine[] {
  const out: MarkerLine[] = [];
  scan(text, (l, i) => {
    const m = MARKER_RE.exec(l);
    if (m && m[2]) out.push({ marker: m[1] as Marker, text: m[2], line: i });
  });
  return out;
}

/**
 * The protocol's own examples, and the orchestrator contract's. Agents quote
 * the menu back verbatim often enough that an example line has to be
 * recognised as one, or every run "reports" that it closed two duplicate
 * issues — or, worse, pauses an agent because its contract said it could.
 */
const EXAMPLES = new Set([
  ...rawLines(PROTOCOL).map((l) => `${l.marker}:${l.text}`),
  ...PROPOSE_EXAMPLES.map((e) => `PROPOSE:${e}`),
]);

/** Every marker line in the text, examples and placeholders removed. */
export function parseMarkers(text: string): MarkerLine[] {
  return rawLines(text).filter(
    (l) => !EXAMPLES.has(`${l.marker}:${l.text}`) && !l.text.startsWith('<'),
  );
}

/** What remains once the markers are taken out: the turn's own report. Quoted text is kept whole. */
export function stripMarkers(text: string): string {
  const drop = new Set<number>();
  scan(text, (l, i) => {
    if (MARKER_RE.test(l)) drop.add(i);
  });
  return text
    .split('\n')
    .filter((_, i) => !drop.has(i))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface ParsedAsk {
  prompt: string;
  options?: string[];
}

/**
 * Read the outcome the agent declared. Absent or unrecognised means NO_WORK:
 * an agent that did not say it made progress is not assumed to have made any.
 */
export function parseOutcome(text: string): Outcome {
  // The LAST one wins — agents quote the menu above before choosing — and a
  // quoted or fenced one is not a choice at all.
  const declared = parseMarkers(text).filter((m) => m.marker === 'OUTCOME' && isOutcome(m.text));
  return (declared.at(-1)?.text as Outcome | undefined) ?? 'NO_WORK';
}

/** Read the questions the agent filed this turn. OPTIONS binds to the ASK directly above it. */
export function parseAsks(text: string): ParsedAsk[] {
  const out: ParsedAsk[] = [];
  const lines = parseMarkers(text);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.marker !== 'ASK') continue;
    const ask: ParsedAsk = { prompt: l.text };
    const next = lines[i + 1];
    if (next && next.marker === 'OPTIONS' && next.line === l.line + 1) {
      const options = next.text.split('|').map((s) => s.trim()).filter(Boolean);
      if (options.length > 1) ask.options = options;
      i++;
    }
    out.push(ask);
  }
  return out;
}
