import {
  ActivityItem,
  DashboardStat,
  FileProperties,
  LogDirEntry,
  LogServersResponse,
  MemoryStats,
  TableContentResponse,
  TabularData
} from './models';
import { ConfigScope } from './api-endpoints';
import { environment } from '../../environments/environment';

/**
 * Hardcoded data served by {@link mockApiInterceptor} while `USE_MOCK` is true.
 * Everything here is deterministic (seeded) so the UI is stable between reloads,
 * except {@link mockMemory} which jitters to simulate a live feed.
 */

// ---------------------------------------------------------------------------
// Log Analytics
// ---------------------------------------------------------------------------

/**
 * Servers API response — a map keyed by `{db_source}_{server_type}_{server_name}`
 * whose value is the matching row(s) of the log-server config table. Mirrors the
 * real backend shape exactly. Swap this for the live endpoint (set USE_MOCK
 * false); the UI flattens it via `toLogServers()`.
 */
export const MOCK_LOG_SERVERS: LogServersResponse = {
  OLSGROUP_APP_1_eur12: [{ server_name: 'eur12', base_log_path: 'C:/apps/data', server_type: 'APP_1', db_source: 'OLSGROUP' }],
  // A server with SEVERAL configured base paths — each becomes its own tree root.
  OLSCIB_WEB_A_1_eur17: [
    { server_name: 'eur17', base_log_path: 'C:/my/cib', server_type: 'WEB_A_1', db_source: 'OLSCIB' },
    { server_name: 'eur17', base_log_path: 'D:/game', server_type: 'WEB_A_1', db_source: 'OLSCIB' },
    { server_name: 'eur17', base_log_path: 'E:/my', server_type: 'WEB_A_1', db_source: 'OLSCIB' },
    { server_name: 'eur17', base_log_path: 'F:/cib', server_type: 'WEB_A_1', db_source: 'OLSCIB' }
  ],
  OLSRETAIL_APP_2_eur21: [{ server_name: 'eur21', base_log_path: 'D:/ols/retail', server_type: 'APP_2', db_source: 'OLSRETAIL' }],
  OLSGROUP_WEB_B_1_eur34: [
    { server_name: 'eur34', base_log_path: 'D:/Apps/ols_monitoring_tool/logs', server_type: 'WEB_B_1', db_source: 'OLSGROUP' },
    { server_name: 'eur34', base_log_path: 'D:/Apps/OLS/Logs', server_type: 'WEB_B_1', db_source: 'OLSGROUP' }
  ],
  // Another server with its own base path (remove if you don't want it).
  OLSGROUP_APP_9_eur99: [{ server_name: 'eur99', base_log_path: 'C:/bigdata/logs', server_type: 'APP_9', db_source: 'OLSGROUP' }]
};

/**
 * Immediate children of one folder — a deterministic, depth-capped synthetic tree
 * so load-on-expand is demonstrable without a real filesystem. A real backend
 * lists the actual directory. `base` is the server's `base_log_path`; returns []
 * for a path outside it (belt-and-braces; the interceptor also jails it).
 */
