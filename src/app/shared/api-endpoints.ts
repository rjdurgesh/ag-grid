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
    /** Role flags for the signed-in user (RBAC). */
    roles: `${API_BASE_URL}/api/auth/roles`
  },
  system: {
    memory: `${API_BASE_URL}/api/system/memory`,
    /** Name of the database this instance is connected to (shown in the footer). */
    database: `${API_BASE_URL}/api/system/database`
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
     * File tree for a server → `LogFilesResponse` `{ mode, paths?, roots? }`.
     * `mode:'full'` (or omitted) returns every path up front; `mode:'lazy'`
     * returns only root folders and the UI loads each folder on expand via
     * {@link dir}. The backend picks the mode from tree size.
     */
    files: (serverId: string) => `${API_BASE_URL}/api/log/files?server=${encodeURIComponent(serverId)}`,
    /**
     * Immediate children of ONE folder (lazy mode) → `LogDirResponse`
     * `{ entries: { name, type, path }[] }`. `path` is the folder's FULL path;
     * the backend must jail it to the server's base paths (reject `..`/outside).
     */
    dir: (serverId: string, path: string) =>
      `${API_BASE_URL}/api/log/dir?server=${encodeURIComponent(serverId)}&path=${encodeURIComponent(path)}`,
    /** Content of a single log file. */
    fileContent: (serverId: string, path: string) =>
      `${API_BASE_URL}/api/log/file?server=${encodeURIComponent(serverId)}&path=${encodeURIComponent(path)}`,
    /** Metadata for a single file (name, type, size, timestamps). */
    fileProperties: (serverId: string, path: string) =>
      `${API_BASE_URL}/api/log/file-properties?server=${encodeURIComponent(serverId)}&path=${encodeURIComponent(path)}`
  },
  config: {
    /**
     * Table catalogue for a scope — returns `TabularData` ({ cols, rows }).
     * The running environment is sent as `?app_env=` so the backend returns the
     * catalogue for this environment. `LIVE` is sent to the API as `PROD` (see
     * {@link apiEnv}).
     */
    tables: (scope: ConfigScope) =>
      `${API_BASE_URL}/api/config/${scope}/tables?app_env=${encodeURIComponent(apiEnv())}`,
    /**
     * Column detail (down-arrow expand). POST { table_name } → `TabularData`
     * `{ cols, rows }`. The nested detail grid renders whatever comes back as-is.
     */
    columnRetrieve: (scope: ConfigScope) => `${API_BASE_URL}/api/config/${scope}/columnretrieve`,
    /** Roll (COB) data for a table over a date range. POST { table_name, from, to }. */
    rollData: (scope: ConfigScope) => `${API_BASE_URL}/api/config/${scope}/roll`,
    /**
     * Table content (eye-click). POST
     * `{ table_name, is_cobdt, start_date, end_date, date_range }` →
     * `TableContentResponse` { cols, cols_data_types, Table_data } (self-describing).
     * `is_cobdt` ('Y'/'N') comes from the catalogue row. When it is 'Y' the two
     * dates are sent (default: T-1 on both; `date_range` false = just those two
     * days, true = the inclusive range between them). When it is 'N' both dates
     * are sent as `null`.
     */
    retrieve: (scope: ConfigScope) => `${API_BASE_URL}/api/config/${scope}/retrieve`,
    /**
     * INSERT rows. Table name in the URL; body = `{ inserted_by, columns, rows }`
     * where `rows` are value arrays in `columns` order. Returns `{ inserted: N }`.
     */
    createRows: (scope: ConfigScope, table: string) =>
      `${API_BASE_URL}/api/config/${scope}/table/${encodeURIComponent(table)}/rows`,
    /**
     * UPDATE rows. Table name in the URL; body = `{ updated_by, updates:
     * [{ rowid, values: { COL: val } }] }` (changed columns only). Returns
     * `{ updated: N }`.
     */
    updateRows: (scope: ConfigScope, table: string) =>
      `${API_BASE_URL}/api/config/${scope}/table/${encodeURIComponent(table)}/update`,
    /**
     * DELETE rows. Table name in the URL; body = `{ deleted_by, rowids: [...] }`.
     * Returns `{ deleted: N }`.
     */
    deleteRows: (scope: ConfigScope, table: string) =>
      `${API_BASE_URL}/api/config/${scope}/table/${encodeURIComponent(table)}/delete`
  },
  infra: {
    /**
     * Configuration rows from `health_Server_Details` for an environment — one
     * call per page load. Returns which servers/shares to monitor and each
     * server's `monitor_config` (disk / infra / services).
     */
    config: (env: AppEnv) => `${API_BASE_URL}/api/infra/config?env=${encodeURIComponent(apiEnv(env))}`,
    /**
     * Collect live readings from a server's agent. POST
     * { hostname, host_platform, host_address, agent_listen_port, monitor_config }.
     * In production this call targets the agent at `host_address:agent_listen_port`.
     */
    agentCollect: `${API_BASE_URL}/api/infra/agent/collect`,
    /**
     * Start/stop a service through the agent. POST
     * { hostname, host_address, agent_listen_port, service, script, action }.
     */
    agentAction: `${API_BASE_URL}/api/infra/agent/action`,
    /** Free space for a share drive (no agent — computed directly). */
    shareSpace: (app: InfraApp, name: string) =>
      `${API_BASE_URL}/api/infra/share?app=${app}&name=${encodeURIComponent(name)}`
  }
} as const;
