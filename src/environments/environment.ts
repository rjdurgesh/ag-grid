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

export const environment: AppEnvironment = {
  production: false,
  useMock: true,
  // Points at the FastAPI backend (backend/). Change for your host.
  apiBaseUrl: 'http://localhost:8000',
  appEnv: 'DEV',
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
  // Per-screen mock switches — override the global `useMock` above for that screen's API
  // prefix. false = hit the real FastAPI backend; true = in-app mock. Anything not listed
  // here falls back to `useMock`. Flip a single screen to develop/test it in isolation.
  apiMocks: {
    '/api/log/':            false, // Log Analytics Hub       → live backend
    '/api/infra_health':    false, // Infrastructure Health   → live backend
    '/api/service_console': false, // Service Console         → live backend
    '/api/oracle_cc':       false, // Oracle Command Center   → live backend
    '/api/config':          true,  // Config Ops Console      → in-app mock
  },
};
