import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatDuration,
  formatDurationMinutes,
  getTimeframeRange,
  splitIntervalAtMidnight,
} from '../core/timeUtils';

describe('time utilities', () => {
  it('formats short durations', () => {
    assert.equal(formatDuration(61), '1m 1s');
    assert.equal(formatDuration(3661), '1h 1m 1s');
  });

  it('formats elapsed minutes without seconds', () => {
    assert.equal(formatDurationMinutes(0), '0m');
    assert.equal(formatDurationMinutes(59), '59m');
    assert.equal(formatDurationMinutes(60), '1h');
    assert.equal(formatDurationMinutes(62), '1h 2m');
  });

  it('splits intervals at local midnight boundaries', () => {
    const start = new Date(2024, 5, 1, 23, 30, 0).getTime();
    const end = new Date(2024, 5, 2, 0, 45, 0).getTime();

    const segments = splitIntervalAtMidnight(start, end);

    assert.equal(segments.length, 2);
    assert.equal(segments[0].dateKey, '2024-06-01');
    assert.equal(segments[1].dateKey, '2024-06-02');
    assert.equal(segments[0].end - segments[0].start, 30 * 60 * 1000);
    assert.equal(segments[1].end - segments[1].start, 45 * 60 * 1000);
  });

  it('splits elapsed time across a daylight-saving transition without adding or losing time', () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const start = new Date(2024, 2, 10, 1, 30).getTime();
      const end = new Date(2024, 2, 10, 3, 30).getTime();
      const segments = splitIntervalAtMidnight(start, end);

      assert.equal(end - start, 60 * 60 * 1000);
      assert.equal(segments.reduce((total, segment) => total + segment.end - segment.start, 0), end - start);
      assert.ok(segments.every((segment) => segment.dateKey === '2024-03-10'));
    } finally {
      if (previousTimezone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = previousTimezone;
      }
    }
  });

  it('returns local calendar boundaries for daily, weekly, and monthly timeframes', () => {
    const now = new Date(2026, 10, 16, 13, 30).getTime();

    assert.equal(getTimeframeRange('day', now).startDate, '2026-11-16');
    assert.equal(getTimeframeRange('week', now).startDate, '2026-11-16');
    assert.equal(getTimeframeRange('month', now).startDate, '2026-11-01');
    assert.equal(getTimeframeRange('day', now).endDate, '2026-11-16');
  });

  it('returns no segments for invalid or reversed intervals', () => {
    assert.deepEqual(splitIntervalAtMidnight(Number.NaN, 10), []);
    assert.deepEqual(splitIntervalAtMidnight(20, 10), []);
  });
});
