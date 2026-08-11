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
     */
    tables: (scope: ConfigScope) => `${API_BASE_URL}/api/config/${scope}/tables`,
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
  }
} as const;