export function mockDirEntries(base: string, folderPath: string): LogDirEntry[] {
  const p = (folderPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const b = (base ?? '').replace(/\\/g, '/').replace(/[\\/]+$/, '');
  if (!b || !(p.toLowerCase() === b.toLowerCase() || p.toLowerCase().startsWith(b.toLowerCase() + '/'))) {
    return [];
  }
  const rel = p.slice(b.length).replace(/^\/+/, '');
  const depth = rel ? rel.split('/').length : 0;
  const entries: LogDirEntry[] = [];
  // Sub-folders, capped so the demo tree is deep but finite.
  if (depth < 4) {
    ['batch', 'app', 'archive'].forEach((name) => entries.push({ name, type: 'folder', path: `${p}/${name}` }));
  }
  // A few files at every level (varied extensions to exercise the icons).
  ['run.log', 'error.log', 'summary.log', 'settings.json'].forEach((name) =>
    entries.push({ name, type: 'file', path: `${p}/${name}` })
  );
  return entries;
}

/**
 * True if `absPath` is inside the given `base` (and has no `..` traversal) — the
 * jail check a real backend must enforce before reading a file. Used by the
 * content / properties handlers.
 */
export function isLogPathAllowed(base: string | null, absPath: string | null): boolean {
  const p = (absPath ?? '').replace(/\\/g, '/');
  if (!p || p.split('/').some((s) => s === '..')) {
    return false;
  }
  const lower = p.toLowerCase();
  const b = (base ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return !!b && (lower === b || lower.startsWith(b + '/'));
}

/** Deterministic line count per file so pagination behaviour is demonstrable. */
function fileLineCount(name: string): number {
  if (/\.(yml|xml|json)$/i.test(name)) {
    return 40 + (name.length % 60);
  }
  if (name.includes('application')) {
    return 12000;
  }
  if (name.includes('access')) {
    return 8000;
  }
  if (name.includes('eod')) {
    return 6400;
  }
  if (name.includes('intraday')) {
    return 1500;
  }
  if (name.includes('security')) {
    return 900;
  }
  if (name.includes('error')) {
    return 320;
  }
  return 1200 + ((name.length * 37) % 3800);
}

const LEVELS = ['INFO ', 'INFO ', 'DEBUG', 'WARN ', 'INFO ', 'ERROR'];
const THREADS = ['main', 'pool-2', 'sched', 'http-8', 'batch-1'];

export function mockFileContent(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;

  if (/\.json$/i.test(name)) {
    return JSON.stringify(
      {
        ConnectionStrings: {
          Live: 'cl-3274-p-scan.uk.net.intra:1551/POSEIDON',
          Staging1: 'eurvlid11524.xmp.net.intra:1521/19zuk104',
          UAT1: 'eurvlid08402.xmp.net.intra:1521/12ruk104',
          Integration: 'eurvlid11358.xmp.net.intra:1521/17ruk104'
        },
        DBUserID: 'PSN_SERVICE',
        IS_PROD: 'DEV',
        DefaultDatabase: 'Regression 2',
        ShowDataTestButtons: 'false'
      },
      null,
      2
    );
  }
  if (/\.(yml|yaml)$/i.test(name)) {
    return ['server:', '  port: 8080', '  threads: 32', 'logging:', '  level: INFO', '  retentionDays: 2555'].join('\n');
  }
  if (/\.xml$/i.test(name)) {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<configuration>',
      '  <appender name="FILE" class="ch.qos.logback.core.FileAppender">',
      '    <file>D:\\OLS\\logs\\app\\application.log</file>',
      '  </appender>',
      '  <root level="INFO"><appender-ref ref="FILE"/></root>',
      '</configuration>'
    ].join('\n');
  }
  if (/\.html?$/i.test(name)) {
    return ['<!doctype html>', '<html>', '  <head><title>OLS Report</title></head>', '  <body><h1>Daily Summary</h1></body>', '</html>'].join('\n');
  }
  if (/\.csv$/i.test(name)) {
    const rows = ['activity_type,count,status'];
    for (let i = 1; i <= 250; i++) {
      rows.push(`ACTIVITY_${String(i).padStart(3, '0')},${i * 7},${i % 5 === 0 ? 'FAILED' : 'OK'}`);
    }
    return rows.join('\n');
  }
  if (/\.(bat|cmd|sh|ps1)$/i.test(name)) {
    return ['@echo off', 'REM OLS startup script', 'set OLS_HOME=D:\\OLS', 'java -jar %OLS_HOME%\\ols-app.jar', 'exit /b %ERRORLEVEL%'].join('\n');
  }
  if (/\.sql$/i.test(name)) {
    return ['SELECT table_name, active, is_cob', 'FROM   ols_config_catalog', "WHERE  scope = 'CIB'", 'ORDER  BY last_update DESC;'].join('\n');
  }
  if (/\.(zip|xlsx|xls)$/i.test(name)) {
    return `(binary ${name.split('.').pop()?.toUpperCase()} file — preview not available)`;
  }
  if (/\.txt$/i.test(name)) {
    return ['OLS Platform', '============', '', 'Operational log and configuration suite.', 'See docs for details.'].join('\n');
  }
  const count = fileLineCount(name);
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) {
    const level = LEVELS[i % LEVELS.length];
    const thread = THREADS[i % THREADS.length];
    const ss = String(i % 60).padStart(2, '0');
    lines.push(
      `2026-07-21 22:${String(14 + (i % 45)).padStart(2, '0')}:${ss} ${level} [${thread}] ` +
        `(${name}) event #${i} — processed batch ${1000 + i}, latency ${5 + (i % 40)}ms, status OK`
    );
  }
  return lines.join('\n');
}

