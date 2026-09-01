/**
 * Global application configuration — the ONE place to change per deployment.
 *
 * Everything here is app/runtime config (not API endpoint URLs — those live in
 * `shared/api-endpoints.ts`, which reads `apiBaseUrl` from here). Point the app at
 * a real backend, switch environment, toggle the mock, etc. all from this file.
 */

/** Environment this tool instance runs in — as configured & displayed. */
export type AppEnv = 'DEV' | 'STG' | 'LIVE';

/** Environment label as the BACKEND knows it — the UI's `LIVE` is the API's `PROD`. */
export type ApiEnv = 'DEV' | 'STG' | 'PROD';

export interface AppEnvironment {
  production: boolean;
  /** UI version shown in the footer. Bump this on each frontend release. */
  uiVersion: string;
  /** true → the in-app mock answers APIs; false → every call hits the real backend. */
  useMock: boolean;
  /** Root of the backend. Every endpoint in api-endpoints.ts is built from this. */
  apiBaseUrl: string;
  /** Running environment (header pill; `LIVE` is sent to APIs as `PROD`). */
  appEnv: AppEnv;
  /** Where the error-popup "Email" button sends reports. */
  supportEmail: string;
  /** Default auto-refresh cadence (minutes) for the Infrastructure Health screen. */
  infraHealthRefreshMinutes: number;
  /** Default auto-refresh cadence (minutes) for the Service Console screen. */
  serviceConsoleRefreshMinutes: number;
  /** Default auto-refresh cadence (minutes) for the Oracle Command Center screen. */
  oracleCommandCenterRefreshMinutes: number;
  /** Demo identity for the direct (non-SSO) login / dev mode. Real SSO overrides it. */
  username: string;
  name: string;
  /** Master switch for OpenID Connect / SSO (false → direct login form). */
  isSsoEnabled: boolean;
  /**
   * Preview role flags while `GET /api/auth/roles` is mocked (ignored once real).
   * `label` sets the role value returned with the access level (e.g. `OMT-BOTH`,
   * `OMT-TECHNICAL`, `OMT-FUNCTIONAL`) — used to exercise the technical-action gate
   * (ADMIN + OMT-TECHNICAL/OMT-BOTH → can kill / start / stop; else view-only).
   */
  devRoles: { is_admin: boolean; is_read: boolean; is_salt: boolean; label?: string };
  /** Dev-only access-scenario override for on-screen validation (mock mode). '' → use devRoles. */
  devScenario: string;
  /**
   * Per-screen mock control — the flexible alternative to the single global switch. Maps each
   * screen's API path-prefix to whether that screen is MOCKED (`true` → in-app dummy data) or
   * LIVE (`false` → real backend at `apiBaseUrl`). A request is matched to the LONGEST prefix
   * it starts with and uses that flag; anything not listed falls back to the global `useMock`.
   * So you can build/test one screen against the real backend while the rest stay on mock data
   * (or vice-versa) — flip one entry without disturbing the others.
   */
  apiMocks: Record<string, boolean>;
}

// ---------------------------------------------------------------------------
// Runtime environment resolution — ONE build runs in DEV / STG / PROD.
//
// The app decides which environment it is from the BROWSER HOSTNAME, so the SAME built bundle
// deploys to all three with NO per-env build and NOTHING to swap. The API is same-origin:
// `ui_server.py` serves the UI and proxies `/api/*` to that env's backend, so the app just calls
// `/api/...` (no cross-origin URL to configure). Local dev (`ng serve` on localhost) is the only
// special case — it talks to the FastAPI backend on :8000 and uses the in-app mock.
//
//   ►► EDIT `ENV_BY_HOST` below with your real hostnames. ◄◄
// ---------------------------------------------------------------------------
const HOST = (typeof window !== 'undefined' && window.location ? window.location.hostname : '').toLowerCase();
const IS_LOCAL = HOST === 'localhost' || HOST === '127.0.0.1' || HOST === '';

/** hostname substring → environment (first match wins; unknown host → PROD). Substring match so
 *  `www.`, bare domain and any sub-domain all resolve. */
const ENV_BY_HOST: ReadonlyArray<readonly [string, AppEnv]> = [
  ['abc.dev.com', 'DEV'],
  ['abc.stg.com', 'STG'],
  ['abc.group.com', 'LIVE'],   // production
];

