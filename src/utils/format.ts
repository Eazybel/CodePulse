export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms/60000));
  const h = Math.floor(minutes/60), m = minutes%60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
export function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
}
