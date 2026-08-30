import { describe, expect, it } from 'vitest';
import { blocksHuman, toneOf } from '@/shared/api/types';
import type { DerivedStatus } from '@/shared/api/types';

describe('status tone', () => {
  it('gives the blocker tone to exactly the two statuses that mean YOU are the blocker', () => {
    const blockers: DerivedStatus[] = ['WAITING_HUMAN', 'BLOCKED'];
    for (const s of blockers) {
      expect(toneOf(s)).toBe('blocker');
      expect(blocksHuman(s)).toBe(true);
    }
  });

  it('does not badge anything that merely means nothing is wrong', () => {
    // Collapsing these into the blocker group rebuilds the problem the whole
    // product exists to solve.
    const fine: DerivedStatus[] = [
      'WAITING_RESOURCE', 'BACKING_OFF', 'SCHEDULED', 'WAITING_EVENT', 'MANUAL', 'PAUSED', 'RETIRED', 'DRAFT',
    ];
    for (const s of fine) {
      expect(blocksHuman(s)).toBe(false);
      expect(toneOf(s)).toBe('quiet');
    }
  });

  it('marks work in flight as working, not as a blocker', () => {
    expect(toneOf('RUNNING')).toBe('working');
    expect(toneOf('DUE')).toBe('working');
    expect(blocksHuman('RUNNING')).toBe(false);
  });
});
