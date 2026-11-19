import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  getLocalDateKey,
  getTimeframeRange,
  splitIntervalAtMidnight,
  Timeframe,
  TimeframeRange,
  TrackingMode,
} from './timeUtils';

export interface DailyBucket {
  /** Local date key, YYYY-MM-DD. */
  date: string;
  /** Short weekday name ("Mon") in weekly mode, day of month ("16") in monthly mode. */
  label: string;
  seconds: number;
  isToday: boolean;
}

export interface StoredSession {
  id: string;
  start: number;
  end: number;
  durationSeconds: number;
  project: string;
  language: string;
  localDate: string;
  localHour: number;
  mode: TrackingMode;
}

export interface DashboardSummary {
  timeframe: Timeframe;
  rangeStart: string;
  rangeEnd: string;
  totalSecondsToday: number;
  totalSecondsThisWeek: number;
  totalSeconds: number;
  totalSessions: number;
  activeDays: number;
  recentSessions: StoredSession[];
  projectBreakdown: Array<{ project: string; seconds: number }>;
  languageBreakdown: Array<{ language: string; seconds: number }>;
  averageDailySeconds: number;
  dailyGoalSeconds: number;
  goalProgressPercent: number;
  currentStreak: number;
  longestStreak: number;
  peakCodingHour: number | null;
  hourlyActivity: number[];
  /** One bar per day for weekly (Mon-Sun) and monthly (1..last day) modes; empty for daily mode. */
  dailyBreakdown: DailyBucket[];
  activeRatioPercent: number;
  idleRatioPercent: number;
}

export interface CodePulseSnapshot {
  version: number;
  generation: string;
  resetAt: number;
  sessions: StoredSession[];
  lastUpdated: number;
}

/** A periodic record used to recover work after an abrupt VS Code shutdown. */
export interface ActiveCheckpoint {
  instanceId: string;
  start: number;
  lastSeen: number;
  project: string;
  language: string;
  mode: TrackingMode;
}

const CHECKPOINT_PATTERN = /^codepulse-active-[0-9a-f-]+\.json$/i;
const WRITE_DEBOUNCE_MS = 1_500;
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 30_000;

export function sessionIdFor(instanceId: string, segmentStart: number): string {
  return `${instanceId}-${segmentStart}`;
}

export class DataStore {
  private static readonly sharedStores = new Map<string, DataStore>();

  private readonly storageDir: string;
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly reportError: (message: string, error: unknown) => void;
  private snapshot: CodePulseSnapshot;
  private sessionIds = new Set<string>();
  private readonly pendingSessionVersions = new Map<string, number>();
  private revision = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private flushTimer: NodeJS.Timeout | undefined;
  private loadedMtimeMs = 0;
  private liveStartMs: number | null = null;

  public constructor(
    storageDir: string,
    reportError: (message: string, error: unknown) => void = (message, error) => console.error(message, error),
  ) {
    const existing = DataStore.sharedStores.get(storageDir);
    if (existing) {
      this.storageDir = existing.storageDir;
      this.filePath = existing.filePath;
      this.lockPath = existing.lockPath;
      this.reportError = existing.reportError;
      this.snapshot = existing.snapshot;
      this.sessionIds = existing.sessionIds;
      this.pendingSessionVersions = existing.pendingSessionVersions;
      this.revision = existing.revision;
      this.writeQueue = existing.writeQueue;
      this.flushTimer = existing.flushTimer;
      this.loadedMtimeMs = existing.loadedMtimeMs;
      this.liveStartMs = existing.liveStartMs;
      return;
    }

    this.storageDir = storageDir;
    this.filePath = path.join(storageDir, 'codepulse-state.json');
    this.lockPath = `${this.filePath}.lock`;
    this.reportError = reportError;
    this.snapshot = this.readSnapshot();
    this.sessionIds = new Set(this.snapshot.sessions.map((session) => session.id));
    this.loadedMtimeMs = this.currentMtimeMs();
    DataStore.sharedStores.set(storageDir, this);
  }

  private currentStore(): DataStore {
    return DataStore.sharedStores.get(this.storageDir) ?? this;
  }

