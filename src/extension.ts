import * as vscode from 'vscode';

import { DataStore } from './core/dataStore';
import { CodePulseTracker } from './core/tracker';
import { DashboardPanel } from './dashboard';

export function activate(context: vscode.ExtensionContext): void {
  const storageDir = context.globalStorageUri?.fsPath ?? context.globalStoragePath;
  const dataStore = new DataStore(storageDir);
  const dashboard = DashboardPanel.create(context, dataStore);
  const tracker = new CodePulseTracker(context, dataStore);

  tracker.setDashboardRefresh(() => dashboard.refresh());

  context.subscriptions.push(
    tracker,
    dashboard,
    vscode.commands.registerCommand('codepulse.openDashboard', () => dashboard.show()),
    vscode.commands.registerCommand('codepulse.refreshDashboard', () => dashboard.refresh()),
    vscode.commands.registerCommand('codepulse.exportData', async () => {
      const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(context.globalStorageUri, 'codepulse-export.json'),
        saveLabel: 'Export CodePulse data',
        filters: {
          JSON: ['json'],
        },
      });

      if (!saveUri) {
        return;
      }

      const savedFile = dataStore.exportData(saveUri.fsPath);
      void vscode.window.showInformationMessage(`CodePulse data exported to ${savedFile}`);
    }),
    vscode.commands.registerCommand('codepulse.resetData', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Reset all local CodePulse data?',
        { modal: true },
        'Reset',
      );

      if (choice !== 'Reset') {
        return;
      }

      dataStore.reset();
      dashboard.refresh();
      void vscode.window.showInformationMessage('CodePulse data reset.');
    }),
  );

  tracker.start();
  dashboard.refresh();
}

export function deactivate(): void {
  // Intentionally empty: cleanup is handled via disposables.
}
