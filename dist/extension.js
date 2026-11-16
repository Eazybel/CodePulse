"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const dataStore_1 = require("./core/dataStore");
const tracker_1 = require("./core/tracker");
const dashboard_1 = require("./dashboard");
function activate(context) {
    const output = vscode.window.createOutputChannel('CodePulse');
    context.subscriptions.push(output);
    const dataStore = new dataStore_1.DataStore(context.globalStorageUri.fsPath, (message, error) => {
        output.appendLine(`${message} ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    });
    const tracker = new tracker_1.CodePulseTracker(context, dataStore);
    const exportToFile = async (format, timeframe) => {
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
    tracker.setDashboardRefresh(() => dashboard_1.DashboardPanel.currentPanel?.refresh());
    context.subscriptions.push(tracker, vscode.commands.registerCommand('codepulse.openDashboard', () => {
        dashboard_1.DashboardPanel.create(context, dataStore, exportToFile).show();
    }), vscode.commands.registerCommand('codepulse.refreshDashboard', () => {
        dashboard_1.DashboardPanel.create(context, dataStore, exportToFile).show();
    }), vscode.commands.registerCommand('codepulse.exportData', async () => {
        const format = await vscode.window.showQuickPick([
            { label: 'JSON', description: 'Export all tracked sessions as JSON', value: 'json' },
            { label: 'CSV', description: 'Export all tracked sessions as CSV', value: 'csv' },
        ], { placeHolder: 'Choose an export format' });
        if (!format) {
            return;
        }
        await runExport(exportToFile, format.value);
    }), vscode.commands.registerCommand('codepulse.exportJson', async () => {
        await runExport(exportToFile, 'json');
    }), vscode.commands.registerCommand('codepulse.exportCsv', async () => {
        await runExport(exportToFile, 'csv');
    }), vscode.commands.registerCommand('codepulse.resetData', async () => {
        const choice = await vscode.window.showWarningMessage('Reset all local CodePulse data? Tracking will continue with a new session.', { modal: true }, 'Reset');
        if (choice !== 'Reset') {
            return;
        }
        let trackingPaused = false;
        try {
            await tracker.resetTracking();
            trackingPaused = true;
            await dataStore.reset();
            dashboard_1.DashboardPanel.currentPanel?.refresh();
            void vscode.window.showInformationMessage('CodePulse data reset.');
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`CodePulse could not reset its data: ${detail}`);
        }
        finally {
            if (trackingPaused) {
                await tracker.resumeTracking().catch((error) => {
                    const detail = error instanceof Error ? error.message : String(error);
                    void vscode.window.showErrorMessage(`CodePulse could not resume tracking: ${detail}`);
                });
            }
        }
    }));
    tracker.start();
}
async function runExport(exportToFile, format) {
    try {
        const filePath = await exportToFile(format);
        if (filePath) {
            void vscode.window.showInformationMessage(`CodePulse data exported to ${filePath}`);
        }
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        void vscode.window.showErrorMessage(`CodePulse export failed: ${detail}`);
    }
}
function deactivate() {
    // Extension disposables perform tracker and dashboard cleanup.
}
//# sourceMappingURL=extension.js.map