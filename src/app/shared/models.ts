/** Shared data-model contracts for the OLS Dashboard API. */

/** A server option shown in the Log Analytics server dropdown. */
export interface ServerInfo {
  id: string;
  name: string;
  host?: string;
  environment?: string;
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

/** A row in a Config Ops Console catalogue table. */
export interface ConfigTableRow {
  table_name: string;
  active: boolean;
  is_cob: boolean;
  last_update: string;
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
