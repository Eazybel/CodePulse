import * as fs from 'node:fs';
import * as path from 'node:path';

import { getLocalDateKey, splitIntervalAtMidnight, TrackingMode } from './timeUtils';

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
  totalSecondsToday: number;
  totalSecondsThisWeek: number;
  totalSessions: number;
  activeDays: number;
  recentSessions: StoredSession[];
  projectBreakdown: Array<{ project: string; seconds: number }>;
  averageDailySeconds: number;
}

export interface CodePulseSnapshot {
  version: number;
  sessions: StoredSession[];
  lastUpdated: number;
}

/**
 * Written periodically while a window is tracking so that time is not lost if
 * VS Code is closed abruptly (crash, kill, power loss) before the session is saved.
 */
export interface ActiveCheckpoint {
  instanceId: string;
  start: number;
  lastSeen: number;
  project: string;
  language: string;
  mode: TrackingMode;
}

const CHECKPOINT_PATTERN = /^codepulse-active-[0-9a-f-]+\.json$/i;

export function sessionIdFor(instanceId: string, segmentStart: number): string {
  return `${instanceId}-${segmentStart}`;
}

export class DataStore {
  private readonly storageDir: string;
  private readonly filePath: string;
  private snapshot: CodePulseSnapshot;
  private loadedMtimeMs = 0;
  private liveStartMs: number | null = null;

  public constructor(storageDir: string) {
    this.storageDir = storageDir;
    this.filePath = path.join(storageDir, 'codepulse-state.json');
    this.snapshot = this.readSnapshot();
    this.loadedMtimeMs = this.currentMtimeMs();
  }

  public getSnapshot(): CodePulseSnapshot {
    this.reloadIfChanged();
    return this.snapshot;
  }

  /** Tells the store about the interval that is being tracked right now (or null when idle). */
  public setLiveInterval(startMs: number | null): void {
    this.liveStartMs = startMs;
  }

  public appendSession(session: StoredSession): void {
    // Always merge into what is on disk: other VS Code windows write to the same
    // file, and persisting a stale in-memory copy would erase their sessions.
    this.reloadIfChanged();

    if (this.snapshot.sessions.some((existing) => existing.id === session.id)) {
      return;
    }

    this.snapshot.sessions.push(session);
    this.snapshot.sessions.sort((left, right) => left.start - right.start);
    this.snapshot.lastUpdated = Date.now();
    this.persist();
  }

  public reset(): void {
    this.snapshot = {
      version: 1,
      sessions: [],
      lastUpdated: Date.now(),
    };
    this.persist();
  }

