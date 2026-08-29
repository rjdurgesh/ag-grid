/** Shared data-model contracts for the OLS Dashboard API. */

/**
 * One row of the log-server config table as returned by the servers API.
 * Real table columns: `Server_name, base_log_path, is_base_server, is_active,
 * server_type, db_source, app_env`. The API returns only the fields the UI
 * needs for active rows in the current environment.
 */
export interface LogServerRow {
  server_name: string;
  base_log_path: string;
  server_type: string;
  db_source: string;
}

/**
 * Response of `GET /api/log/servers`: a map keyed by a composite id
 * (`{db_source}_{server_type}_{server_name}`, e.g. "OLSCIB_WEB_A_1_eur17")
 * whose value is the matching config row(s).
 */
export type LogServersResponse = Record<string, LogServerRow[]>;

/** One immediate child returned by `GET /api/log/dir` (lazy expansion). */
export interface LogDirEntry {
  name: string;
  type: 'folder' | 'file';
  /** Full absolute path of this entry (used to expand further or read a file). */
  path: string;
}

/** Response of `GET /api/log/dir` — the immediate children of one folder. */
export interface LogDirResponse {
  entries: LogDirEntry[];
  /** Real (uncapped) child count; `entries.length` may be smaller when capped. */
  total?: number;
  /** True when the folder held more than the per-folder cap and was truncated. */
  truncated?: boolean;
}

/**
 * Response of `POST /api/log/file`. The backend picks the shape by file size:
 *
 * - `full` (size <= threshold) — the whole file; the UI paginates it by line.
 * - `window` (larger) — a line-aligned byte slice the UI pages through, so a
 *   multi-GB file never loads whole. `start`/`end` are byte offsets; `bof`/`eof`
 *   mark the ends of the file.
 */
export interface LogFileFull {
  mode: 'full';
  content: string;
  total_size: number;
}
export interface LogFileWindow {
  mode: 'window';
  content: string;
  start: number;
  end: number;
  total_size: number;
  bof: boolean;
  eof: boolean;
}
export type LogFileResponse = LogFileFull | LogFileWindow;

/** Flattened, UI-friendly log server — one option in the server dropdown. */
export interface LogServer {
  /** Composite unique key from the API map, e.g. "OLSCIB_WEB_A_1_eur17". */
  key: string;
  serverName: string;
  serverType: string;
  dbSource: string;
  /** Every configured `base_log_path` for this server (the value array can hold
   *  several). Each becomes a separate root in the file tree. */
  basePaths: string[];
}

/** File metadata shown in the Log Analytics "Properties" dialog. */
export interface FileProperties {
  name: string;
  /** Human-readable file type, e.g. "JSON Source File". */
  type: string;
  /** Containing folder. */
  location: string;
  /** Size in bytes. */
  size: number;
  created: string;
  modified: string;
  accessed: string;
  /** Total line count. */
  lines: number;
  /** e.g. "Read-only" / "Read & Write". */
  attributes?: string;
}

/** Logical type of a table cell — drives special rendering (clob/json/xml/blob). */
export type CellDataType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'timestamp'
  | 'clob'
  | 'json'
  | 'xml'
  | 'blob';

/** Column metadata returned alongside table content. */
export interface ColumnMeta {
  field: string;
  header?: string;
  type: CellDataType;
}

/** Generic tabular payload: typed columns + arbitrary row objects. */
export interface TableContent {
  columns: ColumnMeta[];
  rows: Record<string, unknown>[];
}

/**
 * Config Ops **catalogue** payload (`/tables`): column names + row value arrays.
 * The grid renders whatever columns the API returns — no hardcoded headers.
 */
export interface TabularData {
  cols: string[];
  rows: unknown[][];
}

/**
 * Config Ops **table-content** payload (eye-click / `/retrieve`). Self-describing:
 *  - `cols`            : display column names (rowid is intentionally NOT here).
 *  - `cols_data_types` : parallel cx_Oracle DB types, e.g.
 *                        "<cx_Oracle.DbType DB_TYPE_DATE>" — drives typed rendering.
 *  - `Table_data`      : row objects keyed by column name; each ALSO carries a
 *                        `rowid` (the DB row id) used for update/delete but hidden
 *                        from the grid because it isn't in `cols`.
 */
export interface TableContentResponse {
  cols: string[];
  cols_data_types: string[];
  Table_data: Record<string, unknown>[];
}

/** Live memory usage stats shown in the header. */
export interface MemoryStats {
  free: number;
  used: number;
  total: number;
  /** Unit label, e.g. "GB". */
  unit: string;
  /** Used percentage 0–100. */
  percent: number;
}

/** Role flags for a user (from the user table). Any combination may be set. */
export interface UserRoles {
  /** Full access — every screen visible + all actions. */
  is_admin: boolean;
  /** Read-only — every screen visible, but no actions (buttons hidden). */
  is_read: boolean;
  /** Restricted power user — admin-like actions but only on the salt-allowed screens. */
  is_salt: boolean;
}

