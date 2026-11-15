import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import * as vscode from 'vscode';

import { DataStore, StoredSession } from './dataStore';
import { splitIntervalAtMidnight, TrackingMode } from './timeUtils';

interface LeaseState {
  instanceId: string;
  lastSeenMs: number;
  workspaceName: string;
}

export class CodePulseTracker implements vscode.Disposable {
  private readonly instanceId: string;
  private readonly dataStore: DataStore;
  private readonly leasePath: string;
  private readonly timer: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[];

  private activeStartedAt: number | null = null;
  private activeProject = 'Workspace';
  private activeLanguage = 'Unknown';
  private focusLostAt: number | null = null;
  private dashboardRefresh: (() => void) | undefined;

  public constructor(context: vscode.ExtensionContext, dataStore: DataStore) {
    this.instanceId = randomUUID();
    this.dataStore = dataStore;
    this.leasePath = path.join(context.globalStorageUri.fsPath, 'codepulse-lease.json');
    this.disposables = [];
    this.timer = setInterval(() => this.tick(), 1000);
  }

  public setDashboardRefresh(handler: () => void): void {
    this.dashboardRefresh = handler;
  }

  public start(): void {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.tick()),
      vscode.window.onDidChangeWindowState(() => this.tick()),
    );

    this.tick();
  }

  public dispose(): void {
    clearInterval(this.timer);
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    if (this.activeStartedAt !== null) {
      this.closeActiveInterval();
    }
  }

  private tick(): void {
    const enabled = vscode.workspace.getConfiguration('codepulse').get<boolean>('enabled', true);
    if (!enabled) {
      this.closeActiveInterval();
      this.writeLease();
      return;
    }

    const shouldTrack = this.shouldTrack();
    if (shouldTrack && this.activeStartedAt === null) {
      this.beginActiveInterval();
    }

    if (!shouldTrack && this.activeStartedAt !== null) {
      this.closeActiveInterval();
    }

    this.writeLease();
  }

  private beginActiveInterval(): void {
    this.activeStartedAt = Date.now();
    this.activeProject = this.resolveProjectName();
    this.activeLanguage = this.resolveLanguage();
  }

  private closeActiveInterval(): void {
    if (this.activeStartedAt === null) {
      return;
    }

    const endMs = Date.now();
    const segments = splitIntervalAtMidnight(this.activeStartedAt, endMs);

    const minSessionSeconds = vscode.workspace.getConfiguration('codepulse').get<number>('minSessionSeconds', 10) ?? 10;
    let savedSession = false;

    for (const segment of segments) {
      const durationSeconds = Math.max(0, Math.round((segment.end - segment.start) / 1000));
      if (durationSeconds < minSessionSeconds) {
        continue;
      }

      const session: StoredSession = {
        id: randomUUID(),
        start: segment.start,
        end: segment.end,
        durationSeconds,
        project: this.activeProject,
        language: this.activeLanguage,
        localDate: segment.dateKey,
        localHour: segment.hour,
        mode: this.getTrackingMode(),
      };

      this.dataStore.appendSession(session);
      savedSession = true;
    }

    this.activeStartedAt = null;
    this.focusLostAt = null;

    if (savedSession) {
      this.dashboardRefresh?.();
    }
  }

  private shouldTrack(): boolean {
    const config = vscode.workspace.getConfiguration('codepulse');
    const trackingMode = this.getTrackingMode();
    const lease = this.readLease();
    const nowMs = Date.now();

    if (lease && lease.instanceId !== this.instanceId && nowMs - lease.lastSeenMs < 4000) {
      return false;
    }

    if (trackingMode === 'alwaysOpen') {
      return true;
    }

    const focused = vscode.window.state.focused;
    if (focused) {
      this.focusLostAt = null;
      return true;
    }

    if (this.focusLostAt === null) {
      this.focusLostAt = nowMs;
    }

    const gracePeriodMs = (config.get<number>('focusGracePeriod', 30) ?? 30) * 1000;
    return nowMs - this.focusLostAt <= gracePeriodMs;
  }

  private writeLease(): void {
    const lease: LeaseState = {
      instanceId: this.instanceId,
      lastSeenMs: Date.now(),
      workspaceName: vscode.workspace.name ?? 'unnamed-workspace',
    };

    fs.mkdirSync(path.dirname(this.leasePath), { recursive: true });
    fs.writeFileSync(this.leasePath, JSON.stringify(lease, null, 2), 'utf8');
  }

  private readLease(): LeaseState | undefined {
    try {
      if (!fs.existsSync(this.leasePath)) {
        return undefined;
      }

      const content = fs.readFileSync(this.leasePath, 'utf8');
      if (!content.trim()) {
        return undefined;
      }

      const parsed = JSON.parse(content) as LeaseState;
      if (!parsed || typeof parsed.instanceId !== 'string' || typeof parsed.lastSeenMs !== 'number') {
        return undefined;
      }

      return parsed;
    } catch {
      return undefined;
    }
  }

  private getTrackingMode(): TrackingMode {
    const mode = vscode.workspace.getConfiguration('codepulse').get<string>('trackingMode', 'alwaysOpen');
    return mode === 'windowFocused' ? 'windowFocused' : 'alwaysOpen';
  }

  private resolveProjectName(): string {
    const workspaceName = vscode.workspace.name ?? 'Unnamed workspace';
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.length > 0 ? folders[0].name : workspaceName;
  }

  private resolveLanguage(): string {
    const editor = vscode.window.activeTextEditor;
    return editor?.document.languageId ?? 'Unknown';
  }
}