const FILE_TYPE_LABELS: Record<string, string> = {
  log: 'Log File',
  txt: 'Text Document',
  json: 'JSON Source File',
  xml: 'XML Document',
  yml: 'YAML Config File',
  yaml: 'YAML Config File',
  html: 'HTML Document',
  csv: 'Comma Separated Values',
  xlsx: 'Excel Worksheet',
  xls: 'Excel Worksheet',
  zip: 'Compressed Archive',
  bat: 'Windows Batch File'
};

/** Deterministic file metadata for the Properties dialog. */
export function mockFileProperties(path: string): FileProperties {
  const parts = path.split(/[\\/]/);
  const name = parts.pop() ?? path;
  const location = parts.join(path.includes('\\') ? '\\' : '/');
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  const content = mockFileContent(path);
  const lines = content.split('\n').length;

  // Deterministic timestamps derived from the name so they are stable.
  const seed = [...name].reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const created = new Date(Date.UTC(2026, 3, 1 + (seed % 60), 8 + (seed % 10), seed % 60, 0));
  const modified = new Date(Date.UTC(2026, 6, 20 + (seed % 2), 14 + (seed % 8), (seed * 7) % 60, 0));
  const accessed = new Date(Date.UTC(2026, 6, 22, 9 + (seed % 12), (seed * 3) % 60, 0));

  return {
    name,
    type: FILE_TYPE_LABELS[ext] ?? (ext ? `${ext.toUpperCase()} File` : 'File'),
    location,
    size: new TextEncoder().encode(content).length,
    created: created.toISOString(),
    modified: modified.toISOString(),
    accessed: accessed.toISOString(),
    lines,
    attributes: ext === 'log' ? 'Read-only' : 'Read & Write'
  };
}

// ---------------------------------------------------------------------------
// Config Ops Console — table catalogue per scope
// ---------------------------------------------------------------------------

/** Catalogue definitions per scope — name + COB/active flags (rendered as Y/N). */
interface CatalogueDef {
  name: string;
  cob: boolean;
  active: boolean;
}

const CONFIG_TABLE_DEFS: Record<ConfigScope, CatalogueDef[]> = {
  cib: [
    { name: 'CIB_ACCOUNT_MASTER', cob: true, active: true },
    { name: 'CIB_LIMIT_CONFIG', cob: false, active: true },
    { name: 'CIB_FX_RATES', cob: true, active: false },
    { name: 'CIB_PAYMENT_ROUTES', cob: true, active: true },
    { name: 'CIB_SWIFT_MAPPING', cob: false, active: true }
  ],
  group: [
    { name: 'GRP_ENTITY_HIERARCHY', cob: true, active: true },
    { name: 'GRP_COST_CENTER', cob: false, active: true },
    { name: 'GRP_GL_MAPPING', cob: true, active: false },
    { name: 'GRP_RISK_WEIGHTS', cob: true, active: true }
  ],
  retail: [
    { name: 'RTL_PRODUCT_CATALOG', cob: true, active: true },
    { name: 'RTL_BRANCH_CONFIG', cob: false, active: true },
    { name: 'RTL_FEE_SCHEDULE', cob: true, active: true },
    { name: 'RTL_CARD_BINS', cob: false, active: false },
    { name: 'RTL_LOYALTY_TIERS', cob: true, active: true },
    { name: 'RTL_ATM_NETWORK', cob: true, active: true }
  ]
};

/** Prefix used to synthesise extra catalogue rows so pagination is demonstrable. */
const SCOPE_PREFIX: Record<ConfigScope, string> = { cib: 'CIB', group: 'GRP', retail: 'RTL' };

/** Catalogue columns — the generic `{ cols, rows }` shape the real API returns. */
const CATALOGUE_COLS = ['APP_ENV', 'TABLE_NAME', 'IS_COBDT', 'IS_ACTIVE'];

const yn = (v: boolean): string => (v ? 'Y' : 'N');

/**
 * Config catalogue for a scope, as `TabularData` ({ cols, rows }). Columns are
 * returned by the API — the UI renders whatever arrives, so adding a column here
 * needs no UI change.
 */
export function mockConfigTables(scope: ConfigScope): TabularData {
  const defs = CONFIG_TABLE_DEFS[scope] ?? [];
  const prefix = SCOPE_PREFIX[scope] ?? 'OLS';
  const rows: unknown[][] = defs.map((d) => [environment.appEnv,d.name, yn(d.cob), yn(d.active)]);
  // Pad out to ~60 rows so the grid's pagination is exercised.
  for (let i = defs.length + 1; i <= 60; i++) {
    rows.push([environment.appEnv,`${prefix}_REF_DATA_${String(i).padStart(3, '0')}`, yn(i % 3 === 0), yn(i % 4 !== 0)]);
  }
  return { cols: CATALOGUE_COLS, rows };
}