  public exportData(targetPath: string): string {
    this.reloadIfChanged();
    const output = JSON.stringify(this.snapshot, null, 2);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, output, 'utf8');
    return targetPath;
  }

  /** Total tracked seconds for the local calendar day, including the interval running now. */
  public getTodaySeconds(now: number = Date.now()): number {
    this.reloadIfChanged();
    const todayKey = getLocalDateKey(new Date(now));

    const stored = this.snapshot.sessions
      .filter((session) => session.localDate === todayKey)
      .reduce((sum, session) => sum + session.durationSeconds, 0);

    const liveMs = this.liveSegments(now)
      .filter((segment) => segment.dateKey === todayKey)
      .reduce((sum, segment) => sum + (segment.end - segment.start), 0);

    return stored + Math.round(liveMs / 1000);
  }

  public getDashboardSummary(now: number = Date.now()): DashboardSummary {
    this.reloadIfChanged();
    const sessions = [...this.snapshot.sessions].sort((left, right) => left.start - right.start);
    const todayKey = getLocalDateKey(new Date(now));
    const startOfWeek = new Date(now);
    startOfWeek.setHours(0, 0, 0, 0);
    startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));

    const liveSegments = this.liveSegments(now);
    const liveTodaySeconds = Math.round(
      liveSegments
        .filter((segment) => segment.dateKey === todayKey)
        .reduce((sum, segment) => sum + (segment.end - segment.start), 0) / 1000,
    );
    const liveWeekSeconds = Math.round(
      liveSegments
        .filter((segment) => segment.start >= startOfWeek.getTime())
        .reduce((sum, segment) => sum + (segment.end - segment.start), 0) / 1000,
    );

    const totalSecondsToday = sessions
      .filter((session) => session.localDate === todayKey)
      .reduce((sum, session) => sum + session.durationSeconds, 0) + liveTodaySeconds;

    const weekSessions = sessions.filter((session) => session.start >= startOfWeek.getTime());
    const totalSecondsThisWeek = weekSessions.reduce((sum, session) => sum + session.durationSeconds, 0)
      + liveWeekSeconds;

    const activeWeekDates = new Set(weekSessions.map((session) => session.localDate));
    if (liveWeekSeconds > 0) {
      activeWeekDates.add(todayKey);
    }
    const activeDaysThisWeek = activeWeekDates.size;

    const uniqueDates = new Set(sessions.map((session) => session.localDate));
    const recentSessions = sessions.slice(-8).reverse();

    const projectSeconds = new Map<string, number>();
    for (const session of sessions) {
      const current = projectSeconds.get(session.project) ?? 0;
      projectSeconds.set(session.project, current + session.durationSeconds);
    }

    const projectBreakdown = Array.from(projectSeconds.entries())
      .map(([project, seconds]) => ({ project, seconds }))
      .sort((left, right) => right.seconds - left.seconds)
      .slice(0, 5);

    return {
      totalSecondsToday,
      totalSecondsThisWeek,
      totalSessions: sessions.length,
      activeDays: uniqueDates.size,
      recentSessions,
      projectBreakdown,
      // Weekly total over the days active this week, not over all-time active days.
      averageDailySeconds: activeDaysThisWeek === 0 ? 0 : Math.round(totalSecondsThisWeek / activeDaysThisWeek),
    };
  }

  public writeCheckpoint(checkpoint: ActiveCheckpoint): void {
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
      fs.writeFileSync(this.checkpointPath(checkpoint.instanceId), JSON.stringify(checkpoint), 'utf8');
    } catch {
      // Checkpoints are best-effort; never break tracking because of them.
    }
  }

  public clearCheckpoint(instanceId: string): void {
    try {
      fs.rmSync(this.checkpointPath(instanceId), { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }

  /**
   * Turns checkpoints left behind by windows that died without saving into real
   * sessions, so a crash or forced close does not lose the time tracked so far.
   * Returns the number of sessions recovered.
   */
  public recoverStaleCheckpoints(
    ownInstanceId: string,
    minSessionSeconds: number,
    now: number = Date.now(),
    staleMs = 20_000,
  ): number {
    let names: string[];
    try {
      names = fs.readdirSync(this.storageDir);
    } catch {
      return 0;
    }

    let recovered = 0;
    for (const name of names) {
      if (!CHECKPOINT_PATTERN.test(name) || name === path.basename(this.checkpointPath(ownInstanceId))) {
        continue;
      }

      const fullPath = path.join(this.storageDir, name);
      try {
        const checkpoint = JSON.parse(fs.readFileSync(fullPath, 'utf8')) as ActiveCheckpoint;
        if (typeof checkpoint.start !== 'number' || typeof checkpoint.lastSeen !== 'number') {
          fs.rmSync(fullPath, { force: true });
          continue;
        }

        if (now - checkpoint.lastSeen <= staleMs) {
          continue; // Still being updated by a live window.
        }

        for (const segment of splitIntervalAtMidnight(checkpoint.start, checkpoint.lastSeen)) {
          const durationSeconds = Math.round((segment.end - segment.start) / 1000);
          if (durationSeconds < minSessionSeconds) {
            continue;
          }

          const id = sessionIdFor(checkpoint.instanceId, segment.start);
          const before = this.snapshot.sessions.length;
          this.appendSession({
            id,
            start: segment.start,
            end: segment.end,
            durationSeconds,
            project: checkpoint.project,
            language: checkpoint.language,
            localDate: segment.dateKey,
            localHour: segment.hour,
            mode: checkpoint.mode,
          });
          if (this.snapshot.sessions.length > before) {
            recovered += 1;
          }
        }

        fs.rmSync(fullPath, { force: true });
      } catch {
        // Unreadable checkpoint: leave it; it will be retried next start.
      }
    }

    return recovered;
  }

  private liveSegments(now: number): ReturnType<typeof splitIntervalAtMidnight> {
    return this.liveStartMs === null ? [] : splitIntervalAtMidnight(this.liveStartMs, now);
  }

  private checkpointPath(instanceId: string): string {
    return path.join(this.storageDir, `codepulse-active-${instanceId}.json`);
  }

  private currentMtimeMs(): number {
    try {
      return fs.statSync(this.filePath).mtimeMs;
    } catch {
      return 0;
    }
  }

  private reloadIfChanged(): void {
    const mtime = this.currentMtimeMs();
    if (mtime !== this.loadedMtimeMs) {
      this.snapshot = this.readSnapshot();
      this.loadedMtimeMs = this.currentMtimeMs();
    }
  }

  private readSnapshot(): CodePulseSnapshot {
    const fallback: CodePulseSnapshot = {
      version: 1,
      sessions: [],
      lastUpdated: Date.now(),
    };

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (!fs.existsSync(this.filePath)) {
        return fallback;
      }

      const fileContent = fs.readFileSync(this.filePath, 'utf8');
      if (!fileContent.trim()) {
        return fallback;
      }

      const parsed = JSON.parse(fileContent) as CodePulseSnapshot;
      if (!parsed || !Array.isArray(parsed.sessions)) {
        this.backupBrokenFile();
        return fallback;
      }

      return {
        version: Number(parsed.version ?? 1),
        sessions: parsed.sessions.map((session) => ({
          ...session,
          durationSeconds: Number(session.durationSeconds ?? 0),
          localHour: Number(session.localHour ?? 0),
          start: Number(session.start ?? 0),
          end: Number(session.end ?? 0),
        })),
        lastUpdated: Number(parsed.lastUpdated ?? Date.now()),
      };
    } catch (error) {
      this.backupBrokenFile();
      return fallback;
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    if (fs.existsSync(this.filePath)) {
      const backupPath = `${this.filePath}.bak`;
      fs.copyFileSync(this.filePath, backupPath);
    }

    // Write to a temp file and rename so other windows never read a half-written file.
    const tempPath = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tempPath, JSON.stringify(this.snapshot, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
    this.loadedMtimeMs = this.currentMtimeMs();
  }

  private backupBrokenFile(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    const backupPath = `${this.filePath}.corrupt-${Date.now()}.bak`;
    fs.copyFileSync(this.filePath, backupPath);
  }
}
