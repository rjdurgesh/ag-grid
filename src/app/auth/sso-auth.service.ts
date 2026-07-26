import { Injectable, signal } from '@angular/core';

import { AuthUser } from '../shared/models';
import { SSO_CONFIG } from './sso.config';

/** Shared localStorage keys (also read by the AuthService facade + interceptor). */
export const TOKEN_KEY = 'ols.token';
export const USER_KEY = 'ols.user';
export const EXPIRY_KEY = 'ols.token.exp';
const REFRESH_KEY = 'ols.refresh';
const PKCE_KEY = 'ols.pkce';

interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

/**
 * OpenID Connect engine — Authorization Code + PKCE, dependency-free.
 *
 * Handles the redirect login, code exchange, silent renew before token expiry,
 * and provider logout. It only runs when `IS_SSO_ENABLED` is true (the
 * {@link AuthService} facade decides). Configure it in {@link SSO_CONFIG}.
 */
@Injectable({ providedIn: 'root' })
export class SsoAuthService {
  readonly user = signal<AuthUser | null>(readUser());
  /** Set true when a silent renew fails — the app should send the user to /login. */
  readonly sessionExpired = signal(false);

  private renewTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    // Resume the renew schedule after a page reload.
    const expiry = Number(localStorage.getItem(EXPIRY_KEY) ?? 0);
    if (this.accessToken && expiry) {
      this.scheduleRenew(expiry);
    }
  }

  get accessToken(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  }

  isAuthenticated(): boolean {
    if (!this.accessToken) {
      return false;
    }
    const expiry = Number(localStorage.getItem(EXPIRY_KEY) ?? 0);
    return expiry === 0 || Date.now() < expiry;
  }

  /** Begin the OIDC flow — redirects the browser to the provider. */
  async startLogin(returnUrl = '/home'): Promise<void> {
    const state = randomString(32);
    const nonce = randomString(32);
    const verifier = randomString(64);
    const challenge = await pkceChallenge(verifier);
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ state, nonce, verifier, returnUrl }));

    const params = new URLSearchParams({
      client_id: SSO_CONFIG.clientId,
      redirect_uri: SSO_CONFIG.redirectUri,
      response_type: 'code',
      scope: SSO_CONFIG.scope,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    });
    window.location.assign(`${SSO_CONFIG.authorizeEndpoint}?${params.toString()}`);
  }

  /** Handle the provider redirect back and exchange the code. Returns the return URL. */
  async handleCallback(): Promise<string> {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const stored = JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? '{}') as {
      state?: string;
      verifier?: string;
      returnUrl?: string;
    };
    sessionStorage.removeItem(PKCE_KEY);

    if (!code || !state || state !== stored.state || !stored.verifier) {
      throw new Error('Invalid SSO callback (state/code mismatch).');
    }
    await this.exchangeCode(code, stored.verifier);
    return stored.returnUrl || '/home';
  }

  /** Silent renew via refresh token; marks the session expired on failure. */
  async renew(): Promise<boolean> {
    const refresh = localStorage.getItem(REFRESH_KEY);
    if (!refresh) {
      this.fail();
      return false;
    }
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: SSO_CONFIG.clientId,
        scope: SSO_CONFIG.scope
      });
      const res = await fetch(SSO_CONFIG.tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
      });
      if (!res.ok) {
        throw new Error(`renew ${res.status}`);
      }
      this.storeTokens(await res.json());
      return true;
    } catch {
      this.fail();
      return false;
    }
  }

  /** Clear the session and redirect to the provider's end-session endpoint. */
  logout(): void {
    this.clear();
    const params = new URLSearchParams({
      client_id: SSO_CONFIG.clientId,
      post_logout_redirect_uri: SSO_CONFIG.postLogoutRedirectUri
    });
    window.location.assign(`${SSO_CONFIG.endSessionEndpoint}?${params.toString()}`);
  }

  private async exchangeCode(code: string, verifier: string): Promise<void> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: SSO_CONFIG.redirectUri,
      client_id: SSO_CONFIG.clientId,
      code_verifier: verifier
    });
    const res = await fetch(SSO_CONFIG.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!res.ok) {
      throw new Error(`Token exchange failed: ${res.status}`);
    }
    this.storeTokens(await res.json());
  }

  private storeTokens(tok: TokenResponse): void {
    localStorage.setItem(TOKEN_KEY, tok.access_token);
    if (tok.refresh_token) {
      localStorage.setItem(REFRESH_KEY, tok.refresh_token);
    }
    const expiry = Date.now() + (tok.expires_in ? Number(tok.expires_in) : 3600) * 1000;
    localStorage.setItem(EXPIRY_KEY, String(expiry));

    const claims = tok.id_token ? decodeJwt(tok.id_token) : {};
    // OpenID returns UID (sub), full name and email.
    const user: AuthUser = {
      username: String(claims['sub'] ?? claims['preferred_username'] ?? 'user'),
      displayName: String(claims['name'] ?? claims['preferred_username'] ?? 'User'),
      email: claims['email'] ? String(claims['email']) : undefined,
      role: String((Array.isArray(claims['roles']) ? claims['roles'][0] : claims['role']) ?? 'Operator')
    };
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    this.user.set(user);
    this.sessionExpired.set(false);
    this.scheduleRenew(expiry);
  }

  private scheduleRenew(expiry: number): void {
    if (this.renewTimer) {
      clearTimeout(this.renewTimer);
    }
    const delay = Math.max(0, expiry - Date.now() - SSO_CONFIG.renewLeewaySeconds * 1000);
    this.renewTimer = setTimeout(() => this.renew(), delay);
  }

  private fail(): void {
    this.clear();
    this.sessionExpired.set(true);
  }

  private clear(): void {
    [TOKEN_KEY, USER_KEY, EXPIRY_KEY, REFRESH_KEY].forEach((k) => localStorage.removeItem(k));
    if (this.renewTimer) {
      clearTimeout(this.renewTimer);
    }
    this.user.set(null);
  }
}

// ---------------------------------------------------------------------------
// PKCE + JWT helpers (dependency-free)
// ---------------------------------------------------------------------------

function readUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

function randomString(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) {
    str += String.fromCharCode(b);
  }
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeJwt(token: string): Record<string, unknown> {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(payload)))) as Record<string, unknown>;
  } catch {
    return {};
  }
}
