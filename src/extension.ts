import * as vscode from 'vscode';

import { DataStore } from './core/dataStore';
import { Timeframe } from './core/timeUtils';
import { CodePulseTracker } from './core/tracker';
import { DashboardPanel } from './dashboard';

type ExportFormat = 'json' | 'csv';

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('CodePulse');
  context.subscriptions.push(output);
  const dataStore = new DataStore(context.globalStorageUri.fsPath, (message, error) => {
    output.appendLine(`${message} ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  });
  const tracker = new CodePulseTracker(context, dataStore);

  const exportToFile = async (format: ExportFormat, timeframe?: Timeframe): Promise<string | undefined> => {
    const extension = format;
    const saveUri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(context.globalStorageUri, `codepulse-export.${extension}`),
      saveLabel: `Export CodePulse ${format.toUpperCase()}`,
      filters: {
        [format.toUpperCase()]: [extension],
      },
    });

    if (!saveUri) {
      return undefined;
    }

    return dataStore.exportData(saveUri.fsPath, format, timeframe);
  };

  tracker.setDashboardRefresh(() => DashboardPanel.currentPanel?.refresh());

  context.subscriptions.push(
    tracker,
    vscode.commands.registerCommand('codepulse.openDashboard', () => {
      DashboardPanel.create(context, dataStore, exportToFile).show();
    }),
    vscode.commands.registerCommand('codepulse.refreshDashboard', () => {
      DashboardPanel.create(context, dataStore, exportToFile).show();
    }),
    vscode.commands.registerCommand('codepulse.exportData', async () => {
      const format = await vscode.window.showQuickPick(
        [
          { label: 'JSON', description: 'Export all tracked sessions as JSON', value: 'json' as const },
          { label: 'CSV', description: 'Export all tracked sessions as CSV', value: 'csv' as const },
        ],
        { placeHolder: 'Choose an export format' },
      );
      if (!format) {
        return;
      }
      await runExport(exportToFile, format.value);
    }),
    vscode.commands.registerCommand('codepulse.exportJson', async () => {
      await runExport(exportToFile, 'json');
    }),
    vscode.commands.registerCommand('codepulse.exportCsv', async () => {
      await runExport(exportToFile, 'csv');
    }),
    vscode.commands.registerCommand('codepulse.resetData', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Reset all local CodePulse data? Tracking will continue with a new session.',
        { modal: true },
        'Reset',
      );

      if (choice !== 'Reset') {
        return;
      }

      let trackingPaused = false;
      try {
        await tracker.resetTracking();
        trackingPaused = true;
        await dataStore.reset();
        DashboardPanel.currentPanel?.refresh();
        void vscode.window.showInformationMessage('CodePulse data reset.');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`CodePulse could not reset its data: ${detail}`);
      } finally {
        if (trackingPaused) {
          await tracker.resumeTracking().catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`CodePulse could not resume tracking: ${detail}`);
          });
        }
      }
    }),
  );

  tracker.start();
}

async function runExport(
  exportToFile: (format: ExportFormat, timeframe?: Timeframe) => Promise<string | undefined>,
  format: ExportFormat,
): Promise<void> {
  try {
    const filePath = await exportToFile(format);
    if (filePath) {
      void vscode.window.showInformationMessage(`CodePulse data exported to ${filePath}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`CodePulse export failed: ${detail}`);
  }
}

export function deactivate(): void {
  // Extension disposables perform tracker and dashboard cleanup.
}
