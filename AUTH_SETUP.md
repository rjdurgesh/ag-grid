# Authentication Setup — OpenID Connect (SSO) + real RBAC

Step-by-step guide to switch the OLS Dashboard from the current **dummy auth** to **real
OpenID Connect** sign-in with **real, DB-backed access control**.

> **Read this alongside** [`RBAC_DESIGN.md`](RBAC_DESIGN.md) (the authorization model) and
> [`DEPLOYMENT.md`](DEPLOYMENT.md) (how each environment is hosted). This file is the
> *authentication* half; RBAC_DESIGN is the *authorization* half.

---

## 0. Two layers — don't confuse them

| Layer | Question it answers | Where it lives | Status |
|---|---|---|---|
| **Authentication (AuthN)** | *Who are you?* | OpenID Connect provider + `src/app/auth/` | **Frontend built**, backend token check **not built** |
| **Authorization (AuthZ / RBAC)** | *What may you do?* | `ols_users` + `ols_app_access` → `POST /api/access/me` | Built; runs in **dummy** mode by default |

The IdP proves identity and hands back a **username** (the `sub` / `preferred_username` claim).
That username is then looked up in **your** `ols_users` / `ols_app_access` tables to decide the
role and grants. **The IdP's own `role` claim is NOT used for access** — RBAC always comes from
your tables. So a user must exist in `ols_users` even after SSO is on.

---

## 1. Why you currently see "read access + few screens" in the project env

This is the dummy path, working as designed — not a bug in your grants:

- **Local** (`localhost`) → `environment.useMock = true`, so `/api/access/me` is answered by the
  **frontend mock**, which defaults to the **ADMIN** dev scenario. The backend and DB are never
  touched. → you see everything.
- **Project env** (deployed) → `useMock = false`, so the **real backend** answers. There,
  [`access_api.py`](backend/access_api.py) has `ACCESS_USE_DUMMY = env_bool("ACCESS_USE_DUMMY", True)`
  — **default on**. In dummy mode the backend **ignores `ols_users` / `ols_app_access` entirely**
  and derives the role from the **username string**: it is ADMIN only if the username contains the
  literal `"ADMIN"`; otherwise it is **READ** with a fixed, limited canned grant set. Your real
  username doesn't contain `"ADMIN"`, so you get READ + a few screens regardless of the DB.

Turning on real RBAC (§4) is what makes your `IS_ADMIN` flag and `ols_app_access` grants take effect.

---

## 1a. Switching OIDC on/off — the developer bypass (READ THIS)

Like the per-screen `*_USE_DUMMY` flags, OIDC can be switched **off** so you can debug without an identity
provider. There are **two switches — one per layer** (frontend and backend). Keep them **consistent**
(both on, or both off).

| Layer | Flag | Where | ON (enforce) | OFF (bypass — debug) |
|---|---|---|---|---|
| **Frontend** | `isSsoEnabled` (per env) | [`environment.ts`](src/environments/environment.ts) `SSO_ENABLED_BY_ENV` + [`sso.config.ts`](src/app/auth/sso.config.ts) `SSO_BY_ENV` | `true` → redirect to the IdP (real OIDC login) | `false` → dev-bypass login button, no IdP; the user is `environment.username` |
| **Backend** | `validate_token` (per env) | [`backend/config/oidc_config.yml`](backend/config/oidc_config.yml), section chosen by `APP_ENV` in `backend/.env` | `true` → verify the bearer token; no/invalid token → **401**; identity from the token | `false` (default) → **no token required** |

