import {
  ActivityItem,
  ColumnsResponse,
  DashboardStat,
  FileProperties,
  LogServersResponse,
  MemoryStats,
  TabularData
} from './models';
import { APP_ENV, AppEnv, ConfigScope } from './api-endpoints';
import {
  AgentActionResponse,
  AgentCollectResponse,
  AgentDiskReading,
  AgentServiceReading,
  HealthServerConfigRow,
  ServiceState,
  ShareSpaceResponse,
  parseMonitorConfig
} from './infra-models';

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
  ]
};

// Relative subpaths under a base_log_path — a realistic spread of folders and
// file types so the tree and its type icons are exercised.
const REL_LOG_PATHS: string[] = [
  'olslogfileerr.log',
  'olslogfileout.log',
  'BatchLogs/ols_main.log',
  'BatchLogs/2026-07-30/run.log',
  'BatchLogs/2026-07-30/summary.log',
  'BatchLogs/2026-07-29/run.log',
  'BatchLogs/2026-07-28/run.log',
  'app/application.log',
  'app/error.log',
  'app/gc/gc.log',
  'config/application.yml',
  'config/logback.xml',
  'config/db_settings.json',
  'audit/access.log',
  'reports/activity.csv',
  'reports/readme.txt',
  'scripts/startup.bat',
  'archive/logs-2026-07.zip'
];

/**
 * File paths for a server — **absolute paths across every configured
 * `base_log_path`**. The UI groups them back under each base (one tree root per
 * base). A little variety per base so each root looks distinct.
 */
export function mockFilePaths(serverKey: string): string[] {
  const bases = (MOCK_LOG_SERVERS[serverKey] ?? []).map((r) => r.base_log_path);
  const out: string[] = [];
  bases.forEach((base, i) => {
    const b = base.replace(/[\\/]+$/, '');
    // Rotate the list a little per base so the roots aren't identical.
    const rel = [...REL_LOG_PATHS];
    if (i % 2 === 1) {
      rel.push('app/http/access.log', 'app/http/requests.log');
    }
    if (serverKey.includes('APP_2')) {
      rel.push('batch/settlement/settle.log');
    }
    rel.forEach((r) => out.push(`${b}/${r}`));
  });
  return out;
}

/**
 * True if `absPath` is inside one of the server's configured base paths (and has
 * no `..` traversal) — the jail check a real backend must enforce before reading
 * a file. Used by the content / properties handlers.
 */
export function isLogPathAllowed(serverKey: string | null, absPath: string | null): boolean {
  const p = (absPath ?? '').replace(/\\/g, '/');
  if (!p || p.split('/').some((s) => s === '..')) {
    return false;
  }
  const lower = p.toLowerCase();
  const bases = (MOCK_LOG_SERVERS[serverKey ?? ''] ?? []).map((r) =>
    r.base_log_path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  );
  return bases.some((b) => b && (lower === b || lower.startsWith(b + '/')));
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
  const rows: unknown[][] = defs.map((d) => [APP_ENV, d.name, yn(d.cob), yn(d.active)]);
  // Pad out to ~60 rows so the grid's pagination is exercised.
  for (let i = defs.length + 1; i <= 60; i++) {
    rows.push([APP_ENV, `${prefix}_REF_DATA_${String(i).padStart(3, '0')}`, yn(i % 3 === 0), yn(i % 4 !== 0)]);
  }
  return { cols: CATALOGUE_COLS, rows };
}

// ---------------------------------------------------------------------------
// Config Ops Console — content of a single table (mixed data types)
// ---------------------------------------------------------------------------

/**
 * Table schema — the column names + DB data types the columns API (dba_tab_columns)
 * returns. Content rows are generated in this exact order.
 */
