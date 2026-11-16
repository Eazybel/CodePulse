import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import { DataStore, StoredSession } from '../core/dataStore';
import { getLocalDateKey } from '../core/timeUtils';

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codepulse-persist-'));
}

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

describe('daily totals across VS Code restarts', () => {
  it('keeps counting today from where the previous run stopped', () => {
    const dir = makeDir();
    try {
      const now = new Date(2024, 5, 5, 15, 0, 0).getTime();

      const firstRun = new DataStore(dir);
      firstRun.appendSession(makeSession('a', new Date(2024, 5, 5, 9, 0, 0), 1200));

      // VS Code is closed and opened again: a brand-new store reads the same folder.
      const secondRun = new DataStore(dir);
      assert.equal(secondRun.getTodaySeconds(now), 1200);

      secondRun.appendSession(makeSession('b', new Date(2024, 5, 5, 14, 0, 0), 600));
      assert.equal(secondRun.getTodaySeconds(now), 1800);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('includes the interval that is running right now', () => {
    const dir = makeDir();
    try {
      const store = new DataStore(dir);
      const now = new Date(2024, 5, 5, 15, 0, 0).getTime();
      store.appendSession(makeSession('a', new Date(2024, 5, 5, 9, 0, 0), 1200));

      store.setLiveInterval(now - 300_000); // tracking for 5 minutes
      assert.equal(store.getTodaySeconds(now), 1500);
      assert.equal(store.getDashboardSummary(now).totalSecondsToday, 1500);

      store.setLiveInterval(null);
      assert.equal(store.getTodaySeconds(now), 1200);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not lose sessions written by another window', () => {
    const dir = makeDir();
    try {
      const windowA = new DataStore(dir);
      const windowB = new DataStore(dir);

      windowA.appendSession(makeSession('a', new Date(2024, 5, 5, 9, 0, 0), 600));
      windowB.appendSession(makeSession('b', new Date(2024, 5, 5, 10, 0, 0), 900));

      const ids = new DataStore(dir).getSnapshot().sessions.map((session) => session.id).sort();
      assert.deepEqual(ids, ['a', 'b']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers time from a window that was closed without saving', () => {
    const dir = makeDir();
    try {
      const start = new Date(2024, 5, 5, 9, 0, 0).getTime();
      const lastSeen = start + 45 * 60_000;

      const crashed = new DataStore(dir);
      crashed.writeCheckpoint({
        instanceId: 'deadbeef-0000',
        start,
        lastSeen,
        project: 'demo',
        language: 'typescript',
        mode: 'alwaysOpen',
      });

      const nextRun = new DataStore(dir);
      const afterCrash = lastSeen + 60_000;
      assert.equal(nextRun.recoverStaleCheckpoints('new-instance', 10, afterCrash), 1);
      assert.equal(nextRun.getTodaySeconds(afterCrash), 45 * 60);

      // Running recovery again must not count the same time twice.
      assert.equal(nextRun.recoverStaleCheckpoints('new-instance', 10, afterCrash), 0);
      assert.equal(nextRun.getTodaySeconds(afterCrash), 45 * 60);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the checkpoint of a window that is still running alone', () => {
    const dir = makeDir();
    try {
      const now = new Date(2024, 5, 5, 9, 30, 0).getTime();
      const store = new DataStore(dir);
      store.writeCheckpoint({
        instanceId: 'live-window',
        start: now - 600_000,
        lastSeen: now - 2_000,
        project: 'demo',
        language: 'typescript',
        mode: 'alwaysOpen',
      });

      assert.equal(store.recoverStaleCheckpoints('other-window', 10, now), 0);
      assert.equal(store.getSnapshot().sessions.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
