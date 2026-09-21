# OpenID Connect (SSO) — Generic Implementation Guide

A drop-in, reusable guide for adding **OpenID Connect login** to an Angular SPA + FastAPI backend, and
showing the signed-in user on a profile/account menu.

**Design principle (read this first):**

| What | Comes from | Why |
| --- | --- | --- |
| **Identity** — username, email, full name | the **IdP** (OIDC `id_token` claims) | the identity provider is the source of truth for who the user is |
| **Authorization** — role (Admin / Normal), access | **your app DB** (e.g. an `ols_users` table) | *you* decide what a user may do; the IdP does not own your roles |
| **On/off switch** | a single flag (`.env` on the backend, one toggle on the frontend) | run the app with SSO **or** a local dev-bypass, no code changes |

The SPA uses **Authorization Code + PKCE** (a public client — no client secret in the browser). The SPA
sends the **`id_token`** (a JWT) as the `Bearer` token to the API; the API verifies it against the
provider's JWKS and trusts the username **from the token**, then loads that user's role from the DB.

> ⚠️ **The #1 gotcha:** send the **`id_token`**, not the `access_token`. Many providers (Okta, Azure AD
> v1, Ping…) issue an **opaque** `access_token` that is not a JWT — the backend can't decode it
> (`"not enough segments"`). The `id_token` is always a JWT. See §9.

---

## 1. Architecture at a glance

```
┌────────────┐  1. redirect (Auth Code + PKCE)   ┌────────────────┐
│  Browser   │ ────────────────────────────────► │  OIDC Provider │
│  (Angular) │ ◄──────────────  2. code  ──────── │  (IdP)         │
└─────┬──────┘                                    └────────────────┘
      │ 3. code + verifier → tokens (id_token, refresh_token)
      │    stores id_token; decodes claims → {username, email, name}
      │
      │ 4. every API call:  Authorization: Bearer <id_token>
      ▼
┌────────────────────────────────────────────────────────────────┐
│  FastAPI backend                                                 │
│   • validate id_token  (JWKS signature + iss/aud/exp)            │
│   • username = token claim (never the request body)              │
│   • role/access = SELECT ... FROM ols_users WHERE username = ?   │
│   • return the profile/authorization snapshot  (/api/access/me)  │
└────────────────────────────────────────────────────────────────┘
```

- **Frontend** shows username/email/name from the **id_token** directly (no round-trip needed).
- **Backend** returns the **role** (from your DB) which the profile also displays.

---

## 2. The enable / disable flag  ⭐

There are **two** switches (frontend flow + backend enforcement); keep them in sync per environment.

### Backend — `backend/.env`

```dotenv
# THE SSO ON/OFF SWITCH for the API.
#   1 = SSO ON  → every request must carry a valid bearer id_token; identity comes from the token.
#   0 = SSO OFF → no token required; identity is AUTH_DEV_USER (below) or the request body username.
AUTH_VALIDATE_TOKEN=1

# Only used when AUTH_VALIDATE_TOKEN=0 (debug/dummy): authenticate AS this fixed user id.
# Give it real rows in ols_users. Blank = fall back to the username the frontend sends.
AUTH_DEV_USER=
```

### Frontend — one toggle per environment

```ts
// src/environments/environment.ts
const SSO_ENABLED_BY_ENV: Record<AppEnv, boolean> = { DEV: false, STG: true, LIVE: true };
export const environment = {
  // …
  isSsoEnabled: SSO_ENABLED_BY_ENV[RESOLVED_ENV],   // resolved from hostname (DEV/STG/LIVE)
};
```

> A compiled Angular SPA has no runtime `.env`; `environment.ts` **is** its config file. If you truly
> need a runtime toggle, serve a small `assets/config.json` and read it at bootstrap — but the per-env
> flag above is simpler and is what the backend switch pairs with.

### Behaviour matrix

