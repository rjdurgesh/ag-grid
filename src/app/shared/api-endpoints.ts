/**
 * Central place for every backend URL used by the OLS Dashboard.
 *
 * Nothing else in the app should hardcode a URL — import from here so that
 * pointing the app at a real backend is a one-line change.
 *
 *  - `API_BASE_URL`  : root of the real backend. Swap this for your server.
 *  - `USE_MOCK`      : while `true`, `mockApiInterceptor` answers these routes
 *                      with the canned data in `mock-data.ts`. Set to `false`
 *                      (or remove the interceptor in app.config.ts) once the
 *                      real backend is available.
 */

/** Root URL of the backend. Replace with your real host when ready. */
export const API_BASE_URL = 'https://ols-api.local';

/** When true, requests to the endpoints below are answered by the mock interceptor. */
export const USE_MOCK = true;

/** Environment this tool instance is running in. */
export type AppEnv = 'DEV' | 'STG' | 'PROD';

/**
 * The environment this deployment is running in. It is sent to the Infrastructure
 * Pulse config API so the backend returns only the rows for this environment
 * (health_Server_Details.app_env). **Change this per deployment** (DEV / STG / PROD)
 * — it is the single source of truth for the running environment.
 */
export const APP_ENV: AppEnv = 'DEV';

/**
 * Master switch for OpenID Connect / SSO.
 *  - `true`  → users authenticate against the configured OIDC provider
 *              (see `src/app/auth/sso.config.ts`); tokens auto-renew and expiry
 *              forces re-authentication.
 *  - `false` → SSO is bypassed and the app uses the simple direct login form.
 * Keep it `false` until `SSO_CONFIG` is filled in with your provider details.
 */
export const IS_SSO_ENABLED = false;

/**
 * Local role flags used while the real `GET /api/auth/roles` is not wired
 * (`USE_MOCK = true`). Flip these to preview each access level — admin (all),
 * read (view-only), salt (Home + Config Ops, can act there). Any combination is
 * allowed. Ignored once the real backend returns the user's roles.
 */
export const DEV_ROLES = {
  is_admin: true,
  is_read: false,
  is_salt: false
} as const;

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
    servers: `${API_BASE_URL}/api/log/servers`,
    /** Flat list of file paths for the selected server. */
    files: (serverId: string) => `${API_BASE_URL}/api/log/files?server=${encodeURIComponent(serverId)}`,
    /** Content of a single log file. */
    fileContent: (serverId: string, path: string) =>
      `${API_BASE_URL}/api/log/file?server=${encodeURIComponent(serverId)}&path=${encodeURIComponent(path)}`,
    /** Metadata for a single file (name, type, size, timestamps). */
    fileProperties: (serverId: string, path: string) =>
      `${API_BASE_URL}/api/log/file-properties?server=${encodeURIComponent(serverId)}&path=${encodeURIComponent(path)}`
  },
  config: {
    /** Table catalogue for a scope (cib | group | retail). */
    tables: (scope: ConfigScope) => `${API_BASE_URL}/api/config/${scope}/tables`,
    /** Row content of a single table within a scope. */
    tableContent: (scope: ConfigScope, tableName: string) =>
      `${API_BASE_URL}/api/config/${scope}/table/${encodeURIComponent(tableName)}`,
    /** Roll (COB) data for a table over a date range. POST { table_name, from, to }. */
    rollData: (scope: ConfigScope) => `${API_BASE_URL}/api/config/${scope}/roll`,
    /**
     * Retrieve rows for specific dates. POST { table_name, start, end, range }.
     * `range: false` = the two dates only; `true` = everything between them.
     */
    retrieve: (scope: ConfigScope) => `${API_BASE_URL}/api/config/${scope}/retrieve`,
    /** Insert new rows. POST { table_name, rows }. */
    createRows: (scope: ConfigScope) => `${API_BASE_URL}/api/config/${scope}/rows`
  },
  infra: {
    /**
     * Configuration rows from `health_Server_Details` for an environment — one
     * call per page load. Returns which servers/shares to monitor and each
     * server's `monitor_config` (disk / infra / services).
     */
    config: (env: AppEnv) => `${API_BASE_URL}/api/infra/config?env=${env}`,
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
