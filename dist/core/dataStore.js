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
const node_crypto_1 = require("node:crypto");
const timeUtils_1 = require("./timeUtils");
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 30_000;
const WRITE_DEBOUNCE_MS = 1_500;
class DataStore {
    filePath;
    lockPath;
    reportError;
    snapshot;
    sessionIds = new Set();
    pendingSessionVersions = new Map();
    revision = 0;
    writeQueue = Promise.resolve();
    flushTimer;
    constructor(storageDir, reportError = (message, error) => console.error(message, error)) {
        this.filePath = path.join(storageDir, 'codepulse-state.json');
        this.lockPath = `${this.filePath}.lock`;
        this.reportError = reportError;
        this.snapshot = this.readSnapshot();
        this.sessionIds = new Set(this.snapshot.sessions.map((session) => session.id));
    }
    getSnapshot() {
        return this.snapshot;
    }
    async refreshFromDisk() {
        const revisionAtStart = this.revision;
        const generationAtStart = this.snapshot.generation;
        const diskSnapshot = await this.readDiskSnapshot();
        if (this.revision !== revisionAtStart && this.snapshot.generation !== generationAtStart) {
            return;
        }
        const generationChanged = diskSnapshot.generation !== generationAtStart;
        const localPendingSessions = this.snapshot.sessions.filter((session) => this.pendingSessionVersions.has(session.id));
        const recentLocalSessions = !generationChanged
            ? localPendingSessions
            : clipSessionsAfter(localPendingSessions, diskSnapshot.resetAt);
        this.snapshot = {
            ...diskSnapshot,
            sessions: mergeOverlappingSessions([...diskSnapshot.sessions, ...recentLocalSessions]),
        };
        this.sessionIds = new Set(this.snapshot.sessions.map((session) => session.id));
        if (generationChanged) {
            const retainedIds = new Set(recentLocalSessions.map((session) => session.id));
            for (const id of this.pendingSessionVersions.keys()) {
                if (!retainedIds.has(id)) {
                    this.pendingSessionVersions.delete(id);
                }
            }
        }
    }
    appendSession(session) {
        if (!isValidSession(session)) {
            throw new TypeError('Cannot append an invalid CodePulse session.');
        }
        if (this.sessionIds.has(session.id)) {
            throw new TypeError(`CodePulse session id "${session.id}" already exists.`);
        }
        const sessions = this.snapshot.sessions;
        const previous = sessions[sessions.length - 1];
        if (previous && canMergeSessions(previous, session)) {
            previous.end = Math.max(previous.end, session.end);
            previous.durationSeconds = (previous.end - previous.start) / 1000;
            this.markPending(previous.id);
        }
        else {
            sessions.push({ ...session });
            this.sessionIds.add(session.id);
            this.markPending(session.id);
        }
        this.snapshot.lastUpdated = Date.now();
        this.schedulePersist();
    }
    async reset() {
        this.clearFlushTimer();
        this.snapshot = {
            version: 2,
            generation: (0, node_crypto_1.randomUUID)(),
            resetAt: Date.now(),
            sessions: [],
            lastUpdated: Date.now(),
        };
        this.revision += 1;
        this.pendingSessionVersions.clear();
        this.sessionIds.clear();
        await this.enqueuePersist(true);
    }
    async flush() {
        this.clearFlushTimer();
        await this.enqueuePersist();
    }
    async exportData(targetPath, format = 'json', timeframe, now = Date.now()) {
        const sessions = timeframe ? this.getSessionsForTimeframe(timeframe, now) : this.snapshot.sessions;
        const output = format === 'csv' ? sessionsToCsv(sessions) : JSON.stringify({ ...this.snapshot, sessions }, null, 2);
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        const temporaryPath = `${targetPath}.${(0, node_crypto_1.randomUUID)()}.tmp`;
        try {
            await fs.promises.writeFile(temporaryPath, output, { encoding: 'utf8', flag: 'wx' });
            await fs.promises.rename(temporaryPath, targetPath);
            return targetPath;
        }
        catch (error) {
            await fs.promises.unlink(temporaryPath).catch(() => undefined);
            throw error;
        }
    }
    getDashboardSummary(now = Date.now(), dailyGoalMinutes = 120, timeframe = 'day') {
        const range = (0, timeUtils_1.getTimeframeRange)(timeframe, now);
        const sessions = this.snapshot.sessions
            .filter((session) => session.localDate >= range.startDate && session.localDate <= range.endDate)
            .sort((left, right) => left.start - right.start);
        const totalSeconds = sessions.reduce((sum, session) => sum + session.durationSeconds, 0);
        const todayKey = (0, timeUtils_1.getLocalDateKey)(new Date(now));
        const totalSecondsToday = this.snapshot.sessions
            .filter((session) => session.localDate === todayKey)
            .reduce((sum, session) => sum + session.durationSeconds, 0);
        const weekStart = (0, timeUtils_1.getTimeframeRange)('week', now).startDate;
        const totalSecondsThisWeek = this.snapshot.sessions
            .filter((session) => session.localDate >= weekStart && session.localDate <= todayKey)
            .reduce((sum, session) => sum + session.durationSeconds, 0);
        const projectBreakdown = aggregate(sessions, (session) => session.project, 8);
        const languageBreakdown = aggregate(sessions, (session) => session.language, 8)
            .map((entry) => ({ language: entry.project, seconds: entry.seconds }));
        const dates = Array.from(new Set(this.snapshot.sessions.map((session) => session.localDate))).sort();
        const rangeDates = new Set(sessions.map((session) => session.localDate));
        const hourlyActivity = Array.from({ length: 24 }, () => 0);
        for (const session of sessions) {
            hourlyActivity[session.localHour] += session.durationSeconds;
        }
        const peakSeconds = Math.max(...hourlyActivity);
        const earliest = sessions.length > 0 ? Math.max(range.start, sessions[0].start) : now;
        const lastSessionEnd = sessions.reduce((latestEnd, session) => Math.max(latestEnd, session.end), -Infinity);
        const latest = sessions.length > 0 ? Math.min(now, lastSessionEnd) : now;
        const observedSeconds = Math.max(0, Math.round((latest - earliest) / 1000));
        const activeSeconds = Math.min(totalSeconds, observedSeconds);
        const activeRatioPercent = observedSeconds === 0 ? 0 : Math.round((activeSeconds / observedSeconds) * 100);
        const currentStreak = getCurrentStreak(dates, todayKey);
        const dailyGoalSeconds = Math.max(0, Math.round(dailyGoalMinutes * 60));
        return {
            timeframe,
            rangeStart: range.startDate,
            rangeEnd: range.endDate,
            totalSecondsToday,
            totalSecondsThisWeek,
            totalSeconds,
            totalSessions: sessions.length,
            activeDays: rangeDates.size,
            recentSessions: sessions.slice(-8).reverse(),
            projectBreakdown,
            languageBreakdown,
            averageDailySeconds: rangeDates.size === 0 ? 0 : Math.round(totalSeconds / rangeDates.size),
            dailyGoalSeconds,
            goalProgressPercent: dailyGoalSeconds === 0
                ? 0
                : Math.min(100, Math.round((totalSecondsToday / dailyGoalSeconds) * 100)),
            currentStreak,
            longestStreak: getLongestStreak(dates),
            peakCodingHour: peakSeconds === 0 ? null : hourlyActivity.indexOf(peakSeconds),
            hourlyActivity,
            activeRatioPercent,
            idleRatioPercent: 100 - activeRatioPercent,
        };
    }
    getSessionsForTimeframe(timeframe, now) {
        const range = (0, timeUtils_1.getTimeframeRange)(timeframe, now);
        return this.snapshot.sessions.filter((session) => session.localDate >= range.startDate && session.localDate <= range.endDate);
    }
    readSnapshot() {
        const fallback = createEmptySnapshot();
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        for (const candidate of [this.filePath, `${this.filePath}.bak`]) {
            if (!fs.existsSync(candidate)) {
                continue;
            }
            try {
                const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
                const validated = validateSnapshot(parsed);
                if (!validated) {
                    throw new TypeError('The saved CodePulse data does not match the supported schema.');
                }
                if (candidate !== this.filePath) {
                    this.reportError('Recovered CodePulse data from its backup file.', new Error(candidate));
                }
                return validated;
            }
            catch (error) {
                this.reportError(`Unable to load CodePulse data from ${candidate}.`, error);
                if (candidate === this.filePath) {
                    this.backupBrokenFile();
                }
            }
        }
        return fallback;
    }
    schedulePersist() {
        if (this.flushTimer) {
            return;
        }
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            void this.enqueuePersist().catch((error) => {
                this.reportError('Unable to persist CodePulse data.', error);
            });
        }, WRITE_DEBOUNCE_MS);
    }
    enqueuePersist(reset = false) {
        this.writeQueue = this.writeQueue.then(() => this.persist(reset), () => this.persist(reset));
        return this.writeQueue;
    }
    async persist(reset) {
        const revisionAtStart = this.revision;
        const pendingAtStart = new Map(this.pendingSessionVersions);
        const localSessionsAtStart = this.snapshot.sessions.map((session) => ({ ...session }));
        const generationAtStart = this.snapshot.generation;
        const resetAtStart = this.snapshot.resetAt;
        const releaseLock = await this.acquireFileLock();
        try {
            const diskSnapshot = await this.readDiskSnapshot();
            let sessions;
            if (reset) {
                sessions = clipSessionsAfter(localSessionsAtStart, resetAtStart);
            }
            else if (diskSnapshot.generation !== generationAtStart) {
                sessions = diskSnapshot.sessions.concat(clipSessionsAfter(localSessionsAtStart.filter((session) => pendingAtStart.has(session.id)), diskSnapshot.resetAt));
            }
            else {
                const byId = new Map(diskSnapshot.sessions.map((session) => [session.id, session]));
                for (const session of localSessionsAtStart) {
                    if (pendingAtStart.has(session.id)) {
                        byId.set(session.id, session);
                    }
                }
                sessions = Array.from(byId.values());
            }
            const snapshotToWrite = {
                version: 2,
                generation: reset ? generationAtStart : diskSnapshot.generation,
                resetAt: reset ? resetAtStart : diskSnapshot.resetAt,
                sessions: mergeOverlappingSessions(sessions),
                lastUpdated: Date.now(),
            };
            await this.writeSnapshotAtomically(snapshotToWrite);
            if (this.revision !== revisionAtStart && this.snapshot.generation !== generationAtStart) {
                return;
            }
            const newPendingSessions = this.snapshot.sessions.filter((session) => this.pendingSessionVersions.has(session.id) &&
                this.pendingSessionVersions.get(session.id) !== pendingAtStart.get(session.id));
            this.snapshot = {
                ...snapshotToWrite,
                generation: snapshotToWrite.generation,
                resetAt: snapshotToWrite.resetAt,
                sessions: mergeOverlappingSessions([...snapshotToWrite.sessions, ...newPendingSessions]),
            };
            this.sessionIds = new Set(this.snapshot.sessions.map((session) => session.id));
            for (const [id, version] of pendingAtStart) {
                if (this.pendingSessionVersions.get(id) === version) {
                    this.pendingSessionVersions.delete(id);
                }
            }
            if (this.revision !== revisionAtStart) {
                this.snapshot.lastUpdated = Date.now();
            }
        }
        finally {
            await releaseLock();
        }
    }
    async readDiskSnapshot() {
        try {
            const content = await fs.promises.readFile(this.filePath, 'utf8');
            const validated = validateSnapshot(JSON.parse(content));
            if (validated) {
                return validated;
            }
            throw new TypeError('The latest CodePulse data file does not match the supported schema.');
        }
        catch (error) {
            if (isNodeError(error, 'ENOENT')) {
                const backupContent = await fs.promises.readFile(`${this.filePath}.bak`, 'utf8').catch((backupError) => {
                    if (isNodeError(backupError, 'ENOENT')) {
                        return undefined;
                    }
                    throw backupError;
                });
                if (!backupContent) {
                    return createEmptySnapshot();
                }
                const backupSnapshot = validateSnapshot(JSON.parse(backupContent));
                if (!backupSnapshot) {
                    throw new TypeError('The CodePulse backup does not match the supported schema.');
                }
                this.reportError('Recovered CodePulse data from its backup file.', new Error(`${this.filePath}.bak`));
                return backupSnapshot;
            }
            this.reportError('Unable to read the latest CodePulse data before saving.', error);
            const content = await fs.promises.readFile(`${this.filePath}.bak`, 'utf8').catch((backupError) => {
                if (isNodeError(backupError, 'ENOENT')) {
                    return undefined;
                }
                throw backupError;
            });
            if (!content) {
                return createEmptySnapshot();
            }
            const validated = validateSnapshot(JSON.parse(content));
            if (validated) {
                return validated;
            }
            throw new TypeError('The CodePulse backup does not match the supported schema.');
        }
    }
    async writeSnapshotAtomically(snapshot) {
        const temporaryPath = `${this.filePath}.${(0, node_crypto_1.randomUUID)()}.tmp`;
        const content = JSON.stringify(snapshot, null, 2);
        try {
            const handle = await fs.promises.open(temporaryPath, 'wx');
            try {
                await handle.writeFile(content, 'utf8');
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            try {
                const existing = await fs.promises.readFile(this.filePath, 'utf8');
                if (validateSnapshot(JSON.parse(existing))) {
                    await fs.promises.copyFile(this.filePath, `${this.filePath}.bak`);
                }
            }
            catch (error) {
                if (!isNodeError(error, 'ENOENT') && !(error instanceof SyntaxError)) {
                    throw error;
                }
            }
            await fs.promises.rename(temporaryPath, this.filePath);
        }
        catch (error) {
            await fs.promises.unlink(temporaryPath).catch(() => undefined);
            throw error;
        }
    }
    async acquireFileLock() {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        const startedAt = Date.now();
        while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
            try {
                const handle = await fs.promises.open(this.lockPath, 'wx');
                await handle.writeFile(`${process.pid}:${Date.now()}`);
                return async () => {
                    await handle.close();
                    await fs.promises.unlink(this.lockPath).catch((error) => {
                        if (!isNodeError(error, 'ENOENT')) {
                            throw error;
                        }
                    });
                };
            }
            catch (error) {
                if (!isNodeError(error, 'EEXIST')) {
                    throw error;
                }
            }
            const lockStat = await fs.promises.stat(this.lockPath).catch((error) => {
                if (isNodeError(error, 'ENOENT')) {
                    return undefined;
                }
                throw error;
            });
            if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
                await delay(100);
                const currentStat = await fs.promises.stat(this.lockPath).catch((error) => {
                    if (isNodeError(error, 'ENOENT')) {
                        return undefined;
                    }
                    throw error;
                });
                if (currentStat &&
                    currentStat.ino === lockStat.ino &&
                    currentStat.mtimeMs === lockStat.mtimeMs &&
                    Date.now() - currentStat.mtimeMs > LOCK_STALE_MS) {
                    await fs.promises.unlink(this.lockPath).catch((error) => {
                        if (!isNodeError(error, 'ENOENT')) {
                            throw error;
                        }
                    });
                }
            }
            await delay(50);
        }
        throw new Error('Timed out waiting for the CodePulse data file lock.');
    }
    clearFlushTimer() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }
    }
    markPending(id) {
        this.revision += 1;
        this.pendingSessionVersions.set(id, this.revision);
    }
    backupBrokenFile() {
        if (!fs.existsSync(this.filePath)) {
            return;
        }
        try {
            fs.copyFileSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}.bak`);
        }
        catch (error) {
            this.reportError('Unable to back up the damaged CodePulse data file.', error);
        }
    }
}
exports.DataStore = DataStore;
function createEmptySnapshot() {
    return {
        version: 2,
        generation: 'initial',
        resetAt: 0,
        sessions: [],
        lastUpdated: Date.now(),
    };
}
function validateSnapshot(value) {
    if (!isRecord(value) ||
        (value.version !== 1 && value.version !== 2) ||
        !Array.isArray(value.sessions)) {
        return undefined;
    }
    const sessions = value.sessions.filter(isValidSession);
    if (sessions.length !== value.sessions.length ||
        new Set(sessions.map((session) => session.id)).size !== sessions.length) {
        return undefined;
    }
    const generation = typeof value.generation === 'string' ? value.generation : 'initial';
    const resetAt = isFiniteNumber(value.resetAt) ? value.resetAt : 0;
    const lastUpdated = isFiniteNumber(value.lastUpdated) ? value.lastUpdated : Date.now();
    return {
        version: 2,
        generation,
        resetAt,
        sessions: mergeOverlappingSessions(sessions),
        lastUpdated,
    };
}
function isValidSession(value) {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.id === 'string' &&
        value.id.length > 0 &&
        value.id.length <= 256 &&
        isFiniteNumber(value.start) &&
        Math.abs(value.start) <= 8_640_000_000_000_000 &&
        isFiniteNumber(value.end) &&
        Math.abs(value.end) <= 8_640_000_000_000_000 &&
        value.end > value.start &&
        isFiniteNumber(value.durationSeconds) &&
        Number.isInteger(value.durationSeconds) &&
        value.durationSeconds > 0 &&
        Math.abs(value.durationSeconds - (value.end - value.start) / 1000) <= 1 &&
        typeof value.project === 'string' &&
        value.project.length <= 512 &&
        typeof value.language === 'string' &&
        value.language.length <= 512 &&
        typeof value.localDate === 'string' &&
        isValidDateKey(value.localDate) &&
        isFiniteNumber(value.localHour) &&
        Number.isInteger(value.localHour) &&
        value.localHour >= 0 &&
        value.localHour <= 23 &&
        (value.mode === 'alwaysOpen' || value.mode === 'windowFocused');
}
function isValidDateKey(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) {
        return false;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month - 1 &&
        parsed.getUTCDate() === day;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function isNodeError(error, code) {
    return error instanceof Error && 'code' in error && error.code === code;
}
function canMergeSessions(left, right) {
    return left.project === right.project &&
        left.language === right.language &&
        left.localDate === right.localDate &&
        left.localHour === right.localHour &&
        left.mode === right.mode &&
        right.start <= left.end + 1_500 &&
        right.end >= left.end;
}
function mergeOverlappingSessions(sessions) {
    const ordered = [...sessions].sort((left, right) => left.start - right.start || left.id.localeCompare(right.id));
    const merged = [];
    let coverageEnd = -Infinity;
    for (const current of ordered) {
        if (current.start < coverageEnd) {
            current.start = coverageEnd;
            if (current.end <= current.start) {
                continue;
            }
            const startDate = new Date(current.start);
            current.durationSeconds = (current.end - current.start) / 1000;
            if (current.durationSeconds <= 0) {
                continue;
            }
            current.localDate = (0, timeUtils_1.getLocalDateKey)(startDate);
            current.localHour = startDate.getHours();
        }
        const previous = merged[merged.length - 1];
        if (previous && canMergeSessions(previous, current)) {
            previous.end = Math.max(previous.end, current.end);
            previous.durationSeconds = (previous.end - previous.start) / 1000;
            coverageEnd = Math.max(coverageEnd, previous.end);
        }
        else {
            merged.push({ ...current });
            coverageEnd = Math.max(coverageEnd, current.end);
        }
    }
    return merged;
}
function clipSessionsAfter(sessions, cutoff) {
    const clipped = [];
    for (const source of sessions) {
        if (source.end <= cutoff) {
            continue;
        }
        const session = { ...source };
        if (session.start < cutoff) {
            session.start = cutoff;
            const date = new Date(cutoff);
            session.localDate = (0, timeUtils_1.getLocalDateKey)(date);
            session.localHour = date.getHours();
            session.durationSeconds = (session.end - session.start) / 1000;
        }
        if (session.durationSeconds > 0) {
            clipped.push(session);
        }
    }
    return clipped;
}
function aggregate(sessions, keySelector, limit) {
    const secondsByKey = new Map();
    for (const session of sessions) {
        const key = keySelector(session);
        secondsByKey.set(key, (secondsByKey.get(key) ?? 0) + session.durationSeconds);
    }
    return Array.from(secondsByKey, ([project, seconds]) => ({ project, seconds }))
        .sort((left, right) => right.seconds - left.seconds)
        .slice(0, limit);
}
function getCurrentStreak(dates, todayKey) {
    const dateSet = new Set(dates);
    let cursor = new Date(`${todayKey}T12:00:00`);
    if (!dateSet.has(todayKey)) {
        cursor.setDate(cursor.getDate() - 1);
    }
    let streak = 0;
    while (dateSet.has((0, timeUtils_1.getLocalDateKey)(cursor))) {
        streak += 1;
        cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
}
function getLongestStreak(dates) {
    let longest = 0;
    let current = 0;
    let previous;
    for (const key of dates) {
        const date = new Date(`${key}T12:00:00`);
        const gap = previous ? Math.round((date.getTime() - previous.getTime()) / 86_400_000) : 0;
        current = gap === 1 ? current + 1 : 1;
        longest = Math.max(longest, current);
        previous = date;
    }
    return longest;
}
function sessionsToCsv(sessions) {
    const columns = [
        'id',
        'start',
        'end',
        'durationSeconds',
        'project',
        'language',
        'localDate',
        'localHour',
        'mode',
    ];
    return [
        columns.join(','),
        ...sessions.map((session) => columns.map((column) => csvCell(String(session[column]))).join(',')),
    ].join('\r\n');
}
function csvCell(value) {
    const spreadsheetSafeValue = /^[\t\r ]*[=+\-@]/.test(value) ? `'${value}` : value;
    return `"${spreadsheetSafeValue.replace(/"/g, '""')}"`;
}
function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
//# sourceMappingURL=dataStore.js.map