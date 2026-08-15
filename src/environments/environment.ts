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
  /** Demo identity for the direct (non-SSO) login / dev mode. Real SSO overrides it. */
  username: string;
  name: string;
  /** Master switch for OpenID Connect / SSO (false → direct login form). */
  isSsoEnabled: boolean;
  /** Preview role flags while `GET /api/auth/roles` is mocked (ignored once real). */
  devRoles: { is_admin: boolean; is_read: boolean; is_salt: boolean };
  /**
   * While `useMock` is true, any request whose path starts with one of these
   * prefixes is sent to the REAL backend (`apiBaseUrl`) instead of the mock —
   * wire endpoints to the live API one prefix at a time, no code change. Empty
   * (or `useMock:false`) → normal behaviour.
   */
  liveApiPrefixes: string[];
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
  username: 'OPS-10432',
  name: 'Alex Morgan',
  isSsoEnabled: false,
  devRoles: { is_admin: true, is_read: false, is_salt: false },
  // Log Analytics + Infrastructure Health are served by the real FastAPI backend;
  // everything else (incl. the Service Console's /api/infra/*) is still mocked.
  // Add more prefixes here as you implement real endpoints.
  liveApiPrefixes: ['/api/log/', '/api/infra_health', '/api/service_console'],
};
