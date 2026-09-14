# OIDC / SSO Integration Guide — Angular + FastAPI **or** Flask (portable)

A **self-contained, copy-ready** recipe for adding OpenID Connect (Authorization Code + PKCE) sign-in
to *any* Angular SPA with a Python backend. The **frontend is identical** regardless of backend
framework — pick your backend section: **[§3 FastAPI](#3-backend-fastapi--verify-the-token)** or
**[§3-Flask](#3-flask-backend-flask--verify-the-token)**. It's the generalised version of this repo's
[`AUTH_SETUP.md`](AUTH_SETUP.md) (which is specific to the OLS Dashboard) — use **this** file when
standing OIDC up on a **new** project.

- **No frontend dependencies** — PKCE, JWT-decode and silent renew are hand-rolled with Web Crypto +
  `fetch` (nothing from npm to add).
- **Backend** uses `PyJWT[crypto]` to verify the token against the provider's JWKS — **FastAPI** (§3)
  and **Flask** (§3-Flask) versions provided; the config loading + validation logic is shared.
- **Two independent switches** (frontend `isSsoEnabled`, backend `validate_token`) so you can develop
  with a bypass and flip to real SSO per environment.

---

## 0. How it fits together

```
Browser (Angular SPA)              Identity Provider (IdP)            Backend (FastAPI)
─────────────────────              ──────────────────────            ─────────────────
click "Sign in"
  └─ redirect /authorize?code_challenge=… ─────► login page
                                     user authenticates
      ◄──── redirect /auth/callback?code=… ──────┘
  POST /token (code + PKCE verifier) ──────────► token endpoint
      ◄──────── access_token (+ id_token + refresh_token)
  store tokens in localStorage
  every API call: Authorization: Bearer <access_token> ────────────► verify signature (JWKS) + iss/aud/exp
      ◄──────────────────────────────────────────────────────────── 200 (or 401 if invalid)
  before expiry: silent refresh (refresh_token grant) — no redirect
  on a 401:      silent refresh, then retry the request — no redirect
```

Key idea: the **frontend proves identity and carries a bearer token**; the **backend only verifies**
it. The frontend needs the *client + browser-facing endpoints*; the backend needs the *issuer + JWKS*.

---

## 1. Prerequisites — register the app with your IdP

Create a **public / SPA client**: Authorization Code + PKCE, **no client secret**. Record:

| You need | Goes to | Notes |
|---|---|---|
| **Issuer** | frontend `issuer` + backend `issuer` | base URL; the discovery doc lives at `<issuer>/.well-known/openid-configuration` |
| **Authorization endpoint** | frontend `authorizeEndpoint` | from discovery `authorization_endpoint` |
| **Token endpoint** | frontend `tokenEndpoint` | from discovery `token_endpoint` |
| **JWKS URL** | backend `jwks_url` | from discovery `jwks_uri` |
| **Client ID** | frontend `clientId` + backend `audience` (usually) | public |
| **Redirect URI** | registered at the IdP | must match **exactly** — the SPA uses `<origin>/auth/callback` |
| **Post-logout redirect URI** | registered at the IdP | `<origin>/login` (only if the IdP supports RP logout) |
| **Scopes** | frontend `scope` | `openid profile email offline_access` (`offline_access` = refresh token for silent renew) |
| **end_session_endpoint** | frontend `endSessionEndpoint` (optional) | from discovery; **blank if the IdP has none** → app does local logout |

> **issuer** = the discovery URL minus `/.well-known/openid-configuration`. Copy the exact `"issuer"`
> value from the discovery JSON — it must match the token's `iss` (trailing slash included).

---

## 2. Frontend (Angular) — the files to add

All under `src/app/auth/`. Copy them as-is; the only per-project edits are the config block (§2.1)
and wiring (§2.7–2.8).

### 2.1 `sso.config.ts` — per-environment provider config

```ts
import { AppEnv, environment } from '../../environments/environment';

export interface SsoConfig {
  issuer: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  /** Provider RP-logout endpoint. Leave '' if the IdP has none → logout goes to /login locally. */
  endSessionEndpoint: string;
  clientId: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  scope: string;
  /** Seconds before token expiry to silently renew. */
  renewLeewaySeconds: number;
  /** App-enforced inactivity timeout (minutes); 0 = off. Separate from the token lifetime. */
  idleTimeoutMinutes: number;
}

// Derived from the current origin so each deployment just registers its own callback with the IdP.
const redirectUri = `${window.location.origin}/auth/callback`;
const postLogoutRedirectUri = `${window.location.origin}/login`;

const SSO_BY_ENV: Record<AppEnv, SsoConfig> = {
  DEV: {
    issuer: 'https://login-dev.yourbank.com',
    authorizeEndpoint: 'https://login-dev.yourbank.com/authorize',
    tokenEndpoint: 'https://login-dev.yourbank.com/oauth2/token',
    endSessionEndpoint: '',            // set the IdP's end_session_endpoint, or '' for local logout
    clientId: 'my-app-dev',
    redirectUri,
    postLogoutRedirectUri,
    scope: 'openid profile email offline_access',
    renewLeewaySeconds: 60,
    idleTimeoutMinutes: 0
  },
  STG:  { /* …same shape, STG values… */ } as SsoConfig,
  LIVE: { /* …same shape, PROD values… */ } as SsoConfig
};

/** Active config for THIS environment (resolved from the hostname in environment.ts). */
export const SSO_CONFIG: SsoConfig = SSO_BY_ENV[environment.appEnv];
```

> If your project has no per-env `AppEnv`, replace `SSO_BY_ENV[environment.appEnv]` with a single
> `SsoConfig` object.

### 2.2 `sso-auth.service.ts` — the OIDC engine (PKCE, exchange, silent renew, logout)

```ts
import { Injectable, signal } from '@angular/core';
import { AuthUser } from '../shared/models';      // { username, displayName, email?, role }
import { SSO_CONFIG } from './sso.config';

export const TOKEN_KEY = 'app.token';
export const USER_KEY = 'app.user';
export const EXPIRY_KEY = 'app.token.exp';
const REFRESH_KEY = 'app.refresh';
const PKCE_KEY = 'app.pkce';

interface TokenResponse { access_token: string; id_token?: string; refresh_token?: string; expires_in?: number; }

@Injectable({ providedIn: 'root' })
export class SsoAuthService {
  readonly user = signal<AuthUser | null>(readUser());
  readonly sessionExpired = signal(false);

  private renewTimer?: ReturnType<typeof setTimeout>;
  private renewInFlight?: Promise<boolean>;      // dedupe concurrent renews (e.g. many 401s at once)

  constructor() {
    const expiry = Number(localStorage.getItem(EXPIRY_KEY) ?? 0);
    if (this.accessToken && expiry) { this.scheduleRenew(expiry); }
  }

  get accessToken(): string | null { return localStorage.getItem(TOKEN_KEY); }

  isAuthenticated(): boolean {
    if (!this.accessToken) { return false; }
    const expiry = Number(localStorage.getItem(EXPIRY_KEY) ?? 0);
    return expiry === 0 || Date.now() < expiry;
  }

  /** Begin the OIDC redirect flow. */
  async startLogin(returnUrl = '/'): Promise<void> {
    const state = randomString(32), nonce = randomString(32), verifier = randomString(64);
    const challenge = await pkceChallenge(verifier);
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ state, nonce, verifier, returnUrl }));
    const params = new URLSearchParams({
      client_id: SSO_CONFIG.clientId, redirect_uri: SSO_CONFIG.redirectUri,
      response_type: 'code', scope: SSO_CONFIG.scope, state, nonce,
      code_challenge: challenge, code_challenge_method: 'S256'
    });
    window.location.assign(`${SSO_CONFIG.authorizeEndpoint}?${params.toString()}`);
  }

  /** Handle the redirect back; exchange code → tokens. Returns the return URL. */
  async handleCallback(): Promise<string> {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code'), state = url.searchParams.get('state');
    const stored = JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? '{}') as
      { state?: string; verifier?: string; returnUrl?: string };
    sessionStorage.removeItem(PKCE_KEY);
    if (!code || !state || state !== stored.state || !stored.verifier) {
      throw new Error('Invalid SSO callback (state/code mismatch).');
    }
    await this.exchangeCode(code, stored.verifier);
    return stored.returnUrl || '/';
  }

  /** Silent renew via refresh token. Deduped: concurrent callers share one refresh request. */
  renew(): Promise<boolean> {
    return (this.renewInFlight ??= this.performRenew().finally(() => { this.renewInFlight = undefined; }));
  }

  private async performRenew(): Promise<boolean> {
    const refresh = localStorage.getItem(REFRESH_KEY);
    if (!refresh) { this.fail(); return false; }
    try {
      const body = new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: refresh,
        client_id: SSO_CONFIG.clientId, scope: SSO_CONFIG.scope
      });
      const res = await fetch(SSO_CONFIG.tokenEndpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
      });
      if (!res.ok) { throw new Error(`renew ${res.status}`); }
      this.storeTokens(await res.json());
      return true;
    } catch { this.fail(); return false; }
  }

  /** Clear the session; log out at the provider if it has an end-session endpoint, else go to /login. */
  logout(): void {
    this.clear();
    const end = (SSO_CONFIG.endSessionEndpoint || '').trim();
    if (!end) { window.location.assign(SSO_CONFIG.postLogoutRedirectUri); return; }
    const params = new URLSearchParams({
      client_id: SSO_CONFIG.clientId, post_logout_redirect_uri: SSO_CONFIG.postLogoutRedirectUri
    });
    window.location.assign(`${end}?${params.toString()}`);
  }

  private async exchangeCode(code: string, verifier: string): Promise<void> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: SSO_CONFIG.redirectUri,
      client_id: SSO_CONFIG.clientId, code_verifier: verifier
    });
    const res = await fetch(SSO_CONFIG.tokenEndpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
    });
    if (!res.ok) { throw new Error(`Token exchange failed: ${res.status}`); }
    this.storeTokens(await res.json());
  }

  private storeTokens(tok: TokenResponse): void {
    localStorage.setItem(TOKEN_KEY, tok.access_token);
    if (tok.refresh_token) { localStorage.setItem(REFRESH_KEY, tok.refresh_token); }
    const expiry = Date.now() + (tok.expires_in ? Number(tok.expires_in) : 3600) * 1000;
    localStorage.setItem(EXPIRY_KEY, String(expiry));
    const claims = tok.id_token ? decodeJwt(tok.id_token) : {};
    const user: AuthUser = {
      username: String(claims['sub'] ?? claims['preferred_username'] ?? 'user'),
      displayName: String(claims['name'] ?? claims['preferred_username'] ?? 'User'),
      email: claims['email'] ? String(claims['email']) : undefined,
      role: String((Array.isArray(claims['roles']) ? claims['roles'][0] : claims['role']) ?? 'User')
    };
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    this.user.set(user);
    this.sessionExpired.set(false);
    this.scheduleRenew(expiry);
  }

  private scheduleRenew(expiry: number): void {
    if (this.renewTimer) { clearTimeout(this.renewTimer); }
    const delay = Math.max(0, expiry - Date.now() - SSO_CONFIG.renewLeewaySeconds * 1000);
    this.renewTimer = setTimeout(() => this.renew(), delay);
  }

  private fail(): void { this.clear(); this.sessionExpired.set(true); }
  private clear(): void {
    [TOKEN_KEY, USER_KEY, EXPIRY_KEY, REFRESH_KEY].forEach((k) => localStorage.removeItem(k));
    if (this.renewTimer) { clearTimeout(this.renewTimer); }
    this.user.set(null);
  }
}

// --- dependency-free PKCE + JWT helpers -----------------------------------
function readUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY);
  try { return raw ? JSON.parse(raw) as AuthUser : null; } catch { return null; }
}
function randomString(n: number): string {
  const b = new Uint8Array(n); crypto.getRandomValues(b);
  return Array.from(b, (x) => ('0' + (x & 0xff).toString(16)).slice(-2)).join('');
}
async function pkceChallenge(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(d));
}
function base64Url(bytes: Uint8Array): string {
  let s = ''; for (const b of bytes) { s += String.fromCharCode(b); }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeJwt(token: string): Record<string, unknown> {
  try {
    const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(p)))) as Record<string, unknown>;
  } catch { return {}; }
}
```

### 2.3 `auth.service.ts` — the facade (SSO vs bypass)

A thin wrapper the rest of the app talks to. Swap SSO on/off via `environment.isSsoEnabled`; when off,
it establishes a local dev session so you can build without an IdP.

```ts
import { inject, Injectable, signal } from '@angular/core';
import { environment } from '../../environments/environment';
import { AuthUser } from '../shared/models';
import { SsoAuthService, TOKEN_KEY, USER_KEY } from './sso-auth.service';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly sso = inject(SsoAuthService);
  readonly ssoEnabled = environment.isSsoEnabled;
  readonly user = signal<AuthUser | null>(this.readStoredUser());

  /** Login button entry point. SSO → provider redirect; bypass → local session. */
  async signIn(returnUrl = '/'): Promise<boolean> {
    if (environment.isSsoEnabled) { await this.sso.startLogin(returnUrl); return false; }
    const user: AuthUser = { username: environment.username, displayName: environment.name, role: 'User' };
    localStorage.setItem(TOKEN_KEY, `dev-bypass.${Date.now()}`);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    this.user.set(user);
    return true;
  }

  /** Complete the OIDC callback; returns the URL to navigate to. */
  async completeSsoLogin(): Promise<string> {
    const url = await this.sso.handleCallback();
    this.user.set(this.sso.user());
    return url;
  }

  isAuthenticated(): boolean {
    return environment.isSsoEnabled ? this.sso.isAuthenticated() : !!localStorage.getItem(TOKEN_KEY);
  }
  get token(): string | null {
    return environment.isSsoEnabled ? this.sso.accessToken : localStorage.getItem(TOKEN_KEY);
  }
  /** Silent renewal used by the 401 interceptor. No-op when SSO is off. */
  tryRenew(): Promise<boolean> {
    return environment.isSsoEnabled ? this.sso.renew() : Promise.resolve(false);
  }
  logout(): void {
    if (environment.isSsoEnabled) { this.user.set(null); this.sso.logout(); return; }
    [TOKEN_KEY, USER_KEY].forEach((k) => localStorage.removeItem(k));
    this.user.set(null);
  }

  private readStoredUser(): AuthUser | null {
    const raw = localStorage.getItem(USER_KEY);
    try { return raw ? JSON.parse(raw) as AuthUser : null; } catch { return null; }
  }
}
```

### 2.4 `auth.interceptor.ts` — bearer token + silent re-auth on 401

```ts
import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { AuthService } from './auth.service';

const RETRY_HEADER = 'X-Auth-Retry';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const token = auth.token;
  const authed = token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

  return next(authed).pipe(
    catchError((err: unknown) => {
      // 401 under SSO → renew once and retry the SAME request on the SAME page.
      if (!(err instanceof HttpErrorResponse) || err.status !== 401
          || !auth.ssoEnabled || req.headers.has(RETRY_HEADER)) {
        return throwError(() => err);
      }
      return from(auth.tryRenew()).pipe(
        switchMap((ok) => {
          if (!ok) { router.navigate(['/login']); return throwError(() => err); }
          const retried = req.clone({
            setHeaders: { Authorization: `Bearer ${auth.token}`, [RETRY_HEADER]: '1' }
          });
          return next(retried);
        })
      );
    })
  );
};
```

### 2.5 `sso-callback.component.ts` — the `/auth/callback` landing page

```ts
import { Component, inject, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from './auth.service';

@Component({
  selector: 'app-sso-callback',
  template: `<p style="padding:2rem;text-align:center">{{ message() }}</p>`
})
export class SsoCallbackComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly message = signal('Completing secure sign-in…');

  async ngOnInit(): Promise<void> {
    try {
      const returnUrl = await this.auth.completeSsoLogin();
      await this.router.navigateByUrl(returnUrl);
    } catch {
      this.message.set('Sign-in could not be completed. Redirecting…');
      await this.router.navigate(['/login']);
    }
  }
}
```

### 2.6 `auth.guard.ts` — protect the authenticated shell

```ts
import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (auth.isAuthenticated()) { return true; }
  return router.createUrlTree(['/login'], { queryParams: { redirect: state.url } });
};
```

### 2.7 Wire the routes — `app.routes.ts`

```ts
export const routes: Routes = [
  { path: '', canActivate: [authGuard],
    loadComponent: () => import('./layout').then((m) => m.DefaultLayoutComponent),
    children: [ /* …your protected routes… */ ] },
  { path: 'login',
    loadComponent: () => import('./views/login/login.component').then((m) => m.LoginComponent) },
  { path: 'auth/callback',                                  // ← the OIDC redirect landing
    loadComponent: () => import('./auth/sso-callback.component').then((m) => m.SsoCallbackComponent) },
];
```

### 2.8 Register the interceptor — `app.config.ts`

```ts
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { authInterceptor } from './auth/auth.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideHttpClient(withInterceptors([authInterceptor])),
    // …
  ]
};
```

### 2.9 The login button

```ts
// in your LoginComponent
constructor(private auth: AuthService, private router: Router) {}
async onSignIn() {
  const ok = await this.auth.signIn(this.redirect ?? '/');
  if (ok) { this.router.navigateByUrl(this.redirect ?? '/'); }   // ok is false in SSO mode (redirecting)
}
```

### 2.10 Enable it — `environment.ts`

```ts
export interface AppEnvConfig { appEnv: AppEnv; isSsoEnabled: boolean; username: string; name: string; /* … */ }
const SSO_ENABLED_BY_ENV: Record<AppEnv, boolean> = { DEV: false, STG: true, LIVE: true };
export const environment: AppEnvConfig = {
  appEnv: RESOLVED_ENV,
  isSsoEnabled: SSO_ENABLED_BY_ENV[RESOLVED_ENV],   // ← the on/off switch, per env
  username: 'devuser', name: 'Dev User',
};
```

> `isSsoEnabled` is compile-time — **rebuild** after changing it.

---

## 3. Backend (FastAPI) — verify the token

### 3.1 Dependency

```
# requirements.txt
PyJWT[crypto]>=2.8,<3.0
```

### 3.2 `auth_token.py` — the validator dependency

A FastAPI dependency that verifies the bearer JWT against the IdP's JWKS and `iss`/`aud`/`exp`, and
returns the username claim. Config comes from a per-env YAML (§3.3) with env-var overrides; everything
is read once at import (restart after changes). It imports `jwt` **lazily**, so the app still runs with
`validate_token: false` and no PyJWT installed.

```python
"""OIDC access-token validation — verify Authorization: Bearer <jwt> and return the caller username."""
from __future__ import annotations
import os
from pathlib import Path
from fastapi import HTTPException, Request

_APP_ENV = os.getenv("APP_ENV", "PROD").strip().lower()

def _load_oidc_section() -> dict:
    path = Path(os.getenv("OIDC_CONFIG_FILE", str(Path(__file__).parent / "config" / "oidc_config.yml")))
    if not path.is_file():
        return {}
    try:
        import yaml
    except Exception:
        return {}
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}
    section = data.get(_APP_ENV) or data.get(_APP_ENV.upper()) or {}
    return section if isinstance(section, dict) else {}

_OIDC = _load_oidc_section()

def _cfg_str(env_key, yaml_key, default=""):
    v = os.getenv(env_key)
    if v and v.strip():
        return v.strip()
    yv = _OIDC.get(yaml_key)
    return str(yv).strip() if yv is not None and str(yv).strip() else default

def _cfg_bool(env_key, yaml_key, default=False):
    v = os.getenv(env_key)
    if v and v.strip():
        return v.strip().lower() in ("1", "true", "yes", "on")
    yv = _OIDC.get(yaml_key)
    if isinstance(yv, bool):
        return yv
    return str(yv).strip().lower() in ("1", "true", "yes", "on") if yv is not None and str(yv).strip() else default

def _cfg_list(env_key, yaml_key, default):
    v = os.getenv(env_key)
    if v and v.strip():
        return [x.strip() for x in v.split(",") if x.strip()]
    yv = _OIDC.get(yaml_key)
    if isinstance(yv, (list, tuple)):
        return [str(x).strip() for x in yv if str(x).strip()]
    return list(default)

AUTH_VALIDATE_TOKEN = _cfg_bool("AUTH_VALIDATE_TOKEN", "validate_token", False)  # THE on/off switch
AUTH_DEV_USER       = _cfg_str("AUTH_DEV_USER", "dev_user", "")                  # fixed UID when OIDC off
OIDC_ISSUER         = _cfg_str("OIDC_ISSUER", "issuer", "")
OIDC_AUDIENCE       = _cfg_list("OIDC_AUDIENCE", "audience", [])
OIDC_JWKS_URL       = _cfg_str("OIDC_JWKS_URL", "jwks_url", "") or (
    f"{OIDC_ISSUER.rstrip('/')}/.well-known/jwks.json" if OIDC_ISSUER else "")
OIDC_USERNAME_CLAIM = _cfg_str("OIDC_USERNAME_CLAIM", "username_claim", "preferred_username") or "preferred_username"
OIDC_ALGORITHMS     = _cfg_list("OIDC_ALGORITHMS", "algorithms", ["RS256"])
OIDC_LEEWAY         = int(_cfg_str("OIDC_LEEWAY", "leeway", "30") or 30)

_jwks_client = None
def _get_jwks_client():
    global _jwks_client
    if _jwks_client is None:
        if not OIDC_JWKS_URL:
            raise HTTPException(500, "OIDC not configured: set OIDC_ISSUER or OIDC_JWKS_URL.")
        from jwt import PyJWKClient          # lazy; needs PyJWT[crypto]
        _jwks_client = PyJWKClient(OIDC_JWKS_URL)
    return _jwks_client

def _bearer(request: Request):
    auth = request.headers.get("Authorization", "")
    return auth[7:].strip() if auth.lower().startswith("bearer ") else None

def current_username(request: Request) -> str:
    """FastAPI dependency → caller username. OIDC off: AUTH_DEV_USER or '' (fall back to body).
       OIDC on: verified username claim, else 401."""
    if not AUTH_VALIDATE_TOKEN:
        return AUTH_DEV_USER
    token = _bearer(request)
    if not token:
        raise HTTPException(401, "Missing bearer token")
    import jwt
    try:
        key = _get_jwks_client().get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token, key, algorithms=OIDC_ALGORITHMS,
            audience=OIDC_AUDIENCE or None, issuer=OIDC_ISSUER or None, leeway=OIDC_LEEWAY,
            options={"require": ["exp"], "verify_aud": bool(OIDC_AUDIENCE)},
        )
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(401, "Invalid or expired token")
    uname = str(claims.get(OIDC_USERNAME_CLAIM) or claims.get("sub") or "").strip()
    if not uname:
        raise HTTPException(401, "Token has no username claim")
    return uname

def caller_or_body(token_user: str, body_value: str | None) -> str:
    """Token wins (prod), else the body value (dev)."""
    return token_user or (body_value or "")
```

### 3.3 `config/oidc_config.yml` — per-environment provider values

```yaml
dev:
  validate_token: false            # OIDC off (dev-bypass); true = enforce
  issuer:  "https://login-dev.yourbank.com"
  audience: ["my-app-dev"]         # usually the client id; [] = skip aud check
  jwks_url: ""                     # blank → <issuer>/.well-known/jwks.json
  username_claim: "preferred_username"
  algorithms: ["RS256"]
  leeway: 30
stg:
  validate_token: true
  issuer:  "https://login-stg.yourbank.com"
  audience: ["my-app-stg"]
prod:
  validate_token: true
  issuer:  "https://login.yourbank.com"
  audience: ["my-app"]
```

`backend/.env` only needs the selector: `APP_ENV=PROD` (DEV | STG | PROD).

### 3.4 Use it in your endpoints

```python
from fastapi import Depends, Request
from auth_token import current_username, caller_or_body

@router.post("/api/whoami")
def whoami(user: str = Depends(current_username)):
    return {"user": user}            # 401 automatically if OIDC on and token missing/invalid

# For endpoints that used to trust a body "caller"/"username" field — let the token win:
@router.post("/api/do-thing")
def do_thing(body: ThingBody, token_user: str = Depends(current_username)):
    caller = caller_or_body(token_user, body.caller)   # token (prod) → body (dev)
    ...
```

---

## 3-Flask. Backend (Flask) — verify the token

Same idea as §3, adapted to Flask's request context and error handling. The **config loading and JWT
verification are line-for-line the same**; only the framework glue differs (Flask's global `request` /
`abort` / `g` instead of FastAPI's injected `Request` / `HTTPException` / `Depends`). Use **either §3
or this** — not both.

### 3F.1 Dependencies

```
# requirements.txt
Flask>=3.0
PyJWT[crypto]>=2.8,<3.0
PyYAML>=6.0
```

### 3F.2 `auth_token.py` — validator + `@require_auth` decorator

```python
"""OIDC access-token validation for Flask — verify Authorization: Bearer <jwt>, return the username."""
from __future__ import annotations
import os
from functools import wraps
from pathlib import Path
from flask import request, g, abort

# --- per-environment config: env var → oidc_config.yml section (by APP_ENV) → default ---------------
_APP_ENV = os.getenv("APP_ENV", "PROD").strip().lower()

def _load_oidc_section() -> dict:
    path = Path(os.getenv("OIDC_CONFIG_FILE", str(Path(__file__).parent / "config" / "oidc_config.yml")))
    if not path.is_file():
        return {}
    try:
        import yaml
    except Exception:
        return {}
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}
    section = data.get(_APP_ENV) or data.get(_APP_ENV.upper()) or {}
    return section if isinstance(section, dict) else {}

_OIDC = _load_oidc_section()

def _cfg_str(env_key, yaml_key, default=""):
    v = os.getenv(env_key)
    if v and v.strip():
        return v.strip()
    yv = _OIDC.get(yaml_key)
    return str(yv).strip() if yv is not None and str(yv).strip() else default

def _cfg_bool(env_key, yaml_key, default=False):
    v = os.getenv(env_key)
    if v and v.strip():
        return v.strip().lower() in ("1", "true", "yes", "on")
    yv = _OIDC.get(yaml_key)
    if isinstance(yv, bool):
        return yv
    return str(yv).strip().lower() in ("1", "true", "yes", "on") if yv is not None and str(yv).strip() else default

def _cfg_list(env_key, yaml_key, default):
    v = os.getenv(env_key)
    if v and v.strip():
        return [x.strip() for x in v.split(",") if x.strip()]
    yv = _OIDC.get(yaml_key)
    if isinstance(yv, (list, tuple)):
        return [str(x).strip() for x in yv if str(x).strip()]
    return list(default)

AUTH_VALIDATE_TOKEN = _cfg_bool("AUTH_VALIDATE_TOKEN", "validate_token", False)  # THE on/off switch
AUTH_DEV_USER       = _cfg_str("AUTH_DEV_USER", "dev_user", "")                  # fixed UID when OIDC off
OIDC_ISSUER         = _cfg_str("OIDC_ISSUER", "issuer", "")
OIDC_AUDIENCE       = _cfg_list("OIDC_AUDIENCE", "audience", [])
OIDC_JWKS_URL       = _cfg_str("OIDC_JWKS_URL", "jwks_url", "") or (
    f"{OIDC_ISSUER.rstrip('/')}/.well-known/jwks.json" if OIDC_ISSUER else "")
OIDC_USERNAME_CLAIM = _cfg_str("OIDC_USERNAME_CLAIM", "username_claim", "preferred_username") or "preferred_username"
OIDC_ALGORITHMS     = _cfg_list("OIDC_ALGORITHMS", "algorithms", ["RS256"])
OIDC_LEEWAY         = int(_cfg_str("OIDC_LEEWAY", "leeway", "30") or 30)

_jwks_client = None
def _get_jwks_client():
    global _jwks_client
    if _jwks_client is None:
        if not OIDC_JWKS_URL:
            abort(500, "OIDC not configured: set OIDC_ISSUER or OIDC_JWKS_URL.")
        from jwt import PyJWKClient          # lazy; needs PyJWT[crypto]
        _jwks_client = PyJWKClient(OIDC_JWKS_URL)
    return _jwks_client

def _bearer():
    auth = request.headers.get("Authorization", "")
    return auth[7:].strip() if auth.lower().startswith("bearer ") else None

def current_username() -> str:
    """Caller username. OIDC off: AUTH_DEV_USER or '' (fall back to body). OIDC on: verified claim, else abort(401)."""
    if not AUTH_VALIDATE_TOKEN:
        return AUTH_DEV_USER
    token = _bearer()
    if not token:
        abort(401, "Missing bearer token")
    import jwt
    try:
        key = _get_jwks_client().get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token, key, algorithms=OIDC_ALGORITHMS,
            audience=OIDC_AUDIENCE or None, issuer=OIDC_ISSUER or None, leeway=OIDC_LEEWAY,
            options={"require": ["exp"], "verify_aud": bool(OIDC_AUDIENCE)},
        )
    except Exception:
        abort(401, "Invalid or expired token")
    uname = str(claims.get(OIDC_USERNAME_CLAIM) or claims.get("sub") or "").strip()
    if not uname:
        abort(401, "Token has no username claim")
    return uname

def require_auth(fn):
    """Route decorator: validate the token (when OIDC on), stash g.username, then run the view.
       With OIDC off it stashes AUTH_DEV_USER (or '')—the view can still read a body username."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        g.username = current_username()
        return fn(*args, **kwargs)
    return wrapper

def caller_or_body(token_user: str, body_value):
    """Token wins (prod), else the body value (dev)."""
    return token_user or (body_value or "")
```

### 3F.3 `config/oidc_config.yml`

Identical to §3.3 — same file, same keys (`validate_token`, `issuer`, `audience`, `jwks_url`, …), and
`APP_ENV` in the environment selects the section.

### 3F.4 Use it in your routes

```python
from flask import Flask, g, jsonify, request
from auth_token import require_auth, current_username, caller_or_body

app = Flask(__name__)

@app.get("/api/whoami")
@require_auth                      # 401 automatically if OIDC on and token missing/invalid
def whoami():
    return jsonify(user=g.username)

# For endpoints that used to trust a body "caller"/"username" field — let the token win:
@app.post("/api/do-thing")
def do_thing():
    body = request.get_json(silent=True) or {}
    caller = caller_or_body(current_username(), body.get("caller"))   # token (prod) → body (dev)
    ...
```

Prefer to enforce auth **globally** instead of per-route? Use a `before_request` hook and skip the
public paths:

```python
PUBLIC = {"/health", "/login"}
@app.before_request
def _authenticate():
    if request.path in PUBLIC or request.method == "OPTIONS":
        return
    g.username = current_username()          # aborts 401 when OIDC is on and the token is bad
```

### 3F.5 CORS (only if the SPA and API are on different origins)

If you serve the Angular app and the Flask API from the **same origin** (e.g. a reverse proxy forwards
`/api/*`), you need **no CORS** — and make sure the proxy **forwards the `Authorization` header**. If
they're on different origins, add `flask-cors` and allow the header + your origin:

```python
from flask_cors import CORS
CORS(app, resources={r"/api/*": {"origins": ["https://www.myapp.com"]}},
     allow_headers=["Authorization", "Content-Type"])
```

> As with FastAPI, all OIDC values are read **once at import** — restart the Flask process after
> editing the YAML or env vars.

---

## 4. Silent renewal, idle timeout & logout

- **Proactive renewal** — `scheduleRenew()` refreshes the token ~`renewLeewaySeconds` before it
  expires, in the background. No redirect. Requires a **refresh token** (`offline_access` scope + the
  IdP issuing one for a public client).
- **Reactive renewal** — the interceptor (§2.4) catches a **401**, silently renews, and retries the
  same request. This covers cases where the proactive timer didn't fire (backgrounded tab / sleep).
- **Idle timeout (app-side)** — the token lifetime is the IdP's; you **cannot lengthen** it from the
  app, but you can enforce a **shorter inactivity cap**. Set `idleTimeoutMinutes` > 0 and start a
  small service from your authenticated shell:

  ```ts
  // idle-timeout.service.ts (start() called from the shell component's constructor)
  start() {
    const min = SSO_CONFIG.idleTimeoutMinutes; if (min <= 0 || this.started) return;
    this.started = true; const ms = min * 60_000;
    const kick = () => { if (Date.now() - this.last > 1000) { this.last = Date.now(); this.arm(ms); } };
    ['click','keydown','mousemove','scroll','touchstart','visibilitychange']
      .forEach(e => window.addEventListener(e, kick, { passive: true }));
    this.arm(ms);
  }
  private arm(ms: number) { clearTimeout(this.timer); this.timer = setTimeout(() => this.auth.logout(), ms); }
  ```

- **Logout** — if the IdP has an `end_session_endpoint`, set it in `endSessionEndpoint` and register the
  post-logout redirect; otherwise leave it `''` and logout clears the session and goes to `/login`
  locally (the IdP's own SSO cookie stays, so the next login can be silent).

---

## 5. Common pitfalls

| Symptom | Cause / fix |
|---|---|
| Login redirects, comes back, immediately 401s | **`aud` mismatch** — set backend `audience` to the token's real `aud` (decode a token to check), or `[]` to skip. |
| "Invalid token" though login worked | **issuer mismatch** — backend `issuer` must equal the token's `iss` exactly (trailing slash matters). |
| Silent renew never happens / logs out at expiry | No **refresh token** issued — confirm `offline_access` is granted and the client is allowed refresh tokens; else use hidden-iframe `prompt=none`. |
| Renew/exchange fails with a CORS error | The **token endpoint must allow CORS** from the app origin (browser calls it directly). |
| Logs out but lands on a blank/JSON page | `endSessionEndpoint` points at a non-logout URL (e.g. the discovery doc) — set the real `end_session_endpoint` or leave it `''`. |
| Backend 401s every call while UI logged in | Frontend `isSsoEnabled:false` but backend `validate_token:true` — keep the two switches **consistent** per env. |
| Access token is opaque (not a JWT) | JWKS verification can't work — the backend must use the provider's **introspection** endpoint instead. |

---

## 6. Test plan

1. **Bypass unchanged** — `isSsoEnabled:false` + `validate_token:false` → local dev login still works.
2. **Login** — `isSsoEnabled:true`, deploy → Sign in → provider → back to `/auth/callback` → lands in
   the app; `localStorage['app.user']` shows the real UID.
3. **Enforcement** — `validate_token:true`, restart → a call with **no** `Authorization` header → **401**.
4. **Silent renew** — leave the app open past the access-token lifetime → a token-endpoint refresh fires
   in the Network tab, no re-login.
5. **401 recovery** — delete `app.token.exp` (or shorten `expires_in`) and trigger a request → renew +
   retry, no navigation to `/login`.
6. **Idle timeout** — set `idleTimeoutMinutes: 1`, stay idle 1 min → returned to `/login`.

---

*Companion docs in this repo: [`AUTH_SETUP.md`](AUTH_SETUP.md) (OLS-specific go-live) and
[`RBAC_DESIGN.md`](RBAC_DESIGN.md) (authorization).*
