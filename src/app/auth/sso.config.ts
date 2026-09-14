/**
 * OpenID Connect / SSO configuration — PER ENVIRONMENT (DEV / STG / PROD).
 *
 * Fill in each environment's identity-provider details below. The correct block is picked
 * automatically from `environment.appEnv` (which is resolved from the browser hostname in
 * `src/environments/environment.ts`), so the SAME built bundle works in DEV, STG and PROD with
 * nothing to swap. Turn SSO on/off per environment with `isSsoEnabled` in `environment.ts`.
 *
 * The app uses the standard Authorization Code + PKCE browser flow — no client secret is stored in
 * the SPA. Most providers expose these values on their discovery document
 * (`<issuer>/.well-known/openid-configuration`).
 *
 * The BACKEND has its own, separate per-server OIDC config (see backend/auth_token.py + each
 * server's backend/.env: OIDC_ISSUER / OIDC_AUDIENCE / OIDC_JWKS_URL / …). Frontend and backend must
 * point at the SAME provider per environment. Full go-live guide: AUTH_SETUP.md.
 */
import { AppEnv, environment } from '../../environments/environment';

export interface SsoConfig {
  /** Issuer / authority base URL. */
  issuer: string;
  /** Authorization endpoint (where the user is sent to sign in). */
  authorizeEndpoint: string;
  /** Token endpoint (code → tokens, and refresh_token → new tokens). */
  tokenEndpoint: string;
  /** End-session endpoint (provider RP-initiated logout — the discovery doc's
   *  `end_session_endpoint`). LEAVE BLANK ('') if your provider does NOT expose one:
   *  logout then simply clears the local session and navigates to `postLogoutRedirectUri`
   *  (the login page) WITHOUT contacting the provider. Do NOT put the Provider Meta
   *  (discovery) URL or a Revocation URL here — neither performs a browser logout. */
  endSessionEndpoint: string;
  /** Public client id registered with the provider. */
  clientId: string;
  /** Redirect URI registered with the provider (must match exactly). */
  redirectUri: string;
  /** Where the provider returns after logout. */
  postLogoutRedirectUri: string;
  /** Requested scopes. Include `openid`; add `offline_access` for refresh tokens. */
  scope: string;
  /** Seconds before token expiry to silently renew (and re-auth leeway). */
  renewLeewaySeconds: number;
  /** App-enforced INACTIVITY timeout, in minutes. This is separate from the token lifetime (which
   *  the IdP owns and the app cannot extend). After this many minutes with no user activity the
   *  app ends the session and returns to /login. 0 disables it. */
  idleTimeoutMinutes: number;
}

/** redirect/logout URIs default to the current origin so they work in any environment once the
 *  provider has them whitelisted. Override per env below if your provider needs fixed absolute URIs. */
const redirectUri = `${window.location.origin}/auth/callback`;
const postLogoutRedirectUri = `${window.location.origin}/login`;

/**
 * ►► EDIT the three blocks with your real provider details per environment. ◄◄
 * Keys are the UI environments (DEV / STG / LIVE = production). The backend's per-server .env must
 * carry the MATCHING OIDC_* values for that same environment.
 */
const SSO_BY_ENV: Record<AppEnv, SsoConfig> = {
  DEV: {
    issuer: 'https://your-openid-provider-dev.example.com',
    authorizeEndpoint: 'https://your-openid-provider-dev.example.com/authorize',
    tokenEndpoint: 'https://your-openid-provider-dev.example.com/oauth2/token',
    endSessionEndpoint: '',   // provider's end_session_endpoint, or '' → local logout to /login
    clientId: 'ols-dashboard-dev',
    redirectUri,
    postLogoutRedirectUri,
    scope: 'openid profile email offline_access',
    renewLeewaySeconds: 60,
    idleTimeoutMinutes: 0          // 0 = no app idle timeout; e.g. 30 = log out after 30 min idle
  },
  STG: {
    issuer: 'https://your-openid-provider-stg.example.com',
    authorizeEndpoint: 'https://your-openid-provider-stg.example.com/authorize',
    tokenEndpoint: 'https://your-openid-provider-stg.example.com/oauth2/token',
    endSessionEndpoint: '',   // provider's end_session_endpoint, or '' → local logout to /login
    clientId: 'ols-dashboard-stg',
    redirectUri,
    postLogoutRedirectUri,
    scope: 'openid profile email offline_access',
    renewLeewaySeconds: 60,
    idleTimeoutMinutes: 0
  },
  LIVE: {
    issuer: 'https://your-openid-provider.example.com',
    authorizeEndpoint: 'https://your-openid-provider.example.com/authorize',
    tokenEndpoint: 'https://your-openid-provider.example.com/oauth2/token',
    endSessionEndpoint: '',   // provider's end_session_endpoint, or '' → local logout to /login
    clientId: 'ols-dashboard',
    redirectUri,
    postLogoutRedirectUri,
    scope: 'openid profile email offline_access',
    renewLeewaySeconds: 60,
    idleTimeoutMinutes: 0
  }
};

/** The active provider config for THIS environment (resolved from the hostname). */
export const SSO_CONFIG: SsoConfig = SSO_BY_ENV[environment.appEnv];