**What identity the backend uses when `AUTH_VALIDATE_TOKEN=0` (OIDC off):** it reads, in order —
1. **`AUTH_DEV_USER`** (env) — if set, every request authenticates AS this fixed UID (the "hardcoded
   debug user"). Give it the access it needs: real rows in `ols_users`/`ols_app_access` when
   `ACCESS_USE_DUMMY=0`, or any name containing `ADMIN` when `ACCESS_USE_DUMMY=1`.
2. otherwise, the **`username`/caller field in the request body** (what the frontend sends) — so the app
   keeps working with zero extra config.

**⚠️ Keep the two switches consistent.** If the backend enforces (`AUTH_VALIDATE_TOKEN=1`) while the
frontend bypasses (`isSsoEnabled=false`), the frontend sends a fake `dev-bypass.<ts>` token, the backend
can't validate it, and **every API call 401s**. So: `isSsoEnabled:false` ↔ `AUTH_VALIDATE_TOKEN=0`
(debug), and `isSsoEnabled:true` ↔ `AUTH_VALIDATE_TOKEN=1` (real).

**`AUTH_VALIDATE_TOKEN` is read once at process start — restart the backend after changing it** (see
[`backend-uvicorn-reload-unreliable`]). `isSsoEnabled` is build-time (rebuild the UI, or make it
env-aware, e.g. `isSsoEnabled: !IS_LOCAL`).

**This is separate from `ACCESS_USE_DUMMY`** (the RBAC dummy switch): OIDC = *who you are*;
`ACCESS_USE_DUMMY` = *whether your grants come from the DB or a canned set*. Common combinations:

| Goal | `isSsoEnabled` | `AUTH_VALIDATE_TOKEN` | `AUTH_DEV_USER` | `ACCESS_USE_DUMMY` |
|---|---|---|---|---|
| Local dev, no IdP, no DB (default) | `false` | `0` | *(blank, or a name with ADMIN)* | `1` |
| Debug against the real DB as a specific user, no IdP | `false` | `0` | `<a real UID>` | `0` |
| Production / real SSO | `true` | `1` | *(unused)* | `0` |

---

## 2. The sign-in flow (Authorization Code + PKCE)

Already implemented in [`src/app/auth/sso-auth.service.ts`](src/app/auth/sso-auth.service.ts) —
dependency-free, no client secret in the browser:

```
Browser (SPA)                    Identity Provider                 Backend (FastAPI)
─────────────                    ─────────────────                 ─────────────────
click Sign in
  └─ /authorize?code_challenge… ────────► login page
                                 user authenticates
      ◄── redirect /auth/callback?code=… ┘
  exchange code + PKCE verifier ────────► /oauth2/token
      ◄──────── access_token + id_token + refresh_token
  store tokens (localStorage)
  read username from id_token (sub / preferred_username)
  POST /api/access/me  (Authorization: Bearer <access_token>) ────► validate token, resolve RBAC
      ◄──────────────────────────────── AccessSnapshot (role, screens, grants)
  silent renew via refresh_token before expiry
```

Every outgoing API call already carries the token — [`auth.interceptor.ts`](src/app/auth/auth.interceptor.ts)
adds `Authorization: Bearer <token>` whenever one is present. The callback route
`auth/callback` → `SsoCallbackComponent` is registered in
[`app.routes.ts`](src/app/app.routes.ts).

---

## 3. Part A — Frontend: enable OpenID Connect

### 3.1 Register the app with your IdP

Create a **public / SPA client** (Authorization Code + PKCE, **no client secret**) and record:

- **Issuer** (authority) and its endpoints — most providers publish them at
  `<issuer>/.well-known/openid-configuration`: `authorization_endpoint`, `token_endpoint`,
  `end_session_endpoint`, and `jwks_uri`.
- **Client ID** (public).
- **Redirect URI** — must match **exactly**. The SPA uses `<origin>/auth/callback`, so register
  one per environment:
  - `https://www.abc.dev.com/auth/callback`
  - `https://www.abc.stg.com/auth/callback`
  - `https://www.abc.group.com/auth/callback`
  - `http://localhost:4200/auth/callback` (only if you test SSO locally)
- **Post-logout redirect URI** — `<origin>/login` for each of the above.
- **Scopes** — `openid profile email offline_access` (`offline_access` gives the refresh token used
  for silent renew).
- **Audience** — note what the provider stamps into the **access token's `aud`**; the backend (§3B)
  verifies it. Often the client ID or a dedicated API identifier.

### 3.2 Fill in `SSO_CONFIG` (per environment)

Edit [`src/app/auth/sso.config.ts`](src/app/auth/sso.config.ts). It holds **one block per environment**
(`DEV` / `STG` / `LIVE`) in `SSO_BY_ENV`; the app auto-selects the block for the current environment via
`environment.appEnv` (resolved from the browser hostname — see `environment.ts` `ENV_BY_HOST`). Replace the
`your-openid-provider*.example.com` placeholders with each environment's real values:

```ts
const SSO_BY_ENV: Record<AppEnv, SsoConfig> = {
  DEV:  { issuer: 'https://login-dev.yourbank.com',  clientId: 'ols-dashboard-dev',  /* …endpoints… */ },
  STG:  { issuer: 'https://login-stg.yourbank.com',  clientId: 'ols-dashboard-stg',  /* …endpoints… */ },
  LIVE: { issuer: 'https://login.yourbank.com',      clientId: 'ols-dashboard',      /* …endpoints… */ },
};
export const SSO_CONFIG: SsoConfig = SSO_BY_ENV[environment.appEnv];   // active block for this env
```

So the **same built bundle** works in all three: DEV hosts pick the DEV block, STG the STG block, PROD the
LIVE block. `redirectUri` / `postLogoutRedirectUri` derive from `window.location.origin`, so each origin
just needs its callback registered with that environment's IdP (3.1).

### 3.3 Turn SSO on (per environment)

In [`src/environments/environment.ts`](src/environments/environment.ts), flip the per-env switch in
`SSO_ENABLED_BY_ENV` (which feeds `environment.isSsoEnabled`):

```ts
const SSO_ENABLED_BY_ENV: Record<AppEnv, boolean> = { DEV: false, STG: true, LIVE: true };
```

`environment.isSsoEnabled` is what [`auth.service.ts`](src/app/auth/auth.service.ts) reads to switch the
login button from the dev-bypass session to the real OIDC redirect. Because it's per-env you can, e.g.,
keep the **dev-bypass locally/DEV** while **STG and PROD use real SSO** — all from one build. Pair each
environment with its backend switch: `isSsoEnabled` for env X ↔ `AUTH_VALIDATE_TOKEN=1` on env X's server.

### 3.4 What the SPA reads from the token (already handled)

`storeTokens()` in `sso-auth.service.ts` maps id-token claims → the app's user:

| App field | Claim (in order of preference) |
|---|---|
| `username` | `sub` → `preferred_username` |
| `displayName` | `name` → `preferred_username` |
| `email` | `email` |
| `role` | `roles[0]` / `role` — **display only; NOT used for RBAC** |

The `username` is what gets sent to `/api/access/me` and looked up in your tables, so make sure the
claim you rely on matches the `USERNAME` column in `ols_users`. If your IdP puts the corporate UID in
a non-standard claim, tell me and I'll adjust the mapping.

---

## 4. Part B — Backend: validate the token *(core implemented — configure, then extend to the other write endpoints)*

Until now the backend trusted the `username` in the request body. That's now hardened: with
`AUTH_VALIDATE_TOKEN=1` the backend **verifies the bearer token and derives the caller from it**,
ignoring the body. While the flag is off (default) everything behaves exactly as before, so this is a
non-breaking change you turn on when the IdP is ready.

### 4.1 JWT library — DONE

`PyJWT[crypto]>=2.8,<3.0` is in [`backend/requirements.txt`](backend/requirements.txt). It's imported
**lazily** (only when validation is on), so the backend still runs without it while
`AUTH_VALIDATE_TOKEN=0`. Run `pip install -r requirements.txt` on the server before enabling.

### 4.2 Token validator — DONE (`backend/auth_token.py`)

Implemented as [`backend/auth_token.py`](backend/auth_token.py): a FastAPI dependency
`current_username(request)` that verifies the bearer JWT against the IdP's JWKS (signature) and its
`iss` / `aud` / `exp` claims (via `PyJWKClient`, which caches keys), then returns the username claim.

- `AUTH_VALIDATE_TOKEN=1` → **OIDC ON**: a missing / invalid / expired token → **401**; otherwise the
  validated UID from the token.
- `AUTH_VALIDATE_TOKEN=0` → **OIDC OFF** (the debug switch you flip to work without an IdP): returns
  `AUTH_DEV_USER` if set (authenticate AS that fixed UID), else `""` so callers fall back to the body
  username. **`AUTH_VALIDATE_TOKEN` is the single on/off switch for OIDC enforcement.**
- Helpers: `caller_or_body(token_user, body_value)` ("token wins, else body") and
  `resolve_caller(request, body_caller)` (the one-liner used across the write endpoints — resolves +
  raises 401 when OIDC is on and no token).

Config (all read once at import — restart after changing): `AUTH_VALIDATE_TOKEN` (the on/off switch),
`AUTH_DEV_USER` (debug identity when OIDC is off), `OIDC_ISSUER`, `OIDC_AUDIENCE` (comma-separated;
empty = skip aud check), `OIDC_JWKS_URL` (defaults to `<issuer>/.well-known/jwks.json`),
`OIDC_USERNAME_CLAIM` (default `preferred_username`, falls back to `sub`), `OIDC_ALGORITHMS` (default
`RS256`), `OIDC_LEEWAY` (default 30s).

**Debugging without an IdP:** leave `AUTH_VALIDATE_TOKEN=0` and set `AUTH_DEV_USER` to a UID that has
the access you need (real `ols_users`/`ols_app_access` when `ACCESS_USE_DUMMY=0`, or any name containing
`ADMIN` when `ACCESS_USE_DUMMY=1`). Every request then authenticates as that user — no tokens, no
frontend login flow — and you flip `AUTH_VALIDATE_TOKEN=1` to turn real OIDC back on. This is also the
answer to "why does the deployed app show read-only access": with OIDC off and no `AUTH_DEV_USER`, the
backend falls back to the body username, which under `ACCESS_USE_DUMMY=1` is READ unless it contains `ADMIN`.

### 4.3 Access endpoints wired — DONE (`backend/access_api.py`)

`/api/access/me`, `/api/access/effective`, and every `/api/access/admin/*` route now take
`token_user: str = Depends(current_username)` and resolve the caller with `caller_or_body(...)` —
so the signed-in identity and the audit `granted_by` come from the validated token when enforcement
is on, and from the body only in dev.

### 4.4 The other modules' write endpoints — DONE

The identity is now resolved from the token across every module (via `resolve_caller(request, ...)`,
which stamps the effective caller onto the body so both the RBAC gate AND the audit trail use the real
identity; with OIDC on, a missing/invalid token → 401):

- `regression_api.py` — resolved centrally in `_require_regression(request, body)`, so **all** run /
  step / git / run-sql / file-copy / cleanup / monitor / activity endpoints are covered.
- `sql_studio_api.py` — resolved in `_require_sql_admin(request, body)` → `/databases` + `/execute`.
- `config_api.py` — each write/read endpoint resolves its actor field (`caller` / `rolled_by` /
  `inserted_by` / `updated_by` / `deleted_by`): roll, upload, insert, update, delete, retrieve, columnretrieve.
- `oracle_cc_api.py` — `mview-refresh` + `gather-stats` resolve `body.caller` (→ `requested_by`);
  `kill-session` + `apply_fix` (currently stubs) enforce authentication via `Depends(current_username)`.
- `service_console_api.py` — `service-manage` enforces authentication via `Depends(current_username)`
  and logs the operator on a start/stop/restart.
- `docs_api.py` — `/catalog` + `/content` resolve `body.caller`, then the existing per-audience RBAC
  (`_docs_access` → User Guide `SCREEN/docs` / Technical Guide `SCREEN/docs_technical`) authorizes the
  real user. A technical doc is never returned to a non-technical caller (re-checked on both endpoints).

**Per-screen coverage** (which backend modules resolve the caller from the token):

| Screen / module | OIDC wired? | Notes |
|---|---|---|
| RBAC snapshot (`access_api` `/me`, `/effective`) | ✅ | identity from token |
| User Management (`access_api` `/admin/*`) | ✅ | caller + audit `granted_by` from token |
| Config Ops (`config_api`) | ✅ | per-endpoint actor field |
| Regression (`regression_api`) | ✅ | central gate → every endpoint |
| S-Studio (`sql_studio_api`) | ✅ | `_require_sql_admin` |
| Oracle Command Center (`oracle_cc_api`) | ✅ | writes (mv/gather/kill/apply) |
| Service Console (`service_console_api`) | ✅ | auth-enforced + operator logged |
| Docs — User + Technical (`docs_api`) | ✅ | + per-audience RBAC |
| **Log Analytics** (`log_analytics_api`) | ❌ | ungated "everyone" screen — no RBAC. Serves log-file contents, so **authentication-only** enforcement is a reasonable hardening (optional). |
| **Infrastructure Health** (`infrastructure_health_api`) | ❌ | ungated "everyone" screen — no RBAC; read-only metrics. Authentication-only optional. |
| `system_api` (memory/uptime) | ❌ | global read, no user identity. |

Log Analytics + Infra Health are the two ungated-by-design screens (every active user sees all), so they
need **no RBAC**. If you want them to still require a *logged-in* user when OIDC is on (defence in depth —
Log Analytics exposes log contents), add `Depends(current_username)` to their routes; that enforces a valid
token (401 without) without any per-user authorization. Not done, per the current call that they don't need it.

**Authentication vs authorization:** this wiring makes every write **authenticated** (real identity,
401 without a token when OIDC is on) and **audited** (the real UID is logged / gate-checked). The
modules that already had a server-side RBAC gate (regression, sql_studio, config) now authorize the
*real* user. Two endpoints that historically had **no** server-side authorization — `oracle_cc`
kill/apply and `service_console` start/stop/restart (write-gated only in the UI via `*olsCanWrite`) —
are now authenticated but still rely on the UI for the write-permission check; adding a server-side
RBAC re-check there is the recommended next hardening.

### 4.5 Backend config — per-environment YAML ([`backend/config/oidc_config.yml`](backend/config/oidc_config.yml))

OIDC provider details live in **one committed YAML with `dev` / `stg` / `prod` sections**. The backend reads
the section matching **`APP_ENV`** (the only env-specific line in `backend/.env`), so `.env` stays generic and
the config travels with the code — no per-server OIDC edits. Fill each section in once:

```yaml
dev:
  validate_token: false            # OIDC off in DEV (dev-bypass); true = enforce
  issuer:  "https://login-dev.yourbank.com"
  audience: ["ols-dashboard-dev"]
  # jwks_url blank → <issuer>/.well-known/jwks.json ; username_claim/algorithms/leeway have defaults
stg:
  validate_token: true
  issuer:  "https://login-stg.yourbank.com"
  audience: ["ols-dashboard-stg"]
prod:
  validate_token: true
  issuer:  "https://login.yourbank.com"
  audience: ["ols-dashboard"]
```

Then each server's `backend/.env` just needs its environment selector:

```ini
APP_ENV=PROD                         # DEV | STG | PROD → picks the oidc_config.yml section
```

**Precedence per key:** the matching env var (if set — a break-glass override on one server) → the YAML
section → a built-in default. So the commented `AUTH_VALIDATE_TOKEN` / `OIDC_*` keys in `.env.example` still
work to override a single value, but normally you leave them unset and edit the YAML. `OIDC_CONFIG_FILE`
relocates the YAML; if PyYAML or the file is missing, the backend falls back to env vars + defaults.

> Values are read **once at process start** — **restart the backend** after editing the YAML or `.env`
> (`--reload` is unreliable on Windows; hard-restart per [`backend-uvicorn-reload-unreliable`]).

---

## 5. Part C — Turn on real RBAC (makes your grants take effect)

Independent of SSO, but required for real access. Three steps:

1. **`backend/.env`** → `ACCESS_USE_DUMMY=0`.
2. **Wire the app DB.** [`app.py`](backend/app.py) currently has the stub
   `app.state.app_db_config = {}`. Point it at the database that holds `ols_users` + `ols_app_access`
   (same connection pattern as the other DB configs — build it from `APP_ENV` + per-env creds, e.g.
   `OLS_APP_DB_DSN` / `_USER` / `_PASSWORD`). Without this, `ACCESS_USE_DUMMY=0` makes
   `fetch_user_identity` fail → HTTP 500.
3. **Restart** the backend.

Then `POST /api/access/me` runs the real path: `fetch_user_identity` + `fetch_user_grants` +
`fetch_is_ops_admin` + `fetch_can_sql` → `build_snapshot`. Your `IS_ADMIN` flag / grants now drive
the UI. Confirm the required tables exist: `backend/sql/rbac_setup.sql`, `ops_access_setup.sql`.

---

## 6. Deployment notes

- **Same-origin, no CORS.** Each env's `ui_server.py` proxies `/api/*` to that env's backend
  (see [`env-config-runtime-detection`] / DEPLOYMENT.md). Confirm the proxy **forwards the
  `Authorization` header** to the backend (it must, for token validation to see it).
- **Clock skew.** PyJWT allows a small `leeway`; if you see spurious "expired" errors, add
  `leeway=30` to `jwt.decode`.
- **Token storage.** Tokens live in `localStorage` (`ols.token` / `ols.user` / `ols.token.exp` /
  `ols.refresh`). This is standard for a PKCE SPA; if your security policy forbids it, that's a
  larger change (BFF / cookie-based) — raise it separately.
- **Logout.** `logout()` clears local tokens and redirects to the provider's `end_session_endpoint`,
  so the next sign-in re-authenticates.

---

## 7. Test plan

1. **Local unchanged.** With `isSsoEnabled:false` + `AUTH_VALIDATE_TOKEN` unset, local dev still uses
   the bypass login + frontend mock (ADMIN). Nothing regresses.
2. **Staging AuthN.** Point `SSO_CONFIG` at the STG IdP, `isSsoEnabled:true`, deploy: Sign in →
   provider login → back to `/auth/callback` → lands on Home. Check `localStorage['ols.user']` shows
   your real UID.
3. **Staging AuthZ.** `ACCESS_USE_DUMMY=0` + `app_db_config` wired + `AUTH_VALIDATE_TOKEN=1`, restart.
   Sign in as an `IS_ADMIN='Y'` user → all screens; as a granted READ user → only granted screens;
   as a user absent from `ols_users` → the "no access / raise a request" page.
4. **Spoofing check.** Call `POST /api/access/me` with a body username but **no** `Authorization`
   header → **401** (not a snapshot). Confirms the body is no longer trusted.
5. **Silent renew.** Leave the app open past the access-token lifetime → it refreshes without a
   re-login (needs `offline_access`).

---

## 8. Rollback

Fully reversible, no redeploy of code needed — just config:

- Frontend: `isSsoEnabled:false` → dev-bypass login returns.
- Backend: `AUTH_VALIDATE_TOKEN=0` (trust body again) and/or `ACCESS_USE_DUMMY=1` (canned RBAC), then
  restart.

---

## 9. Checklist

- [ ] SPA registered with IdP (per-origin redirect + post-logout URIs, PKCE, scopes, audience)
- [ ] `SSO_CONFIG` filled in
- [ ] `isSsoEnabled: true`
- [x] `PyJWT[crypto]` added to `backend/requirements.txt` *(run `pip install -r requirements.txt` on the server)*
- [x] `backend/auth_token.py` added; wired into `/api/access/me`, `/effective`, `/admin/*`
- [x] Token check wired into the other modules' write endpoints (§4.4 — regression / sql_studio / config / oracle_cc / service_console)
- [x] `OIDC_*` + `AUTH_VALIDATE_TOKEN` + `AUTH_DEV_USER` documented in `.env.example`; set them (`AUTH_VALIDATE_TOKEN=1`) in each server's `.env`
- [ ] `ACCESS_USE_DUMMY=0` and `app.state.app_db_config` wired to the app DB (`app.py`)
- [ ] `rbac_setup.sql` / `ops_access_setup.sql` applied; your UID active in `ols_users`
- [ ] Backend restarted; `ui_server` forwards `Authorization`
- [ ] Test plan §7 passed

<!-- Keep this file in step with src/app/auth/*, backend/access_api.py, and RBAC_DESIGN.md §Security. -->
