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
exports.CodePulseTracker = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const vscode = __importStar(require("vscode"));
const timeUtils_1 = require("./timeUtils");
class CodePulseTracker {
    instanceId;
    dataStore;
    leasePath;
    timer;
    statusBarItem;
    disposables;
    activeStartedAt = null;
    activeProject = 'Workspace';
    activeLanguage = 'Unknown';
    focusLostAt = null;
    dashboardRefresh;
    constructor(context, dataStore) {
        this.instanceId = (0, node_crypto_1.randomUUID)();
        this.dataStore = dataStore;
        this.leasePath = path.join(context.globalStorageUri.fsPath, 'codepulse-lease.json');
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBarItem.command = 'codepulse.openDashboard';
        this.statusBarItem.show();
        this.disposables = [this.statusBarItem];
        this.timer = setInterval(() => this.tick(), 1000);
    }
    setDashboardRefresh(handler) {
        this.dashboardRefresh = handler;
    }
    start() {
        this.disposables.push(vscode.window.onDidChangeActiveTextEditor(() => this.tick()), vscode.window.onDidChangeWindowState(() => this.tick()));
        this.tick();
    }
    dispose() {
        clearInterval(this.timer);
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        if (this.activeStartedAt !== null) {
            this.closeActiveInterval();
        }
    }
    tick() {
        const enabled = vscode.workspace.getConfiguration('codepulse').get('enabled', true);
        if (!enabled) {
            this.closeActiveInterval();
            this.updateStatusBar();
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
        this.updateStatusBar();
        this.writeLease();
    }
    updateStatusBar() {
        if (this.activeStartedAt === null) {
            this.statusBarItem.text = '$(watch) 0s';
            this.statusBarItem.tooltip = 'CodePulse: Not currently tracking. Click to open the dashboard.';
            return;
        }
        const elapsedSeconds = Math.floor((Date.now() - this.activeStartedAt) / 1000);
        this.statusBarItem.text = `$(watch) ${(0, timeUtils_1.formatDuration)(elapsedSeconds)}`;
        this.statusBarItem.tooltip = 'CodePulse: Time tracked in the current session. Click to open the dashboard.';
    }
    beginActiveInterval() {
        this.activeStartedAt = Date.now();
        this.activeProject = this.resolveProjectName();
        this.activeLanguage = this.resolveLanguage();
    }
    closeActiveInterval() {
        if (this.activeStartedAt === null) {
            return;
        }
        const endMs = Date.now();
        const segments = (0, timeUtils_1.splitIntervalAtMidnight)(this.activeStartedAt, endMs);
        const minSessionSeconds = vscode.workspace.getConfiguration('codepulse').get('minSessionSeconds', 10) ?? 10;
        let savedSession = false;
        for (const segment of segments) {
            const durationSeconds = Math.max(0, Math.round((segment.end - segment.start) / 1000));
            if (durationSeconds < minSessionSeconds) {
                continue;
            }
            const session = {
                id: (0, node_crypto_1.randomUUID)(),
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
    shouldTrack() {
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
        const gracePeriodMs = (config.get('focusGracePeriod', 30) ?? 30) * 1000;
        return nowMs - this.focusLostAt <= gracePeriodMs;
    }
    writeLease() {
        const lease = {
            instanceId: this.instanceId,
            lastSeenMs: Date.now(),
            workspaceName: vscode.workspace.name ?? 'unnamed-workspace',
        };
        fs.mkdirSync(path.dirname(this.leasePath), { recursive: true });
        fs.writeFileSync(this.leasePath, JSON.stringify(lease, null, 2), 'utf8');
    }
    readLease() {
        try {
            if (!fs.existsSync(this.leasePath)) {
                return undefined;
            }
            const content = fs.readFileSync(this.leasePath, 'utf8');
            if (!content.trim()) {
                return undefined;
            }
            const parsed = JSON.parse(content);
            if (!parsed || typeof parsed.instanceId !== 'string' || typeof parsed.lastSeenMs !== 'number') {
                return undefined;
            }
            return parsed;
        }
        catch {
            return undefined;
        }
    }
    getTrackingMode() {
        const mode = vscode.workspace.getConfiguration('codepulse').get('trackingMode', 'alwaysOpen');
        return mode === 'windowFocused' ? 'windowFocused' : 'alwaysOpen';
    }
    resolveProjectName() {
        const workspaceName = vscode.workspace.name ?? 'Unnamed workspace';
        const folders = vscode.workspace.workspaceFolders ?? [];
        return folders.length > 0 ? folders[0].name : workspaceName;
    }
    resolveLanguage() {
        const editor = vscode.window.activeTextEditor;
        return editor?.document.languageId ?? 'Unknown';
    }
}
exports.CodePulseTracker = CodePulseTracker;
//# sourceMappingURL=tracker.js.map