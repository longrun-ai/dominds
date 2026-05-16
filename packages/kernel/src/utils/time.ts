export function formatUnifiedTimestamp(date: Date): string {
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export function parseUnifiedTimestampMs(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const unifiedMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (unifiedMatch) {
    const [, year, month, day, hour, minute, second] = unifiedMatch;
    const parsed = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ).getTime();
    return Number.isNaN(parsed) ? null : parsed;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

export function compareUnifiedTimestamps(a: string, b: string): number {
  if (a === b) return 0;
  const aMs = parseUnifiedTimestampMs(a);
  const bMs = parseUnifiedTimestampMs(b);
  if (aMs !== null && bMs !== null) return aMs - bMs;
  if (aMs !== null) return 1;
  if (bMs !== null) return -1;
  return a.localeCompare(b);
}

export function isUnifiedTimestampAfter(candidate: string, current: string): boolean {
  return compareUnifiedTimestamps(candidate, current) > 0;
}

export function pickNewerUnifiedTimestamp(current: string, candidate: string | undefined): string {
  if (candidate === undefined) return current;
  return isUnifiedTimestampAfter(candidate, current) ? candidate : current;
}
