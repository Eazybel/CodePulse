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
    const storageDir = context.globalStorageUri?.fsPath ?? context.globalStoragePath;
    const dataStore = new dataStore_1.DataStore(storageDir);
    const dashboard = dashboard_1.DashboardPanel.create(context, dataStore);
    const tracker = new tracker_1.CodePulseTracker(context, dataStore);
    tracker.setDashboardRefresh(() => dashboard.refresh());
    context.subscriptions.push(tracker, dashboard, vscode.commands.registerCommand('codepulse.openDashboard', () => dashboard.show()), vscode.commands.registerCommand('codepulse.refreshDashboard', () => dashboard.refresh()), vscode.commands.registerCommand('codepulse.exportData', async () => {
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
    }), vscode.commands.registerCommand('codepulse.resetData', async () => {
        const choice = await vscode.window.showWarningMessage('Reset all local CodePulse data?', { modal: true }, 'Reset');
        if (choice !== 'Reset') {
            return;
        }
        dataStore.reset();
        dashboard.refresh();
        void vscode.window.showInformationMessage('CodePulse data reset.');
    }));
    tracker.start();
    dashboard.refresh();
}
function deactivate() {
    // Intentionally empty: cleanup is handled via disposables.
}
//# sourceMappingURL=extension.js.map