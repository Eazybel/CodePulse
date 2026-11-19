import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import { CodePulseSnapshot, DataStore, DashboardSummary } from './core/dataStore';
import { Timeframe } from './core/timeUtils';

type ExportHandler = (format: 'json' | 'csv', timeframe: Timeframe) => Promise<string | undefined>;

export class DashboardPanel implements vscode.Disposable {
  public static currentPanel: DashboardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly dataStore: DataStore;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private refreshInProgress = false;
  private refreshQueued = false;
  private timeframe: Timeframe = 'day';
  private exportHandler: ExportHandler;

  private constructor(
    dataStore: DataStore,
    exportHandler: ExportHandler,
  ) {
    this.dataStore = dataStore;
    this.exportHandler = exportHandler;
    this.panel = vscode.window.createWebviewPanel(
      'codepulse.dashboard',
      'CodePulse Tracker',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      },
    );

    this.panel.webview.html = this.buildHtml();
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: unknown) => {
        void this.handleMessage(message);
      }),
      this.panel.onDidDispose(() => {
      this.disposed = true;
      if (DashboardPanel.currentPanel === this) {
        DashboardPanel.currentPanel = undefined;
      }
        this.disposeListeners();
      }),
    );
  }

  public static create(
    context: vscode.ExtensionContext,
    dataStore: DataStore,
    exportHandler: ExportHandler,
  ): DashboardPanel {
    if (DashboardPanel.currentPanel && !DashboardPanel.currentPanel.disposed) {
      DashboardPanel.currentPanel.exportHandler = exportHandler;
      return DashboardPanel.currentPanel;
    }

    const panel = new DashboardPanel(dataStore, exportHandler);
    DashboardPanel.currentPanel = panel;
    context.subscriptions.push(panel);
    return panel;
  }

  public show(): void {
    if (this.disposed) {
      return;
    }
    this.panel.reveal(vscode.ViewColumn.One, true);
    this.refresh();
  }

  public refresh(): void {
    if (this.disposed) {
      return;
    }
    if (this.refreshInProgress) {
      this.refreshQueued = true;
      return;
    }

    this.refreshInProgress = true;
    void this.refreshState();
  }

  private async refreshState(): Promise<void> {
    try {
      await this.dataStore.refreshFromDisk();
      if (this.disposed) {
        return;
      }
      const dailyGoalMinutes = vscode.workspace.getConfiguration('codepulse').get<number>('dailyGoalMinutes', 120) ?? 120;
      const summary: DashboardSummary = this.dataStore.getDashboardSummary(Date.now(), dailyGoalMinutes, this.timeframe);
      const snapshot: CodePulseSnapshot = this.dataStore.getSnapshot();
      await this.panel.webview.postMessage({ type: 'state', summary, lastUpdated: snapshot.lastUpdated });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`CodePulse dashboard could not refresh: ${detail}`);
    } finally {
      this.refreshInProgress = false;
      if (this.refreshQueued && !this.disposed) {
        this.refreshQueued = false;
        this.refresh();
      }
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.panel.dispose();
    this.disposeListeners();
  }

  private disposeListeners(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isRecord(message) || typeof message.type !== 'string') {
      return;
    }

    if (message.type === 'timeframe' && isTimeframe(message.value)) {
      this.timeframe = message.value;
      this.refresh();
      return;
    }

    if (message.type === 'export' && (message.format === 'json' || message.format === 'csv')) {
      try {
        const path = await this.exportHandler(message.format, this.timeframe);
        await this.panel.webview.postMessage({
          type: path ? 'exported' : 'exportCancelled',
          ...(path ? { path } : {}),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`CodePulse export failed: ${detail}`);
      }
    }
  }

  private buildHtml(): string {
    const nonce = randomBytes(18).toString('base64');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';">
  <title>CodePulse Tracker</title>
  <style nonce="${nonce}">
    :root { color-scheme: dark; --bg: #0f172a; --panel: #111827; --card: #1f2937; --muted: #9ca3af; --text: #e5e7eb; --accent: #38bdf8; --good: #4ade80; --border: rgba(148,163,184,.2); }
    * { box-sizing: border-box; }
    body { margin: 0; background: linear-gradient(180deg,#0b1120 0%,#111827 100%); color: var(--text); font-family: var(--vscode-font-family,Segoe UI,sans-serif); }
    .shell { max-width: 1320px; margin: auto; padding: 24px; }
    .header,.toolbar,.card-head,.row-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .header { margin-bottom: 20px; flex-wrap: wrap; }
    h1 { font-size: 1.8rem; margin: 0; } h2 { font-size: 1.05rem; margin: 0 0 16px; }
    .tag { padding: 7px 12px; border: 1px solid var(--border); border-radius: 999px; color: var(--accent); background: rgba(56,189,248,.12); font-size: .78rem; text-transform: uppercase; }
    select,button { color: var(--text); background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 8px 11px; font: inherit; }
    button { cursor: pointer; } button:hover,select:hover { border-color: var(--accent); }
    .toolbar { flex-wrap: wrap; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit,minmax(170px,1fr)); gap: 14px; margin: 18px 0; }
    .card,.panel { background: rgba(17,24,39,.94); border: 1px solid var(--border); border-radius: 13px; padding: 17px; }
    .card-label { color: var(--muted); font-size: .72rem; text-transform: uppercase; letter-spacing: .07rem; margin-bottom: 7px; }
    .card-value { font-size: clamp(1.35rem,2vw,2rem); font-weight: 700; overflow-wrap: anywhere; }
    .grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 14px; }
    .stack { display: grid; gap: 14px; align-content: start; }
    .progress { display: block; width: 100%; height: 10px; margin-top: 12px; border: 0; border-radius: 99px; overflow: hidden; appearance: none; }
    .progress::-webkit-progress-bar { background: #374151; border-radius: 99px; }
    .progress::-webkit-progress-value { background: var(--good); border-radius: 99px; transition: width .2s ease; }
    .list { display: grid; gap: 9px; } .entry { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px solid var(--border); padding: 7px 0; }
    .entry span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 6px 12px; padding: 10px 0; border-bottom: 1px solid var(--border); }
    .session-title { font-weight: 600; overflow-wrap: anywhere; } .session-meta,.muted { color: var(--muted); font-size: .82rem; }
    .session-duration { color: var(--good); font-weight: 700; }
    .hours { height: 128px; display: grid; grid-template-columns: repeat(24,minmax(3px,1fr)); gap: 3px; align-items: end; border-bottom: 1px solid var(--border); }
    .hour { height: 128px; min-height: 2px; width: 100%; border: 0; border-radius: 3px 3px 0 0; appearance: none; writing-mode: vertical-lr; direction: rtl; }
    .hour::-webkit-progress-bar { background: #374151; border-radius: 3px 3px 0 0; }
    .hour::-webkit-progress-value { background: var(--accent); border-radius: 3px 3px 0 0; }
    .hour-labels { display: flex; justify-content: space-between; margin-top: 7px; color: var(--muted); font-size: .72rem; }
    .hours.daily { height: auto; gap: 8px; border-bottom: 0; }
    .day-col { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; }
    .day-col .hour { height: 128px; }
    .day-label { color: var(--muted); font-size: .72rem; white-space: nowrap; }
    .day-label.today { color: var(--accent); font-weight: 700; }
    .status { min-height: 1.2em; color: var(--muted); font-size: .82rem; }
    .empty { color: var(--muted); padding: 8px 0; }
    @media(max-width:850px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main class="shell">
    <header class="header"><h1>CodePulse Tracker</h1><span class="tag">Offline · private</span></header>
    <div class="toolbar">
      <label for="timeframe">Period</label>
      <select id="timeframe" aria-label="Analytics timeframe">
        <option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option>
      </select>
      <div>
        <button id="export-json" type="button">Export JSON</button>
        <button id="export-csv" type="button">Export CSV</button>
      </div>
    </div>
    <div id="status" class="status" role="status" aria-live="polite"></div>
    <section class="cards">
      <div class="card"><div class="card-label">Selected period</div><div class="card-value" id="period-total">0s</div></div>
      <div class="card"><div class="card-label">Active days</div><div class="card-value" id="active-days">0</div></div>
      <div class="card"><div class="card-label">Current streak</div><div class="card-value" id="current-streak">0 days</div></div>
      <div class="card"><div class="card-label">Longest streak</div><div class="card-value" id="longest-streak">0 days</div></div>
    </section>
    <div class="grid">
      <div class="stack">
        <section class="panel">
          <div class="card-head"><h2>Daily coding goal</h2><strong id="goal-label">0 / 0</strong></div>
          <progress class="progress" aria-label="Daily coding goal progress" id="goal-progress" max="100" value="0"></progress>
        </section>
        <section class="panel"><h2 id="activity-title">Hourly activity</h2><div class="hours" id="hours"></div><div class="hour-labels" id="hour-labels"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>11 PM</span></div><p class="muted" id="peak-hour">Peak coding hour: no activity yet</p></section>
        <section class="panel"><h2>Recent sessions</h2><div id="sessions" class="list"></div></section>
      </div>
      <div class="stack">
        <section class="panel"><h2>Project breakdown</h2><div id="projects" class="list"></div></section>
        <section class="panel"><h2>Language breakdown</h2><div id="languages" class="list"></div></section>
        <section class="panel"><h2>Active and idle time</h2><div class="entry"><span>Active</span><strong id="active-ratio">0%</strong></div><div class="entry"><span>Idle / untracked</span><strong id="idle-ratio">100%</strong></div></section>
      </div>
    </div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const byId = (id) => document.getElementById(id);
    const formatDuration = (value) => {
      const seconds = Math.max(0, Math.round(Number(value) || 0));
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const remainder = seconds % 60;
      const parts = [];
      if (hours) parts.push(hours + 'h');
      if (minutes || hours) parts.push(minutes + 'm');
      parts.push(remainder + 's');
      return parts.join(' ');
    };
    const setList = (element, entries, key) => {
      element.replaceChildren();
      if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No tracked activity in this period.';
        element.appendChild(empty);
        return;
      }
      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'entry';
        const name = document.createElement('span');
        name.textContent = String(entry[key]);
        const value = document.createElement('strong');
        value.textContent = formatDuration(entry.seconds);
        row.append(name, value);
        element.appendChild(row);
      }
    };
    const renderActivity = (summary) => {
      const hours = byId('hours');
      const labels = byId('hour-labels');
      const title = byId('activity-title');
      const peak = byId('peak-hour');
      hours.replaceChildren();
      hours.style.gridTemplateColumns = '';
      if (summary.timeframe === 'day') {
        hours.classList.remove('daily');
        labels.hidden = false;
        title.textContent = 'Hourly activity';
        const max = Math.max(1, ...summary.hourlyActivity);
        summary.hourlyActivity.forEach((seconds, index) => {
          const bar = document.createElement('progress');
          bar.className = 'hour';
          bar.max = max;
          bar.value = seconds;
          bar.title = index + ':00 · ' + formatDuration(seconds);
          hours.appendChild(bar);
        });
        peak.textContent = summary.peakCodingHour === null
          ? 'Peak coding hour: no activity yet'
          : 'Peak coding hour: ' + summary.peakCodingHour + ':00';
        return;
      }

      const buckets = summary.dailyBreakdown;
      hours.classList.add('daily');
      labels.hidden = true;
      title.textContent = summary.timeframe === 'week' ? 'Daily activity this week' : 'Daily activity this month';
      hours.style.gridTemplateColumns = 'repeat(' + buckets.length + ', minmax(0, 1fr))';
      const max = Math.max(1, ...buckets.map((bucket) => bucket.seconds));
      for (const bucket of buckets) {
        const column = document.createElement('div');
        column.className = 'day-col';
        const bar = document.createElement('progress');
        bar.className = 'hour';
        bar.max = max;
        bar.value = bucket.seconds;
        bar.title = longDate(bucket.date) + ' · ' + formatDuration(bucket.seconds);
        const label = document.createElement('span');
        label.className = bucket.isToday ? 'day-label today' : 'day-label';
        label.textContent = bucket.label;
        column.append(bar, label);
        hours.appendChild(column);
      }

      const busiest = buckets.reduce((best, bucket) => (bucket.seconds > best.seconds ? bucket : best), buckets[0]);
      peak.textContent = busiest && busiest.seconds > 0
        ? 'Most active day: ' + longDate(busiest.date) + ' (' + formatDuration(busiest.seconds) + ')'
        : 'Most active day: no activity yet';
    };
    const longDate = (dateKey) => new Date(dateKey + 'T00:00:00').toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
    const render = (summary) => {
      byId('period-total').textContent = formatDuration(summary.totalSeconds);
      byId('active-days').textContent = String(summary.activeDays);
      byId('current-streak').textContent = summary.currentStreak + ' days';
      byId('longest-streak').textContent = summary.longestStreak + ' days';
      byId('goal-label').textContent = formatDuration(summary.totalSecondsToday) + ' / ' + formatDuration(summary.dailyGoalSeconds);
      const progress = byId('goal-progress');
      progress.value = summary.goalProgressPercent;
      setList(byId('projects'), summary.projectBreakdown, 'project');
      setList(byId('languages'), summary.languageBreakdown, 'language');
      const sessionList = byId('sessions');
      sessionList.replaceChildren();
      if (!summary.recentSessions.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No tracked sessions in this period.';
        sessionList.appendChild(empty);
      }
      for (const session of summary.recentSessions) {
        const row = document.createElement('div');
        row.className = 'session';
        const title = document.createElement('span');
        title.className = 'session-title';
        title.textContent = session.project + ' · ' + session.language;
        const duration = document.createElement('span');
        duration.className = 'session-duration';
        duration.textContent = formatDuration(session.durationSeconds);
        const date = document.createElement('span');
        date.className = 'session-meta';
        date.textContent = new Date(session.start).toLocaleString();
        row.append(title, duration, date);
        sessionList.appendChild(row);
      }
      renderActivity(summary);
      byId('active-ratio').textContent = summary.activeRatioPercent + '%';
      byId('idle-ratio').textContent = summary.idleRatioPercent + '%';
    };
    byId('timeframe').addEventListener('change', (event) => {
      vscode.postMessage({ type: 'timeframe', value: event.target.value });
    });
    byId('export-json').addEventListener('click', () => vscode.postMessage({ type: 'export', format: 'json' }));
    byId('export-csv').addEventListener('click', () => vscode.postMessage({ type: 'export', format: 'csv' }));
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'state') render(message.summary);
      if (message.type === 'exported') byId('status').textContent = 'Exported to ' + message.path;
      if (message.type === 'exportCancelled') byId('status').textContent = 'Export cancelled.';
    });
  </script>
</body>
</html>`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTimeframe(value: unknown): value is Timeframe {
  return value === 'day' || value === 'week' || value === 'month';
}
