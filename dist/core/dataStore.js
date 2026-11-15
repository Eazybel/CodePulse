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
exports.DataStore = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const timeUtils_1 = require("./timeUtils");
class DataStore {
    filePath;
    snapshot;
    constructor(storageDir) {
        this.filePath = path.join(storageDir, 'codepulse-state.json');
        this.snapshot = this.readSnapshot();
    }
    getSnapshot() {
        return this.snapshot;
    }
    appendSession(session) {
        this.snapshot.sessions.push(session);
        this.snapshot.sessions.sort((left, right) => left.start - right.start);
        this.snapshot.lastUpdated = Date.now();
        this.persist();
    }
    reset() {
        this.snapshot = {
            version: 1,
            sessions: [],
            lastUpdated: Date.now(),
        };
        this.persist();
    }
    exportData(targetPath) {
        const output = JSON.stringify(this.snapshot, null, 2);
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, output, 'utf8');
        return targetPath;
    }
    getDashboardSummary(now = Date.now()) {
        const sessions = [...this.snapshot.sessions].sort((left, right) => left.start - right.start);
        const todayKey = (0, timeUtils_1.getLocalDateKey)(new Date(now));
        const startOfWeek = new Date(now);
        startOfWeek.setHours(0, 0, 0, 0);
        startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));
        const totalSecondsToday = sessions
            .filter((session) => session.localDate === todayKey)
            .reduce((sum, session) => sum + session.durationSeconds, 0);
        const totalSecondsThisWeek = sessions
            .filter((session) => session.start >= startOfWeek.getTime())
            .reduce((sum, session) => sum + session.durationSeconds, 0);
        const uniqueDates = new Set(sessions.map((session) => session.localDate));
        const recentSessions = sessions.slice(-8).reverse();
        const projectSeconds = new Map();
        for (const session of sessions) {
            const current = projectSeconds.get(session.project) ?? 0;
            projectSeconds.set(session.project, current + session.durationSeconds);
        }
        const projectBreakdown = Array.from(projectSeconds.entries())
            .map(([project, seconds]) => ({ project, seconds }))
            .sort((left, right) => right.seconds - left.seconds)
            .slice(0, 5);
        return {
            totalSecondsToday,
            totalSecondsThisWeek,
            totalSessions: sessions.length,
            activeDays: uniqueDates.size,
            recentSessions,
            projectBreakdown,
            averageDailySeconds: uniqueDates.size === 0 ? 0 : Math.round(totalSecondsThisWeek / uniqueDates.size),
        };
    }
    readSnapshot() {
        const fallback = {
            version: 1,
            sessions: [],
            lastUpdated: Date.now(),
        };
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            if (!fs.existsSync(this.filePath)) {
                return fallback;
            }
            const fileContent = fs.readFileSync(this.filePath, 'utf8');
            if (!fileContent.trim()) {
                return fallback;
            }
            const parsed = JSON.parse(fileContent);
            if (!parsed || !Array.isArray(parsed.sessions)) {
                this.backupBrokenFile();
                return fallback;
            }
            return {
                version: Number(parsed.version ?? 1),
                sessions: parsed.sessions.map((session) => ({
                    ...session,
                    durationSeconds: Number(session.durationSeconds ?? 0),
                    localHour: Number(session.localHour ?? 0),
                    start: Number(session.start ?? 0),
                    end: Number(session.end ?? 0),
                })),
                lastUpdated: Number(parsed.lastUpdated ?? Date.now()),
            };
        }
        catch (error) {
            this.backupBrokenFile();
            return fallback;
        }
    }
    persist() {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        if (fs.existsSync(this.filePath)) {
            const backupPath = `${this.filePath}.bak`;
            fs.copyFileSync(this.filePath, backupPath);
        }
        fs.writeFileSync(this.filePath, JSON.stringify(this.snapshot, null, 2), 'utf8');
    }
    backupBrokenFile() {
        if (!fs.existsSync(this.filePath)) {
            return;
        }
        const backupPath = `${this.filePath}.corrupt-${Date.now()}.bak`;
        fs.copyFileSync(this.filePath, backupPath);
    }
}
exports.DataStore = DataStore;
//# sourceMappingURL=dataStore.js.map