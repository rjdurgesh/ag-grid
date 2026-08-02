import { inject, Injectable, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';

import { ApiDataService } from '../shared/api-data.service';
import { API } from '../shared/api-endpoints';
import { environment } from '../../environments/environment';
import { AuthUser, LoginResponse } from '../shared/models';
import { RbacService } from './rbac.service';
import { SsoAuthService, TOKEN_KEY, USER_KEY } from './sso-auth.service';

/** When the current session was established (ISO), shown in the account menu. */
const LOGIN_AT_KEY = 'ols.login_at';

/**
 * Authentication facade used by the guard, interceptor, header and login page.
 *
 * It delegates to {@link SsoAuthService} when `IS_SSO_ENABLED` is true (OpenID
 * Connect), or falls back to the simple direct-login form (mock/basic backend)
 * when it is false. Callers don't need to know which mode is active.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly api = inject(ApiDataService);
  private readonly sso = inject(SsoAuthService);
  private readonly rbac = inject(RbacService);

  /** True when the app is running in OpenID/SSO mode. */
  readonly ssoEnabled = environment.isSsoEnabled;

  /** Current user, kept in sync for the header greeting. */
  readonly user = signal<AuthUser | null>(this.readStoredUser());

  /** Silent-renew-failed signal (SSO only) — the app should route to /login. */
  readonly sessionExpired = this.sso.sessionExpired;

  // --- Direct (non-SSO) login ----------------------------------------------
  login(username: string, password: string): Observable<LoginResponse> {
    return this.api.post<LoginResponse>(API.auth.login, { username, password }).pipe(
      tap((res) => {
        localStorage.setItem(TOKEN_KEY, res.token);
        localStorage.setItem(USER_KEY, JSON.stringify(res.user));
        localStorage.setItem(LOGIN_AT_KEY, new Date().toISOString());
        this.user.set(res.user);
        this.rbac.reset();
      })
    );
  }

  /**
   * Single entry point used by the login button.
   *  - SSO enabled  → redirects to the OIDC provider (this call never returns);
   *    resolves `false` only in the unlikely case the redirect is blocked.
   *  - SSO disabled → establishes a local (bypass) session and resolves `true`
   *    so the caller can navigate onward.
   */
  async signIn(returnUrl = '/home'): Promise<boolean> {
    if (environment.isSsoEnabled) {
      await this.sso.startLogin(returnUrl);
      return false;
    }
    const user: AuthUser = {
      username: environment.username,
      displayName: environment.name,
      email: 'alex.morgan@ols.local',
      role: 'Ops Admin'
    };
    localStorage.setItem(TOKEN_KEY, `dev-bypass.${Date.now()}`);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    localStorage.setItem(LOGIN_AT_KEY, new Date().toISOString());
    this.user.set(user);
    this.rbac.reset();
    return true;
  }

  // --- SSO ------------------------------------------------------------------
  /** Start the OIDC redirect flow. */
  startSsoLogin(returnUrl = '/home'): Promise<void> {
    return this.sso.startLogin(returnUrl);
  }

  /** Complete the OIDC callback; resolves with the URL to navigate to. */
  async completeSsoLogin(): Promise<string> {
    const returnUrl = await this.sso.handleCallback();
    localStorage.setItem(LOGIN_AT_KEY, new Date().toISOString());
    this.user.set(this.sso.user());
    this.rbac.reset();
    return returnUrl;
  }

  /** ISO timestamp of when the current session was established (null if unknown). */
  get loginAt(): string | null {
    return localStorage.getItem(LOGIN_AT_KEY);
  }

  // --- Shared ---------------------------------------------------------------
  isAuthenticated(): boolean {
    return environment.isSsoEnabled ? this.sso.isAuthenticated() : !!localStorage.getItem(TOKEN_KEY);
  }

  get token(): string | null {
    return environment.isSsoEnabled ? this.sso.accessToken : localStorage.getItem(TOKEN_KEY);
  }

  logout(): void {
    this.rbac.reset();
    if (environment.isSsoEnabled) {
      // Clears the session and redirects to the provider end-session → /login,
      // so the next sign-in re-authenticates.
      this.user.set(null);
      this.sso.logout();
      return;
    }
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(LOGIN_AT_KEY);
    this.user.set(null);
  }

  private readStoredUser(): AuthUser | null {
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
}
