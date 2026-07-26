/**
 * OpenID Connect / SSO configuration.
 *
 * Fill these in with your identity provider's details, then set
 * `IS_SSO_ENABLED = true` in `src/app/shared/api-endpoints.ts`. The app uses the
 * standard Authorization Code + PKCE browser flow — no client secret is stored in
 * the SPA. Most providers expose these values on their discovery document
 * (`<issuer>/.well-known/openid-configuration`).
 */
export interface SsoConfig {
  /** Issuer / authority base URL. */
  issuer: string;
  /** Authorization endpoint (where the user is sent to sign in). */
  authorizeEndpoint: string;
  /** Token endpoint (code → tokens, and refresh_token → new tokens). */
  tokenEndpoint: string;
  /** End-session endpoint (provider logout). */
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
}

export const SSO_CONFIG: SsoConfig = {
  issuer: 'https://your-openid-provider.example.com',
  authorizeEndpoint: 'https://your-openid-provider.example.com/authorize',
  tokenEndpoint: 'https://your-openid-provider.example.com/oauth2/token',
  endSessionEndpoint: 'https://your-openid-provider.example.com/logout',
  clientId: 'ols-dashboard',
  // These default to the current origin so they work in any environment once the
  // provider has them whitelisted.
  redirectUri: `${window.location.origin}/auth/callback`,
  postLogoutRedirectUri: `${window.location.origin}/login`,
  scope: 'openid profile email offline_access',
  renewLeewaySeconds: 60
};
