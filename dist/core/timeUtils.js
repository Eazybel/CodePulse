"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLocalDateKey = getLocalDateKey;
exports.clampDuration = clampDuration;
exports.splitIntervalAtMidnight = splitIntervalAtMidnight;
exports.formatDuration = formatDuration;
exports.formatDurationMinutes = formatDurationMinutes;
function getLocalDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
function clampDuration(startMs, endMs) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
        return 0;
    }
    return Math.max(0, endMs - startMs);
}
function splitIntervalAtMidnight(startMs, endMs) {
    if (endMs <= startMs) {
        return [];
    }
    const segments = [];
    let cursor = startMs;
    while (cursor < endMs) {
        const current = new Date(cursor);
        const nextMidnight = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1, 0, 0, 0, 0).getTime();
        const segmentEnd = Math.min(endMs, nextMidnight);
        segments.push({
            start: cursor,
            end: segmentEnd,
            dateKey: getLocalDateKey(new Date(cursor)),
            hour: new Date(cursor).getHours(),
        });
        cursor = segmentEnd;
    }
    return segments;
}
function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.round(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    const parts = [];
    if (hours > 0) {
        parts.push(`${hours}h`);
    }
    if (minutes > 0 || hours > 0) {
        parts.push(`${minutes}m`);
    }
    parts.push(`${remainingSeconds}s`);
    return parts.join(' ');
}
function formatDurationMinutes(totalMinutes) {
    const minutes = Number.isFinite(totalMinutes) ? Math.max(0, Math.floor(totalMinutes)) : 0;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    const parts = [];
    if (hours > 0) {
        parts.push(`${hours}h`);
    }
    if (remainingMinutes > 0 || hours === 0) {
        parts.push(`${remainingMinutes}m`);
    }
    return parts.join(' ');
}
//# sourceMappingURL=timeUtils.js.map