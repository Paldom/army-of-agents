/**
 * Status is DERIVED, never stored — so it can never disagree with the runs it
 * describes. The UI additionally needs the *why*, not just the label: an agent
 * that is merely backing off looks identical to a stuck one unless the reason
 * is rendered next to it.
 *
 * The distinction the whole product hangs on:
 *   WAITING_HUMAN / BLOCKED     -> you are the blocker      (badges, notifies)
 *   everything else             -> nothing is wrong         (never badges)
 */
import type { RunState } from './state.ts';

export const DERIVED_STATUSES = [
  'RUNNING',
  'WAITING_HUMAN',
  'BLOCKED',
  'WAITING_RESOURCE',
  'BACKING_OFF',
  'SCHEDULED',
  'DUE',
  'WAITING_EVENT',
  'MANUAL',
  'PAUSED',
  'RETIRED',
  'DRAFT',
] as const;
export type DerivedStatus = (typeof DERIVED_STATUSES)[number];

/** The only two that may badge, count or raise a notification. */
export const BLOCKER_STATUSES: readonly DerivedStatus[] = ['WAITING_HUMAN', 'BLOCKED'];

export function isBlockingHuman(s: DerivedStatus): boolean {
  return BLOCKER_STATUSES.includes(s);
}

export interface DerivationInput {
  status: string;                   // lifecycle: DRAFT|ACTIVE|PAUSED|RETIRED
  wakeKind: string;
  nextDueAt: number | null;
  wakeReason: string | null;
  idleStreak: number;
  liveRunState: RunState | null;
  laneBlockedUntil: number | null;  // from provider_gates
  nowMs: number;
}

export interface Derivation {
  status: DerivedStatus;
  /** Plain-English reason, rendered beside the label. Never omit it. */
  why: string;
}

export function derive(i: DerivationInput): Derivation {
  if (i.status === 'RETIRED') return { status: 'RETIRED', why: 'Retired by a human.' };
  if (i.status === 'PAUSED') return { status: 'PAUSED', why: 'Paused by a human. Only a human resumes it.' };
  if (i.status === 'DRAFT') return { status: 'DRAFT', why: 'Defined but never activated.' };

  if (i.liveRunState === 'waiting_human') {
    return {
      status: 'WAITING_HUMAN',
      why: 'It asked a question and released its session. Nothing is pending; nothing will retry. Only a verdict from you moves it.',
    };
  }
  if (i.liveRunState && !['continue', 'completed', 'failed'].includes(i.liveRunState)) {
    return { status: 'RUNNING', why: `A run is in flight (${i.liveRunState}).` };
  }

  if (i.laneBlockedUntil !== null && i.laneBlockedUntil > i.nowMs) {
    return {
      status: 'WAITING_RESOURCE',
      why: 'Its vendor lane is capped or cooling. Nothing is broken — it is waiting.',
    };
  }

  // next_due_at IS NULL means different things, and conflating them is how a
  // healthy event-driven agent gets displayed as stuck. wake_reason disambiguates.
  if (i.nextDueAt === null) {
    if (i.wakeReason === 'human') {
      return { status: 'BLOCKED', why: 'No next wake is scheduled. Only a human unblocks it.' };
    }
    if (i.wakeKind === 'manual') return { status: 'MANUAL', why: 'Starts only when a human says so.' };
    if (i.wakeKind === 'on_message') {
      return { status: 'WAITING_EVENT', why: 'Event-driven. Waiting for a message to arrive.' };
    }
    return { status: 'WAITING_EVENT', why: 'Waiting on an external event.' };
  }

  if (i.nextDueAt <= i.nowMs) return { status: 'DUE', why: 'Due now; the next tick will dispatch it.' };

  if (i.idleStreak > 0) {
    return {
      status: 'BACKING_OFF',
      why: `Nothing to do ${i.idleStreak} time(s) in a row; backing off. Next check ${fmt(i.nextDueAt - i.nowMs)}.`,
    };
  }
  return { status: 'SCHEDULED', why: `Scheduled. Next run ${fmt(i.nextDueAt - i.nowMs)}.` };
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  return `in ${Math.round(m / 60)}h`;
}
