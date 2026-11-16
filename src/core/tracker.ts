import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import * as vscode from 'vscode';

import { DataStore, sessionIdFor, StoredSession } from './dataStore';
import { formatDurationMinutes, splitIntervalAtMidnight, TrackingMode } from './timeUtils';

const CHECKPOINT_INTERVAL_MS = 5_000;

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
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[];

  private activeStartedAt: number | null = null;
  private activeProject = 'Workspace';
  private activeLanguage = 'Unknown';
  private focusLostAt: number | null = null;
  private lastCheckpointAt = 0;
  private dashboardRefresh: (() => void) | undefined;

  public constructor(context: vscode.ExtensionContext, dataStore: DataStore) {
    this.instanceId = randomUUID();
    this.dataStore = dataStore;
    this.leasePath = path.join(context.globalStorageUri.fsPath, 'codepulse-lease.json');
    this.statusBarItem = vscode.window.createStatusBarItem('codepulse.timer', vscode.StatusBarAlignment.Right, 1000);
    this.statusBarItem.text = '$(watch) 0m';
    this.statusBarItem.tooltip = 'CodePulse: Not currently tracking. Click to open the dashboard.';
    this.statusBarItem.command = 'codepulse.openDashboard';
    this.statusBarItem.show();
    this.disposables = [this.statusBarItem];
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

    // Recover time from windows that were closed abruptly before they could save it.
    const minSessionSeconds = vscode.workspace.getConfiguration('codepulse').get<number>('minSessionSeconds', 10) ?? 10;
    if (this.dataStore.recoverStaleCheckpoints(this.instanceId, minSessionSeconds) > 0) {
      this.dashboardRefresh?.();
    }

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
    // The lease is only renewed while this window is actually tracking. Renewing it
    // unconditionally made every window look "owned" by another one, so with two
    // windows open neither of them tracked anything.
    if (!enabled) {
      this.closeActiveInterval();
      this.updateStatusBar();
      return;
    }

    const shouldTrack = this.shouldTrack();
    if (shouldTrack && this.activeStartedAt === null) {
      this.beginActiveInterval();
    }

    if (!shouldTrack && this.activeStartedAt !== null) {
      this.closeActiveInterval();
    }

    if (this.activeStartedAt !== null && Date.now() - this.lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
      this.writeCheckpoint();
    }

    this.updateStatusBar();
    if (shouldTrack) {
      this.writeLease();
    }
  }

  private updateStatusBar(): void {
    // Show the whole day's total (saved sessions plus the one running now), so the
    // count carries on across VS Code restarts instead of starting from 0m again.
    const todayMinutes = Math.floor(this.dataStore.getTodaySeconds() / 60);
    this.statusBarItem.text = `$(watch) ${formatDurationMinutes(todayMinutes)}`;
    this.statusBarItem.tooltip = this.activeStartedAt === null
      ? "CodePulse: Time tracked today. Not tracking right now. Click to open the dashboard."
      : "CodePulse: Time tracked today (tracking now). Click to open the dashboard.";
  }

  private beginActiveInterval(): void {
    this.activeStartedAt = Date.now();
    this.activeProject = this.resolveProjectName();
    this.activeLanguage = this.resolveLanguage();
    this.dataStore.setLiveInterval(this.activeStartedAt);
    this.writeCheckpoint();
  }

  private writeCheckpoint(): void {
    if (this.activeStartedAt === null) {
      return;
    }

    const now = Date.now();
    this.dataStore.writeCheckpoint({
      instanceId: this.instanceId,
      start: this.activeStartedAt,
      lastSeen: now,
      project: this.activeProject,
      language: this.activeLanguage,
      mode: this.getTrackingMode(),
    });
    this.lastCheckpointAt = now;
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
        id: sessionIdFor(this.instanceId, segment.start),
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
    this.dataStore.setLiveInterval(null);
    this.dataStore.clearCheckpoint(this.instanceId);

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

    try {
      fs.mkdirSync(path.dirname(this.leasePath), { recursive: true });
      fs.writeFileSync(this.leasePath, JSON.stringify(lease, null, 2), 'utf8');
    } catch {
      // A failed lease write must not throw out of the 1s timer callback.
    }
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