/**
 * BACKUP override — force the environment regardless of hostname. Use only when a host can't be
 * matched by `ENV_BY_HOST` (normally leave empty). Two ways, both optional:
 *   1. Set `FORCE_ENV` to 'DEV' | 'STG' | 'LIVE' (baked into this build — makes it env-specific).
 *   2. Have the deployment drop `<script>window.__OLS_ENV__='STG'</script>` into the served
 *      `index.html` — no rebuild, keeps one bundle. This wins over `FORCE_ENV`, which wins over
 *      hostname detection.
 */
const FORCE_ENV: '' | AppEnv = '';

function forcedEnv(): AppEnv | '' {
  const injected = (typeof window !== 'undefined'
    ? (window as unknown as { __OLS_ENV__?: string }).__OLS_ENV__ : '') || '';
  const v = String(injected || FORCE_ENV || '').toUpperCase();
  return (v === 'DEV' || v === 'STG' || v === 'LIVE') ? (v as AppEnv) : '';
}

function detectEnv(host: string): AppEnv {
  for (const [match, env] of ENV_BY_HOST) {
    if (host.includes(match)) {
      return env;
    }
  }
  return 'LIVE';                // unknown host → assume PROD (safest: real backend, no mock)
}

// Priority: explicit override → localhost (dev) → hostname detection.
const RESOLVED_ENV: AppEnv = forcedEnv() || (IS_LOCAL ? 'DEV' : detectEnv(HOST));
/** Deployed → '' = same-origin (ui_server proxies /api to this env's backend). Local → :8000. */
const RESOLVED_API_BASE = IS_LOCAL ? 'http://localhost:8000' : '';

export const environment: AppEnvironment = {
  production: !IS_LOCAL,
  // Bump on each UI release — shown in the footer as "UI v…".
  uiVersion: '1.0.0',
  // Mock ONLY in local dev; every deployed env hits the real backend (same-origin via ui_server).
  useMock: IS_LOCAL,
  // Same-origin when deployed ('' → calls go to /api/… which ui_server proxies); :8000 locally.
  apiBaseUrl: RESOLVED_API_BASE,
  appEnv: RESOLVED_ENV,
  supportEmail: 'abc@gmail.com',
  // Auto-refresh cadence (minutes) for the two monitoring screens. Must be one of the
  // dropdown options offered on each page (5 / 10 / 15 / 30).
  infraHealthRefreshMinutes: 30,
  serviceConsoleRefreshMinutes: 30,
  oracleCommandCenterRefreshMinutes: 30,
  username: 'OPS-10432',
  name: 'Alex Morgan',
  isSsoEnabled: false,
  devRoles: { is_admin: true, is_read: false, is_salt: false, label: 'OMT-BOTH' },
  /**
   * Dev-only: force a specific ACCESS SCENARIO so you can validate on screen exactly what each kind
   * of user sees (mock mode only). Empty '' → use `devRoles` as before. You can also switch WITHOUT
   * rebuilding by running in the browser console:
   *   localStorage.setItem('ols.devScenario','defaults_only'); location.reload();
   *   localStorage.removeItem('ols.devScenario'); location.reload();   // back to devRoles
   * Scenarios (see mock-api.interceptor DEV_SCENARIOS): 'admin' | 'defaults_only' | 'not_provisioned'
   * | 'config_group_cib' | 'occ_group_write' | 'service_console' | 'ops_admin' | 'sql_studio'
   * | 'config_{cib,group,retail}_only' | 'config_{cib,group,retail}_readonly'
   * | 'docs_user_only' | 'docs_technical_only'  (Documentation: one guide granted; defaults_only = none).
   */
  devScenario: '' as string,
  // Per-screen mock switches — LOCAL DEV ONLY (deployed envs never mock, so this is {} there).
  // Override the global `useMock` for that screen's API prefix: false = hit the real FastAPI
  // backend on :8000; true = in-app mock. Flip a single screen to develop/test it in isolation.
  apiMocks: IS_LOCAL ? {
    '/api/log/':            false, // Log Analytics Hub       → live backend
    '/api/infra_health':    false, // Infrastructure Health   → live backend
    '/api/service_console': false, // Service Console         → live backend
    '/api/oracle_cc':       false, // Oracle Command Center   → live backend
    '/api/config':          true,  // Config Ops Console      → in-app mock
    '/api/docs':            false, // Documentation Center    → live backend (real .md files from base_dir)
  } : {},
};
