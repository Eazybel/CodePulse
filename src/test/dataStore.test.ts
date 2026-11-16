import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { DataStore, StoredSession } from '../core/dataStore';
import { getLocalDateKey } from '../core/timeUtils';

function makeSession(id: string, start: Date, durationSeconds: number): StoredSession {
  return {
    id,
    start: start.getTime(),
    end: start.getTime() + durationSeconds * 1000,
    durationSeconds,
    project: 'demo',
    language: 'typescript',
    localDate: getLocalDateKey(start),
    localHour: start.getHours(),
    mode: 'alwaysOpen',
  };
}

describe('dashboard summary', () => {
  it('averages the week over the days active this week only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepulse-test-'));
    try {
      const store = new DataStore(dir);

      // Wednesday 2024-06-05; the week starts on Monday 2024-06-03.
      const now = new Date(2024, 5, 5, 12, 0, 0).getTime();

      store.appendSession(makeSession('old', new Date(2024, 5, 1, 10, 0, 0), 3600)); // previous week
      store.appendSession(makeSession('mon', new Date(2024, 5, 3, 10, 0, 0), 1800));
      store.appendSession(makeSession('tue', new Date(2024, 5, 4, 10, 0, 0), 3600));

      const summary = store.getDashboardSummary(now);

      assert.equal(summary.totalSecondsThisWeek, 5400);
      assert.equal(summary.activeDays, 3);
      assert.equal(summary.averageDailySeconds, 2700);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a zero average when nothing was tracked this week', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepulse-test-'));
    try {
      const store = new DataStore(dir);
      const now = new Date(2024, 5, 5, 12, 0, 0).getTime();

      store.appendSession(makeSession('old', new Date(2024, 4, 20, 10, 0, 0), 3600));

      assert.equal(store.getDashboardSummary(now).averageDailySeconds, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