/**
 * Column detail for the down-arrow expand (`columnretrieve`). Returns a plain
 * `{ cols, rows }` table for the clicked table — the nested grid renders it as-is
 * (mirrors the example backend shape: APP_ENV / TABLE_NAME / IS_COBDT / IS_ACTIVE).
 */
export function mockColumnRetrieve(tableName: string): TabularData {
  const cols = ['APP_ENV', 'TABLE_NAME', 'IS_COBDT', 'IS_ACTIVE'];
  const seed = [...tableName].reduce((a, c) => a + c.charCodeAt(0), 0);
  const rows: unknown[][] = [
    [environment.appEnv,tableName, yn(seed % 2 === 0), 'Y'],
    [environment.appEnv,`${tableName}_HIST`, yn(seed % 3 === 0), yn(seed % 2 === 1)],
    [environment.appEnv,`${tableName}_STG`, 'N', 'Y']
  ];
  return { cols, rows };
}

// ---------------------------------------------------------------------------
// Config Ops Console — content of a single table (mixed data types)
// ---------------------------------------------------------------------------

/**
 * Table schema — the column names + DB data types the columns API (dba_tab_columns)
 * returns. Content rows are generated in this exact order.
 */
const CONTENT_SCHEMA: { name: string; cx: string }[] = [
  { name: 'ID', cx: '<cx_Oracle.DbType DB_TYPE_NUMBER>' },
  { name: 'CODE', cx: '<cx_Oracle.DbType DB_TYPE_VARCHAR>' },
  { name: 'DESCRIPTION', cx: '<cx_Oracle.DbType DB_TYPE_CLOB>' },
  { name: 'PAYLOAD', cx: '<cx_Oracle.DbType DB_TYPE_JSON>' },
  { name: 'DEFINITION', cx: '<cx_Oracle.DbType DB_TYPE_XMLTYPE>' },
  { name: 'ATTACHMENT', cx: '<cx_Oracle.DbType DB_TYPE_BLOB>' },
  { name: 'ENABLED', cx: '<cx_Oracle.DbType DB_TYPE_CHAR>' },
  { name: 'COB_DT', cx: '<cx_Oracle.DbType DB_TYPE_DATE>' },
  { name: 'UPDATED_AT', cx: '<cx_Oracle.DbType DB_TYPE_TIMESTAMP>' }
];

function longText(tableName: string, i: number): string {
  return (
    `Configuration record #${i} for ${tableName}. ` +
    'This CLOB column holds a long free-text description that would normally be ' +
    'truncated in a grid cell. It covers operational notes, change history and ' +
    'approval references. Row was migrated during the 2026 platform consolidation ' +
    'and validated against the golden source. Additional remarks: retain for audit, ' +
    'do not purge before the regulatory retention window of seven years elapses.'
  );
}

function jsonPayload(tableName: string, i: number): string {
  return JSON.stringify(
    {
      table: tableName,
      rowId: i,
      thresholds: { warn: 70 + i, critical: 90 + i },
      regions: ['EMEA', 'APAC', 'AMER'],
      flags: { replicated: i % 2 === 0, encrypted: true },
      lastReviewedBy: 'ops.batch',
      metadata: { version: `1.${i}.0`, checksum: `a1b2c3${i}` }
    },
    null,
    2
  );
}

