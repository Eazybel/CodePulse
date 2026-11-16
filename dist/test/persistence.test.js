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
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_test_1 = require("node:test");
const dataStore_1 = require("../core/dataStore");
const timeUtils_1 = require("../core/timeUtils");
function makeDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'codepulse-persist-'));
}
function makeSession(id, start, durationSeconds) {
    return {
        id,
        start: start.getTime(),
        end: start.getTime() + durationSeconds * 1000,
        durationSeconds,
        project: 'demo',
        language: 'typescript',
        localDate: (0, timeUtils_1.getLocalDateKey)(start),
        localHour: start.getHours(),
        mode: 'alwaysOpen',
    };
}
(0, node_test_1.describe)('daily totals across VS Code restarts', () => {
    (0, node_test_1.it)('keeps counting today from where the previous run stopped', () => {
        const dir = makeDir();
        try {
            const now = new Date(2024, 5, 5, 15, 0, 0).getTime();
            const firstRun = new dataStore_1.DataStore(dir);
            firstRun.appendSession(makeSession('a', new Date(2024, 5, 5, 9, 0, 0), 1200));
            const secondRun = new dataStore_1.DataStore(dir);
            assert.equal(secondRun.getTodaySeconds(now), 1200);
            secondRun.appendSession(makeSession('b', new Date(2024, 5, 5, 14, 0, 0), 600));
            assert.equal(secondRun.getTodaySeconds(now), 1800);
        }
        finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
    (0, node_test_1.it)('adds project sessions together in the same daily total', () => {
        const dir = makeDir();
        try {
            const now = new Date(2024, 5, 5, 15, 0, 0).getTime();
            const store = new dataStore_1.DataStore(dir);
            store.appendSession({ ...makeSession('a', new Date(2024, 5, 5, 9, 0, 0), 1200), project: 'project-a' });
            store.appendSession({ ...makeSession('b', new Date(2024, 5, 5, 14, 0, 0), 600), project: 'project-b' });
            assert.equal(store.getTodaySeconds(now), 1800);
        }
        finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
    (0, node_test_1.it)('includes the interval that is running right now', () => {
        const dir = makeDir();
        try {
            const store = new dataStore_1.DataStore(dir);
            const now = new Date(2024, 5, 5, 15, 0, 0).getTime();
            store.appendSession(makeSession('a', new Date(2024, 5, 5, 9, 0, 0), 1200));
            store.setLiveInterval(now - 300_000);
            assert.equal(store.getTodaySeconds(now), 1500);
            assert.equal(store.getDashboardSummary(now).totalSecondsToday, 1500);
            store.setLiveInterval(null);
            assert.equal(store.getTodaySeconds(now), 1200);
        }
        finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
    (0, node_test_1.it)('does not lose sessions written by another window', () => {
        const dir = makeDir();
        try {
            const windowA = new dataStore_1.DataStore(dir);
            const windowB = new dataStore_1.DataStore(dir);
            windowA.appendSession(makeSession('a', new Date(2024, 5, 5, 9, 0, 0), 600));
            windowB.appendSession(makeSession('b', new Date(2024, 5, 5, 10, 0, 0), 900));
            const ids = new dataStore_1.DataStore(dir).getSnapshot().sessions.map((session) => session.id).sort();
            assert.deepEqual(ids, ['a', 'b']);
        }
        finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
    (0, node_test_1.it)('recovers time from a window that was closed without saving', () => {
        const dir = makeDir();
        try {
            const start = new Date(2024, 5, 5, 9, 0, 0).getTime();
            const lastSeen = start + 45 * 60_000;
            const crashed = new dataStore_1.DataStore(dir);
            crashed.writeCheckpoint({
                instanceId: 'deadbeef-0000', start, lastSeen, project: 'demo', language: 'typescript', mode: 'alwaysOpen',
            });
            const nextRun = new dataStore_1.DataStore(dir);
            const afterCrash = lastSeen + 60_000;
            assert.equal(nextRun.recoverStaleCheckpoints('new-instance', 10, afterCrash), 1);
            assert.equal(nextRun.getTodaySeconds(afterCrash), 45 * 60);
            assert.equal(nextRun.recoverStaleCheckpoints('new-instance', 10, afterCrash), 0);
            assert.equal(nextRun.getTodaySeconds(afterCrash), 45 * 60);
        }
        finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
    (0, node_test_1.it)('recovers a recent checkpoint after the previous tracking owner releases its lease', () => {
        const dir = makeDir();
        try {
            const now = new Date(2024, 5, 5, 10, 0, 0).getTime();
            const start = now - 60_000;
            const store = new dataStore_1.DataStore(dir);
            store.writeCheckpoint({
                instanceId: 'deadbeef-0000', start, lastSeen: now - 5_000,
                project: 'demo', language: 'typescript', mode: 'alwaysOpen',
            });
            assert.equal(store.recoverStaleCheckpoints('new-owner', 10, now, 0), 1);
            assert.equal(store.getTodaySeconds(now), 55);
        }
        finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
    (0, node_test_1.it)('leaves the checkpoint of a window that is still running alone', () => {
        const dir = makeDir();
        try {
            const now = new Date(2024, 5, 5, 9, 30, 0).getTime();
            const store = new dataStore_1.DataStore(dir);
            store.writeCheckpoint({
                instanceId: 'live-window', start: now - 600_000, lastSeen: now - 2_000,
                project: 'demo', language: 'typescript', mode: 'alwaysOpen',
            });
            assert.equal(store.recoverStaleCheckpoints('other-window', 10, now), 0);
            assert.equal(store.getSnapshot().sessions.length, 0);
        }
        finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
//# sourceMappingURL=persistence.test.js.map