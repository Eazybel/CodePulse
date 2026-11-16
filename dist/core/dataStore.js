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
exports.sessionIdFor = sessionIdFor;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const node_crypto_1 = require("node:crypto");
const timeUtils_1 = require("./timeUtils");
const CHECKPOINT_PATTERN = /^codepulse-active-[0-9a-f-]+\.json$/i;
const WRITE_DEBOUNCE_MS = 1_500;
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_STALE_MS = 30_000;
function sessionIdFor(instanceId, segmentStart) {
    return `${instanceId}-${segmentStart}`;
}
class DataStore {
    static sharedStores = new Map();
    storageDir;
    filePath;
    lockPath;
    reportError;
    snapshot;
    sessionIds = new Set();
    pendingSessionVersions = new Map();
    revision = 0;
    writeQueue = Promise.resolve();
    flushTimer;
    loadedMtimeMs = 0;
    liveStartMs = null;
    constructor(storageDir, reportError = (message, error) => console.error(message, error)) {
        const existing = DataStore.sharedStores.get(storageDir);
        if (existing) {
            this.storageDir = existing.storageDir;
            this.filePath = existing.filePath;
            this.lockPath = existing.lockPath;
            this.reportError = existing.reportError;
            this.snapshot = existing.snapshot;
            this.sessionIds = existing.sessionIds;
            this.pendingSessionVersions = existing.pendingSessionVersions;
            this.revision = existing.revision;
            this.writeQueue = existing.writeQueue;
            this.flushTimer = existing.flushTimer;
            this.loadedMtimeMs = existing.loadedMtimeMs;
            this.liveStartMs = existing.liveStartMs;
            return;
        }
        this.storageDir = storageDir;
        this.filePath = path.join(storageDir, 'codepulse-state.json');
        this.lockPath = `${this.filePath}.lock`;
        this.reportError = reportError;
        this.snapshot = this.readSnapshot();
        this.sessionIds = new Set(this.snapshot.sessions.map((session) => session.id));
        this.loadedMtimeMs = this.currentMtimeMs();
        DataStore.sharedStores.set(storageDir, this);
    }
    currentStore() {
        return DataStore.sharedStores.get(this.storageDir) ?? this;
    }
    getTodaySeconds(now = Date.now()) {
        const store = this.currentStore();
        store.reloadIfChanged();
        const today = (0, timeUtils_1.getLocalDateKey)(new Date(now));
        const saved = store.snapshot.sessions
            .filter((session) => session.localDate === today)
            .reduce((sum, session) => sum + session.durationSeconds, 0);
        const liveMs = store.liveSegments(now)
            .filter((segment) => segment.dateKey === today)
            .reduce((sum, segment) => sum + segment.end - segment.start, 0);
        return saved + Math.round(liveMs / 1000);
    }
    appendSession(session) {
        const store = this.currentStore();
        if (!isValidSession(session)) {
            throw new TypeError('Cannot append an invalid CodePulse session.');
        }
        store.reloadIfChanged();
        const clipped = clipSessionsAfter([session], store.snapshot.resetAt)[0];
        if (!clipped || store.sessionIds.has(clipped.id)) {
            return;
        }
        const sessions = store.snapshot.sessions;
        const previous = sessions[sessions.length - 1];
        if (previous && canMergeSessions(previous, clipped)) {
            previous.end = Math.max(previous.end, clipped.end);
            previous.durationSeconds = (previous.end - previous.start) / 1000;
            store.markPending(previous.id);
        }
        else {
            sessions.push(clipped);
            sessions.sort((left, right) => left.start - right.start);
            store.sessionIds.add(clipped.id);
            store.markPending(clipped.id);
        }
        store.snapshot.lastUpdated = Date.now();
        store.schedulePersist();
    }
    async reset() {
        const store = this.currentStore();
        store.clearFlushTimer();
        store.snapshot = {
            version: 2,
            generation: (0, node_crypto_1.randomUUID)(),
            resetAt: Date.now(),
            sessions: [],
            lastUpdated: Date.now(),
        };
        store.revision += 1;
        store.pendingSessionVersions.clear();
        store.sessionIds.clear();
        await store.enqueuePersist(true);
    }
    async flush() {
        const store = this.currentStore();
        store.clearFlushTimer();
        await store.enqueuePersist();
    }
    async refreshFromDisk() {
        const store = this.currentStore();
        const revisionAtStart = store.revision;
        const generationAtStart = store.snapshot.generation;
        const diskSnapshot = await store.readDiskSnapshot();
        if (store.revision !== revisionAtStart && store.snapshot.generation !== generationAtStart) {
            return;
        }
        const localPending = store.snapshot.sessions.filter((session) => store.pendingSessionVersions.has(session.id));
        const retained = diskSnapshot.generation === generationAtStart
            ? localPending
            : clipSessionsAfter(localPending, diskSnapshot.resetAt);
        store.snapshot = { ...diskSnapshot, sessions: mergeOverlappingSessions([...diskSnapshot.sessions, ...retained]) };
        store.sessionIds = new Set(store.snapshot.sessions.map((session) => session.id));
        store.loadedMtimeMs = store.currentMtimeMs();
    }
    async exportData(targetPath, format = 'json', timeframe, now = Date.now()) {
        const store = this.currentStore();
        store.reloadIfChanged();
        const sessions = timeframe ? store.getSessionsForTimeframe(timeframe, now) : store.snapshot.sessions;
        const output = format === 'csv'
            ? sessionsToCsv(sessions)
            : JSON.stringify({ ...store.snapshot, sessions }, null, 2);
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
        const store = this.currentStore();
        store.reloadIfChanged();
        const range = (0, timeUtils_1.getTimeframeRange)(timeframe, now);
        const sessions = store.snapshot.sessions
            .filter((session) => session.localDate >= range.startDate && session.localDate <= range.endDate)
            .sort((left, right) => left.start - right.start);
        const totalSeconds = sessions.reduce((sum, session) => sum + session.durationSeconds, 0);
        const todayKey = (0, timeUtils_1.getLocalDateKey)(new Date(now));
        const weekStart = (0, timeUtils_1.getTimeframeRange)('week', now).startDate;
        const totalSecondsToday = store.getTodaySeconds(now);
        const totalSecondsThisWeek = store.snapshot.sessions
            .filter((session) => session.localDate >= weekStart && session.localDate <= todayKey)
            .reduce((sum, session) => sum + session.durationSeconds, 0) + store.liveSegments(now)
            .filter((segment) => segment.dateKey >= weekStart && segment.dateKey <= todayKey)
            .reduce((sum, segment) => sum + segment.end - segment.start, 0) / 1000;
        const projectBreakdown = aggregate(sessions, (session) => session.project, 8);
        const languageBreakdown = aggregate(sessions, (session) => session.language, 8)
            .map((entry) => ({ language: entry.project, seconds: entry.seconds }));
        const dates = Array.from(new Set(store.snapshot.sessions.map((session) => session.localDate))).sort();
        const rangeDates = new Set(sessions.map((session) => session.localDate));
        const hourlyActivity = Array.from({ length: 24 }, () => 0);
        for (const session of sessions) {
            hourlyActivity[session.localHour] += session.durationSeconds;
        }
        const peakSeconds = Math.max(...hourlyActivity);
        const earliest = sessions.length > 0 ? Math.max(range.start, sessions[0].start) : now;
        const lastEnd = sessions.reduce((latest, session) => Math.max(latest, session.end), -Infinity);
        const latest = sessions.length > 0 ? Math.min(now, lastEnd) : now;
        const observedSeconds = Math.max(0, Math.round((latest - earliest) / 1000));
        const activeSeconds = Math.min(totalSeconds, observedSeconds);
        const activeRatioPercent = observedSeconds === 0 ? 0 : Math.round((activeSeconds / observedSeconds) * 100);
        const dailyGoalSeconds = Math.max(0, Math.round(dailyGoalMinutes * 60));
        return {
            timeframe,
            rangeStart: range.startDate,
            rangeEnd: range.endDate,
            totalSecondsToday,
            totalSecondsThisWeek: Math.round(totalSecondsThisWeek),
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
            currentStreak: getCurrentStreak(dates, todayKey),
            longestStreak: getLongestStreak(dates),
            peakCodingHour: peakSeconds === 0 ? null : hourlyActivity.indexOf(peakSeconds),
            hourlyActivity,
            activeRatioPercent,
            idleRatioPercent: 100 - activeRatioPercent,
        };
    }
    getSnapshot() {
        const store = this.currentStore();
        store.reloadIfChanged();
        return store.snapshot;
    }
    writeCheckpoint(checkpoint) {
        const store = this.currentStore();
        try {
            fs.mkdirSync(store.storageDir, { recursive: true });
            fs.writeFileSync(store.checkpointPath(checkpoint.instanceId), JSON.stringify(checkpoint), 'utf8');
        }
        catch (error) {
            store.reportError('Unable to write CodePulse tracking checkpoint.', error);
        }
    }
    clearCheckpoint(instanceId) {
        const store = this.currentStore();
        try {
            fs.rmSync(store.checkpointPath(instanceId), { force: true });
        }
        catch (error) {
            store.reportError('Unable to clear CodePulse tracking checkpoint.', error);
        }
    }
    recoverStaleCheckpoints(ownInstanceId, minSessionSeconds, now = Date.now(), staleMs = 20_000) {
        const store = this.currentStore();
        let names;
        try {
            names = fs.readdirSync(store.storageDir);
        }
        catch {
            return 0;
        }
        let recovered = 0;
        for (const name of names) {
            if (!CHECKPOINT_PATTERN.test(name) || name === path.basename(store.checkpointPath(ownInstanceId))) {
                continue;
            }
            const checkpointPath = path.join(store.storageDir, name);
            try {
                const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
                if (!isValidCheckpoint(checkpoint)) {
                    fs.rmSync(checkpointPath, { force: true });
                    continue;
                }
                if (now - checkpoint.lastSeen <= staleMs) {
                    continue;
                }
                for (const segment of (0, timeUtils_1.splitIntervalAtMidnight)(checkpoint.start, checkpoint.lastSeen)) {
                    const durationSeconds = Math.round((segment.end - segment.start) / 1000);
                    if (durationSeconds < minSessionSeconds) {
                        continue;
                    }
                    const before = store.snapshot.sessions.length;
                    store.appendSession({
                        id: sessionIdFor(checkpoint.instanceId, segment.start),
                        start: segment.start,
                        end: segment.end,
                        durationSeconds,
                        project: checkpoint.project,
                        language: checkpoint.language,
                        localDate: segment.dateKey,
                        localHour: segment.hour,
                        mode: checkpoint.mode,
                    });
                    if (store.snapshot.sessions.length > before) {
                        recovered += 1;
                    }
                }
                fs.rmSync(checkpointPath, { force: true });
            }
            catch (error) {
                store.reportError(`Unable to recover CodePulse checkpoint ${name}.`, error);
            }
        }
        return recovered;
    }
    setLiveInterval(startMs) {
        const store = this.currentStore();
        store.liveStartMs = startMs;
    }
    getSessionsForTimeframe(timeframe, now) {
        const store = this.currentStore();
        const range = (0, timeUtils_1.getTimeframeRange)(timeframe, now);
        return store.snapshot.sessions.filter((session) => session.localDate >= range.startDate && session.localDate <= range.endDate);
    }
    liveSegments(now) {
        const store = this.currentStore();
        return store.liveStartMs === null ? [] : (0, timeUtils_1.splitIntervalAtMidnight)(store.liveStartMs, now);
    }
    checkpointPath(instanceId) {
        return path.join(this.storageDir, `codepulse-active-${instanceId}.json`);
    }
    schedulePersist() {
        const store = this.currentStore();
        if (store.flushTimer)
            return;
        store.flushTimer = setTimeout(() => {
            store.flushTimer = undefined;
            void store.enqueuePersist().catch((error) => {
                store.reportError('Unable to persist CodePulse data.', error);
            });
        }, WRITE_DEBOUNCE_MS);
    }
    enqueuePersist(reset = false) {
        const store = this.currentStore();
        store.writeQueue = store.writeQueue.then(() => store.persist(reset), () => store.persist(reset));
        return store.writeQueue;
    }
    async persist(reset) {
        const store = this.currentStore();
        const revisionAtStart = store.revision;
        const pendingAtStart = new Map(store.pendingSessionVersions);
        const localSessionsAtStart = store.snapshot.sessions.map((session) => ({ ...session }));
        const generationAtStart = store.snapshot.generation;
        const resetAtStart = store.snapshot.resetAt;
        const releaseLock = await store.acquireFileLock();
        try {
            const diskSnapshot = await store.readDiskSnapshot();
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
                    if (pendingAtStart.has(session.id))
                        byId.set(session.id, session);
                }
                sessions = Array.from(byId.values());
            }
            const saved = {
                version: 2,
                generation: reset ? generationAtStart : diskSnapshot.generation,
                resetAt: reset ? resetAtStart : diskSnapshot.resetAt,
                sessions: mergeOverlappingSessions(sessions),
                lastUpdated: Date.now(),
            };
            await store.writeSnapshotAtomically(saved);
            if (store.revision !== revisionAtStart && store.snapshot.generation !== generationAtStart)
                return;
            const newlyPending = store.snapshot.sessions.filter((session) => store.pendingSessionVersions.has(session.id) &&
                store.pendingSessionVersions.get(session.id) !== pendingAtStart.get(session.id));
            store.snapshot = { ...saved, sessions: mergeOverlappingSessions([...saved.sessions, ...newlyPending]) };
            store.sessionIds = new Set(store.snapshot.sessions.map((session) => session.id));
            for (const [id, version] of pendingAtStart) {
                if (store.pendingSessionVersions.get(id) === version)
                    store.pendingSessionVersions.delete(id);
            }
            if (store.revision !== revisionAtStart)
                store.snapshot.lastUpdated = Date.now();
            store.loadedMtimeMs = store.currentMtimeMs();
        }
        finally {
            await releaseLock();
        }
    }
    async readDiskSnapshot() {
        try {
            const parsed = JSON.parse(await fs.promises.readFile(this.filePath, 'utf8'));
            const validated = validateSnapshot(parsed);
            if (!validated)
                throw new TypeError('The latest CodePulse data file does not match the supported schema.');
            return validated;
        }
        catch (error) {
            if (isNodeError(error, 'ENOENT')) {
                try {
                    const backup = JSON.parse(await fs.promises.readFile(`${this.filePath}.bak`, 'utf8'));
                    return validateSnapshot(backup) ?? createEmptySnapshot();
                }
                catch {
                    return createEmptySnapshot();
                }
            }
            this.reportError('Unable to read the latest CodePulse data before saving; trying backup.', error);
            try {
                const backup = JSON.parse(await fs.promises.readFile(`${this.filePath}.bak`, 'utf8'));
                const validated = validateSnapshot(backup);
                if (validated)
                    return validated;
            }
            catch {
                // Ignore backup failure and keep the empty snapshot.
            }
            return createEmptySnapshot();
        }
    }
    readSnapshot() {
        fs.mkdirSync(this.storageDir, { recursive: true });
        for (const candidate of [this.filePath, `${this.filePath}.bak`]) {
            try {
                const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
                const validated = validateSnapshot(parsed);
                if (validated)
                    return validated;
                throw new TypeError(`Unsupported schema in ${candidate}.`);
            }
            catch (error) {
                if (isNodeError(error, 'ENOENT'))
                    continue;
                if (candidate === this.filePath) {
                    const corruptPath = `${candidate}.corrupt-${Date.now()}`;
                    try {
                        fs.renameSync(candidate, corruptPath);
                    }
                    catch {
                        // If the file cannot be renamed, proceed with the fallback path.
                    }
                    this.reportError(`Unable to load CodePulse data from ${candidate}; trying backup.`, error);
                    continue;
                }
                this.reportError(`Unable to load CodePulse data from ${candidate}.`, error);
            }
        }
        return createEmptySnapshot();
    }
    reloadIfChanged() {
        const store = this.currentStore();
        const mtime = store.currentMtimeMs();
        if (mtime === store.loadedMtimeMs)
            return;
        const disk = store.readSnapshot();
        const pending = store.snapshot.sessions.filter((session) => store.pendingSessionVersions.has(session.id));
        store.snapshot = { ...disk, sessions: mergeOverlappingSessions([...disk.sessions, ...pending]) };
        store.sessionIds = new Set(store.snapshot.sessions.map((session) => session.id));
        store.loadedMtimeMs = store.currentMtimeMs();
    }
    currentMtimeMs() {
        try {
            return fs.statSync(this.filePath).mtimeMs;
        }
        catch {
            return 0;
        }
    }
    async writeSnapshotAtomically(snapshot) {
        const temporaryPath = `${this.filePath}.${(0, node_crypto_1.randomUUID)()}.tmp`;
        try {
            const handle = await fs.promises.open(temporaryPath, 'wx');
            try {
                await handle.writeFile(JSON.stringify(snapshot, null, 2), 'utf8');
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            try {
                const existing = JSON.parse(await fs.promises.readFile(this.filePath, 'utf8'));
                if (validateSnapshot(existing))
                    await fs.promises.copyFile(this.filePath, `${this.filePath}.bak`);
            }
            catch (error) {
                if (!isNodeError(error, 'ENOENT') && !(error instanceof SyntaxError))
                    throw error;
            }
            await fs.promises.rename(temporaryPath, this.filePath);
        }
        catch (error) {
            await fs.promises.unlink(temporaryPath).catch(() => undefined);
            throw error;
        }
    }
    async acquireFileLock() {
        await fs.promises.mkdir(this.storageDir, { recursive: true });
        const startedAt = Date.now();
        while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
            try {
                const handle = await fs.promises.open(this.lockPath, 'wx');
                await handle.writeFile(`${process.pid}:${Date.now()}`);
                return async () => {
                    await handle.close();
                    await fs.promises.unlink(this.lockPath).catch((error) => {
                        if (!isNodeError(error, 'ENOENT'))
                            throw error;
                    });
                };
            }
            catch (error) {
                if (!isNodeError(error, 'EEXIST'))
                    throw error;
            }
            const stat = await fs.promises.stat(this.lockPath).catch((error) => {
                if (isNodeError(error, 'ENOENT'))
                    return undefined;
                throw error;
            });
            if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
                await delay(100);
                const current = await fs.promises.stat(this.lockPath).catch((error) => {
                    if (isNodeError(error, 'ENOENT'))
                        return undefined;
                    throw error;
                });
                if (current && current.ino === stat.ino && current.mtimeMs === stat.mtimeMs &&
                    Date.now() - current.mtimeMs > LOCK_STALE_MS) {
                    await fs.promises.unlink(this.lockPath).catch((error) => {
                        if (!isNodeError(error, 'ENOENT'))
                            throw error;
                    });
                }
            }
            await delay(50);
        }
        throw new Error('Timed out waiting for the CodePulse data file lock.');
    }
    clearFlushTimer() {
        const store = this.currentStore();
        if (store.flushTimer) {
            clearTimeout(store.flushTimer);
            store.flushTimer = undefined;
        }
    }
    markPending(id) {
        const store = this.currentStore();
        store.revision += 1;
        store.pendingSessionVersions.set(id, store.revision);
    }
}
exports.DataStore = DataStore;
function createEmptySnapshot() {
    return { version: 2, generation: 'initial', resetAt: 0, sessions: [], lastUpdated: Date.now() };
}
function validateSnapshot(value) {
    if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.sessions)) {
        return undefined;
    }
    const sessions = value.sessions.filter(isValidSession);
    if (sessions.length !== value.sessions.length || new Set(sessions.map((session) => session.id)).size !== sessions.length) {
        return undefined;
    }
    return {
        version: 2,
        generation: typeof value.generation === 'string' ? value.generation : 'initial',
        resetAt: isFiniteNumber(value.resetAt) ? value.resetAt : 0,
        sessions: mergeOverlappingSessions(sessions),
        lastUpdated: isFiniteNumber(value.lastUpdated) ? value.lastUpdated : Date.now(),
    };
}
function isValidSession(value) {
    return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 256 &&
        isFiniteNumber(value.start) && isFiniteNumber(value.end) && value.end > value.start &&
        isFiniteNumber(value.durationSeconds) && value.durationSeconds > 0 &&
        typeof value.project === 'string' && typeof value.language === 'string' &&
        typeof value.localDate === 'string' && isFiniteNumber(value.localHour) &&
        Number.isInteger(value.localHour) && value.localHour >= 0 && value.localHour <= 23 &&
        (value.mode === 'alwaysOpen' || value.mode === 'windowFocused');
}
function isValidCheckpoint(value) {
    return isRecord(value) && typeof value.instanceId === 'string' && isFiniteNumber(value.start) &&
        isFiniteNumber(value.lastSeen) && typeof value.project === 'string' && typeof value.language === 'string' &&
        (value.mode === 'alwaysOpen' || value.mode === 'windowFocused');
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
    return left.project === right.project && left.language === right.language && left.localDate === right.localDate &&
        left.localHour === right.localHour && left.mode === right.mode && right.start <= left.end + 1_500 && right.end >= left.end;
}
function mergeOverlappingSessions(sessions) {
    const ordered = [...sessions].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    const merged = [];
    let coveredUntil = -Infinity;
    for (const source of ordered) {
        const current = { ...source };
        if (current.start < coveredUntil) {
            current.start = coveredUntil;
            if (current.end <= current.start)
                continue;
            current.durationSeconds = (current.end - current.start) / 1000;
            const date = new Date(current.start);
            current.localDate = (0, timeUtils_1.getLocalDateKey)(date);
            current.localHour = date.getHours();
        }
        const previous = merged[merged.length - 1];
        if (previous && canMergeSessions(previous, current)) {
            previous.end = Math.max(previous.end, current.end);
            previous.durationSeconds = (previous.end - previous.start) / 1000;
            coveredUntil = Math.max(coveredUntil, previous.end);
        }
        else {
            merged.push(current);
            coveredUntil = Math.max(coveredUntil, current.end);
        }
    }
    return merged;
}
function clipSessionsAfter(sessions, cutoff) {
    return sessions.flatMap((source) => {
        if (source.end <= cutoff)
            return [];
        const session = { ...source };
        if (session.start < cutoff) {
            session.start = cutoff;
            const date = new Date(cutoff);
            session.localDate = (0, timeUtils_1.getLocalDateKey)(date);
            session.localHour = date.getHours();
            session.durationSeconds = (session.end - session.start) / 1000;
        }
        return session.durationSeconds > 0 ? [session] : [];
    });
}
function aggregate(sessions, keySelector, limit) {
    const totals = new Map();
    for (const session of sessions)
        totals.set(keySelector(session), (totals.get(keySelector(session)) ?? 0) + session.durationSeconds);
    return Array.from(totals, ([project, seconds]) => ({ project, seconds }))
        .sort((a, b) => b.seconds - a.seconds).slice(0, limit);
}
function getCurrentStreak(dates, todayKey) {
    const dateSet = new Set(dates);
    const cursor = new Date(`${todayKey}T12:00:00`);
    if (!dateSet.has(todayKey))
        cursor.setDate(cursor.getDate() - 1);
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
        'id', 'start', 'end', 'durationSeconds', 'project', 'language', 'localDate', 'localHour', 'mode',
    ];
    return [columns.join(','), ...sessions.map((session) => columns.map((column) => csvCell(String(session[column]))).join(','))]
        .join('\r\n');
}
function csvCell(value) {
    const safe = /^[\t\r ]*[=+\-@]/.test(value) ? `'${value}` : value;
    return `"${safe.replace(/"/g, '""')}"`;
}
function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
//# sourceMappingURL=dataStore.js.map