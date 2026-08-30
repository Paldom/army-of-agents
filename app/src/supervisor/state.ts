/**
 * The run state machine, and the outcome vocabulary that drives wake policy.
 *
 * There is exactly ONE state machine here. An agent does not get a second,
 * richer one: two machines that can disagree is the 3am page. Everything about
 * an agent's operational status is DERIVED at read time (see derived.ts) so it
 * cannot contradict the runs it describes.
 */

export const RUN_STATES = [
  'ready',
  'dispatching',
  'collecting',
  'evaluating',
  'waiting_human',
  'continue',
  'paused',
  'completed',
  'failed',
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL: readonly RunState[] = ['continue', 'completed', 'failed'];

/** Legal transitions. `assertLegal` throws rather than silently accepting. */
const LEGAL: Record<RunState, readonly RunState[]> = {
  ready: ['dispatching', 'failed', 'paused'],
  dispatching: ['collecting', 'failed', 'paused'],
  collecting: ['collecting', 'evaluating', 'ready', 'failed'],
  evaluating: ['waiting_human', 'continue', 'completed', 'failed'],
  waiting_human: ['continue', 'completed', 'failed', 'paused'],
  paused: ['ready', 'failed'],
  continue: [],
  completed: [],
  failed: [],
};

export function isLegal(from: RunState, to: RunState): boolean {
  return (LEGAL[from] ?? []).includes(to);
}

export function assertLegal(from: RunState, to: RunState): void {
  if (!isLegal(from, to)) {
    throw new Error(`illegal run transition ${from} -> ${to}`);
  }
}

/**
 * Every run must classify itself. Without this, every terminated run looks like
 * WORK_DONE, the agent wakes at the floor forever, and the system becomes the
 * exact quota feedback loop the backoff exists to prevent. The outcome is not
 * optional.
 */
export const OUTCOMES = [
  'WORK_DONE',
  'NO_WORK',
  'RATE_LIMITED',
  'BLOCKED',
  'RETRYABLE_ERROR',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export function isOutcome(v: unknown): v is Outcome {
  return typeof v === 'string' && (OUTCOMES as readonly string[]).includes(v);
}