  public getTodaySeconds(now: number = Date.now()): number {
    const store = this.currentStore();
    store.reloadIfChanged();
    const today = getLocalDateKey(new Date(now));
    const saved = store.snapshot.sessions
      .filter((session) => session.localDate === today)
      .reduce((sum, session) => sum + session.durationSeconds, 0);
    const liveMs = store.liveSegments(now)
      .filter((segment) => segment.dateKey === today)
      .reduce((sum, segment) => sum + segment.end - segment.start, 0);
    return saved + Math.round(liveMs / 1000);
  }

  public appendSession(session: StoredSession): void {
    const store = this.currentStore();
    if (!isValidSession(session)) {
      throw new TypeError('Cannot append an invalid CodePulse session.');
    }
    store.reloadIfChanged();
    const clipped = clipSessionsAfter([session], store.snapshot.resetAt)[0];
    if (!clipped || store.sessionIds.has(clipped.id)) {
      return;
    }

    const sessions = store.snapshot.sessions;
    const previous = sessions[sessions.length - 1];
    if (previous && canMergeSessions(previous, clipped)) {
      previous.end = Math.max(previous.end, clipped.end);
      previous.durationSeconds = (previous.end - previous.start) / 1000;
      store.markPending(previous.id);
    } else {
      sessions.push(clipped);
      sessions.sort((left, right) => left.start - right.start);
      store.sessionIds.add(clipped.id);
      store.markPending(clipped.id);
    }
    store.snapshot.lastUpdated = Date.now();
    store.schedulePersist();
  }

  public async reset(): Promise<void> {
    const store = this.currentStore();
    store.clearFlushTimer();
    store.snapshot = {
      version: 2,
      generation: randomUUID(),
      resetAt: Date.now(),
      sessions: [],
      lastUpdated: Date.now(),
    };
    store.revision += 1;
    store.pendingSessionVersions.clear();
    store.sessionIds.clear();
    await store.enqueuePersist(true);
  }

  public async flush(): Promise<void> {
    const store = this.currentStore();
    store.clearFlushTimer();
    await store.enqueuePersist();
  }

  public async refreshFromDisk(): Promise<void> {
    const store = this.currentStore();
    const revisionAtStart = store.revision;
    const generationAtStart = store.snapshot.generation;
    const diskSnapshot = await store.readDiskSnapshot();
    if (store.revision !== revisionAtStart && store.snapshot.generation !== generationAtStart) {
      return;
    }
    const localPending = store.snapshot.sessions.filter((session) => store.pendingSessionVersions.has(session.id));
    const retained = diskSnapshot.generation === generationAtStart
      ? localPending
      : clipSessionsAfter(localPending, diskSnapshot.resetAt);
    store.snapshot = { ...diskSnapshot, sessions: mergeOverlappingSessions([...diskSnapshot.sessions, ...retained]) };
    store.sessionIds = new Set(store.snapshot.sessions.map((session) => session.id));
    store.loadedMtimeMs = store.currentMtimeMs();
  }

