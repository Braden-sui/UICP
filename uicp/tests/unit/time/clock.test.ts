import { describe, expect, it, vi, afterEach } from 'vitest';
import { formatClockDisplay, formatTimeZoneLabel, resolveLocalTimeZone } from '../../../src/lib/time/clock';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatClockDisplay', () => {
  it('formats time and date with leading zeros', () => {
    const sample = new Date(2024, 4, 6, 9, 5, 42);
    const result = formatClockDisplay(sample);
    expect(result.time).toBe('09:05');
    expect(result.date).toBe('Mon, May 06');
  });
});

describe('formatTimeZoneLabel', () => {
  it('formats a timezone identifier for display', () => {
    expect(formatTimeZoneLabel('America/New_York')).toBe('America · New York');
  });

  it('falls back when timezone is unavailable', () => {
    expect(formatTimeZoneLabel(null)).toBe('Local System Time');
  });
});

describe('resolveLocalTimeZone', () => {
  it('returns the timezone provided by Intl when available', () => {
    const mockFormatter = vi.fn(() => ({
      resolvedOptions: () => ({ timeZone: 'Test/Zone' }),
    }));
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(mockFormatter as unknown as typeof Intl.DateTimeFormat);

    expect(resolveLocalTimeZone()).toBe('Test/Zone');
    expect(mockFormatter).toHaveBeenCalled();
  });

  it('returns null when Intl throws an error', () => {
    const mockFormatter = vi.fn(() => {
      throw new Error('failed');
    });
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(mockFormatter as unknown as typeof Intl.DateTimeFormat);

    expect(resolveLocalTimeZone()).toBeNull();
  });
});
