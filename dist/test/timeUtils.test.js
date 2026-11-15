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
const node_test_1 = require("node:test");
const timeUtils_1 = require("../core/timeUtils");
(0, node_test_1.describe)('time utilities', () => {
    (0, node_test_1.it)('formats short durations', () => {
        assert.equal((0, timeUtils_1.formatDuration)(61), '1m 1s');
        assert.equal((0, timeUtils_1.formatDuration)(3661), '1h 1m 1s');
    });
    (0, node_test_1.it)('formats elapsed minutes without seconds', () => {
        assert.equal((0, timeUtils_1.formatDurationMinutes)(0), '0m');
        assert.equal((0, timeUtils_1.formatDurationMinutes)(59), '59m');
        assert.equal((0, timeUtils_1.formatDurationMinutes)(60), '1h');
        assert.equal((0, timeUtils_1.formatDurationMinutes)(62), '1h 2m');
    });
    (0, node_test_1.it)('splits intervals at local midnight boundaries', () => {
        const start = new Date(2024, 5, 1, 23, 30, 0).getTime();
        const end = new Date(2024, 5, 2, 0, 45, 0).getTime();
        const segments = (0, timeUtils_1.splitIntervalAtMidnight)(start, end);
        assert.equal(segments.length, 2);
        assert.equal(segments[0].dateKey, '2024-06-01');
        assert.equal(segments[1].dateKey, '2024-06-02');
        assert.equal(segments[0].end - segments[0].start, 30 * 60 * 1000);
        assert.equal(segments[1].end - segments[1].start, 45 * 60 * 1000);
    });
});
//# sourceMappingURL=timeUtils.test.js.map