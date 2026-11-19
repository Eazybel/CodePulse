import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { DataStore, StoredSession } from '../core/dataStore';
import { getCustomTimeframeRange, isIdleAt, isValidCustomRange, parseDateKey } from '../core/timeUtils';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true }),
  ));
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codepulse-features-'));
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
    project: `project-${id}`,
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

describe('idle detection', () => {
  it('counts time while activity is recent', () => {
    assert.equal(isIdleAt(0, 4 * 60_000, 5), false);
  });

  it('stops counting after the timeout with no activity', () => {
    assert.equal(isIdleAt(0, 6 * 60_000, 5), true);
  });

  it('never idles when the timeout is 0', () => {
    assert.equal(isIdleAt(0, 10 * 60 * 60_000, 0), false);
  });
});

describe('custom date ranges', () => {
  it('rejects impossible dates and reversed ranges', () => {
    assert.equal(parseDateKey('2026-02-30'), undefined);
    assert.notEqual(parseDateKey('2026-02-28'), undefined);
    assert.equal(isValidCustomRange({ startDate: '2026-11-10', endDate: '2026-11-01' }), false);
    assert.equal(isValidCustomRange({ startDate: '2026-11-01', endDate: '2026-11-10' }), true);
  });

  it('summarises only the chosen days', async () => {
    const store = new DataStore(await makeTemporaryDirectory());
    store.appendSession(makeSession('inside', new Date(2026, 10, 5, 10), 600));
    store.appendSession(makeSession('outside', new Date(2026, 10, 16, 10), 900));
    await store.flush();

    const summary = store.getDashboardSummary(
      new Date(2026, 10, 16, 16).getTime(),
      120,
      'custom',
      { startDate: '2026-11-01', endDate: '2026-11-10' },
    );
    assert.equal(summary.timeframe, 'custom');
    assert.equal(summary.totalSeconds, 600);
    assert.deepEqual(summary.dailyBreakdown, []);
  });

  it('exports only the chosen days', async () => {
    const directory = await makeTemporaryDirectory();
    const store = new DataStore(directory);
    store.appendSession(makeSession('inside', new Date(2026, 10, 5, 10), 600));
    store.appendSession(makeSession('outside', new Date(2026, 10, 16, 10), 900));
    await store.flush();

    const target = path.join(directory, 'custom.json');
    await store.exportData(target, 'json', 'custom', undefined, { startDate: '2026-11-01', endDate: '2026-11-10' });
    const exported = JSON.parse(await fs.readFile(target, 'utf8')) as { sessions: StoredSession[] };
    assert.deepEqual(exported.sessions.map((session) => session.id), ['inside']);
  });

  it('covers both end days in full', () => {
    const range = getCustomTimeframeRange({ startDate: '2026-11-01', endDate: '2026-11-10' });
    assert.equal(new Date(range.end).getHours(), 23);
    assert.equal(range.endDate, '2026-11-10');
  });
});

describe('activity heatmap and recent sessions', () => {
  it('returns twelve full Monday-to-Sunday weeks ending in the current week', async () => {
    const store = new DataStore(await makeTemporaryDirectory());
    store.appendSession(makeSession('today', new Date(2026, 10, 18, 10), 1200));
    await store.flush();

    // Wednesday 18 Nov 2026: the heatmap starts on Monday 25 Aug and ends on Sunday 22 Nov.
    const summary = store.getDashboardSummary(new Date(2026, 10, 18, 16).getTime(), 120, 'day');
    assert.equal(summary.heatmap.length, 84);
    assert.equal(summary.heatmap[0].date, '2026-08-31');
    const today = summary.heatmap.find((day) => day.date === '2026-11-18');
    assert.equal(today?.seconds, 1200);
    assert.equal(summary.heatmap.find((day) => day.date === '2026-11-19')?.isFuture, true);
  });

  it('keeps at most 50 recent sessions for the See more list', async () => {
    const store = new DataStore(await makeTemporaryDirectory());
    for (let index = 0; index < 60; index += 1) {
      store.appendSession(makeSession(`s${index}`, new Date(2026, 10, 16, 0, index), 60));
    }
    await store.flush();

    const summary = store.getDashboardSummary(new Date(2026, 10, 16, 23).getTime(), 120, 'day');
    assert.equal(summary.recentSessions.length, 50);
  });
});
