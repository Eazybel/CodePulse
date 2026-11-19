export type TrackingMode = 'alwaysOpen' | 'windowFocused';
export type Timeframe = 'day' | 'week' | 'month' | 'custom';

export interface CustomDateRange {
  /** Inclusive local start date, YYYY-MM-DD. */
  startDate: string;
  /** Inclusive local end date, YYYY-MM-DD. */
  endDate: string;
}

export interface IntervalSegment {
  start: number;
  end: number;
  dateKey: string;
  hour: number;
}

export interface TimeframeRange {
  start: number;
  end: number;
  startDate: string;
  endDate: string;
}

export function getLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function clampDuration(startMs: number, endMs: number): number {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return 0;
  }

  return Math.max(0, endMs - startMs);
}

export function splitIntervalAtMidnight(startMs: number, endMs: number): IntervalSegment[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return [];
  }

  const segments: IntervalSegment[] = [];
  let cursor = startMs;

  while (cursor < endMs) {
    const current = new Date(cursor);
    const nextHour = new Date(
      current.getFullYear(),
      current.getMonth(),
      current.getDate(),
      current.getHours() + 1,
      0,
      0,
      0,
    ).getTime();
    const segmentEnd = Math.min(endMs, nextHour);

    segments.push({
      start: cursor,
      end: segmentEnd,
      dateKey: getLocalDateKey(current),
      hour: current.getHours(),
    });

    cursor = segmentEnd;
  }

  return segments;
}

export function getTimeframeRange(timeframe: Timeframe, now: number = Date.now()): TimeframeRange {
  const endDate = new Date(now);
  const startDate = new Date(now);
  startDate.setHours(0, 0, 0, 0);

  if (timeframe === 'week') {
    startDate.setDate(startDate.getDate() - ((startDate.getDay() + 6) % 7));
  } else if (timeframe === 'month') {
    startDate.setDate(1);
  }

  const endOfRange = new Date(endDate);
  endOfRange.setHours(23, 59, 59, 999);

  return {
    start: startDate.getTime(),
    end: endDate.getTime(),
    startDate: getLocalDateKey(startDate),
    endDate: getLocalDateKey(endOfRange),
  };
}

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Parses a YYYY-MM-DD key to local midnight; returns undefined for malformed or impossible dates (e.g. 2026-02-30). */
export function parseDateKey(key: string): Date | undefined {
  if (!DATE_KEY_PATTERN.test(key)) {
    return undefined;
  }
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return getLocalDateKey(date) === key ? date : undefined;
}

export function isValidCustomRange(range: CustomDateRange): boolean {
  return parseDateKey(range.startDate) !== undefined
    && parseDateKey(range.endDate) !== undefined
    && range.startDate <= range.endDate;
}

/** Range for a user-picked start and end date, covering both days in full. */
export function getCustomTimeframeRange(range: CustomDateRange): TimeframeRange {
  const start = parseDateKey(range.startDate) ?? new Date();
  const end = parseDateKey(range.endDate) ?? new Date();
  end.setHours(23, 59, 59, 999);
  return {
    start: start.getTime(),
    end: end.getTime(),
    startDate: range.startDate,
    endDate: range.endDate,
  };
}

/** True when no user activity has been seen for longer than the timeout. A timeout of 0 disables idle detection. */
export function isIdleAt(lastActivityMs: number, now: number, idleTimeoutMinutes: number): boolean {
  if (idleTimeoutMinutes <= 0) {
    return false;
  }
  return now - lastActivityMs > idleTimeoutMinutes * 60_000;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.round(totalSeconds)) : 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }

  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }

  parts.push(`${remainingSeconds}s`);
  return parts.join(' ');
}

export function formatDurationMinutes(totalMinutes: number): string {
  const minutes = Number.isFinite(totalMinutes) ? Math.max(0, Math.floor(totalMinutes)) : 0;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }

  if (remainingMinutes > 0 || hours === 0) {
    parts.push(`${remainingMinutes}m`);
  }

  return parts.join(' ');
}