/**
 * Response of `POST /api/auth/roles` `{ username }`: a single-entry map of
 * **{ ACCESS: ROLE }**, e.g. `{ "ADMIN": "OMT-BOTH" }`. The key is the access level
 * (ADMIN / READ / SALT — drives RBAC gating), the value is the role label shown on the
 * profile card ("ADMIN | OMT-BOTH").
 */
export type AccessRoleResponse = Record<string, string>;

// --- RBAC access snapshot (POST /api/access/me — see access_api.py / RBAC_DESIGN.md) ---------

/** A config-ops grant (category or per-table), scoped to one sub-screen (group/cib/retail). */
export interface ConfigCategoryGrant {
  scope: string;
  category: string;
  level: 'READ' | 'WRITE' | 'DENY';
}
export interface ConfigTableGrant {
  scope: string;
  table: string;
  level: 'READ' | 'WRITE' | 'DENY';
}

/** A denied section within a screen (e.g. hide SQL Intelligence in the OCC). `db` scopes the hide
 *  to a single OCC database; absent → hidden on every DB. */
export interface DeniedSection {
  screen: string;
  key: string;
  db?: string;
}

/**
 * The resolved access snapshot for the signed-in user — the ONE thing the app reads to decide
 * what to show and which write actions to enable. Assembled server-side from `ols_users`
 * (identity + base role) + `ols_app_access` (grants). See RBAC_DESIGN.md.
 */
export interface AccessSnapshot {
  status?: string;
  /** Gate 1: active in ols_users (LGCL_DEL_FLG='N'). False → sign out / No-Access. */
  active: boolean;
  username: string;
  display_name: string;
  email: string;
  role: 'ADMIN' | 'READ' | 'SALT' | 'NONE';
  app_env: string;
  /** Screen keys the user may VIEW. */
  screens: string[];
  /** Screens with write (OCC kill, Service start/stop). ADMIN → all write-capable screens. */
  write_screens: string[];
  /** Config Ops access (per sub-screen scope + grants for table resolution). */
  config: {
    /** Visible sub-screen scopes: e.g. ['group','cib']. */
    scopes: string[];
    /** Full config access (ADMIN, or a full-access wildcard grant). `all_level` = READ / WRITE. */
    all?: boolean;
    all_level?: 'READ' | 'WRITE';
    category_grants: ConfigCategoryGrant[];
    table_grants: ConfigTableGrant[];
  };
  /** Log Analytics: visible server names. `all_servers` true → every server; `denied_servers`
   *  subtracts specific servers from that ("all EXCEPT these"). */
  servers: string[];
  all_servers: boolean;
  denied_servers?: string[];
  /** Infrastructure Health: which apps are visible (`all_apps` → every app; `denied_apps` subtracts). */
  infra: { all_apps: boolean; apps: string[]; denied_apps?: string[] };
  /** Service Console: which apps' services are visible (`all_apps` → every app; `denied_apps` subtracts). */
  service: { all_apps: boolean; apps: string[]; denied_apps?: string[] };
  /** Oracle Command Center: per-DB access. `all_dbs` → every DB at `all_level`; else `dbs[key]`.
   *  `denied_dbs` subtracts specific DBs from an `all_dbs` grant ("all DBs EXCEPT these"). */
  oracle: { all_dbs: boolean; all_level: 'READ' | 'WRITE'; dbs: Record<string, 'READ' | 'WRITE'>; denied_dbs?: string[] };
  /** Sections hidden for this user. */
  denied_sections: DeniedSection[];
  /** Ops-admin gate (`ols_ops_access`): may open User Management + hand out grants. Independent of
   *  `role` — even an ADMIN is false here unless listed in the gate table. */
  is_ops_admin?: boolean;
  /** S-Studio gate (`ols_ops_access.can_sql`, assigned per user): sees the Config Ops SQL console.
   *  Only ever true for an ops-admin. */
  can_sql?: boolean;
}

// --- User Management (ops-admin screen — POST /api/access/admin/* — see access_api.py) --------

/** One grantable screen in the catalogue (write_capable → a WRITE grant is meaningful). */
export interface CatalogueScreen {
  key: string;
  label: string;
  write_capable: boolean;
}
/** A generic {key,label} catalogue entry (config scope, category, app, DB, OCC section). */
export interface CatalogueItem {
  key: string;
  label: string;
}
/** A config table option (present only when sourced from ols_master_table_config). */
export interface CatalogueTable {
  scope: string;
  name: string;
  category: string;
}
/** The grantable-resource tree the User Management pickers render. Data-driven lists (servers, DBs)
 *  populate live; a new screen/section needs its one-line registry entry. See RBAC_DESIGN.md §3. */