const CONTENT_SCHEMA: { name: string; db: string }[] = [
  { name: 'ID', db: 'NUMBER' },
  { name: 'CODE', db: 'VARCHAR2' },
  { name: 'DESCRIPTION', db: 'CLOB' },
  { name: 'PAYLOAD', db: 'JSON' },
  { name: 'DEFINITION', db: 'XMLTYPE' },
  { name: 'ATTACHMENT', db: 'BLOB' },
  { name: 'ENABLED', db: 'CHAR' },
  { name: 'COB_DT', db: 'DATE' },
  { name: 'UPDATED_AT', db: 'TIMESTAMP' }
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
 * Column metadata for a table, as the columns API (dba_tab_columns) returns it:
 * column name + DB data type. In this demo every table shares the same schema.
 */
export function mockTableColumns(_tableName: string): ColumnsResponse {
  return { columns: CONTENT_SCHEMA.map((c) => ({ name: c.name, type: c.db })) };
}

/**
 * Table content as `TabularData` ({ cols, rows }). When date filters are passed
 * (COB tables) the result is sliced to emulate a date/range query; without them
 * (non-COB tables) the full set is returned.
 */
export function mockTableData(
  tableName: string,
  opts?: { start?: string; end?: string; range?: boolean }
): TabularData {
  // Enough rows to exercise the modal grid's pagination and vertical scrolling.
  const rowCount = 120 + (tableName.length % 40);
  const cols = CONTENT_SCHEMA.map((c) => c.name);
  let rows: unknown[][] = [];
  for (let i = 1; i <= rowCount; i++) {
    rows.push([
      i,
      `${tableName.split('_')[0]}-${String(i).padStart(4, '0')}`,
      longText(tableName, i),
      jsonPayload(tableName, i),
      xmlDefinition(tableName, i),
      blobData(i),
      i % 3 !== 0 ? 'Y' : 'N',
      new Date(Date.UTC(2026, 6, 22 - (i % 5))).toISOString(),
      new Date(Date.UTC(2026, 6, 21, 22 - (i % 12), (i * 7) % 60, 0)).toISOString()
    ]);
  }
  // Emulate a date filter: a discrete date returns a small slice; a range more.
  if (opts?.start) {
    const keep = opts.range ? Math.ceil(rows.length * 0.6) : Math.min(rows.length, 20);
    rows = rows.slice(0, keep);
  }
  return { cols, rows };
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

// ---------------------------------------------------------------------------
// Infrastructure Pulse — health_Server_Details config + on-server agents
// ---------------------------------------------------------------------------

/** Build a monitor_config CLOB the way the DB stores it (services = single-key objects). */
function mc(disk: string[], infra: string[], services: [string, string | null][]): string {
  return JSON.stringify({ disk, infra, services: services.map(([n, s]) => ({ [n]: s })) });
}

/**
 * Mock of the `health_Server_Details` table. The config API returns these rows
 * filtered by `app_env`. `monitor_config` is a CLOB JSON string (null for shares).
 * Swap this for the real table via the config endpoint — the shape is identical.
 */
const HEALTH_SERVER_CONFIG: HealthServerConfigRow[] = [
  // ---- OLS_GROUP (DEV) ----
  { app_env: 'DEV', resource_category: 'share_drive', host_platform: 'share_drive', hostname: 'olsgroup', host_address: '\\\\abc.euro.net\\prd\\olsgroup', agent_listen_port: 99999, app_name: 'OLS_GROUP', monitor_config: null, is_active: 'Y', comments: 'OLS Group shared drive for batch input/output files.' },
  { app_env: 'DEV', resource_category: 'SERVER', host_platform: 'LINUX', hostname: 'eugv1245', host_address: 'eugv1245.euro.net.intra', agent_listen_port: 7002, app_name: 'OLS_GROUP', monitor_config: mc(['apps', 'data'], ['ram', 'cpu'], [['olsd', '/data/olsd.sh'], ['nginx', '/data/nginx.sh']]), is_active: 'Y', comments: 'OLS Group Linux application host — gateway & web tier.' },
  { app_env: 'DEV', resource_category: 'SERVER', host_platform: 'WINDOW', hostname: 'eugv1246', host_address: 'eugv1246.euro.net.intra', agent_listen_port: 7002, app_name: 'OLS_GROUP', monitor_config: mc(['c', 'd'], ['ram', 'cpu'], [['OLS File Loader', null], ['OLS Scheduler', null]]), is_active: 'Y', comments: 'OLS Group Windows server — file loader & scheduler.' },

  // ---- OLS_CIB (DEV) ----
  { app_env: 'DEV', resource_category: 'share_drive', host_platform: 'share_drive', hostname: 'olscib', host_address: '\\\\abc.euro.net\\prd\\olscib', agent_listen_port: 99999, app_name: 'OLS_CIB', monitor_config: null, is_active: 'Y', comments: 'OLS CIB shared drive for daily extract files.' },
  { app_env: 'DEV', resource_category: 'SERVER', host_platform: 'WINDOW', hostname: 'ecbv1249', host_address: 'ecbv1249.euro.net.intra', agent_listen_port: 7002, app_name: 'OLS_CIB', monitor_config: mc(['c', 'd'], ['ram', 'cpu'], [['OLS CIB Gateway', null], ['OLS CIB RiskEngine', null]]), is_active: 'Y', comments: 'CIB primary Windows host — gateway & risk engine.' },
  { app_env: 'DEV', resource_category: 'SERVER', host_platform: 'WINDOW', hostname: 'ecbv1250', host_address: 'ecbv1250.euro.net.intra', agent_listen_port: 7002, app_name: 'OLS_CIB', monitor_config: mc(['c', 'd'], ['ram', 'cpu'], [['OLS CIB PriceFeed', null], ['OLS CIB Reporting', null], ['W3SVC', null]]), is_active: 'Y', comments: 'CIB reporting Windows host — price feed & reporting.' },

  // ---- OLS_RETAIL (DEV) ----
  { app_env: 'DEV', resource_category: 'share_drive', host_platform: 'share_drive', hostname: 'olsretail', host_address: '\\\\abc.euro.net\\prd\\olsretail', agent_listen_port: 99999, app_name: 'OLS_RETAIL', monitor_config: null, is_active: 'Y', comments: 'OLS Retail shared drive for product catalogue files.' },
  { app_env: 'DEV', resource_category: 'SERVER', host_platform: 'WINDOW', hostname: 'ertv1749', host_address: 'ertv1749.euro.net.intra', agent_listen_port: 7002, app_name: 'OLS_RETAIL', monitor_config: mc(['c', 'd'], ['ram', 'cpu'], []), is_active: 'Y', comments: 'Retail Windows server — space monitored only, no services configured.' },
  { app_env: 'DEV', resource_category: 'SERVER', host_platform: 'WINDOW', hostname: 'ertv1750', host_address: 'ertv1750.euro.net.intra', agent_listen_port: 7002, app_name: 'OLS_RETAIL', monitor_config: mc(['c', 'd'], ['ram', 'cpu'], [['OLS Retail PriceFeed', null], ['OLS Retail Batch', null]]), is_active: 'Y', comments: 'Retail batch Windows host — price feed & batch.' },

  // ---- POSEIDON (DEV) ----
  { app_env: 'DEV', resource_category: 'share_drive', host_platform: 'share_drive', hostname: 'poseidon', host_address: '\\\\abc.euro.net\\prd\\poseidon', agent_listen_port: 99999, app_name: 'POSEIDON', monitor_config: null, is_active: 'Y', comments: 'Poseidon shared drive (2 TB) for market-data archives.' },
  { app_env: 'DEV', resource_category: 'SERVER', host_platform: 'LINUX', hostname: 'psdv1301', host_address: 'psdv1301.euro.net.intra', agent_listen_port: 7002, app_name: 'POSEIDON', monitor_config: mc(['/', 'data'], ['ram', 'cpu'], [['postgresql', '/etc/init.d/postgresql'], ['pgbouncer', '/etc/init.d/pgbouncer']]), is_active: 'Y', comments: 'Poseidon primary DB node — root volume runs tight.' },
  { app_env: 'DEV', resource_category: 'SERVER', host_platform: 'LINUX', hostname: 'psdv1302', host_address: 'psdv1302.euro.net.intra', agent_listen_port: 7002, app_name: 'POSEIDON', monitor_config: mc(['/', 'var'], ['ram', 'cpu'], [['poseidond', '/opt/psd/psd.sh'], ['poseidon-worker', '/opt/psd/worker.sh'], ['poseidon-sync', '/opt/psd/sync.sh']]), is_active: 'Y', comments: 'Poseidon application node — memory pressure under load.' },
  { app_env: 'DEV', resource_category: 'SERVER', host_platform: 'WINDOW', hostname: 'psdv1303', host_address: 'psdv1303.euro.net.intra', agent_listen_port: 7002, app_name: 'POSEIDON', monitor_config: mc(['c', 'd'], ['ram', 'cpu'], [['Poseidon.Gateway', null]]), is_active: 'Y', comments: 'Poseidon Windows gateway host.' },

  // ---- A little STG / PROD so switching APP_ENV shows different data ----
  { app_env: 'STG', resource_category: 'share_drive', host_platform: 'share_drive', hostname: 'olsgroup', host_address: '\\\\abc.euro.net\\stg\\olsgroup', agent_listen_port: 99999, app_name: 'OLS_GROUP', monitor_config: null, is_active: 'Y', comments: 'OLS Group STG shared drive.' },
  { app_env: 'STG', resource_category: 'SERVER', host_platform: 'LINUX', hostname: 'eugs1228', host_address: 'eugs1228.euro.net.intra', agent_listen_port: 7002, app_name: 'OLS_GROUP', monitor_config: mc(['apps', 'data'], ['ram', 'cpu'], [['olsd', '/data/olsd.sh']]), is_active: 'Y', comments: 'OLS Group STG Linux host.' },
  { app_env: 'PROD', resource_category: 'SERVER', host_platform: 'WINDOW', hostname: 'ecbp1409', host_address: 'ecbp1409.euro.net.intra', agent_listen_port: 7002, app_name: 'OLS_CIB', monitor_config: mc(['c', 'd'], ['ram', 'cpu'], [['OLS CIB Gateway', null]]), is_active: 'Y', comments: 'OLS CIB PROD Windows host.' }
];

/** Config API: rows for the given environment. */
export function mockInfraConfig(env: AppEnv): HealthServerConfigRow[] {
  return HEALTH_SERVER_CONFIG.filter((r) => r.app_env === env);
}

/**
 * Per-host baselines that force interesting states (warning / critical disks,
 * memory pressure, stopped / unknown services). Hosts not listed read healthy.
 */
interface HostProfile {
  cpu?: number;
  ram?: { used: number; total: number };
  disks?: Record<string, { used: number; total: number }>;
  services?: Record<string, ServiceState>;
}

const HOST_PROFILES: Record<string, HostProfile> = {
  eugv1246: { services: { 'OLS File Loader': 'Stopped' } },
  ecbv1250: { services: { 'OLS CIB Reporting': 'Faulted' } },
  ertv1750: { disks: { c: { used: 84, total: 99.39 } }, services: { 'OLS Retail Batch': 'Stopped' } },
  psdv1301: { cpu: 40, ram: { used: 100, total: 128 }, disks: { '/': { used: 47, total: 50 } } },
  psdv1302: { cpu: 22, ram: { used: 100, total: 128 }, services: { 'poseidon-worker': 'Stopped', 'poseidon-sync': 'Unknown' } }
};

/** Capacity of a disk/mount when the agent reports it (GB). */
function diskTotal(platform: string, name: string): number {
  if (platform === 'WINDOW') {
    const n = name.toLowerCase();
    return n === 'c' ? 99.39 : n === 'd' ? 449.98 : 200;
  }
  switch (name) {
    case '/':
      return 50;
    case 'data':
      return 1000;
    case 'var':
      return 200;
    case 'apps':
      return 200;
    default:
      return 100;
  }
}

/** Share free-space baselines, keyed by share name. */
const SHARE_SPACE: Record<string, ShareSpaceResponse> = {
  olsgroup: { used: 210, total: 800, unit: 'GB' },
  olscib: { used: 198.13, total: 600, unit: 'GB' },
  olsretail: { used: 0.56, total: 200, unit: 'GB' },
  poseidon: { used: 1.2, total: 2, unit: 'TB' }
};

/** Running services beat within the minute; down ones went quiet a while ago. */
function heartbeatTs(up: boolean): string {
  const ageMs = up ? Math.floor(Math.random() * 55_000) : (5 + Math.floor(Math.random() * 90)) * 60_000;
  return new Date(Date.now() - ageMs).toISOString();
}

/**
 * Session-lived service state per host, so Start/Stop persists across polls
 * (the real agent keeps this itself). Keyed by `${hostname}::${serviceName}`.
 */
const agentServiceState = new Map<string, { state: ServiceState; lastHeartbeat: string }>();

function ensureAgentServiceState(host: string, name: string, initial: ServiceState): { state: ServiceState; lastHeartbeat: string } {
  const key = `${host}::${name}`;
  let s = agentServiceState.get(key);
  if (!s) {
    s = { state: initial, lastHeartbeat: heartbeatTs(initial === 'Running') };
    agentServiceState.set(key, s);
  }
  return s;
}

/** Payload the tool sends to a server's agent. */
export interface AgentCollectPayload {
  hostname: string;
  host_platform: 'LINUX' | 'WINDOW' | 'share_drive';
  monitor_config: string | null;
}

/**
 * Agent collect: given a server's monitor_config, return live disk / infra /
 * service readings. In production this hits the agent at host_address:port.
 */
export function mockAgentCollect(payload: AgentCollectPayload): AgentCollectResponse {
  const { hostname, host_platform } = payload;
  const config = parseMonitorConfig(payload.monitor_config);
  const profile = HOST_PROFILES[hostname] ?? {};
  const jit = (value: number, amount: number) => +Math.max(0, value + (Math.random() * 2 - 1) * amount).toFixed(2);

  let cpu: number | undefined;
  if (config.infra.includes('cpu')) {
    const base = profile.cpu ?? 2 + Math.random() * 8;
    cpu = +Math.max(0, Math.min(100, jit(base, 3))).toFixed(1);
  }

  let ram: { used: number; total: number } | undefined;
  if (config.infra.includes('ram')) {
    const total = profile.ram?.total ?? (host_platform === 'LINUX' ? 128 : 144);
    const baseUsed = profile.ram?.used ?? total * (0.15 + Math.random() * 0.25);
    ram = { used: Math.min(total, jit(baseUsed, total * 0.02)), total };
  }

  const disks: AgentDiskReading[] = config.disk.map((name) => {
    const total = diskTotal(host_platform, name);
    const baseUsed = profile.disks?.[name]?.used ?? total * (0.15 + Math.random() * 0.4);
    return { name, used: Math.min(total, jit(baseUsed, total * 0.015)), total, unit: 'GB' };
  });

  const services: AgentServiceReading[] = config.services.map((svc) => {
    const initial = profile.services?.[svc.name] ?? 'Running';
    const state = ensureAgentServiceState(hostname, svc.name, initial);
    return { name: svc.name, state: state.state, lastHeartbeat: state.lastHeartbeat };
  });

  return { hostname, reachable: true, cpu, ram, disks, services };
}

/** Payload for a start/stop action against a server's agent. */
export interface AgentActionPayload {
  hostname: string;
  service: string;
  action: 'start' | 'stop';
}

/** Agent action: start/stop a service and return its new state. */
export function mockAgentAction(payload: AgentActionPayload): AgentActionResponse {
  const state = ensureAgentServiceState(payload.hostname, payload.service, 'Running');
  state.state = payload.action === 'start' ? 'Running' : 'Stopped';
  state.lastHeartbeat = heartbeatTs(state.state === 'Running');
  return { service: payload.service, state: state.state, lastHeartbeat: state.lastHeartbeat };
}

/** Share free space (no agent — computed directly), with light jitter. */
export function mockShareSpace(name: string): ShareSpaceResponse {
  const base = SHARE_SPACE[name] ?? { used: 100, total: 500, unit: 'GB' };
  const jitter = base.total * 0.01;
  const used = +Math.max(0, Math.min(base.total, base.used + (Math.random() * 2 - 1) * jitter)).toFixed(2);
  return { used, total: base.total, unit: base.unit };
}
