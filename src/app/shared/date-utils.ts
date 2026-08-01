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

/**
 * Compact "time since" label for the Home last-synced line, e.g.
 * `just now`, `10 sec ago`, `5 min ago`, `4 hour ago`, `6 hour 30 min ago`,
 * `2 days ago`. Pass a live `now` (ms) so callers can tick it and have the
 * label re-compute.
 */
export function syncAgo(value: Date | number, now: number = Date.now()): string {
  const then = value instanceof Date ? value.getTime() : value;
  let s = Math.floor((now - then) / 1000);
  if (s < 0) {
    s = 0;
  }
  if (s < 10) {
    return 'just now';
  }
  if (s < 60) {
    return `${s} sec ago`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m} min ago`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rem = m % 60;
    return rem ? `${h} hour ${rem} min ago` : `${h} hour ago`;
  }
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
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
