export function localDate(ts: number): string {
  const d = new Date(ts);
  return [d.getFullYear(), String(d.getMonth()+1).padStart(2,'0'), String(d.getDate()).padStart(2,'0')].join('-');
}
export function localHour(ts: number): number { return new Date(ts).getHours(); }
export function splitAtLocalMidnight(start: number, end: number): Array<{start:number;end:number;date:string}> {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const out: Array<{start:number;end:number;date:string}> = [];
  let cursor = start;
  while (cursor < end) {
    const d = new Date(cursor);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate()+1).getTime();
    const stop = Math.min(end, next);
    out.push({start:cursor,end:stop,date:localDate(cursor)});
    cursor = stop;
  }
  return out;
}
export function safeElapsed(start: number, end: number): number {
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? end-start : 0;
}
