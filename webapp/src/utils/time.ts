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

/**
 * Format a timestamp as relative time (e.g., "2 hours ago", "Just now")
 * @param isoTimestamp - ISO 8601 timestamp string
 * @returns Human-readable relative time string
 */
export function formatRelativeTime(isoTimestamp: string): string {
  const now = new Date();
  const then = new Date(isoTimestamp);

  if (isNaN(then.getTime())) {
    return 'Unknown time';
  }

  const diffMs = now.getTime() - then.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) {
    return 'Just now';
  }

  if (diffMinutes < 60) {
    const unit = diffMinutes === 1 ? 'minute' : 'minutes';
    return `${diffMinutes} ${unit} ago`;
  }

  if (diffHours < 24) {
    const unit = diffHours === 1 ? 'hour' : 'hours';
    return `${diffHours} ${unit} ago`;
  }

  if (diffDays < 7) {
    const unit = diffDays === 1 ? 'day' : 'days';
    return `${diffDays} ${unit} ago`;
  }

  // For older dates, show a formatted date
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const month = months[then.getMonth()];
  const day = then.getDate();
  const year = then.getFullYear();
  const hours = then.getHours();
  const minutes = then.getMinutes();
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  const displayMinutes = minutes < 10 ? `0${minutes}` : minutes;

  // Show year only if different from current year
  const yearStr = year !== now.getFullYear() ? ` ${year}` : '';

  return `${month} ${day}${yearStr} at ${displayHours}:${displayMinutes} ${period}`;
}