  public async exportData(
    targetPath: string,
    format: 'json' | 'csv' = 'json',
    timeframe?: Timeframe,
    now: number = Date.now(),
  ): Promise<string> {
    const store = this.currentStore();
    store.reloadIfChanged();
    const sessions = timeframe ? store.getSessionsForTimeframe(timeframe, now) : store.snapshot.sessions;
    const output = format === 'csv'
      ? sessionsToCsv(sessions)
      : JSON.stringify({ ...store.snapshot, sessions }, null, 2);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporaryPath, output, { encoding: 'utf8', flag: 'wx' });
      await fs.promises.rename(temporaryPath, targetPath);
      return targetPath;
    } catch (error) {
      await fs.promises.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  public getDashboardSummary(
    now: number = Date.now(),
    dailyGoalMinutes = 120,
    timeframe: Timeframe = 'day',
  ): DashboardSummary {
    const store = this.currentStore();
    store.reloadIfChanged();
    const range = getTimeframeRange(timeframe, now);
    const sessions = store.snapshot.sessions
      .filter((session) => session.localDate >= range.startDate && session.localDate <= range.endDate)
      .sort((left, right) => left.start - right.start);
    const totalSeconds = sessions.reduce((sum, session) => sum + session.durationSeconds, 0);
    const todayKey = getLocalDateKey(new Date(now));
    const weekStart = getTimeframeRange('week', now).startDate;
    const totalSecondsToday = store.getTodaySeconds(now);
    const totalSecondsThisWeek = store.snapshot.sessions
      .filter((session) => session.localDate >= weekStart && session.localDate <= todayKey)
      .reduce((sum, session) => sum + session.durationSeconds, 0) + store.liveSegments(now)
      .filter((segment) => segment.dateKey >= weekStart && segment.dateKey <= todayKey)
      .reduce((sum, segment) => sum + segment.end - segment.start, 0) / 1000;

    const projectBreakdown = aggregate(sessions, (session) => session.project, 8);
    const languageBreakdown = aggregate(sessions, (session) => session.language, 8)
      .map((entry) => ({ language: entry.project, seconds: entry.seconds }));
    const dates = Array.from(new Set(store.snapshot.sessions.map((session) => session.localDate))).sort();
    const rangeDates = new Set(sessions.map((session) => session.localDate));
    const hourlyActivity = Array.from({ length: 24 }, () => 0);
    for (const session of sessions) {
      hourlyActivity[session.localHour] += session.durationSeconds;
    }
    const peakSeconds = Math.max(...hourlyActivity);
    const earliest = sessions.length > 0 ? Math.max(range.start, sessions[0].start) : now;
    const lastEnd = sessions.reduce((latest, session) => Math.max(latest, session.end), -Infinity);
    const latest = sessions.length > 0 ? Math.min(now, lastEnd) : now;
    const observedSeconds = Math.max(0, Math.round((latest - earliest) / 1000));
    const activeSeconds = Math.min(totalSeconds, observedSeconds);
    const activeRatioPercent = observedSeconds === 0 ? 0 : Math.round((activeSeconds / observedSeconds) * 100);
    const dailyGoalSeconds = Math.max(0, Math.round(dailyGoalMinutes * 60));

    return {
      timeframe,
      rangeStart: range.startDate,
      rangeEnd: range.endDate,
      totalSecondsToday,
      totalSecondsThisWeek: Math.round(totalSecondsThisWeek),
      totalSeconds,
      totalSessions: sessions.length,
      activeDays: rangeDates.size,
      recentSessions: sessions.slice(-8).reverse(),
      projectBreakdown,
      languageBreakdown,
      averageDailySeconds: rangeDates.size === 0 ? 0 : Math.round(totalSeconds / rangeDates.size),
      dailyGoalSeconds,
      goalProgressPercent: dailyGoalSeconds === 0
        ? 0
        : Math.min(100, Math.round((totalSecondsToday / dailyGoalSeconds) * 100)),
      currentStreak: getCurrentStreak(dates, todayKey),
      longestStreak: getLongestStreak(dates),
      peakCodingHour: peakSeconds === 0 ? null : hourlyActivity.indexOf(peakSeconds),
      hourlyActivity,
      dailyBreakdown: buildDailyBreakdown(timeframe, range, sessions, now),
      activeRatioPercent,
      idleRatioPercent: 100 - activeRatioPercent,
    };
  }

  public getSnapshot(): CodePulseSnapshot {
    const store = this.currentStore();
    store.reloadIfChanged();
    return store.snapshot;
  }

  public writeCheckpoint(checkpoint: ActiveCheckpoint): void {
    const store = this.currentStore();
    try {
      fs.mkdirSync(store.storageDir, { recursive: true });
      fs.writeFileSync(store.checkpointPath(checkpoint.instanceId), JSON.stringify(checkpoint), 'utf8');
    } catch (error) {
      store.reportError('Unable to write CodePulse tracking checkpoint.', error);
    }
  }

  public clearCheckpoint(instanceId: string): void {
    const store = this.currentStore();
    try {
      fs.rmSync(store.checkpointPath(instanceId), { force: true });
    } catch (error) {
      store.reportError('Unable to clear CodePulse tracking checkpoint.', error);
    }
  }

  public recoverStaleCheckpoints(
    ownInstanceId: string,
    minSessionSeconds: number,
    now: number = Date.now(),
    staleMs = 20_000,
  ): number {
    const store = this.currentStore();
    let names: string[];
    try {
      names = fs.readdirSync(store.storageDir);
    } catch {
      return 0;
    }

    let recovered = 0;
    for (const name of names) {
      if (!CHECKPOINT_PATTERN.test(name) || name === path.basename(store.checkpointPath(ownInstanceId))) {
        continue;
      }
      const checkpointPath = path.join(store.storageDir, name);
      try {
        const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as ActiveCheckpoint;
        if (!isValidCheckpoint(checkpoint)) {
          fs.rmSync(checkpointPath, { force: true });
          continue;
        }
        if (now - checkpoint.lastSeen <= staleMs) {
          continue;
        }
        for (const segment of splitIntervalAtMidnight(checkpoint.start, checkpoint.lastSeen)) {
          const durationSeconds = Math.round((segment.end - segment.start) / 1000);
          if (durationSeconds < minSessionSeconds) {
            continue;
          }
          const before = store.snapshot.sessions.length;
          store.appendSession({
            id: sessionIdFor(checkpoint.instanceId, segment.start),
            start: segment.start,
            end: segment.end,
            durationSeconds,
            project: checkpoint.project,
            language: checkpoint.language,
            localDate: segment.dateKey,
            localHour: segment.hour,
            mode: checkpoint.mode,
          });
          if (store.snapshot.sessions.length > before) {
            recovered += 1;
          }
        }
        fs.rmSync(checkpointPath, { force: true });
      } catch (error) {
        store.reportError(`Unable to recover CodePulse checkpoint ${name}.`, error);
      }
    }
    return recovered;
  }

  public setLiveInterval(startMs: number | null): void {
    const store = this.currentStore();
    store.liveStartMs = startMs;
  }

  private getSessionsForTimeframe(timeframe: Timeframe, now: number): StoredSession[] {
    const store = this.currentStore();
    const range = getTimeframeRange(timeframe, now);
    return store.snapshot.sessions.filter(
      (session) => session.localDate >= range.startDate && session.localDate <= range.endDate,
    );
  }

  private liveSegments(now: number): ReturnType<typeof splitIntervalAtMidnight> {
    const store = this.currentStore();
    return store.liveStartMs === null ? [] : splitIntervalAtMidnight(store.liveStartMs, now);
  }

  private checkpointPath(instanceId: string): string {
    return path.join(this.storageDir, `codepulse-active-${instanceId}.json`);
  }

  private schedulePersist(): void {
    const store = this.currentStore();
    if (store.flushTimer) return;
    store.flushTimer = setTimeout(() => {
      store.flushTimer = undefined;
      void store.enqueuePersist().catch((error: unknown) => {
        store.reportError('Unable to persist CodePulse data.', error);
      });
    }, WRITE_DEBOUNCE_MS);
  }

  private enqueuePersist(reset = false): Promise<void> {
    const store = this.currentStore();
    store.writeQueue = store.writeQueue.then(() => store.persist(reset), () => store.persist(reset));
    return store.writeQueue;
  }

  private async persist(reset: boolean): Promise<void> {
    const store = this.currentStore();
    const revisionAtStart = store.revision;
    const pendingAtStart = new Map(store.pendingSessionVersions);
    const localSessionsAtStart = store.snapshot.sessions.map((session) => ({ ...session }));
    const generationAtStart = store.snapshot.generation;
    const resetAtStart = store.snapshot.resetAt;
    const releaseLock = await store.acquireFileLock();
    try {
      const diskSnapshot = await store.readDiskSnapshot();
      let sessions: StoredSession[];
      if (reset) {
        sessions = clipSessionsAfter(localSessionsAtStart, resetAtStart);
      } else if (diskSnapshot.generation !== generationAtStart) {
        sessions = diskSnapshot.sessions.concat(clipSessionsAfter(
          localSessionsAtStart.filter((session) => pendingAtStart.has(session.id)),
          diskSnapshot.resetAt,
        ));
      } else {
        const byId = new Map(diskSnapshot.sessions.map((session) => [session.id, session]));
        for (const session of localSessionsAtStart) {
          if (pendingAtStart.has(session.id)) byId.set(session.id, session);
        }
        sessions = Array.from(byId.values());
      }
      const saved: CodePulseSnapshot = {
        version: 2,
        generation: reset ? generationAtStart : diskSnapshot.generation,
        resetAt: reset ? resetAtStart : diskSnapshot.resetAt,
        sessions: mergeOverlappingSessions(sessions),
        lastUpdated: Date.now(),
      };
      await store.writeSnapshotAtomically(saved);
      if (store.revision !== revisionAtStart && store.snapshot.generation !== generationAtStart) return;
      const newlyPending = store.snapshot.sessions.filter((session) =>
        store.pendingSessionVersions.has(session.id) &&
        store.pendingSessionVersions.get(session.id) !== pendingAtStart.get(session.id));
      store.snapshot = { ...saved, sessions: mergeOverlappingSessions([...saved.sessions, ...newlyPending]) };
      store.sessionIds = new Set(store.snapshot.sessions.map((session) => session.id));
      for (const [id, version] of pendingAtStart) {
        if (store.pendingSessionVersions.get(id) === version) store.pendingSessionVersions.delete(id);
      }
      if (store.revision !== revisionAtStart) store.snapshot.lastUpdated = Date.now();
      store.loadedMtimeMs = store.currentMtimeMs();
    } finally {
      await releaseLock();
    }
  }

  private async readDiskSnapshot(): Promise<CodePulseSnapshot> {
    try {
      const parsed: unknown = JSON.parse(await fs.promises.readFile(this.filePath, 'utf8'));
      const validated = validateSnapshot(parsed);
      if (!validated) throw new TypeError('The latest CodePulse data file does not match the supported schema.');
      return validated;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        try {
          const backup = JSON.parse(await fs.promises.readFile(`${this.filePath}.bak`, 'utf8')) as unknown;
          return validateSnapshot(backup) ?? createEmptySnapshot();
        } catch {
          return createEmptySnapshot();
        }
      }
      this.reportError('Unable to read the latest CodePulse data before saving; trying backup.', error);
      try {
        const backup = JSON.parse(await fs.promises.readFile(`${this.filePath}.bak`, 'utf8')) as unknown;
        const validated = validateSnapshot(backup);
        if (validated) return validated;
      } catch {
        // Ignore backup failure and keep the empty snapshot.
      }
      return createEmptySnapshot();
    }
  }

  private readSnapshot(): CodePulseSnapshot {
    fs.mkdirSync(this.storageDir, { recursive: true });
    for (const candidate of [this.filePath, `${this.filePath}.bak`]) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as unknown;
        const validated = validateSnapshot(parsed);
        if (validated) return validated;
        throw new TypeError(`Unsupported schema in ${candidate}.`);
      } catch (error) {
        if (isNodeError(error, 'ENOENT')) continue;
        if (candidate === this.filePath) {
          const corruptPath = `${candidate}.corrupt-${Date.now()}`;
          try {
            fs.renameSync(candidate, corruptPath);
          } catch {
            // If the file cannot be renamed, proceed with the fallback path.
          }
          this.reportError(`Unable to load CodePulse data from ${candidate}; trying backup.`, error);
          continue;
        }
        this.reportError(`Unable to load CodePulse data from ${candidate}.`, error);
      }
    }
    return createEmptySnapshot();
  }

  private reloadIfChanged(): void {
    const store = this.currentStore();
    const mtime = store.currentMtimeMs();
    if (mtime === store.loadedMtimeMs) return;
    const disk = store.readSnapshot();
    const pending = store.snapshot.sessions.filter((session) => store.pendingSessionVersions.has(session.id));
    store.snapshot = { ...disk, sessions: mergeOverlappingSessions([...disk.sessions, ...pending]) };
    store.sessionIds = new Set(store.snapshot.sessions.map((session) => session.id));
    store.loadedMtimeMs = store.currentMtimeMs();
  }

  private currentMtimeMs(): number {
    try {
      return fs.statSync(this.filePath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private async writeSnapshotAtomically(snapshot: CodePulseSnapshot): Promise<void> {
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.promises.open(temporaryPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify(snapshot, null, 2), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        const existing = JSON.parse(await fs.promises.readFile(this.filePath, 'utf8')) as unknown;
        if (validateSnapshot(existing)) await fs.promises.copyFile(this.filePath, `${this.filePath}.bak`);
      } catch (error) {
        if (!isNodeError(error, 'ENOENT') && !(error instanceof SyntaxError)) throw error;
      }
      await fs.promises.rename(temporaryPath, this.filePath);
    } catch (error) {
      await fs.promises.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async acquireFileLock(): Promise<() => Promise<void>> {
    await fs.promises.mkdir(this.storageDir, { recursive: true });
    const startedAt = Date.now();
    while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
      try {
        const handle = await fs.promises.open(this.lockPath, 'wx');
        await handle.writeFile(`${process.pid}:${Date.now()}`);
        return async () => {
          await handle.close();
          await fs.promises.unlink(this.lockPath).catch((error: unknown) => {
            if (!isNodeError(error, 'ENOENT')) throw error;
          });
        };
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
      }
      const stat = await fs.promises.stat(this.lockPath).catch((error: unknown) => {
        if (isNodeError(error, 'ENOENT')) return undefined;
        throw error;
      });
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await delay(100);
        const current = await fs.promises.stat(this.lockPath).catch((error: unknown) => {
          if (isNodeError(error, 'ENOENT')) return undefined;
          throw error;
        });
        if (current && current.ino === stat.ino && current.mtimeMs === stat.mtimeMs &&
          Date.now() - current.mtimeMs > LOCK_STALE_MS) {
          await fs.promises.unlink(this.lockPath).catch((error: unknown) => {
            if (!isNodeError(error, 'ENOENT')) throw error;
          });
        }
      }
      await delay(50);
    }
    throw new Error('Timed out waiting for the CodePulse data file lock.');
  }

  private clearFlushTimer(): void {
    const store = this.currentStore();
    if (store.flushTimer) {
      clearTimeout(store.flushTimer);
      store.flushTimer = undefined;
    }
  }

  private markPending(id: string): void {
    const store = this.currentStore();
    store.revision += 1;
    store.pendingSessionVersions.set(id, store.revision);
  }
}

function createEmptySnapshot(): CodePulseSnapshot {
  return { version: 2, generation: 'initial', resetAt: 0, sessions: [], lastUpdated: Date.now() };
}

function validateSnapshot(value: unknown): CodePulseSnapshot | undefined {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.sessions)) {
    return undefined;
  }
  const sessions = value.sessions.filter(isValidSession);
  if (sessions.length !== value.sessions.length || new Set(sessions.map((session) => session.id)).size !== sessions.length) {
    return undefined;
  }
  return {
    version: 2,
    generation: typeof value.generation === 'string' ? value.generation : 'initial',
    resetAt: isFiniteNumber(value.resetAt) ? value.resetAt : 0,
    sessions: mergeOverlappingSessions(sessions),
    lastUpdated: isFiniteNumber(value.lastUpdated) ? value.lastUpdated : Date.now(),
  };
}

