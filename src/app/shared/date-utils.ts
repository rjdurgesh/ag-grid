/** Small, dependency-free date/formatting helpers reused across views. */

/** Format an ISO string (or Date) as `YYYY-MM-DD HH:mm:ss`. Returns '' for empty input. */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    return String(value);
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format as `YYYY-MM-DD`. */
export function formatDate(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return '';
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    return String(value);
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Previous business day (T-1), skipping weekends.
 * Fri → Thu, Mon → Fri, Sat → Fri, Sun → Fri.
 */
export function previousWeekday(from: Date = new Date()): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d;
}

/** Previous business day as `YYYY-MM-DD` (for `<input type="date">`). */
export function previousWeekdayIso(from: Date = new Date()): string {
  return formatDate(previousWeekday(from));
}

/** Human-friendly "x minutes ago" style relative time. */
export function timeAgo(value: string | number | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  const units: [number, string][] = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.35, 'week'],
    [12, 'month'],
    [Number.POSITIVE_INFINITY, 'year']
  ];
  let amount = seconds;
  let unit = 'second';
  for (const [divisor, name] of units) {
    if (Math.abs(amount) < divisor) {
      unit = name;
      break;
    }
    amount = Math.floor(amount / divisor);
    unit = name;
  }
  const rounded = Math.round(amount);
  return rounded <= 1 && unit === 'second' ? 'just now' : `${rounded} ${unit}${rounded === 1 ? '' : 's'} ago`;
}
