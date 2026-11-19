import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { DataStore, StoredSession } from '../core/dataStore';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codepulse-daily-'));
  temporaryDirectories.push(directory);
  return directory;
}

function makeSession(id: string, startDate: Date, durationSeconds: number): StoredSession {
  const start = startDate.getTime();
  return {
    id,
    start,
    end: start + durationSeconds * 1000,
    durationSeconds,
    project: 'demo',
    language: 'typescript',
    localDate: [
      startDate.getFullYear(),
      String(startDate.getMonth() + 1).padStart(2, '0'),
      String(startDate.getDate()).padStart(2, '0'),
    ].join('-'),
    localHour: startDate.getHours(),
    mode: 'alwaysOpen',
  };
}

describe('per-day breakdown for weekly and monthly modes', () => {
  it('weekly mode returns Monday to Sunday with weekday names and totals per day', async () => {
    const directory = await makeTemporaryDirectory();
    const store = new DataStore(directory);
    // Wednesday 2026-11-18 is "today"; its week runs Mon 16 Nov to Sun 22 Nov.
    store.appendSession(makeSession('monday', new Date(2026, 10, 16, 10), 120));
    store.appendSession(makeSession('wednesday', new Date(2026, 10, 18, 14), 300));
    await store.flush();

    const now = new Date(2026, 10, 18, 16).getTime();
    const summary = store.getDashboardSummary(now, 120, 'week');

    assert.deepEqual(summary.dailyBreakdown.map((bucket) => bucket.label),
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    assert.deepEqual(summary.dailyBreakdown.map((bucket) => bucket.seconds),
      [120, 0, 300, 0, 0, 0, 0]);
    assert.equal(summary.dailyBreakdown[0].date, '2026-11-16');
    assert.equal(summary.dailyBreakdown.map((bucket) => bucket.isToday).indexOf(true), 2);
  });

  it('monthly mode returns one bar per day of the month', async () => {
    const directory = await makeTemporaryDirectory();
    const store = new DataStore(directory);
    store.appendSession(makeSession('first', new Date(2026, 10, 1, 10), 60));
    store.appendSession(makeSession('sixteenth', new Date(2026, 10, 16, 10), 180));
    await store.flush();

    const now = new Date(2026, 10, 16, 16).getTime();
    const summary = store.getDashboardSummary(now, 120, 'month');

    assert.equal(summary.dailyBreakdown.length, 30); // November has 30 days
    assert.equal(summary.dailyBreakdown[0].label, '1');
    assert.equal(summary.dailyBreakdown[29].label, '30');
    assert.equal(summary.dailyBreakdown[0].seconds, 60);
    assert.equal(summary.dailyBreakdown[15].seconds, 180);
    assert.equal(summary.dailyBreakdown[15].isToday, true);
  });

  it('daily mode keeps the hourly view and has no per-day breakdown', async () => {
    const directory = await makeTemporaryDirectory();
    const store = new DataStore(directory);
    store.appendSession(makeSession('today', new Date(2026, 10, 16, 10), 60));
    await store.flush();

    const summary = store.getDashboardSummary(new Date(2026, 10, 16, 16).getTime(), 120, 'day');
    assert.deepEqual(summary.dailyBreakdown, []);
    assert.equal(summary.hourlyActivity.length, 24);
  });
});
