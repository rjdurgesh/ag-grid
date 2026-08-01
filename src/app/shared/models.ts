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
 * Generic tabular payload: column names + row value arrays. The Config Ops
 * catalogue (`/tables`) and table content (`/retrieve`) both use this, so the
 * grid renders whatever columns the API returns — no hardcoded headers.
 */
export interface TabularData {
  cols: string[];
  rows: unknown[][];
}

/**
 * One column's metadata as returned by the table-columns API (backed by
 * `dba_tab_columns`): the column name + its DB data type.
 */
export interface ColumnDetail {
  name: string;
  /** DB data type, e.g. VARCHAR2 | NUMBER | DATE | TIMESTAMP | CLOB | JSON | XMLTYPE | BLOB. */
  type: string;
}

/** Response of the table-columns API. */
export interface ColumnsResponse {
  columns: ColumnDetail[];
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
