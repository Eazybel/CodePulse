import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatDuration, splitIntervalAtMidnight } from '../core/timeUtils';

describe('time utilities', () => {
  it('formats short durations', () => {
    assert.equal(formatDuration(61), '1m 1s');
    assert.equal(formatDuration(3661), '1h 1m 1s');
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
});
