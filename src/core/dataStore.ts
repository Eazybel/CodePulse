import * as fs from 'node:fs';
import * as path from 'node:path';

import { getLocalDateKey, TrackingMode } from './timeUtils';

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

export class DataStore {
  private readonly filePath: string;
  private snapshot: CodePulseSnapshot;

  public constructor(storageDir: string) {
    this.filePath = path.join(storageDir, 'codepulse-state.json');
    this.snapshot = this.readSnapshot();
  }

  public getSnapshot(): CodePulseSnapshot {
    return this.snapshot;
  }

  public appendSession(session: StoredSession): void {
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
    const output = JSON.stringify(this.snapshot, null, 2);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, output, 'utf8');
    return targetPath;
  }

  public getDashboardSummary(now: number = Date.now()): DashboardSummary {
    const sessions = [...this.snapshot.sessions].sort((left, right) => left.start - right.start);
    const todayKey = getLocalDateKey(new Date(now));
    const startOfWeek = new Date(now);
    startOfWeek.setHours(0, 0, 0, 0);
    startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));

    const totalSecondsToday = sessions
      .filter((session) => session.localDate === todayKey)
      .reduce((sum, session) => sum + session.durationSeconds, 0);

    const totalSecondsThisWeek = sessions
      .filter((session) => session.start >= startOfWeek.getTime())
      .reduce((sum, session) => sum + session.durationSeconds, 0);

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
      averageDailySeconds: uniqueDates.size === 0 ? 0 : Math.round(totalSecondsThisWeek / uniqueDates.size),
    };
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

    fs.writeFileSync(this.filePath, JSON.stringify(this.snapshot, null, 2), 'utf8');
  }

  private backupBrokenFile(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    const backupPath = `${this.filePath}.corrupt-${Date.now()}.bak`;
    fs.copyFileSync(this.filePath, backupPath);
  }
}