function isValidSession(value: unknown): value is StoredSession {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 256 &&
    isFiniteNumber(value.start) && isFiniteNumber(value.end) && value.end > value.start &&
    isFiniteNumber(value.durationSeconds) && value.durationSeconds > 0 &&
    typeof value.project === 'string' && typeof value.language === 'string' &&
    typeof value.localDate === 'string' && isFiniteNumber(value.localHour) &&
    Number.isInteger(value.localHour) && value.localHour >= 0 && value.localHour <= 23 &&
    (value.mode === 'alwaysOpen' || value.mode === 'windowFocused');
}

function isValidCheckpoint(value: unknown): value is ActiveCheckpoint {
  return isRecord(value) && typeof value.instanceId === 'string' && isFiniteNumber(value.start) &&
    isFiniteNumber(value.lastSeen) && typeof value.project === 'string' && typeof value.language === 'string' &&
    (value.mode === 'alwaysOpen' || value.mode === 'windowFocused');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function canMergeSessions(left: StoredSession, right: StoredSession): boolean {
  return left.project === right.project && left.language === right.language && left.localDate === right.localDate &&
    left.localHour === right.localHour && left.mode === right.mode && right.start <= left.end + 1_500 && right.end >= left.end;
}

function mergeOverlappingSessions(sessions: StoredSession[]): StoredSession[] {
  const ordered = [...sessions].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const merged: StoredSession[] = [];
  let coveredUntil = -Infinity;
  for (const source of ordered) {
    const current = { ...source };
    if (current.start < coveredUntil) {
      current.start = coveredUntil;
      if (current.end <= current.start) continue;
      current.durationSeconds = (current.end - current.start) / 1000;
      const date = new Date(current.start);
      current.localDate = getLocalDateKey(date);
      current.localHour = date.getHours();
    }
    const previous = merged[merged.length - 1];
    if (previous && canMergeSessions(previous, current)) {
      previous.end = Math.max(previous.end, current.end);
      previous.durationSeconds = (previous.end - previous.start) / 1000;
      coveredUntil = Math.max(coveredUntil, previous.end);
    } else {
      merged.push(current);
      coveredUntil = Math.max(coveredUntil, current.end);
    }
  }
  return merged;
}

function clipSessionsAfter(sessions: StoredSession[], cutoff: number): StoredSession[] {
  return sessions.flatMap((source) => {
    if (source.end <= cutoff) return [];
    const session = { ...source };
    if (session.start < cutoff) {
      session.start = cutoff;
      const date = new Date(cutoff);
      session.localDate = getLocalDateKey(date);
      session.localHour = date.getHours();
      session.durationSeconds = (session.end - session.start) / 1000;
    }
    return session.durationSeconds > 0 ? [session] : [];
  });
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function buildDailyBreakdown(
  timeframe: Timeframe,
  range: TimeframeRange,
  sessions: StoredSession[],
  now: number,
): DailyBucket[] {
  if (timeframe === 'day') {
    return [];
  }

  // range.startDate is the first day of the week (Monday) or month (day 1).
  const [year, month, firstDay] = range.startDate.split('-').map(Number);
  const dayCount = timeframe === 'week' ? 7 : new Date(year, month, 0).getDate();

  const secondsByDate = new Map<string, number>();
  for (const session of sessions) {
    secondsByDate.set(session.localDate, (secondsByDate.get(session.localDate) ?? 0) + session.durationSeconds);
  }

  const todayKey = getLocalDateKey(new Date(now));
  const buckets: DailyBucket[] = [];
  for (let offset = 0; offset < dayCount; offset += 1) {
    const day = new Date(year, month - 1, firstDay + offset);
    const date = getLocalDateKey(day);
    buckets.push({
      date,
      label: timeframe === 'week' ? WEEKDAY_NAMES[day.getDay()] : String(day.getDate()),
      seconds: secondsByDate.get(date) ?? 0,
      isToday: date === todayKey,
    });
  }
  return buckets;
}

function aggregate(
  sessions: StoredSession[],
  keySelector: (session: StoredSession) => string,
  limit: number,
): Array<{ project: string; seconds: number }> {
  const totals = new Map<string, number>();
  for (const session of sessions) totals.set(keySelector(session), (totals.get(keySelector(session)) ?? 0) + session.durationSeconds);
  return Array.from(totals, ([project, seconds]) => ({ project, seconds }))
    .sort((a, b) => b.seconds - a.seconds).slice(0, limit);
}

function getCurrentStreak(dates: string[], todayKey: string): number {
  const dateSet = new Set(dates);
  const cursor = new Date(`${todayKey}T12:00:00`);
  if (!dateSet.has(todayKey)) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (dateSet.has(getLocalDateKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function getLongestStreak(dates: string[]): number {
  let longest = 0;
  let current = 0;
  let previous: Date | undefined;
  for (const key of dates) {
    const date = new Date(`${key}T12:00:00`);
    const gap = previous ? Math.round((date.getTime() - previous.getTime()) / 86_400_000) : 0;
    current = gap === 1 ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = date;
  }
  return longest;
}

function sessionsToCsv(sessions: StoredSession[]): string {
  const columns: Array<keyof StoredSession> = [
    'id', 'start', 'end', 'durationSeconds', 'project', 'language', 'localDate', 'localHour', 'mode',
  ];
  return [columns.join(','), ...sessions.map((session) => columns.map((column) => csvCell(String(session[column]))).join(','))]
    .join('\r\n');
}

function csvCell(value: string): string {
  const safe = /^[\t\r ]*[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
