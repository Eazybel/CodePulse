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
const assert = __importStar(require("node:assert/strict"));
const fs = __importStar(require("node:fs/promises"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_test_1 = require("node:test");
const dataStore_1 = require("../core/dataStore");
const temporaryDirectories = [];
(0, node_test_1.afterEach)(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
(0, node_test_1.describe)('CodePulse data store', () => {
    (0, node_test_1.it)('serializes writes from multiple extension hosts without losing sessions', async () => {
        const directory = await makeTemporaryDirectory();
        const first = new dataStore_1.DataStore(directory);
        const second = new dataStore_1.DataStore(directory);
        const day = new Date(2026, 10, 16);
        first.appendSession(makeSession('first', new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9), 120));
        second.appendSession(makeSession('second', new Date(day.getFullYear(), day.getMonth(), day.getDate(), 14), 180));
        await Promise.all([first.flush(), second.flush()]);
        const reloaded = new dataStore_1.DataStore(directory);
        const summary = reloaded.getDashboardSummary(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 16).getTime(), 4, 'day');
        assert.equal(summary.totalSeconds, 300);
        assert.equal(summary.activeDays, 1);
        assert.equal(summary.goalProgressPercent, 100);
        assert.equal(summary.projectBreakdown.length, 2);
        assert.equal(summary.languageBreakdown.length, 2);
        assert.equal(summary.peakCodingHour, 14);
        assert.equal(summary.hourlyActivity[9], 120);
        assert.equal(summary.hourlyActivity[14], 180);
    });
    (0, node_test_1.it)('prevents overlapping sessions from counting the same elapsed time twice', async () => {
        const directory = await makeTemporaryDirectory();
        const first = new dataStore_1.DataStore(directory);
        const second = new dataStore_1.DataStore(directory);
        const start = new Date(2026, 10, 16, 9);
        first.appendSession(makeSession('earlier', start, 120));
        second.appendSession(makeSession('overlap', new Date(start.getTime() + 60_000), 120));
        await Promise.all([first.flush(), second.flush()]);
        const reloaded = new dataStore_1.DataStore(directory);
        assert.equal(reloaded.getSnapshot().sessions.reduce((sum, session) => sum + session.durationSeconds, 0), 180);
    });
    (0, node_test_1.it)('aggregates daily, weekly, and monthly analytics over their local date ranges', async () => {
        const directory = await makeTemporaryDirectory();
        const store = new dataStore_1.DataStore(directory);
        store.appendSession(makeSession('november-first', new Date(2026, 10, 1, 10), 120));
        store.appendSession(makeSession('november-fifteenth', new Date(2026, 10, 15, 10), 60));
        store.appendSession(makeSession('november-sixteenth', new Date(2026, 10, 16, 10), 180));
        await store.flush();
        const now = new Date(2026, 10, 16, 16).getTime();
        assert.equal(store.getDashboardSummary(now, 10, 'day').totalSeconds, 180);
        assert.equal(store.getDashboardSummary(now, 10, 'week').totalSeconds, 180);
        assert.equal(store.getDashboardSummary(now, 10, 'month').totalSeconds, 360);
    });
    (0, node_test_1.it)('recovers valid data from the backup when the primary file is damaged', async () => {
        const directory = await makeTemporaryDirectory();
        const statePath = path.join(directory, 'codepulse-state.json');
        const expected = makeSession('recoverable', new Date(2026, 10, 16, 10), 60);
        const snapshot = {
            version: 2,
            generation: 'recovery',
            resetAt: 0,
            sessions: [expected],
            lastUpdated: Date.now(),
        };
        await fs.writeFile(statePath, '{invalid JSON', 'utf8');
        await fs.writeFile(`${statePath}.bak`, JSON.stringify(snapshot), 'utf8');
        const errors = [];
        const recovered = new dataStore_1.DataStore(directory, (message) => errors.push(message));
        assert.equal(recovered.getSnapshot().sessions[0].id, expected.id);
        assert.ok(errors.some((message) => message.includes('backup')));
    });
    (0, node_test_1.it)('reclaims an abandoned persistence lock', async () => {
        const directory = await makeTemporaryDirectory();
        const lockPath = path.join(directory, 'codepulse-state.json.lock');
        await fs.writeFile(lockPath, 'abandoned');
        const abandonedAt = new Date(Date.now() - 60_000);
        await fs.utimes(lockPath, abandonedAt, abandonedAt);
        const store = new dataStore_1.DataStore(directory);
        store.appendSession(makeSession('after-lock-recovery', new Date(2026, 10, 16, 10), 60));
        await store.flush();
        assert.equal((await fs.stat(path.join(directory, 'codepulse-state.json'))).isFile(), true);
    });
    (0, node_test_1.it)('rejects invalid session records instead of loading partial data', async () => {
        const directory = await makeTemporaryDirectory();
        const statePath = path.join(directory, 'codepulse-state.json');
        const valid = makeSession('valid', new Date(2026, 10, 16, 10), 60);
        const invalid = { ...valid, localDate: '2026-02-30' };
        await fs.writeFile(statePath, JSON.stringify({
            version: 2,
            sessions: [valid, invalid],
            lastUpdated: Date.now(),
        }), 'utf8');
        const errors = [];
        const loaded = new dataStore_1.DataStore(directory, (message) => errors.push(message));
        assert.equal(loaded.getSnapshot().sessions.length, 0);
        assert.ok(errors.some((message) => message.includes('Unable to load CodePulse data')));
        assert.ok((await fs.readdir(directory)).some((name) => name.includes('.corrupt-')));
    });
    (0, node_test_1.it)('resets active persisted history and exports quoted CSV fields', async () => {
        const directory = await makeTemporaryDirectory();
        const store = new dataStore_1.DataStore(directory);
        const session = makeSession('export', new Date(2026, 10, 16, 11), 90);
        session.project = 'Workspace, "One"';
        store.appendSession(session);
        const formulaSession = makeSession('formula', new Date(2026, 10, 16, 12), 30);
        formulaSession.project = '=SUM(1,1)';
        store.appendSession(formulaSession);
        await store.flush();
        const csvPath = path.join(directory, 'export.csv');
        await fs.writeFile(csvPath, 'old export');
        await store.exportData(csvPath, 'csv');
        const csv = await fs.readFile(csvPath, 'utf8');
        assert.match(csv, /"Workspace, ""One"""/);
        assert.match(csv, /"'=SUM\(1,1\)"/);
        assert.match(csv, /id,start,end,durationSeconds,project,language,localDate,localHour,mode/);
        const jsonPath = path.join(directory, 'export.json');
        await store.exportData(jsonPath, 'json');
        const json = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
        assert.equal(json.sessions[0].project, 'Workspace, "One"');
        await store.reset();
        const restarted = new dataStore_1.DataStore(directory);
        assert.equal(restarted.getSnapshot().sessions.length, 0);
    });
    (0, node_test_1.it)('clips stale-window writes at the reset boundary', async () => {
        const directory = await makeTemporaryDirectory();
        const resetter = new dataStore_1.DataStore(directory);
        const staleWindow = new dataStore_1.DataStore(directory);
        resetter.appendSession(makeSession('before-reset', new Date(Date.now() - 120_000), 60));
        await resetter.flush();
        await resetter.reset();
        const resetAt = resetter.getSnapshot().resetAt;
        const staleSession = makeSession('straddling-reset', new Date(resetAt - 20_000), 80);
        staleWindow.appendSession(staleSession);
        await staleWindow.flush();
        const reloaded = new dataStore_1.DataStore(directory);
        assert.equal(reloaded.getSnapshot().sessions.length, 1);
        assert.equal(reloaded.getSnapshot().sessions[0].start, resetAt);
        assert.equal(reloaded.getSnapshot().sessions[0].durationSeconds, 60);
    });
});
async function makeTemporaryDirectory() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codepulse-test-'));
    temporaryDirectories.push(directory);
    return directory;
}
function makeSession(id, startDate, durationSeconds) {
    const start = startDate.getTime();
    return {
        id,
        start,
        end: start + durationSeconds * 1000,
        durationSeconds,
        project: `project-${id}`,
        language: `language-${id}`,
        localDate: [
            startDate.getFullYear(),
            String(startDate.getMonth() + 1).padStart(2, '0'),
            String(startDate.getDate()).padStart(2, '0'),
        ].join('-'),
        localHour: startDate.getHours(),
        mode: 'alwaysOpen',
    };
}
//# sourceMappingURL=dataStore.test.js.map