| `isSsoEnabled` (FE) | `AUTH_VALIDATE_TOKEN` (BE) | Result |
| --- | --- | --- |
| `true` | `1` | **Production SSO.** Login redirects to the IdP; API enforces the token. ✅ |
| `false` | `0` | **Local dev-bypass.** "Sign in" makes a local session; API trusts `AUTH_DEV_USER`/body. Great for UI work with no IdP. |
| `true` | `0` | FE logs in via IdP, BE doesn't enforce — fine for early integration; the API still reads the username the FE sends. |
| `false` | `1` | ❌ Avoid: FE never obtains a token, so every API call is 401. |

**Golden rule:** in each environment, set both to the same intent (both on for STG/PROD, both off for local dev).

---

## 3. Provider registration checklist (one-time, per environment)

Register the SPA as a **public client** with the IdP and note the values for §4:

- [ ] **Client type:** Public / SPA (Authorization Code + **PKCE**; **no** client secret).
- [ ] **Redirect URI:** `https://<your-host>/auth/callback` (exact match, per environment).
- [ ] **Post-logout redirect URI:** `https://<your-host>/login`.
- [ ] **Grant types:** Authorization Code + Refresh Token.
- [ ] **Scopes:** `openid profile email offline_access` (`offline_access` → refresh tokens for silent renew).
- [ ] From the discovery doc `<issuer>/.well-known/openid-configuration`, note: `authorization_endpoint`,
      `token_endpoint`, `jwks_uri`, `issuer`, and (if present) `end_session_endpoint`.
- [ ] Confirm the **`id_token`** carries the corporate UID claim you'll match to your DB
      (usually `preferred_username`, else `sub`) — and `email`, `name`.

---

## 4. Configuration files

### 4a. Backend — `backend/config/oidc_config.yml` (non-secret, committed; one section per env)

```yaml
# The backend picks the section matching APP_ENV in backend/.env, so .env stays generic.
# Any key can be overridden per-server by its env var (env wins → yaml → default).
dev:
  validate_token: false          # OIDC off in dev by default (dev-bypass)
  dev_user: ""                   # e.g. "OPS-10432" to debug AS a user; blank = body username
  issuer: "https://login-dev.example.com"
  audience: ["your-client-id-dev"]   # the id_token's `aud` = the SPA client_id (see §9)
  jwks_url: ""                        # blank → <issuer>/.well-known/jwks.json
  username_claim: "preferred_username"
  algorithms: ["RS256"]
  leeway: 30
stg:  { validate_token: true, issuer: "https://login-stg.example.com", audience: ["your-client-id-stg"] }
prod: { validate_token: true, issuer: "https://login.example.com",     audience: ["your-client-id"] }
```

### 4b. Backend — `.env` keys (secrets/global; env var overrides the YAML)

