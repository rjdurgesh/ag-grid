/**
 * Central place for every backend URL used by the OLS Dashboard.
 *
 * URLs only. All app/runtime config — base URL, environment, mock toggle,
 * support email, SSO flag, dev roles, demo user — lives in
 * `src/environments/environment.ts`. This file reads `apiBaseUrl` from there and
 * builds the endpoints; nothing else should hardcode a URL — import `API` here.
 */

import { environment } from '../../environments/environment';

/** Env types live with the config; re-exported so existing imports keep working. */
export type { AppEnv, ApiEnv } from '../../environments/environment';
import type { AppEnv, ApiEnv } from '../../environments/environment';

/** Root URL of the backend (from the global environment config). */
const API_BASE_URL = environment.apiBaseUrl;

/**
 * The environment label sent to the BACKEND. The UI stores/shows `LIVE`, but the
 * APIs expect `PROD`, so `LIVE` is mapped to `PROD` here (DEV/STG pass through).
 * Use this — never the raw `environment.appEnv` — for any env value on the wire.
 */
export function apiEnv(env: AppEnv = environment.appEnv): ApiEnv {
  return env === 'LIVE' ? 'PROD' : env;
}

/** Scopes handled by the Config Ops Console. */
export type ConfigScope = 'cib' | 'group' | 'retail';

/** Applications monitored by Infrastructure Pulse. */
export type InfraApp = 'OLS_GROUP' | 'OLS_CIB' | 'OLS_RETAIL' | 'POSEIDON';

/** Fixed order the apps are shown in, across both Infra Pulse pages. */
export const INFRA_APPS: InfraApp[] = ['OLS_GROUP', 'OLS_CIB', 'OLS_RETAIL', 'POSEIDON'];

/** Human-readable label for each app (used in headers). */
export const INFRA_APP_LABELS: Record<InfraApp, string> = {
  OLS_GROUP: 'OLS GROUP',
  OLS_CIB: 'OLS CIB',
  OLS_RETAIL: 'OLS RETAIL',
  POSEIDON: 'POSEIDON'
};

