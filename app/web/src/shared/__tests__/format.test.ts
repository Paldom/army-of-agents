import { describe, expect, it } from 'vitest';
import { ago, bytes, when } from '@/shared/format';

describe('ago', () => {
  it('reports unknown rather than zero when the age is not known', () => {
    // An imported ask has no real age. "0s" would be a confident lie and it
    // breaks the primary sort key on the landing screen.
    expect(ago(null)).toBe('—');
    expect(ago(undefined)).toBe('—');
  });

  it('scales through seconds, minutes, hours and days', () => {
    expect(ago(5_000)).toBe('5s');
    expect(ago(90_000)).toBe('1m');
    expect(ago(3_600_000 + 120_000)).toBe('1h 02m');
    expect(ago(50 * 3_600_000)).toBe('2d 2h');
  });

  it('never renders a negative age', () => {
    expect(ago(-5_000)).toBe('0s');
  });
});

describe('bytes', () => {
  it('switches unit at the right boundaries', () => {
    expect(bytes(512)).toBe('512 B');
    expect(bytes(2048)).toBe('2.0 KB');
    expect(bytes(5 * 1048576)).toBe('5.0 MB');
  });
});

describe('when', () => {
  it('is empty-safe', () => {
    expect(when(null)).toBe('—');
    expect(when(0)).toBe('—');
  });
});