function xmlDefinition(tableName: string, i: number): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<definition table="${tableName}" row="${i}">\n` +
    `  <owner>OLS Platform</owner>\n` +
    `  <schedule cron="0 0 22 * * ?" timezone="UTC"/>\n` +
    `  <columns>\n` +
    `    <column name="code" nullable="false"/>\n` +
    `    <column name="enabled" type="boolean"/>\n` +
    `  </columns>\n` +
    `  <retentionDays>2555</retentionDays>\n` +
    `</definition>`
  );
}

function blobData(i: number): string {
  // Pseudo base64 blob preview.
  const chunk = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCA',
    seed = (i * 977).toString(36);
  return `data:application/octet-stream;base64,${chunk}${seed}QAAAABJRU5ErkJggg==`;
}

/**
 * Table content (eye-click) as `TableContentResponse` — self-describing:
 *  - `cols` / `cols_data_types`: display columns + their cx_Oracle types.
 *  - `Table_data`: row objects keyed by column name, each ALSO carrying `rowid`
 *    (the DB row id used for update/delete). `rowid` is NOT in `cols`, so the grid
 *    never shows it.
 * When date filters are passed (COB tables) the result is sliced to emulate a
 * date/range query; without them (non-COB tables) the full set is returned.
 */
export function mockTableData(
  tableName: string,
  opts?: { start?: string; end?: string; range?: boolean }
): TableContentResponse {
  // Enough rows to exercise the modal grid's pagination and vertical scrolling.
  const rowCount = 120 + (tableName.length % 40);
  const cols = CONTENT_SCHEMA.map((c) => c.name);
  const cols_data_types = CONTENT_SCHEMA.map((c) => c.cx);
  let Table_data: Record<string, unknown>[] = [];
  for (let i = 1; i <= rowCount; i++) {
    Table_data.push({
      ID: i,
      CODE: `${tableName.split('_')[0]}-${String(i).padStart(4, '0')}`,
      DESCRIPTION: longText(tableName, i),
      PAYLOAD: jsonPayload(tableName, i),
      DEFINITION: xmlDefinition(tableName, i),
      ATTACHMENT: blobData(i),
      ENABLED: i % 3 !== 0 ? 'Y' : 'N',
      COB_DT: new Date(Date.UTC(2026, 6, 22 - (i % 5))).toISOString(),
      UPDATED_AT: new Date(Date.UTC(2026, 6, 21, 22 - (i % 12), (i * 7) % 60, 0)).toISOString(),
      // DB row id — rides along in the data, hidden from the grid (not in `cols`).
      rowid: `AAAR${tableName.length}${String(i).padStart(6, '0')}`
    });
  }
  // Emulate a date filter: a discrete date returns a small slice; a range more.
  if (opts?.start) {
    const keep = opts.range ? Math.ceil(Table_data.length * 0.6) : Math.min(Table_data.length, 20);
    Table_data = Table_data.slice(0, keep);
  }
  return { cols, cols_data_types, Table_data };
}

// ---------------------------------------------------------------------------
// System / header memory usage (live jitter)
// ---------------------------------------------------------------------------

export function mockMemory(): MemoryStats {
  const total = 32;
  const used = +(18 + Math.random() * 8).toFixed(1); // 18–26 GB
  const free = +(total - used).toFixed(1);
  const percent = Math.round((used / total) * 100);
  return { free, used, total, unit: 'GB', percent };
}

// ---------------------------------------------------------------------------
// Dashboard (Home)
// ---------------------------------------------------------------------------

export const MOCK_DASHBOARD_STATS: DashboardStat[] = [
  { key: 'servers', label: 'Active Servers', value: '4 / 4', delta: 0, icon: 'cilSpeedometer', color: 'primary' },
  { key: 'tables', label: 'Config Tables', value: '15', delta: 2, icon: 'cilSpreadsheet', color: 'info' },
  { key: 'cob', label: 'COB Jobs Today', value: '128', delta: 12, icon: 'cilTask', color: 'success' },
  { key: 'alerts', label: 'Open Alerts', value: '3', delta: -1, icon: 'cilBell', color: 'warning' }
];

export const MOCK_ACTIVITY: ActivityItem[] = [
  { time: '2026-07-21T22:14:09Z', title: 'Connection timeout', detail: 'PROD-APP-01 pool-2 recovered after retry', level: 'warning' },
  { time: '2026-07-21T22:14:05Z', title: 'EOD batch completed', detail: 'CIB scope — 5 tables refreshed', level: 'success' },
  { time: '2026-07-21T21:44:00Z', title: 'Config updated', detail: 'RTL_PRODUCT_CATALOG changed by ops.batch', level: 'info' },
  { time: '2026-07-21T20:10:00Z', title: 'Replication lag', detail: 'GRP entity hierarchy synced within SLA', level: 'info' },
  { time: '2026-07-21T18:02:44Z', title: 'Table deactivated', detail: 'CIB_FX_RATES set inactive', level: 'danger' }
];

/** Last 12 samples of used-memory percentage for the dashboard trend chart. */
export const MOCK_MEMORY_TREND: number[] = [58, 61, 63, 60, 66, 70, 68, 72, 69, 74, 71, 67];
