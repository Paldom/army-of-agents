import type { Outcome } from './state.ts';

/**
 * One wake model for continuous and scheduled agents alike.
 *
 * The temptation is to special-case: scheduled agents get an rrule, continuous
 * agents get a `while true`. That produces two code paths, two failure modes,
 * and a continuous agent that burns a subscription doing nothing. Instead every
 * agent has one wake spec and the tick answers one question: is it due?
 *
 * A continuous agent is NOT a zero-delay scheduled agent — that is a quota
 * feedback loop. Continuous means "floor, then back off when there is nothing
 * to do".
 */
export type WakePolicy =
  | { kind: 'continuous'; minIntervalMs: number; backoff: { baseMs: number; maxMs: number; factor: number } }
  | { kind: 'schedule'; everyMs: number }
  | { kind: 'on_message'; from?: string[] }
  | { kind: 'manual' };

export const DEFAULT_CONTINUOUS: WakePolicy = {
  kind: 'continuous',
  minIntervalMs: 60_000,
  backoff: { baseMs: 60_000, maxMs: 3_600_000, factor: 2 },
};

export function parseWake(json: string): WakePolicy {
  const w = JSON.parse(json) as WakePolicy;
  if (!w || typeof w !== 'object' || !('kind' in w)) throw new Error('bad wake policy');
  return w;
}

export interface NextWake {
  /** epoch ms, or null meaning "no next wake at all — only an insert moves it" */
  nextDueAt: number | null;
  wakeReason: 'schedule' | 'backoff' | 'event' | 'manual' | 'human';
  idleStreak: number;
  errorStreak: number;
}

/**
 * Deterministic given (policy, outcome, streaks, now, jitter). Pure so the
 * backoff curve is testable without a clock or a database.
 */
export function computeNextWake(
  policy: WakePolicy,
  outcome: Outcome,
  prev: { idleStreak: number; errorStreak: number },
  nowMs: number,
  jitter = 0,
): NextWake {
  const clampJitter = Math.min(Math.max(jitter, 0), 1);

  if (outcome === 'BLOCKED') {
    // No next wake AT ALL. A blocked agent costs exactly nothing; it is woken by
    // an insert — a verdict row — and that bump is written by the same
    // transaction that records the verdict, so there is no second path to forget.
    return { nextDueAt: null, wakeReason: 'human', idleStreak: prev.idleStreak, errorStreak: 0 };
  }

  if (outcome === 'RATE_LIMITED') {
    // The vendor lane backs off, not this agent alone. The gate is durable and
    // shared; the agent simply is not due until the lane reopens.
    return { nextDueAt: null, wakeReason: 'event', idleStreak: prev.idleStreak, errorStreak: 0 };
  }

  if (outcome === 'RETRYABLE_ERROR') {
    const errorStreak = prev.errorStreak + 1;
    const delay = Math.min(30_000 * 2 ** (errorStreak - 1), 900_000);
    return { nextDueAt: nowMs + delay, wakeReason: 'backoff', idleStreak: prev.idleStreak, errorStreak };
  }

  switch (policy.kind) {
    case 'manual':
      return { nextDueAt: null, wakeReason: 'manual', idleStreak: 0, errorStreak: 0 };

    case 'on_message':
      return { nextDueAt: null, wakeReason: 'event', idleStreak: 0, errorStreak: 0 };

    case 'schedule': {
      // After downtime, fire ONCE — never replay every missed tick. An agent due
      // fourteen times while the box was off should not wake fourteen times.
      const next = nowMs + policy.everyMs;
      return { nextDueAt: next, wakeReason: 'schedule', idleStreak: 0, errorStreak: 0 };
    }

    case 'continuous': {
      if (outcome === 'WORK_DONE') {
        return {
          nextDueAt: nowMs + policy.minIntervalMs,
          wakeReason: 'schedule',
          idleStreak: 0,
          errorStreak: 0,
        };
      }
      // NO_WORK: decay from once-a-minute toward once-an-hour. This backoff is
      // the only thing standing between "runs forever" and "exhausts the
      // subscription by lunchtime".
      const idleStreak = prev.idleStreak + 1;
      const { baseMs, maxMs, factor } = policy.backoff;
      const raw = baseMs * factor ** (idleStreak - 1);
      const capped = Math.min(raw, maxMs);
      const spread = Math.round(capped * 0.1 * clampJitter);
      return {
        nextDueAt: nowMs + capped + spread,
        wakeReason: 'backoff',
        idleStreak,
        errorStreak: 0,
      };
    }
  }
}

/** Missed occurrences coalesce: due-in-the-past means due once, now. */
export function isDue(nextDueAt: number | null, nowMs: number): boolean {
  return nextDueAt !== null && nextDueAt <= nowMs;
}
