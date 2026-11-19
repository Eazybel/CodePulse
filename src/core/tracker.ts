import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import * as vscode from 'vscode';

import { ActiveCheckpoint, DataStore, sessionIdFor, StoredSession } from './dataStore';
import { formatDurationMinutes, isIdleAt, splitIntervalAtMidnight, TrackingMode } from './timeUtils';

const CHECKPOINT_INTERVAL_MS = 5_000;

interface LeaseState {
  instanceId: string;
  lastSeenMs: number;
  workspacePath: string;
}

interface PendingSegment {
  start: number;
  end: number;
  durationMs: number;
  project: string;
  language: string;
  date: string;
  hour: number;
  mode: TrackingMode;
}

const LEASE_EXPIRY_MS = 15_000;
const MAX_TICK_GAP_MS = 15_000;
const LEASE_RECHECK_DELAY_MS = 150;

export class CodePulseTracker implements vscode.Disposable {
  private readonly instanceId: string;
  private readonly dataStore: DataStore;
  private readonly leasePath: string;
  private readonly timer: NodeJS.Timeout;
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[];

  private tracking = false;
  private resetting = false;
  private tickInProgress: Promise<void> | undefined;
  private lastTickMonotonic: bigint | undefined;
  private wallCursor: number | undefined;
  private activeElapsedMs = 0;
  private lastActivityMs = Date.now();
  private focusLostAt: number | null = null;
  private activeProject = 'Workspace';
  private activeLanguage = 'Unknown';
  private pendingSegment: PendingSegment | undefined;
  private lastCheckpointAt = 0;
  private dashboardRefresh: (() => void) | undefined;

  public constructor(context: vscode.ExtensionContext, dataStore: DataStore) {
    this.instanceId = randomUUID();
    this.dataStore = dataStore;
    this.leasePath = path.join(context.globalStorageUri.fsPath, 'codepulse-owner-lease.json');
    this.statusBarItem = vscode.window.createStatusBarItem('codepulse.timer', vscode.StatusBarAlignment.Right, 1000);
    this.statusBarItem.text = '$(watch) 0m';
    this.statusBarItem.tooltip = 'CodePulse: Time tracked today. Click to open the dashboard.';
    this.statusBarItem.command = 'codepulse.openDashboard';
    this.statusBarItem.show();
    this.disposables = [this.statusBarItem];
    this.timer = setInterval(() => {
      void this.tick();
    }, 1000);
  }

  public setDashboardRefresh(handler: () => void): void {
    this.dashboardRefresh = handler;
  }

