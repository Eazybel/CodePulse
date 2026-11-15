import * as vscode from 'vscode';

import { DataStore, DashboardSummary } from './core/dataStore';
import { formatDuration } from './core/timeUtils';

export class DashboardPanel implements vscode.Disposable {
  public static currentPanel: DashboardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly dataStore: DataStore;
  private disposed = false;

  public constructor(context: vscode.ExtensionContext, dataStore: DataStore) {
    this.dataStore = dataStore;
    this.panel = vscode.window.createWebviewPanel(
      'codepulse.dashboard',
      'CodePulse Tracker',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    this.panel.webview.html = this.render();
    this.panel.onDidDispose(() => {
      this.disposed = true;
      if (DashboardPanel.currentPanel === this) {
        DashboardPanel.currentPanel = undefined;
      }
    });
  }

  public static create(context: vscode.ExtensionContext, dataStore: DataStore): DashboardPanel {
    if (DashboardPanel.currentPanel && !DashboardPanel.currentPanel.disposed) {
      DashboardPanel.currentPanel.panel.reveal(vscode.ViewColumn.One, true);
      DashboardPanel.currentPanel.refresh();
      return DashboardPanel.currentPanel;
    }

    const panel = new DashboardPanel(context, dataStore);
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

    this.panel.webview.html = this.render();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.panel.dispose();
  }

  private render(): string {
    const summary = this.dataStore.getDashboardSummary();
    return this.buildHtml(summary);
  }

  private buildHtml(summary: DashboardSummary): string {
    const topProject = summary.projectBreakdown[0] ?? { project: 'No activity yet', seconds: 0 };
    const recentRows = summary.recentSessions.length === 0
      ? '<div class="empty">No tracked sessions yet.</div>'
      : summary.recentSessions
        .map((session) => {
          const title = `${session.project} • ${session.language}`;
          const duration = formatDuration(session.durationSeconds);
          const date = new Date(session.start).toLocaleString();
          return `
            <div class="session-row">
              <div>
                <div class="session-title">${escapeHtml(title)}</div>
                <div class="session-meta">${escapeHtml(date)}</div>
              </div>
              <div class="session-duration">${escapeHtml(duration)}</div>
            </div>
          `;
        })
        .join('');

    return `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>CodePulse Tracker</title>
          <style>
            :root {
              --bg: #0f172a;
              --panel: #111827;
              --card: #1f2937;
              --muted: #9ca3af;
              --text: #e5e7eb;
              --accent: #38bdf8;
              --accent-soft: rgba(56, 189, 248, 0.18);
              --good: #4ade80;
              --border: rgba(148, 163, 184, 0.2);
            }

            * { box-sizing: border-box; }
            body {
              margin: 0;
              background: linear-gradient(180deg, #0b1120 0%, #111827 100%);
              color: var(--text);
              font-family: var(--vscode-font-family, Segoe UI, sans-serif);
            }

            .shell {
              padding: 24px;
            }

            .header {
              display: flex;
              justify-content: space-between;
              align-items: center;
              margin-bottom: 24px;
            }

            .header h1 {
              font-size: 1.8rem;
              margin: 0;
            }

            .tag {
              padding: 7px 12px;
              border-radius: 999px;
              border: 1px solid var(--border);
              background: var(--accent-soft);
              color: var(--accent);
              font-size: 0.8rem;
              letter-spacing: 0.04rem;
              text-transform: uppercase;
            }

            .cards {
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
              gap: 16px;
              margin-bottom: 24px;
            }

            .card {
              background: rgba(31, 41, 55, 0.95);
              border: 1px solid var(--border);
              border-radius: 14px;
              padding: 18px;
              box-shadow: 0 8px 20px rgba(15, 23, 42, 0.25);
            }

            .card-label {
              color: var(--muted);
              font-size: 0.75rem;
              text-transform: uppercase;
              letter-spacing: 0.08rem;
              margin-bottom: 8px;
            }

            .card-value {
              font-size: clamp(1.5rem, 2vw, 2.2rem);
              font-weight: 700;
            }

            .grid {
              display: grid;
              grid-template-columns: 1.6fr 1fr;
              gap: 16px;
            }

            .panel {
              background: rgba(17, 24, 39, 0.92);
              border: 1px solid var(--border);
              border-radius: 14px;
              padding: 18px;
            }

            .panel h2 {
              margin: 0 0 16px 0;
              font-size: 1.1rem;
            }

            .session-list {
              display: flex;
              flex-direction: column;
              gap: 12px;
            }

            .session-row {
              display: flex;
              justify-content: space-between;
              align-items: center;
              gap: 16px;
              border: 1px solid var(--border);
              background: rgba(15, 23, 42, 0.7);
              padding: 12px 14px;
              border-radius: 10px;
            }

            .session-title {
              font-weight: 600;
              margin-bottom: 4px;
            }

            .session-meta {
              color: var(--muted);
              font-size: 0.78rem;
            }

            .session-duration {
              font-weight: 700;
              color: var(--good);
            }

            .empty {
              color: var(--muted);
              padding: 14px 0;
            }

            .breakdown {
              list-style: none;
              margin: 0;
              padding: 0;
              display: flex;
              flex-direction: column;
              gap: 12px;
            }

            .breakdown li {
              display: flex;
              justify-content: space-between;
              align-items: center;
              gap: 10px;
              border-bottom: 1px solid var(--border);
              padding-bottom: 8px;
            }

            .project-name {
              white-space: nowrap;
              overflow: hidden;
              text-overflow: ellipsis;
            }

            @media (max-width: 900px) {
              .grid {
                grid-template-columns: 1fr;
              }
            }
          </style>
        </head>
        <body>
          <div class="shell">
            <div class="header">
              <h1>CodePulse Tracker</h1>
              <div class="tag">Offline</div>
            </div>

            <div class="cards">
              <div class="card">
                <div class="card-label">Today</div>
                <div class="card-value">${escapeHtml(formatDuration(summary.totalSecondsToday))}</div>
              </div>
              <div class="card">
                <div class="card-label">This week</div>
                <div class="card-value">${escapeHtml(formatDuration(summary.totalSecondsThisWeek))}</div>
              </div>
              <div class="card">
                <div class="card-label">Active days</div>
                <div class="card-value">${summary.activeDays}</div>
              </div>
              <div class="card">
                <div class="card-label">Top project</div>
                <div class="card-value">${escapeHtml(topProject.project)}</div>
              </div>
            </div>

            <div class="grid">
              <div class="panel">
                <h2>Recent sessions</h2>
                <div class="session-list">${recentRows}</div>
              </div>

              <div class="panel">
                <h2>Project breakdown</h2>
                <ul class="breakdown">
                  ${summary.projectBreakdown.length === 0 ? '<li class="empty">No tracked projects</li>' : summary.projectBreakdown.map((entry) => `
                    <li>
                      <span class="project-name">${escapeHtml(entry.project)}</span>
                      <strong>${escapeHtml(formatDuration(entry.seconds))}</strong>
                    </li>
                  `).join('')}
                </ul>
              </div>
            </div>
          </div>
        </body>
      </html>
    `;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