| Key | Meaning |
| --- | --- |
| `APP_ENV` | `DEV` / `STG` / `PROD` — selects the YAML section. |
| `AUTH_VALIDATE_TOKEN` | **The on/off switch** (`1`/`0`). Overrides `validate_token`. |
| `AUTH_DEV_USER` | Fixed UID when OIDC is off. |
| `OIDC_ISSUER` | Provider issuer (validated against `iss`). |
| `OIDC_AUDIENCE` | Expected `aud` — **set to your SPA `client_id`** (the id_token's aud), or leave blank to skip. |
| `OIDC_JWKS_URL` | JWKS endpoint; blank → `<issuer>/.well-known/jwks.json`. |
| `OIDC_USERNAME_CLAIM` | Claim carrying the DB UID (default `preferred_username` → `sub`). |
| `OIDC_ALGORITHMS` | Allowed signing algs (default `RS256`). |
| `OIDC_LEEWAY` | Clock-skew seconds (default `30`). |

### 4c. Frontend — `src/app/auth/sso.config.ts` (per-env provider details)

```ts
export interface SsoConfig {
  issuer: string; authorizeEndpoint: string; tokenEndpoint: string;
  endSessionEndpoint: string;      // '' → local logout to postLogoutRedirectUri (no provider call)
  clientId: string; redirectUri: string; postLogoutRedirectUri: string;
  scope: string; renewLeewaySeconds: number; idleTimeoutMinutes: number;
}
const redirectUri = `${window.location.origin}/auth/callback`;
const postLogoutRedirectUri = `${window.location.origin}/login`;

const SSO_BY_ENV: Record<AppEnv, SsoConfig> = {
  DEV:  { issuer:'https://login-dev.example.com', authorizeEndpoint:'…/authorize', tokenEndpoint:'…/oauth2/token',
          endSessionEndpoint:'', clientId:'your-client-id-dev', redirectUri, postLogoutRedirectUri,
          scope:'openid profile email offline_access', renewLeewaySeconds:60, idleTimeoutMinutes:0 },
  STG:  { /* … */ } as SsoConfig,
  LIVE: { /* … */ } as SsoConfig,
};
export const SSO_CONFIG: SsoConfig = SSO_BY_ENV[environment.appEnv];
```

> **Frontend `clientId` = backend `OIDC_AUDIENCE`** (both are the SPA client id). Point FE and BE at the
> **same provider** per environment.

---

## 5. Frontend implementation (Angular, standalone)

### 5a. OIDC engine — `src/app/auth/sso-auth.service.ts` (Auth Code + PKCE, dependency-free)

```ts
import { Injectable, signal } from '@angular/core';
import { AuthUser } from '../shared/models';
import { SSO_CONFIG } from './sso.config';

export const TOKEN_KEY = 'app.token';
export const USER_KEY  = 'app.user';
export const EXPIRY_KEY = 'app.token.exp';
const REFRESH_KEY = 'app.refresh';
const PKCE_KEY = 'app.pkce';

interface TokenResponse { access_token: string; id_token?: string; refresh_token?: string; expires_in?: number; }

@Injectable({ providedIn: 'root' })
export class SsoAuthService {
  readonly user = signal<AuthUser | null>(readUser());
  readonly sessionExpired = signal(false);
  private renewTimer?: ReturnType<typeof setTimeout>;
  private renewInFlight?: Promise<boolean>;

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

  /** Begin the OIDC flow — redirects the browser to the provider. */
  async startLogin(returnUrl = '/home'): Promise<void> {
    const state = randomString(32), nonce = randomString(32), verifier = randomString(64);
    const challenge = await pkceChallenge(verifier);
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ state, nonce, verifier, returnUrl }));
    const params = new URLSearchParams({
      client_id: SSO_CONFIG.clientId, redirect_uri: SSO_CONFIG.redirectUri, response_type: 'code',
      scope: SSO_CONFIG.scope, state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
    });
    window.location.assign(`${SSO_CONFIG.authorizeEndpoint}?${params.toString()}`);
  }

  /** Handle the provider redirect back and exchange the code. Returns the return URL. */
  async handleCallback(): Promise<string> {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code'), state = url.searchParams.get('state');
    const stored = JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? '{}');
    sessionStorage.removeItem(PKCE_KEY);
    if (!code || !state || state !== stored.state || !stored.verifier) {
      throw new Error('Invalid SSO callback (state/code mismatch).');
    }
    await this.exchangeCode(code, stored.verifier);
    return stored.returnUrl || '/home';
  }

  /** Silent renew via refresh token; deduped so concurrent 401s trigger ONE refresh. */
  renew(): Promise<boolean> {
    return (this.renewInFlight ??= this.performRenew().finally(() => { this.renewInFlight = undefined; }));
  }
  private async performRenew(): Promise<boolean> {
    const refresh = localStorage.getItem(REFRESH_KEY);
    if (!refresh) { this.fail(); return false; }
    try {
      const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh,
        client_id: SSO_CONFIG.clientId, scope: SSO_CONFIG.scope });
      const res = await fetch(SSO_CONFIG.tokenEndpoint, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      if (!res.ok) { throw new Error(`renew ${res.status}`); }
      this.storeTokens(await res.json()); return true;
    } catch { this.fail(); return false; }
  }

  logout(): void {
    this.clear();
    const end = (SSO_CONFIG.endSessionEndpoint || '').trim();
    if (!end) { window.location.assign(SSO_CONFIG.postLogoutRedirectUri); return; }  // local logout
    const params = new URLSearchParams({ client_id: SSO_CONFIG.clientId,
      post_logout_redirect_uri: SSO_CONFIG.postLogoutRedirectUri });
    window.location.assign(`${end}?${params.toString()}`);
  }

  private async exchangeCode(code: string, verifier: string): Promise<void> {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code,
      redirect_uri: SSO_CONFIG.redirectUri, client_id: SSO_CONFIG.clientId, code_verifier: verifier });
    const res = await fetch(SSO_CONFIG.tokenEndpoint, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!res.ok) { throw new Error(`Token exchange failed: ${res.status}`); }
    this.storeTokens(await res.json());
  }

  private storeTokens(tok: TokenResponse): void {
    // Send the BACKEND the id_token (a JWT). access_token is often opaque and can't be decoded.
    // On silent-renew some IdPs omit a fresh id_token → keep the previous one; access_token is last resort.
    localStorage.setItem(TOKEN_KEY, tok.id_token ?? localStorage.getItem(TOKEN_KEY) ?? tok.access_token);
    if (tok.refresh_token) { localStorage.setItem(REFRESH_KEY, tok.refresh_token); }
    const expiry = Date.now() + (tok.expires_in ? Number(tok.expires_in) : 3600) * 1000;
    localStorage.setItem(EXPIRY_KEY, String(expiry));

    // ►► Identity comes FROM the id_token (username, email, name). Role is filled later from the DB.
    const claims = tok.id_token ? decodeJwt(tok.id_token) : {};
    const user: AuthUser = {
      username: String(claims['preferred_username'] ?? claims['sub'] ?? 'user'),
      displayName: String(claims['name'] ?? claims['preferred_username'] ?? 'User'),
      email: claims['email'] ? String(claims['email']) : undefined,
      role: String((Array.isArray(claims['roles']) ? claims['roles'][0] : claims['role']) ?? 'Operator'),
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

// ---- PKCE + JWT helpers (dependency-free) ----
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
    return JSON.parse(decodeURIComponent(escape(atob(p))));
  } catch { return {}; }
}
```

### 5b. Auth facade — `src/app/auth/auth.service.ts` (SSO vs dev-bypass; the flag lives here)

```ts
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly sso = inject(SsoAuthService);
  private readonly rbac = inject(RbacService);   // loads role/access from the DB (see §6c)
  readonly ssoEnabled = environment.isSsoEnabled;
  readonly user = signal<AuthUser | null>(this.readStoredUser());
  readonly sessionExpired = this.sso.sessionExpired;

  /** Login button entry point. SSO → redirect to IdP (never returns). Off → local dev-bypass session. */
  async signIn(returnUrl = '/home'): Promise<boolean> {
    if (environment.isSsoEnabled) { await this.sso.startLogin(returnUrl); return false; }
    const user: AuthUser = { username: environment.username, displayName: environment.name,
      email: 'dev.user@example.com', role: 'Ops Admin' };
    localStorage.setItem(TOKEN_KEY, `dev-bypass.${Date.now()}`);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    this.user.set(user); this.rbac.reset(); return true;
  }

  /** Called by the /auth/callback route to finish the OIDC exchange. */
  async completeSsoLogin(): Promise<string> {
    const returnUrl = await this.sso.handleCallback();
    this.user.set(this.sso.user());
    this.rbac.reset();            // triggers a fresh /api/access/me → role from the DB
    return returnUrl;
  }

  isAuthenticated(): boolean {
    return environment.isSsoEnabled ? this.sso.isAuthenticated() : !!localStorage.getItem(TOKEN_KEY);
  }
  get token(): string | null {
    return environment.isSsoEnabled ? this.sso.accessToken : localStorage.getItem(TOKEN_KEY);
  }
  tryRenew(): Promise<boolean> { return environment.isSsoEnabled ? this.sso.renew() : Promise.resolve(false); }
  logout(): void {
    this.rbac.reset();
    if (environment.isSsoEnabled) { this.user.set(null); this.sso.logout(); return; }
    [TOKEN_KEY, USER_KEY].forEach((k) => localStorage.removeItem(k)); this.user.set(null);
  }
  private readStoredUser(): AuthUser | null {
    const raw = localStorage.getItem(USER_KEY);
    try { return raw ? JSON.parse(raw) as AuthUser : null; } catch { return null; }
  }
}
```

### 5c. Callback route — `src/app/auth/sso-callback.component.ts`

```ts
@Component({ standalone: true, template: `<p style="padding:2rem">Signing you in…</p>` })
export class SsoCallbackComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  constructor() {
    this.auth.completeSsoLogin()
      .then((returnUrl) => this.router.navigateByUrl(returnUrl))
      .catch(() => this.router.navigate(['/login'], { queryParams: { error: 'sso' } }));
  }
}
// Route: { path: 'auth/callback', component: SsoCallbackComponent }
```

### 5d. HTTP interceptor — attach the bearer + silent-renew on 401

```ts
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const token = auth.token;
  const authed = token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;
  return next(authed).pipe(
    catchError((err: HttpErrorResponse) => {
      if (err.status !== 401 || !auth.ssoEnabled || req.headers.has('X-Retry')) { return throwError(() => err); }
      return from(auth.tryRenew()).pipe(switchMap((ok) => {
        if (!ok) { return throwError(() => err); }
        const retried = req.clone({ setHeaders: { Authorization: `Bearer ${auth.token}`, 'X-Retry': '1' } });
        return next(retried);
      }));
    }),
  );
};
```

### 5e. Route guard

```ts
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService); const router = inject(Router);
  if (auth.isAuthenticated()) { return true; }
  if (auth.ssoEnabled) { auth.startSsoLogin(state.url); return false; }   // → IdP
  return router.parseUrl('/login');                                       // → local login page
};
```

---

## 6. Backend implementation (FastAPI)

### 6a. Token validation — `backend/auth_token.py` (the core)

```python
"""Verify the incoming `Authorization: Bearer <id_token>` against the IdP's JWKS + iss/aud/exp,
then return the caller's username FROM the token (never the body). AUTH_VALIDATE_TOKEN is the switch;
PyJWT is imported lazily so the app runs without it while SSO is off."""
import os
from fastapi import HTTPException, Request

AUTH_VALIDATE_TOKEN = os.getenv("AUTH_VALIDATE_TOKEN", "0").lower() in ("1", "true", "yes", "on")
AUTH_DEV_USER       = os.getenv("AUTH_DEV_USER", "").strip()
OIDC_ISSUER         = os.getenv("OIDC_ISSUER", "").strip()
OIDC_AUDIENCE       = [a for a in os.getenv("OIDC_AUDIENCE", "").split(",") if a.strip()]
OIDC_JWKS_URL       = os.getenv("OIDC_JWKS_URL", "").strip() or (
    f"{OIDC_ISSUER.rstrip('/')}/.well-known/jwks.json" if OIDC_ISSUER else "")
OIDC_USERNAME_CLAIM = os.getenv("OIDC_USERNAME_CLAIM", "preferred_username") or "preferred_username"
OIDC_ALGORITHMS     = [a.strip() for a in os.getenv("OIDC_ALGORITHMS", "RS256").split(",") if a.strip()]
OIDC_LEEWAY         = int(os.getenv("OIDC_LEEWAY", "30") or 30)

_jwks_client = None
def _get_jwks_client():
    global _jwks_client
    if _jwks_client is None:
        if not OIDC_JWKS_URL:
            raise HTTPException(500, "OIDC not configured: set OIDC_ISSUER or OIDC_JWKS_URL.")
        from jwt import PyJWKClient          # lazy; pip install 'PyJWT[crypto]'
        _jwks_client = PyJWKClient(OIDC_JWKS_URL)
    return _jwks_client

def _bearer(request: Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    return auth[7:].strip() if auth.lower().startswith("bearer ") else None

def current_username(request: Request) -> str:
    """OIDC off → AUTH_DEV_USER (or '' so callers use the body username). OIDC on → the verified
    token's username claim (401 on missing/invalid/expired)."""
    if not AUTH_VALIDATE_TOKEN:
        return AUTH_DEV_USER
    token = _bearer(request)
    if not token:
        raise HTTPException(401, "Missing bearer token")
    import jwt                                # lazy
    try:
        key = _get_jwks_client().get_signing_key_from_jwt(token).key
        claims = jwt.decode(token, key, algorithms=OIDC_ALGORITHMS,
                            audience=OIDC_AUDIENCE or None, issuer=OIDC_ISSUER or None,
                            leeway=OIDC_LEEWAY,
                            options={"require": ["exp"], "verify_aud": bool(OIDC_AUDIENCE)})
    except Exception as exc:
        raise HTTPException(401, _token_error(exc))
    uname = str(claims.get(OIDC_USERNAME_CLAIM) or claims.get("sub") or "").strip()
    if not uname:
        raise HTTPException(401, "Token has no username claim")
    return uname

def resolve_caller(request: Request, body_caller: str | None = "") -> str:
    """Effective caller = validated token identity (OIDC on) → AUTH_DEV_USER → body value.
    Call at the top of an endpoint to ENFORCE auth AND get the real identity for RBAC + audit."""
    return current_username(request) or (body_caller or "")

def _token_error(exc: Exception) -> str:
    name, msg = exc.__class__.__name__, str(exc).lower()
    if name == "ExpiredSignatureError" or "expired" in msg: return "Token has expired — sign in again."
    if name == "InvalidAudienceError" or "audience" in msg:
        return "Token audience mismatch — set OIDC_AUDIENCE to your client_id, or clear it to skip."
    if name == "InvalidIssuerError" or "issuer" in msg:   return "Token issuer mismatch (check OIDC_ISSUER)."
    if "not enough segments" in msg or "not a valid jwt" in msg:
        return "Token is not a JWT (opaque) — the SPA must send the id_token, not the access_token."
    if name == "InvalidSignatureError" or "signature" in msg: return "Token signature could not be verified."
    return "Invalid or expired token."
```

### 6b. Role FROM your DB (`ols_users`), not the token

The token tells you **who** the user is; **you** decide their role. Look it up by the token username:

```python
def fetch_user_role(db, username: str) -> dict:
    """Return {'active': bool, 'role': 'ADMIN'|'USER'|…} from your app DB (e.g. ols_users)."""
    row = db.execute(
        "SELECT is_active, is_admin FROM ols_users WHERE username = :u", {"u": username}
    ).fetchone()
    if not row or not row.is_active:
        return {"active": False, "role": "NONE"}
    return {"active": True, "role": "ADMIN" if row.is_admin else "USER"}
```

### 6c. The profile / authorization endpoint — `/api/access/me`

```python
from fastapi import APIRouter, Request
from auth_token import current_username

router = APIRouter(prefix="/api/access")

@router.get("/me")
def me(request: Request):
    username = current_username(request)      # 401 here if OIDC on and no/invalid token
    info = fetch_user_role(db, username)       # role from ols_users (your DB)
    return {
        "username": username,                  # identity (from the token / DB key)
        "active":   info["active"],
        "role":     info["role"],              # ← Admin / Normal, FROM ols_users
        # email/name are already on the SPA from the id_token; include here too if you prefer server-side.
    }
```

> **Write endpoints:** start each with `body.caller = resolve_caller(request, body.caller)` so the RBAC
> check **and** the audit trail use the real token identity, never a spoofable body field.

---

## 7. User profile display (no code changes needed if you already have the component)

Your `AuthUser` and profile component just bind the pieces:

```ts
export interface AuthUser {
  username: string;      // OpenID `sub` / `preferred_username`   ← from SSO
  displayName: string;   // OpenID `name`                          ← from SSO
  email?: string;        // OpenID `email`                         ← from SSO
  role: string;          // fallback; the DB role is preferred     ← see below
}
```

- **username / email / full name** → read straight from `AuthService.user()` (populated from the
  **id_token** in `storeTokens`). Nothing to fetch.
- **role (Admin / Normal)** → read from the DB via the access snapshot, with the token role as a fallback:

```ts
// user-profile.component.ts
readonly user = this.auth.user;                              // username/email/name from SSO
readonly roleLabel = computed(() =>
  this.rbac.roleLabel()          // ← role from /api/access/me (ols_users)
  || this.user()?.role           // ← fallback: role claim from the token
  || 'Operator');
```

That's the whole contract — **identity from SSO, role from the DB.** If you copied the profile component
as-is, it already does this; just make sure (a) `storeTokens` fills `AuthUser` from the id_token, and
(b) `rbac`/`/api/access/me` returns the DB role.

---

## 8. Wiring checklist

- [ ] Register routes: `{ path: 'auth/callback', component: SsoCallbackComponent }` and `/login`.
- [ ] Provide the interceptor: `provideHttpClient(withInterceptors([authInterceptor]))`.
- [ ] Guard protected routes with `authGuard`.
- [ ] Login button calls `auth.signIn(returnUrl)`.
- [ ] Backend: `pip install "PyJWT[crypto]"`; add the `.env` keys (§4b); mount `/api/access/me`.
- [ ] Set the flag on both sides for the environment (§2).
- [ ] Provider has the redirect URI `…/auth/callback` whitelisted.

---

## 9. Testing & troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| **401 "Token is not a JWT (opaque)"** / `not enough segments` | The SPA sent the **access_token**. Send the **id_token** (already the default in `storeTokens`). |
| **401 "Token audience mismatch"** | `OIDC_AUDIENCE` ≠ the id_token's `aud`. The id_token's `aud` is the **client_id** → set `OIDC_AUDIENCE` to the SPA `client_id`, or leave it blank to skip the check. |
| **401 "Token issuer mismatch"** | `OIDC_ISSUER` differs from the token `iss` (often a trailing-slash mismatch). |
| **500 "No matching signing key in the JWKS"** | Wrong `OIDC_JWKS_URL`, or the token `kid` isn't published — verify the JWKS URL. |
| **Redirect loop / "state mismatch"** | Redirect URI not whitelisted exactly, or third-party cookies/sessionStorage blocked. |
| **Everything 401 in dev** | You have FE `isSsoEnabled=true` but BE `AUTH_VALIDATE_TOKEN=0` mismatch, or vice-versa — align them (§2). |
| **Role always shows the fallback** | `/api/access/me` isn't returning the DB role, or `rbac.reset()` isn't called after login. |

**Local dev without an IdP:** set FE `isSsoEnabled=false` and BE `AUTH_VALIDATE_TOKEN=0` (optionally
`AUTH_DEV_USER=<a real UID in ols_users>`). "Sign in" makes a local session and the API trusts that UID.

---

## 10. Security notes

- **PKCE, public client, no secret in the browser.** The `code_verifier` never leaves the SPA until the
  token exchange.
- **The server trusts the token, not the body.** `current_username` / `resolve_caller` derive identity
  from the verified JWT; request-body usernames are only a dev-mode fallback.
- **UI hiding is never the boundary.** Re-check role/permissions on every write endpoint server-side.
- **Tokens in `localStorage`** are simple and work for an internal SPA; if your threat model needs it,
  move to in-memory + refresh-cookie. Keep token lifetimes short and rely on silent renew.
- **HTTPS everywhere**, and keep FE `clientId` = BE `OIDC_AUDIENCE` per environment.
```
