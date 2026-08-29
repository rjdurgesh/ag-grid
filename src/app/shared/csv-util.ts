/**
 * Small dependency-free CSV toolkit for the Config Ops upload feature.
 * RFC-4180 aware (quoted fields, embedded delimiters/newlines, "" escaping, BOM strip).
 */

/** Resolve a delimiter token (`tab` / `\t` → an actual tab). */
export function resolveDelimiter(delimiter: string): string {
  return delimiter === 'tab' || delimiter === '\\t' ? '\t' : (delimiter || ',');
}

/** Guess the delimiter from the header line: the candidate with the most occurrences wins. */
export function detectDelimiter(text: string): string {
  const firstLine = (text.split(/\r?\n/)[0] || '');
  const candidates = [',', ';', '\t', '|', ':'];
  let best = ',';
  let bestCount = 0;
  for (const c of candidates) {
    const count = firstLine.split(c).length - 1;
    if (count > bestCount) { bestCount = count; best = c; }
  }
  return best;
}

/** Parse CSV text into { header, rows }. `delimiter` may be `tab`/`\t`. */
export function parseCsv(text: string, delimiter: string): { header: string[]; rows: string[][] } {
  if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); }   // strip BOM
  const delim = resolveDelimiter(delimiter);
  const all: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let sawAny = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += ch; }
    } else if (ch === '"') {
      inQuotes = true; sawAny = true;
    } else if (ch === delim) {
      row.push(field); field = ''; sawAny = true;
    } else if (ch === '\n') {
      row.push(field); all.push(row); field = ''; row = []; sawAny = false;
    } else if (ch === '\r') {
      /* swallow — \r\n handled by the \n branch */
    } else {
      field += ch; sawAny = true;
    }
  }
  if (sawAny || field !== '' || row.length) { row.push(field); all.push(row); }
  // drop fully-empty lines
  const rows = all.filter((r) => !(r.length === 1 && r[0].trim() === ''));
  const header = rows.length ? rows[0] : [];
  return { header, rows: rows.slice(1) };
}

/** Serialize header + rows back to RFC-4180 CSV (CRLF). */
export function serializeCsv(header: string[], rows: string[][], delimiter = ','): string {
  const d = resolveDelimiter(delimiter);
  const esc = (v: string): string => {
    const s = v ?? '';
    return (s.includes(d) || /["\r\n]/.test(s)) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(esc).join(d)).join('\r\n');
}

// ---- cell validation (matches the server's canonical rules) -----------------

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) { return false; }
  const dim = [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= dim[m - 1];
}

/** ISO date `YYYY-MM-DD` (optionally with ` HH:MM:SS`), real-calendar checked. */
export function isIsoDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(v.trim());
  if (!m) { return false; }
  if (!validYmd(+m[1], +m[2], +m[3])) { return false; }
  if (m[4] !== undefined && (+m[4] > 23 || +m[5] > 59 || +m[6] > 59)) { return false; }
  return true;
}

/** ISO timestamp `YYYY-MM-DD HH:MM:SS[.ffffff]` (time optional), real-calendar checked. */
export function isIsoTimestamp(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?)?$/.exec(v.trim());
  if (!m) { return false; }
  if (!validYmd(+m[1], +m[2], +m[3])) { return false; }
  if (m[4] !== undefined && (+m[4] > 23 || +m[5] > 59 || +m[6] > 59)) { return false; }
  return true;
}

/**
 * Validate one cell against a logical column type (the modal's `CellDataType`).
 * Returns an error string, or null if valid. Empty = valid here (NULL); NOT NULL is enforced server-side.
 */
export function validateCell(type: string, value: string): string | null {
  const v = (value ?? '').trim();
  if (v === '') { return null; }
  switch (type) {
    case 'date': return isIsoDate(v) ? null : 'Expected date YYYY-MM-DD';
    case 'timestamp': return isIsoTimestamp(v) ? null : 'Expected YYYY-MM-DD HH:MM:SS';
    case 'number': return /^-?(\d+)(\.\d+)?$/.test(v) ? null : 'Not a number';
    default: return null;   // string/clob/etc. — no client-side rule
  }
}
