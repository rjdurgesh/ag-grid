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