  public start(): void {
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.markActivity();
        void this.changeAttribution(() => {
          this.activeProject = this.resolveProjectName(editor);
          this.activeLanguage = this.resolveLanguage(editor);
        });
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.markActivity();
        const editor = vscode.window.activeTextEditor;
        if (editor?.document === event.document && editor.document.languageId !== this.activeLanguage) {
          void this.changeAttribution(() => {
            this.activeLanguage = this.resolveLanguage(editor);
          });
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.changeAttribution(() => {
          this.activeProject = this.resolveProjectName(vscode.window.activeTextEditor);
          this.activeLanguage = this.resolveLanguage(vscode.window.activeTextEditor);
        });
      }),
      vscode.window.onDidChangeTextEditorSelection(() => this.markActivity()),
      vscode.window.onDidChangeWindowState(() => {
        void this.tick();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('codepulse')) {
          void this.tick();
        }
      }),
    );
    this.activeProject = this.resolveProjectName(vscode.window.activeTextEditor);
    this.activeLanguage = this.resolveLanguage(vscode.window.activeTextEditor);

    // Recover the last checkpoint when VS Code or the extension was closed before
    // its pending segment could be saved. All windows use the same global store.
    const minSessionSeconds = vscode.workspace.getConfiguration('codepulse').get<number>('minSessionSeconds', 10) ?? 10;
    if (this.dataStore.recoverStaleCheckpoints(this.instanceId, minSessionSeconds) > 0) {
      this.dashboardRefresh?.();
    }
    void this.tick();
  }

  public async resetTracking(): Promise<void> {
    this.resetting = true;
    await this.tick();
    this.pendingSegment = undefined;
    this.dataStore.setLiveInterval(null);
    this.dataStore.clearCheckpoint(this.instanceId);
    this.tracking = false;
    this.activeElapsedMs = 0;
    this.focusLostAt = null;
    this.lastTickMonotonic = undefined;
    this.wallCursor = undefined;
    this.updateStatusBar();
  }

  public async resumeTracking(): Promise<void> {
    this.resetting = false;
    await this.tick();
  }

  public dispose(): void {
    clearInterval(this.timer);
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    void this.finish().catch((error: unknown) => {
      console.error('CodePulse could not finish tracking cleanly.', error);
    });
  }

  private async finish(): Promise<void> {
    await this.tick();
    this.flushPendingSegment();
    this.dataStore.setLiveInterval(null);
    this.dataStore.clearCheckpoint(this.instanceId);
    await this.dataStore.flush();
    await this.releaseLease();
  }

  private async changeAttribution(update: () => void): Promise<void> {
    await this.tick();
    update();
  }

  private tick(): Promise<void> {
    if (this.tickInProgress) {
      return this.tickInProgress;
    }
    const pendingTick = this.performTick();
    this.tickInProgress = pendingTick;
    void pendingTick.finally(() => {
      if (this.tickInProgress === pendingTick) {
        this.tickInProgress = undefined;
      }
    });
    return pendingTick;
  }

  private async performTick(): Promise<void> {
    try {
      const now = Date.now();
      const monotonicNow = process.hrtime.bigint();
      const shouldRun = !this.resetting &&
        vscode.workspace.getConfiguration('codepulse').get<boolean>('enabled', true) &&
        this.shouldTrack();
      const ownsLease = shouldRun && await this.acquireLease(now);

      if (ownsLease && !this.tracking) {
        const minSessionSeconds = vscode.workspace.getConfiguration('codepulse')
          .get<number>('minSessionSeconds', 10) ?? 10;
        if (this.dataStore.recoverStaleCheckpoints(this.instanceId, minSessionSeconds, Date.now(), 0) > 0) {
          this.dashboardRefresh?.();
        }
      }

      if (ownsLease && this.tracking) {
        if (this.isIdle(now)) {
          // No typing or cursor movement for longer than the idle timeout: stop counting.
          // The idle gap is never recorded, so the next active tick starts fresh from here.
          this.flushPendingSegment();
          this.lastTickMonotonic = monotonicNow;
          this.wallCursor = now;
        } else {
          this.recordElapsed(now, monotonicNow);
          this.updateCheckpoint(now);
        }
        await this.renewLease(now);
      } else {
        if (this.tracking) {
          this.flushPendingSegment();
        } else {
          this.pendingSegment = undefined;
        }
        this.tracking = ownsLease;
        this.lastTickMonotonic = ownsLease ? monotonicNow : undefined;
        this.wallCursor = ownsLease ? now : undefined;
        this.activeElapsedMs = 0;
        if (ownsLease) {
          this.activeProject = this.resolveProjectName(vscode.window.activeTextEditor);
          this.activeLanguage = this.resolveLanguage(vscode.window.activeTextEditor);
          await this.renewLease(now);
        } else {
          this.dataStore.setLiveInterval(null);
          this.dataStore.clearCheckpoint(this.instanceId);
        }
      }

      if (!ownsLease) {
        this.pendingSegment = undefined;
        this.focusLostAt = null;
        await this.releaseLease();
      }
      this.updateStatusBar();
    } catch (error) {
      this.tracking = false;
      this.activeElapsedMs = 0;
      this.lastTickMonotonic = undefined;
      this.wallCursor = undefined;
      this.pendingSegment = undefined;
      this.dataStore.setLiveInterval(null);
      this.dataStore.clearCheckpoint(this.instanceId);
      console.error('CodePulse tracking tick failed.', error);
    }
  }

  private recordElapsed(now: number, monotonicNow: bigint): void {
    const monotonicPrevious = this.lastTickMonotonic;
    if (monotonicPrevious === undefined) {
      this.lastTickMonotonic = monotonicNow;
      this.wallCursor = now;
      return;
    }

    const elapsedMs = Math.min(MAX_TICK_GAP_MS, Math.max(0, Number(monotonicNow - monotonicPrevious) / 1_000_000));
    this.lastTickMonotonic = monotonicNow;
    if (elapsedMs <= 0) return;
    this.activeElapsedMs += elapsedMs;

    const start = Math.max(this.wallCursor ?? now - elapsedMs, now - elapsedMs);
    const end = start + elapsedMs;
    this.wallCursor = end;
    const segments = splitIntervalAtMidnight(start, end);
    const minSessionMs = Math.max(
      0,
      (vscode.workspace.getConfiguration('codepulse').get<number>('minSessionSeconds', 10) ?? 10) * 1000,
    );
    for (const segment of segments) {
      this.addToPendingSegment({
        start: segment.start,
        end: segment.end,
        durationMs: segment.end - segment.start,
        project: this.activeProject,
        language: this.activeLanguage,
        date: segment.dateKey,
        hour: segment.hour,
        mode: this.getTrackingMode(),
      }, minSessionMs);
    }
  }

  private addToPendingSegment(segment: PendingSegment, minSessionMs: number): void {
    const pending = this.pendingSegment;
    if (pending && isSameAttribution(pending, segment) && segment.start <= pending.end + 1_000) {
      pending.end = segment.end;
      pending.durationMs += segment.durationMs;
    } else {
      const timeBoundaryOnly = pending && isSameActivity(pending, segment) &&
        (pending.date !== segment.date || pending.hour !== segment.hour);
      this.flushPendingSegment(timeBoundaryOnly ? 0 : minSessionMs);
      this.pendingSegment = segment;
    }

    if (this.pendingSegment) {
      this.dataStore.setLiveInterval(this.pendingSegment.start);
    }
    if (this.pendingSegment && this.pendingSegment.durationMs >= Math.max(minSessionMs, 1_000)) {
      this.flushPendingSegment(minSessionMs);
    }
  }

  private flushPendingSegment(
    minSessionMs = Math.max(
      0,
      (vscode.workspace.getConfiguration('codepulse').get<number>('minSessionSeconds', 10) ?? 10) * 1000,
    ),
  ): void {
    const pending = this.pendingSegment;
    this.pendingSegment = undefined;
    this.dataStore.setLiveInterval(null);
    if (!pending || pending.durationMs < minSessionMs || pending.durationMs <= 0) return;

    const session: StoredSession = {
      id: sessionIdFor(this.instanceId, pending.start),
      start: pending.start,
      end: pending.end,
      durationSeconds: pending.durationMs / 1000,
      project: pending.project,
      language: pending.language,
      localDate: pending.date,
      localHour: pending.hour,
      mode: pending.mode,
    };
    try {
      this.dataStore.appendSession(session);
      this.dashboardRefresh?.();
    } catch (error) {
      console.error('CodePulse could not save a tracking segment.', error);
    }
  }

  private updateCheckpoint(now: number): void {
    const pending = this.pendingSegment;
    if (!pending) {
      this.dataStore.clearCheckpoint(this.instanceId);
      this.lastCheckpointAt = now;
      return;
    }
    this.dataStore.setLiveInterval(pending.start);
    if (now - this.lastCheckpointAt < CHECKPOINT_INTERVAL_MS) return;
    const checkpoint: ActiveCheckpoint = {
      instanceId: this.instanceId,
      start: pending.start,
      lastSeen: pending.end,
      project: pending.project,
      language: pending.language,
      mode: pending.mode,
    };
    this.dataStore.writeCheckpoint(checkpoint);
    this.lastCheckpointAt = now;
  }

  private shouldTrack(): boolean {
    const config = vscode.workspace.getConfiguration('codepulse');
    if (this.getTrackingMode() === 'alwaysOpen') return true;
    if (vscode.window.state.focused) {
      this.focusLostAt = null;
      return true;
    }
    const focusGracePeriodMs = Math.max(0, config.get<number>('focusGracePeriod', 30) ?? 30) * 1000;
    if (this.focusLostAt === null) this.focusLostAt = Date.now();
    return this.tracking && Date.now() - this.focusLostAt <= focusGracePeriodMs;
  }

  private markActivity(): void {
    this.lastActivityMs = Date.now();
  }

  private isIdle(now: number): boolean {
    const configured = vscode.workspace.getConfiguration('codepulse').get<number>('idleTimeoutMinutes', 5) ?? 5;
    return isIdleAt(this.lastActivityMs, now, Math.max(0, configured));
  }

  private updateStatusBar(): void {
    // The status bar is the total for the local day across all projects and VS Code
    // windows, not the elapsed time since this workspace/window started tracking.
    this.dataStore.setLiveInterval(this.pendingSegment?.start ?? null);
    const todayMinutes = Math.floor(this.dataStore.getTodaySeconds() / 60);
    this.statusBarItem.text = `$(watch) ${formatDurationMinutes(todayMinutes)}`;
    this.statusBarItem.tooltip = this.tracking && this.isIdle(Date.now())
      ? 'CodePulse: Idle, so time is not being counted until you type or move the cursor. Click to open the dashboard.'
      : this.tracking
      ? 'CodePulse: Time tracked today across projects (tracking now). Click to open the dashboard.'
      : 'CodePulse: Time tracked today across projects. Not tracking right now. Click to open the dashboard.';
  }

  private async acquireLease(now: number): Promise<boolean> {
    await fs.promises.mkdir(path.dirname(this.leasePath), { recursive: true });
    const currentLease = await this.readLease();
    if (currentLease?.instanceId === this.instanceId) return true;
    if (currentLease && isLeaseFresh(currentLease.lastSeenMs, now)) return false;

    if (currentLease) {
      await delay(LEASE_RECHECK_DELAY_MS);
      const confirmedLease = await this.readLease();
      if (confirmedLease && (confirmedLease.instanceId !== currentLease.instanceId ||
        confirmedLease.lastSeenMs !== currentLease.lastSeenMs || isLeaseFresh(confirmedLease.lastSeenMs, Date.now()))) {
        return false;
      }
      await fs.promises.unlink(this.leasePath).catch((error: unknown) => {
        if (!isNodeError(error, 'ENOENT')) throw error;
      });
    } else {
      const currentStat = await fs.promises.stat(this.leasePath).catch((error: unknown) => {
        if (isNodeError(error, 'ENOENT')) return undefined;
        throw error;
      });
      if (currentStat) {
        await delay(LEASE_RECHECK_DELAY_MS);
        const confirmedStat = await fs.promises.stat(this.leasePath).catch((error: unknown) => {
          if (isNodeError(error, 'ENOENT')) return undefined;
          throw error;
        });
        if (!confirmedStat || confirmedStat.ino !== currentStat.ino || confirmedStat.mtimeMs !== currentStat.mtimeMs ||
          Math.abs(Date.now() - confirmedStat.mtimeMs) < LEASE_EXPIRY_MS) return false;
        await fs.promises.unlink(this.leasePath).catch((error: unknown) => {
          if (!isNodeError(error, 'ENOENT')) throw error;
        });
      }
    }

    try {
      const handle = await fs.promises.open(this.leasePath, 'wx');
      try {
        await handle.writeFile(JSON.stringify(this.createLease(now)));
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) return false;
      throw error;
    }
  }

  private async renewLease(now: number): Promise<void> {
    const lease = await this.readLease();
    if (lease?.instanceId !== this.instanceId) {
      this.tracking = false;
      this.activeElapsedMs = 0;
      this.lastTickMonotonic = undefined;
      this.wallCursor = undefined;
      this.pendingSegment = undefined;
      this.dataStore.setLiveInterval(null);
      this.dataStore.clearCheckpoint(this.instanceId);
      return;
    }
    const temporaryPath = `${this.leasePath}.${this.instanceId}.tmp`;
    await fs.promises.writeFile(temporaryPath, JSON.stringify(this.createLease(now)), { encoding: 'utf8' });
    await fs.promises.rename(temporaryPath, this.leasePath).catch(async (error: unknown) => {
      await fs.promises.unlink(temporaryPath).catch(() => undefined);
      throw error;
    });
  }

  private async releaseLease(): Promise<void> {
    const lease = await this.readLease();
    if (lease?.instanceId === this.instanceId) {
      await fs.promises.unlink(this.leasePath).catch((error: unknown) => {
        if (!isNodeError(error, 'ENOENT')) console.error('CodePulse could not release its tracking lease.', error);
      });
    }
  }

  private async readLease(): Promise<LeaseState | undefined> {
    try {
      const content = await fs.promises.readFile(this.leasePath, 'utf8');
      const parsed: unknown = JSON.parse(content);
      if (typeof parsed !== 'object' || parsed === null || typeof (parsed as LeaseState).instanceId !== 'string' ||
        !Number.isFinite((parsed as LeaseState).lastSeenMs) || typeof (parsed as LeaseState).workspacePath !== 'string') {
        console.error('CodePulse found a malformed ownership lease.');
        return undefined;
      }
      return parsed as LeaseState;
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return undefined;
      if (error instanceof SyntaxError) {
        console.error('CodePulse found a malformed ownership lease.', error);
        return undefined;
      }
      throw error;
    }
  }

  private createLease(now: number): LeaseState {
    return {
      instanceId: this.instanceId,
      lastSeenMs: now,
      workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'no-workspace',
    };
  }

  private getTrackingMode(): TrackingMode {
    const mode = vscode.workspace.getConfiguration('codepulse').get<string>('trackingMode', 'alwaysOpen');
    return mode === 'windowFocused' ? 'windowFocused' : 'alwaysOpen';
  }

  private resolveProjectName(editor: vscode.TextEditor | undefined): string {
    const folder = editor ? vscode.workspace.getWorkspaceFolder(editor.document.uri) : undefined;
    const fallbackFolder = vscode.workspace.workspaceFolders?.[0];
    return folder?.name ?? fallbackFolder?.name ?? vscode.workspace.name ?? 'Unnamed workspace';
  }

  private resolveLanguage(editor: vscode.TextEditor | undefined): string {
    return editor?.document.languageId ?? 'Unknown';
  }
}

function isSameAttribution(left: PendingSegment, right: PendingSegment): boolean {
  return isSameActivity(left, right) && left.date === right.date && left.hour === right.hour;
}

function isSameActivity(left: PendingSegment, right: PendingSegment): boolean {
  return left.project === right.project && left.language === right.language && left.mode === right.mode;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isLeaseFresh(lastSeenMs: number, now: number): boolean {
  return lastSeenMs <= now && now - lastSeenMs < LEASE_EXPIRY_MS;
}