/** All API endpoints, built from {@link API_BASE_URL}. */
export const API = {
  auth: {
    login: `${API_BASE_URL}/api/auth/login`,
    logout: `${API_BASE_URL}/api/auth/logout`,
    /**
     * Access + role for the signed-in user (RBAC). **POST** `{ username }` (in the body,
     * not the URL) → a single-entry `{ ACCESS: ROLE }` map, e.g. `{ "ADMIN": "OMT-BOTH" }`
     * — key = access level (drives gating), value = role label shown on the profile card.
     */
    roles: `${API_BASE_URL}/api/auth/roles`
  },
  access: {
    /**
     * The resolved RBAC snapshot for the signed-in user. **POST** `{ username, app_env }` →
     * `AccessSnapshot` (active flag + role + visible screens + config scopes/grants + servers +
     * denied sections). The single source the app reads to gate screens, tables, servers,
     * sections and write buttons. See access_api.py / RBAC_DESIGN.md.
     */
    me: `${API_BASE_URL}/api/access/me`,
    /** Admin-only diagnostic: `{ caller, username, app_env }` → resolved snapshot + raw grants. */
    effective: `${API_BASE_URL}/api/access/effective`,
    /**
     * User Management (ops-admin only — gated by `ols_ops_access`). Every call carries `caller`
     * (the acting ops-admin, re-checked server-side). See access_api.py / RBAC_DESIGN.md.
     */
    admin: {
      /** `{ caller }` → the grantable-resource catalogue the pickers render. */
      catalogue: `${API_BASE_URL}/api/access/admin/catalogue`,
      /** `{ caller, uid, app_env }` → `{ lookup, grants, snapshot }` for one user. */
      user: `${API_BASE_URL}/api/access/admin/user`,
      /** `{ caller, username, resource_type, resource_scope, resource_key, access_level, app_env }` → grant (upsert). */
      grant: `${API_BASE_URL}/api/access/admin/grant`,
      /** `{ caller, username, resource_type, resource_scope, resource_key, app_env }` → revoke (hard delete). */
      grantDelete: `${API_BASE_URL}/api/access/admin/grant/delete`,
      /** `{ caller, action: 'list'|'add'|'disable'|'enable'|'sql_on'|'sql_off'|'remove', uid? }` → manage the ops-admin gate table. */
      ops: `${API_BASE_URL}/api/access/admin/ops`
    }
  },
  /**
   * Regression screen (CIB, DEV/STG only). All POST; `caller` re-checked server-side. See regression_api.py.
   */
  regression: {
    runCurrent: `${API_BASE_URL}/api/regression/run/current`,
    runStart: `${API_BASE_URL}/api/regression/run/start`,
    runComplete: `${API_BASE_URL}/api/regression/run/complete`,
    stepMark: `${API_BASE_URL}/api/regression/step/mark`,
    stepUnlock: `${API_BASE_URL}/api/regression/step/unlock`,
    refreshDb: `${API_BASE_URL}/api/regression/refresh-db`,
    gitBranches: `${API_BASE_URL}/api/regression/git/branches`,
    gitPull: `${API_BASE_URL}/api/regression/git/pull`,
    gitScripts: `${API_BASE_URL}/api/regression/git/scripts`,
    gitTree: `${API_BASE_URL}/api/regression/git/tree`,
    gitFile: `${API_BASE_URL}/api/regression/git/file`,
    runSql: `${API_BASE_URL}/api/regression/run-sql`,
    runSqlStream: `${API_BASE_URL}/api/regression/run-sql-stream`,
    logRead: `${API_BASE_URL}/api/regression/log/read`,
    fileCopyManifest: `${API_BASE_URL}/api/regression/file-copy/manifest`,
    fileCopyRun: `${API_BASE_URL}/api/regression/file-copy/run`,
    batchMonitor: `${API_BASE_URL}/api/regression/batch-monitor`,
    activity: `${API_BASE_URL}/api/regression/activity`
  },
  /**
   * S-Studio — the Config Ops SQL console (ops-admins with `can_sql` only). See sql_studio_api.py.
   */
  sqlStudio: {
    /** `{ caller, scope }` → the databases in that config scope. */
    databases: `${API_BASE_URL}/api/sql_studio/databases`,
    /** `{ caller, db, sql }` → run the statement/script → `{ result: SqlResult }`. */
    execute: `${API_BASE_URL}/api/sql_studio/execute`
  },
  /**
   * Documentation Center — catalogue of wiki links + local markdown docs, plus one doc's content.
   * Both POST (caller/username in the body, out of the URL). The server RBAC-filters technical docs.
   * See docs_api.py / DOCS_DESIGN.md.
   */
  docs: {
    /** `{ caller, app_env }` → `{ status, entries: DocEntry[] }` (already audience-filtered). */
    catalog: `${API_BASE_URL}/api/docs/catalog`,
    /** `{ caller, id }` → `{ status, doc: DocContent }` (raw markdown; RBAC re-checked). */
    content: `${API_BASE_URL}/api/docs/content`
  },
  system: {
    /** One-shot memory snapshot → `MemoryStats`. */
    memory: `${API_BASE_URL}/api/system/memory`,
    /**
     * Live memory as Server-Sent Events — ONE persistent connection that streams
     * a `MemoryStats` snapshot every couple of seconds. Consumed via `EventSource`
     * (not HttpClient), so it always hits the real backend and shows as a single
     * entry in the network tab instead of a poll every N seconds.
     */
    memoryStream: `${API_BASE_URL}/api/system/memory/stream`,
    /** Name of the database this instance is connected to (shown in the footer). */
    database: `${API_BASE_URL}/api/system/database`,
    /** Backend version string (footer). GET → `{ version }`. Bumped in backend/app_version.py. */
    version: `${API_BASE_URL}/api/system/version`
  },
  dashboard: {
    stats: `${API_BASE_URL}/api/dashboard/stats`,
    activity: `${API_BASE_URL}/api/dashboard/activity`,
    memoryTrend: `${API_BASE_URL}/api/dashboard/memory-trend`
  },
  log: {
    /** Server catalogue (DB connection). `app_env` (LIVE→PROD) scopes it to the env. */
    servers: () => `${API_BASE_URL}/api/log/servers?app_env=${encodeURIComponent(apiEnv())}`,
    /**
     * Immediate children of ONE folder → `LogDirResponse`
     * `{ entries: { name, type, path }[], total, truncated }`. POST body
     * `{ server_id, base, path }` — `base` is the selected server's `base_log_path`
     * (the UI already has it from {@link servers}); `path` is the folder's FULL path;
     * `server_id` is context only. The backend confirms `path` sits inside `base`
     * (reject `..`/outside) — no DB call. Body (not query) so long paths never bloat
     * the URL. The tree loads one level per expand.
     */
    dir: `${API_BASE_URL}/api/log/dir`,
    /**
     * File content for the preview. POST body `{ server_id, base, path, offset?,
     * length?, from_end? }`. Small file → `{ mode:'full', content, total_size }`;
     * large file → `{ mode:'window', content, start, end, total_size, bof, eof }`
     * (a line-aligned byte window the UI pages through). See {@link models.LogFileResponse}.
     */
    fileContent: `${API_BASE_URL}/api/log/file`,
    /**
     * Streamed download of a whole file (any size) — a plain GET the browser
     * navigates to; the server streams it to disk with a `Content-Disposition`
     * filename, never buffering it in memory. `base`/`path` in the query.
     */
    fileDownload: (base: string, path: string) =>
      `${API_BASE_URL}/api/log/file/download?base=${encodeURIComponent(base)}&path=${encodeURIComponent(path)}`,
    /** Metadata for a single file. POST body `{ server_id, base, path }`. */
    fileProperties: `${API_BASE_URL}/api/log/file-properties`
  },
  config: {
    /**
     * Table catalogue for a scope — **POST** `{ app_env, username }` → `TabularData`
     * `{ cols, rows }`. Sent in the body (not the URL) so `username` never appears in
     * the query string / logs. `app_env` scopes the catalogue to this environment
     * (`LIVE` is sent to the API as `PROD` — see {@link apiEnv}).
     *
     * The master catalogue lives ONLY in the scope's BATCH db, so this call needs no `db_source`.
     * Instead every returned row carries a **`DB_SOURCE`** column — the table's physical DB
     * (`ols_group` | `ols_cib_batch` | `ols_cib_reporting` | `ols_retail_batch` | `ols_retail_reporting`,
     * matching an app.py connection key). Every per-table op below sends that value back so the backend
     * (`config_api._source_db`) routes the read/write to the correct batch OR reporting DB.
     */
    tables: (scope: ConfigScope) => `${API_BASE_URL}/api/config/${scope}/tables`,
    /**
     * Column detail (down-arrow expand). POST { table_name, db_source, caller } → `TabularData`
     * `{ cols, rows }`. `db_source` (the catalogue row's `DB_SOURCE`) routes to the table's physical DB;
     * `caller` is the read-gate actor. The nested detail grid renders whatever comes back as-is.
     */
    columnRetrieve: (scope: ConfigScope) => `${API_BASE_URL}/api/config/${scope}/columnretrieve`,
    /** Roll (COB) data for a table. POST { rolled_by, table_name, db_source, source_date, target_dates,
     *  tablespace }. `db_source` (the row's physical DB, e.g. ols_cib_reporting) routes the op. */
    rollData: (scope: ConfigScope) => `${API_BASE_URL}/api/config/${scope}/roll`,
    /**
     * Table content (eye-click). POST
     * `{ table_name, db_source, caller, is_cobdt, start_date, end_date, date_range }` →
     * `TableContentResponse` { cols, cols_data_types, Table_data } (self-describing).
     * `db_source` (the row's physical DB) routes the read to the right batch/reporting DB.
     * `is_cobdt` ('Y'/'N') comes from the catalogue row. When it is 'Y' the two
     * dates are sent (default: T-1 on both; `date_range` false = just those two
     * days, true = the inclusive range between them). When it is 'N' both dates
     * are sent as `null`.
     */
    retrieve: (scope: ConfigScope) => `${API_BASE_URL}/api/config/${scope}/retrieve`,
    /**
     * INSERT rows. Table name in the URL; body = `{ inserted_by, db_source, columns, rows }`
     * where `rows` are value arrays in `columns` order. `db_source` routes to the table's physical
     * DB (batch/reporting). Returns `{ inserted: N }`.
     */
    createRows: (scope: ConfigScope, table: string) =>
      `${API_BASE_URL}/api/config/${scope}/table/${encodeURIComponent(table)}/rows`,
    /**
     * UPDATE rows. Table name in the URL; body = `{ updated_by, db_source, updates:
     * [{ rowid, values: { COL: val } }] }` (changed columns only). `db_source` routes to the table's
     * physical DB. Returns `{ updated: N }`.
     */
    updateRows: (scope: ConfigScope, table: string) =>
      `${API_BASE_URL}/api/config/${scope}/table/${encodeURIComponent(table)}/update`,
    /**
     * DELETE rows. Table name in the URL; body = `{ deleted_by, db_source, rowids: [...] }`.
     * `db_source` routes to the table's physical DB. Returns `{ deleted: N }`.
     */
    deleteRows: (scope: ConfigScope, table: string) =>
      `${API_BASE_URL}/api/config/${scope}/table/${encodeURIComponent(table)}/delete`,
    /**
     * CSV UPLOAD & LOAD. Body = `{ caller, mode, delimiter, original_filename, file_content, db_source,
     * is_cobdt }`. `db_source` (the row's physical DB, e.g. ols_cib_reporting) routes the load to the
     * right DB. `is_cobdt` ('Y'/'N', from the catalogue row) tells the server whether to apply the
     * date-column rules (single-date-per-file, partition check) — a non-COB table skips them.
     * Append = insert only; Replace = delete-then-insert (whole table, or by the single COB date).
     * See GUIDE.md (Config Ops — CSV Upload & Load).
     */
    upload: (scope: ConfigScope, table: string) =>
      `${API_BASE_URL}/api/config/${scope}/table/${encodeURIComponent(table)}/upload`
  },
  infra: {
    // --- Infrastructure Health (new contract) -------------------------------
    // Everything is POST under /api/infra_health, so the browser only ever sees
    // these clean URLs — the per-server agent URLs are formed + called server-side
    // and never appear in the network tab.
    /** Config catalogue. POST `{ app_env, username }` → `{ status, data:[rows] }`. */
    healthConfig: `${API_BASE_URL}/api/infra_health`,
    /**
     * Per-server live metrics. POST `{ host_name, agent_listen_port, host_platform,
     * monitoring_config }` → the backend builds `http://{host}:{port}/system-metrics`,
     * calls the agent, and returns its cpu/ram/disk reading. One call per server.
     */
    healthMetrics: `${API_BASE_URL}/api/infra_health/metrics`,
    /** Per-share free space (no agent). POST `{ host_address, app_name }` → `{ used, total, unit }`. */
    healthShare: `${API_BASE_URL}/api/infra_health/share`,

    // --- Service Console (new contract; shares the /api/infra_health catalogue) ----
    /**
     * Manage the services on ONE server via its agent — a single endpoint whose payload
     * decides the operation (the backend forms `http://{host}:{port}/service-manage` and
     * calls it, so the agent URL never reaches the browser):
     *  - **bulk status**: POST `{ host_name, agent_listen_port, host_platform, services: [names] }`
     *    → `{ HOST_NAME, <name>: { service, status }, ... }`.
     *  - **action**: POST `{ host_name, agent_listen_port, host_platform, service, action }`
     *    (`action` = start | stop | status) → `{ action, message, service, success }`.
     * Server list + each server's services come from the shared `healthConfig` catalogue.
     */
    serviceManage: `${API_BASE_URL}/api/service_console/service-manage`
  },
  /**
   * Oracle Command Center — per-DB DBA monitoring. Every section is `POST /api/oracle_cc/{db}/…`
   * and returns a self-describing `{ status, columns, rows, summary }` payload so the UI never
   * hardcodes headers/columns. `db` is one of the config-driven target keys from `targets`.
   */
  oracle: {
    /** DB tabs to render (config-driven) → `{ status, data: OracleTarget[] }`. */
    targets: `${API_BASE_URL}/api/oracle_cc/targets`,
    /** Compact per-DB snapshot for the Home strip → `{ status, data: OracleOverview[] }`. */
    overview: `${API_BASE_URL}/api/oracle_cc/overview`,
    /** Section 1 — tablespace/owner space + gauge summary. */
    space: (db: string) => `${API_BASE_URL}/api/oracle_cc/${db}/space`,
    /** Section 2 — top table storage consumers (drill partition → subpartition). */
    topSegments: (db: string) => `${API_BASE_URL}/api/oracle_cc/${db}/top_segments`,
    /** Section 3 — top index storage consumers. */
    topIndexes: (db: string) => `${API_BASE_URL}/api/oracle_cc/${db}/top_indexes`,
    /** Section 4 — index health & stability (unusable / invisible / stale). */
    indexHealth: (db: string) => `${API_BASE_URL}/api/oracle_cc/${db}/index_health`,
    /** Section 5 — critical locks. */
    locks: (db: string) => `${API_BASE_URL}/api/oracle_cc/${db}/locks`,
    /** Section 4 — blocking session tree. */
    blocking: (db: string) => `${API_BASE_URL}/api/oracle_cc/${db}/blocking`,
    tempUsage: (db: string) => `${API_BASE_URL}/api/oracle_cc/${db}/temp-usage`,
    /** Section 5 — sessions list (`?status=active|inactive|all`). */
    sessions: (db: string) => `${API_BASE_URL}/api/oracle_cc/${db}/sessions`,
    /** Section 5 — full deep-dive for one SID/SQL_ID. */
    sessionDetail: (db: string) => `${API_BASE_URL}/api/oracle_cc/${db}/session-detail`,
    /** Kill a session (RBAC admin + confirm). POST `{ sid, serial, immediate }`. */
    killSession: (db: string) => `${API_BASE_URL}/api/oracle_cc/${db}/kill-session`,
    // --- Section 8 · SQL Intelligence (investigate a sql_id; 5-day AWR/ASH window) ---
    /** Find a sql_id (top SQL over the window). POST `{ q?, order? }`. */
    sqlFinder: (db: string) => `${API_BASE_URL}/api/oracle_cc/${db}/sql_finder`,
    /** Identity + verdict + KPIs for a sql_id. */
    sqlOverview: (db: string, sqlId: string) => `${API_BASE_URL}/api/oracle_cc/${db}/sql/${sqlId}/overview`,
    /** Plan-instability timeline (per-snapshot plan_hash + elapsed/exec). */
    sqlPlanTimeline: (db: string, sqlId: string) => `${API_BASE_URL}/api/oracle_cc/${db}/sql/${sqlId}/plan_timeline`,
    /** Distinct plans this sql_id used (drives the diff selector). */
    sqlPlans: (db: string, sqlId: string) => `${API_BASE_URL}/api/oracle_cc/${db}/sql/${sqlId}/plans`,
    /** Runtime plan: bottleneck (self-time) + E/A-Rows misestimate + stats health (live cursor). */
    sqlPlanAnalysis: (db: string, sqlId: string) => `${API_BASE_URL}/api/oracle_cc/${db}/sql/${sqlId}/plan_analysis`,
    /** Real-time SQL Monitor report (live/recent executions only). */
    sqlMonitor: (db: string, sqlId: string) => `${API_BASE_URL}/api/oracle_cc/${db}/sql/${sqlId}/sql_monitor`,
    /** One plan's text. POST `{ plan_hash_value }`. */
    sqlPlanText: (db: string, sqlId: string) => `${API_BASE_URL}/api/oracle_cc/${db}/sql/${sqlId}/plan_text`,
    /** Per-snapshot performance table. */
    sqlPerf: (db: string, sqlId: string) => `${API_BASE_URL}/api/oracle_cc/${db}/sql/${sqlId}/perf`,
    /** ASH breakdown (top waits) for the sql_id. */
    sqlAsh: (db: string, sqlId: string) => `${API_BASE_URL}/api/oracle_cc/${db}/sql/${sqlId}/ash`,
    /** Captured bind variables. */
    sqlBinds: (db: string, sqlId: string) => `${API_BASE_URL}/api/oracle_cc/${db}/sql/${sqlId}/binds`,
    /** Read-only fix recommendation (best plan + copy-ready SQL). */
    sqlFix: (db: string, sqlId: string) => `${API_BASE_URL}/api/oracle_cc/${db}/sql/${sqlId}/fix`,
    /** WRITE — apply the fix (admin + confirm; gated by SQLI_ALLOW_APPLY). POST `{ sql_id, plan_hash_value, method }`. */
    sqlApplyFix: (db: string, sqlId: string) => `${API_BASE_URL}/api/oracle_cc/${db}/sql/${sqlId}/apply_fix`
  }
} as const;
