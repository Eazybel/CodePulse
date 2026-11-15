export type TrackingMode = 'alwaysOpen' | 'windowFocused';

export interface IntervalSegment {
  start: number;
  end: number;
  dateKey: string;
  hour: number;
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
  if (endMs <= startMs) {
    return [];
  }

  const segments: IntervalSegment[] = [];
  let cursor = startMs;

  while (cursor < endMs) {
    const current = new Date(cursor);
    const nextMidnight = new Date(
      current.getFullYear(),
      current.getMonth(),
      current.getDate() + 1,
      0,
      0,
      0,
      0,
    ).getTime();

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

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));

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
