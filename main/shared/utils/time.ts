export function formatUnifiedTimestamp(date: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  const Y = date.getFullYear();
  const M = pad(date.getMonth() + 1);
  const D = pad(date.getDate());
  const H = pad(date.getHours());
  const m = pad(date.getMinutes());
  const S = pad(date.getSeconds());
  return `${Y}-${M}-${D} ${H}:${m}:${S}`;
}