export interface AccessCatalogue {
  screens: CatalogueScreen[];
  config: { scopes: CatalogueItem[]; categories: CatalogueItem[]; tables: CatalogueTable[] };
  servers: string[];
  apps: CatalogueItem[];
  databases: CatalogueItem[];
  sections: CatalogueItem[];
  app_envs: string[];
}
/** One `ols_app_access` grant row (as listed / revoked in User Management). */
export interface GrantRow {
  username: string;
  resource_type: string;
  resource_scope: string;
  resource_key: string;
  access_level: 'READ' | 'WRITE' | 'DENY';
  app_env: string;
}
/** Result of validating a grant target against `ols_users`. `active` false → show `message`. */
export interface UserLookup {
  exists: boolean;
  active: boolean;
  username: string;
  display_name?: string;
  email?: string;
  message?: string;
}
/** Response of `POST /api/access/admin/user`. */
export interface AdminUserResponse {
  status?: string;
  lookup: UserLookup;
  grants: GrantRow[];
  snapshot: AccessSnapshot | null;
}
/** One row of the `ols_ops_access` privileged-operators table. `can_users` = User Management access,
 *  `can_sql` = S-Studio access — independent. */
export interface OpsAdmin {
  username: string;
  is_active: string;
  can_users?: string;
  can_sql?: string;
}

// --- S-Studio (Config Ops SQL console — POST /api/sql_studio/* — see sql_studio_api.py) --------

/** A database the S-Studio console can run against, within a config scope. */
export interface SqlDatabase {
  key: string;
  label: string;
}
// --- Config Ops CSV Upload & Load (POST /api/config/{scope}/table/{table}/upload) ---------------
/** Result of a successful load. */
export interface UploadResult {
  load_id: number;
  mode: string;                    // append | replace
  rows_loaded: number;
  rows_deleted: number;
  rows_rejected: number;
  cob_dt: string | null;
  archived: string;
}
export interface UploadReject { row: number; column: string; reason: string; }
export interface UploadResponse {
  status: string;                  // success | rejected | failed
  result?: UploadResult;
  rejects?: UploadReject[];
  rows_rejected?: number;
}

// --- Regression screen (CIB, DEV/STG — POST /api/regression/* — see regression_api.py) ---------

/** One regression cycle. */
export interface RegressionRun {
  run_id: number;
  app_env: string;
  status: string;
  started_by: string;
  started_on?: string;
}
/** Current status of one step (latest log row). */
export interface RegressionStepState {
  status: string;                 // not_started | in_progress | complete | error | forced
  performed_by?: string;
  forced_by?: string;
  started_on?: string;
  finished_on?: string;
  task_completion_time?: number;
  stale?: boolean;                // in_progress longer than the threshold → possibly stuck
  age_seconds?: number;           // how long it's been in_progress
}
/** The run + per-step status map. */
export interface RegressionState {
  run: RegressionRun | null;
  steps: Record<string, RegressionStepState>;
}
/** One script×db run result. */
export interface RunSqlResult {
  script: string;
  db: string;
  status: string;                 // complete | error
  log_file?: string;
  tail?: string;
}
/** A file-copy manifest item. */
export interface FileCopyItem {
  source: string;
  destination: string;
}
/** A file-copy result per item. */
export interface FileCopyResult {
  source: string;
  destination: string;
  ok: boolean;
  count?: number;
  kind?: string;
  error?: string;
  files?: string[];               // the files actually copied (for the per-item log)
}
/** Batch-monitor grid payload. */
export interface BatchMonitorResult {
  columns: string[];
  rows: unknown[][];
  row_count?: number;
}
/** One regression audit-log row (Regression Activity grid). */
export interface RegressionActivityRow {
  log_id: number;
  run_id: number;
  business_line?: string;
  step_key: string;
  action: string;
  status: string;
  performed_by: string;
  started_on?: string;
  finished_on?: string;
  task_completion_time?: number;
  forced_by?: string;
  details?: string;
}

/** Result of running a statement/script (discriminated by `kind`). */
export type SqlResult =
  | { kind: 'select'; columns: string[]; rows: unknown[][]; row_count: number; truncated?: boolean; statement?: string; statements?: number }
  | { kind: 'exec'; message: string; rows_affected?: number | null; statement?: string; statements?: number }
  | { kind: 'error'; error: string };

/** Authenticated user profile. From OpenID: username = UID (sub), displayName = full name. */
export interface AuthUser {
  /** Unique user id (OpenID `sub`). */
  username: string;
  /** Full name (OpenID `name`). */
  displayName: string;
  /** Email address (OpenID `email`). */
  email?: string;
  role: string;
}

/** Response from the login endpoint. */
export interface LoginResponse {
  token: string;
  user: AuthUser;
}

/** Dashboard KPI tile. */
export interface DashboardStat {
  key: string;
  label: string;
  value: string;
  delta?: number;
  icon: string;
  color: string;
}

/** A dashboard recent-activity entry. */
export interface ActivityItem {
  time: string;
  title: string;
  detail: string;
  level: 'info' | 'success' | 'warning' | 'danger';
}
