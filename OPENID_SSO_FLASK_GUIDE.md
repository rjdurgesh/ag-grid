# OpenID Connect (SSO) + REST Login — Flask Backend Guide

Companion to `OPENID_SSO_GENERIC_GUIDE.md` (which uses FastAPI). Same Angular frontend, same design —
here the backend is **Flask (REST API)**. It covers **both** login paths the SPA can use:

- **Mode A — OpenID SSO:** the SPA logs in at the IdP and sends the **`id_token`** (a JWT); Flask
  validates it against the provider's JWKS. Identity comes from the token.
- **Mode B — Direct REST login:** the SPA posts `username`/`password` to `POST /api/auth/login`; Flask
  verifies the credentials against your DB and returns an **app-signed JWT** + the user. This is the path
  the Angular `AuthService.login()` method uses (explained in detail in §7).

In **both** modes: **identity** (username/email/name) is what you show on the profile, and **role**
(Admin / Normal) is read from **your DB** (e.g. `ols_users`) — never trusted from the client.

> ⚠️ **Gotcha (Mode A):** send the **`id_token`**, not the `access_token`. Many IdPs issue an *opaque*
> access_token that isn't a JWT and can't be decoded. The `id_token` is always a JWT.

---

## 1. The enable / disable flag

One backend switch, in `.env`, selects the mode; the frontend has a matching per-env toggle.

`.env` holds only what's **per-server or secret**. The **OIDC provider values live in
`config/oidc_config.yml`** (one file, per-env `dev`/`stg`/`prod` sections, chosen by `APP_ENV`) — see §3a.

```dotenv
# backend .env  — per-server + secrets ONLY
APP_ENV=PROD                         # selects the oidc_config.yml section (dev/stg/prod)
APP_JWT_SECRET=change-me-long-random # SECRET — signs/verifies the app's own JWTs (Mode B, HS256)
APP_JWT_TTL_MIN=480                  # Mode B token lifetime in minutes
# (Optional break-glass overrides of the yml, only if ever needed on one box:)
# AUTH_VALIDATE_TOKEN=1              # overrides validate_token; 1 = SSO on (Mode A), 0 = REST login (Mode B)
# AUTH_DEV_USER=                     # overrides dev_user (OIDC off: authenticate AS this fixed UID)
```

The on/off switch (`validate_token`) and all provider values (`issuer`, `audience`, `jwks_url`, …) are
read from the **yml section for `APP_ENV`**, so switching an environment is just `APP_ENV=` + the committed
yml — no OIDC values in `.env`.

```ts
// frontend src/environments/environment.ts
const SSO_ENABLED_BY_ENV: Record<AppEnv, boolean> = { DEV: false, STG: true, LIVE: true };
export const environment = { /* … */ isSsoEnabled: SSO_ENABLED_BY_ENV[RESOLVED_ENV] };
```

| `isSsoEnabled` (FE) | `AUTH_VALIDATE_TOKEN` (BE) | Behaviour |
| --- | --- | --- |
| `true` | `1` | **Mode A** — OIDC redirect login; API enforces the IdP id_token. |
| `false` | `0` | **Mode B** (or dev-bypass) — username/password form → `/api/auth/login`; API validates its own JWT. |
| mismatched | | Avoid — align both per environment. |

---

## 2. Dependencies

```bash
pip install Flask "PyJWT[crypto]" flask-cors python-dotenv PyYAML
```

- `PyJWT[crypto]` — verify RS256 id_tokens (Mode A) and sign/verify HS256 app tokens (Mode B).
- `PyYAML` — read `config/oidc_config.yml` (the per-env OIDC config; see §3a).
- `flask-cors` — only needed for **local** cross-origin dev (`ng serve :4200` → API `:5000`). In prod the
  UI and API share one origin (reverse proxy), so CORS isn't needed there.
- `python-dotenv` — load `.env` (or use your process manager's env).

---

### 3a. `config/oidc_config.yml` (committed; one section per env — the OIDC source of truth)

```yaml
# The section for APP_ENV is used, so .env only needs APP_ENV. These are non-secret provider/discovery
# values (the SPA uses Auth Code + PKCE — no client secret here), so this file is committed.
dev:
  validate_token: false            # OIDC off in dev (Mode B / dev-bypass). true = OIDC on (Mode A).
  dev_user: ""                     # OIDC off: authenticate AS this UID; blank = body username
  issuer: "https://login-dev.example.com"
  audience: ["your-spa-client-id-dev"]   # the id_token's aud = the SPA client_id (or [] to skip)
  jwks_url: ""                     # blank → <issuer>/.well-known/jwks.json
  username_claim: "preferred_username"
  algorithms: ["RS256"]
  leeway: 30
stg:  { validate_token: true, issuer: "https://login-stg.example.com", audience: ["your-spa-client-id-stg"] }
prod: { validate_token: true, issuer: "https://login.example.com",     audience: ["your-spa-client-id"] }
```

### 3b. Config loader — `config.py` (reads the yml section for APP_ENV; env only overrides)

```python
import os
from pathlib import Path
from dotenv import load_dotenv
load_dotenv()  # load backend/.env (APP_ENV + secrets)

APP_ENV = os.getenv("APP_ENV", "PROD").strip().lower()

def _load_oidc_section() -> dict:
    """The oidc_config.yml section for APP_ENV. {} on any problem → fall back to env/defaults."""
    path = Path(os.getenv("OIDC_CONFIG_FILE", str(Path(__file__).parent / "config" / "oidc_config.yml")))
    if not path.is_file():
        return {}
    try:
        import yaml
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception:
        return {}
    section = data.get(APP_ENV) or data.get(APP_ENV.upper()) or {}
    return section if isinstance(section, dict) else {}

_OIDC = _load_oidc_section()

# Precedence per key: env var (break-glass) → yml section → default.
def _cfg_str(env_key, yaml_key, default=""):
    v = os.getenv(env_key)
    if v and v.strip():
        return v.strip()
    yv = _OIDC.get(yaml_key)
    return str(yv).strip() if yv not in (None, "") else default
def _cfg_bool(env_key, yaml_key, default=False):
    v = os.getenv(env_key)
    if v and v.strip():
        return v.strip().lower() in ("1", "true", "yes", "on")
    yv = _OIDC.get(yaml_key)
    return (str(yv).strip().lower() in ("1", "true", "yes", "on")) if yv not in (None, "") else default
def _cfg_list(env_key, yaml_key, default):
    v = os.getenv(env_key)
    if v and v.strip():
        return [x.strip() for x in v.split(",") if x.strip()]
    yv = _OIDC.get(yaml_key)
    if isinstance(yv, (list, tuple)):
        return [str(x).strip() for x in yv if str(x).strip()]
    return [x.strip() for x in str(yv).split(",") if x.strip()] if yv not in (None, "") else list(default)

AUTH_VALIDATE_TOKEN = _cfg_bool("AUTH_VALIDATE_TOKEN", "validate_token", False)   # THE SSO ON/OFF SWITCH
AUTH_DEV_USER       = _cfg_str("AUTH_DEV_USER", "dev_user", "")

# SECRETS stay in .env (never in the committed yml):
APP_JWT_SECRET  = os.getenv("APP_JWT_SECRET", "")
APP_JWT_TTL_MIN = int(os.getenv("APP_JWT_TTL_MIN", "480") or 480)

OIDC_ISSUER    = _cfg_str("OIDC_ISSUER", "issuer", "")
OIDC_AUDIENCE  = _cfg_list("OIDC_AUDIENCE", "audience", [])
OIDC_JWKS_URL  = _cfg_str("OIDC_JWKS_URL", "jwks_url", "") or (
    f"{OIDC_ISSUER.rstrip('/')}/.well-known/jwks.json" if OIDC_ISSUER else "")
OIDC_USERNAME_CLAIM = _cfg_str("OIDC_USERNAME_CLAIM", "username_claim", "preferred_username") or "preferred_username"
OIDC_ALGORITHMS = _cfg_list("OIDC_ALGORITHMS", "algorithms", ["RS256"])
OIDC_LEEWAY     = int(_cfg_str("OIDC_LEEWAY", "leeway", "30") or 30)
```

> Add `PyYAML` to the deps for this: `pip install PyYAML`.

---

## 4. Authentication core — `auth.py`

Handles token verification for **both** modes and exposes a `@require_auth` decorator plus
`current_username()`. It puts the resolved username on Flask's request-global `g`.

```python
import time
import jwt                          # PyJWT
from functools import wraps
from flask import request, jsonify, g
import config

_jwks_client = None
def _get_jwks_client():
    global _jwks_client
    if _jwks_client is None:
        if not config.OIDC_JWKS_URL:
            raise RuntimeError("OIDC not configured: set OIDC_ISSUER or OIDC_JWKS_URL.")
        from jwt import PyJWKClient
        _jwks_client = PyJWKClient(config.OIDC_JWKS_URL)
    return _jwks_client

def _bearer():
    auth = request.headers.get("Authorization", "")
    return auth[7:].strip() if auth.lower().startswith("bearer ") else None

# ---- Mode A: verify the IdP id_token (RS256 via JWKS) --------------------------
def _verify_oidc(token: str) -> str:
    key = _get_jwks_client().get_signing_key_from_jwt(token).key
    claims = jwt.decode(
        token, key, algorithms=config.OIDC_ALGORITHMS,
        audience=config.OIDC_AUDIENCE or None, issuer=config.OIDC_ISSUER or None,
        leeway=config.OIDC_LEEWAY,
        options={"require": ["exp"], "verify_aud": bool(config.OIDC_AUDIENCE)},
    )
    return str(claims.get(config.OIDC_USERNAME_CLAIM) or claims.get("sub") or "").strip()

# ---- Mode B: sign / verify the app's own JWT (HS256) --------------------------
def issue_app_token(username: str) -> str:
    now = int(time.time())
    payload = {"sub": username, "iat": now, "exp": now + config.APP_JWT_TTL_MIN * 60}
    return jwt.encode(payload, config.APP_JWT_SECRET, algorithm="HS256")

def _verify_app_token(token: str) -> str:
    claims = jwt.decode(token, config.APP_JWT_SECRET, algorithms=["HS256"],
                        options={"require": ["exp"]}, leeway=30)
    return str(claims.get("sub") or "").strip()

# ---- Unified resolver ---------------------------------------------------------
def current_username() -> str:
    """OIDC on → verify the IdP id_token. OIDC off → verify the app JWT from /api/auth/login,
    else fall back to AUTH_DEV_USER (dev-bypass). Raises 401 (via abort) on a bad/missing token."""
    if config.AUTH_VALIDATE_TOKEN:
        token = _bearer()
        if not token:
            _unauthorized("Missing bearer token")
        try:
            uname = _verify_oidc(token)
        except Exception as exc:
            _unauthorized(_token_error(exc))
        if not uname:
            _unauthorized("Token has no username claim")
        return uname
    # OIDC off:
    token = _bearer()
    if token and config.APP_JWT_SECRET:
        try:
            return _verify_app_token(token)
        except Exception:
            pass                      # fall through to dev-bypass
    return config.AUTH_DEV_USER       # '' → the caller may fall back to a body username

def require_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        g.username = current_username()          # 401s if invalid when enforcement is on
        return fn(*args, **kwargs)
    return wrapper

# ---- helpers ------------------------------------------------------------------
class _AuthError(Exception):
    def __init__(self, msg): self.msg = msg
def _unauthorized(msg): raise _AuthError(msg)

def _token_error(exc) -> str:
    name, msg = exc.__class__.__name__, str(exc).lower()
    if name == "ExpiredSignatureError" or "expired" in msg: return "Token has expired — sign in again."
    if name == "InvalidAudienceError" or "audience" in msg:
        return "Token audience mismatch — set OIDC_AUDIENCE to your client_id, or clear it to skip."
    if name == "InvalidIssuerError" or "issuer" in msg: return "Token issuer mismatch (check OIDC_ISSUER)."
    if "not enough segments" in msg or "not a valid jwt" in msg:
        return "Token is not a JWT (opaque) — the SPA must send the id_token, not the access_token."
    if name == "InvalidSignatureError" or "signature" in msg: return "Token signature could not be verified."
    return "Invalid or expired token."
```

Register a single 401 handler so `_AuthError` becomes a clean JSON 401:

```python
# app.py
from flask import Flask, jsonify
from auth import _AuthError

app = Flask(__name__)

@app.errorhandler(_AuthError)
def _on_auth_error(e):
    return jsonify({"detail": e.msg}), 401
```

---

## 5. Role FROM your DB (not the token)

```python
def fetch_user_role(username: str) -> dict:
    """Return {'active': bool, 'role': 'ADMIN'|'USER'|…} from ols_users (your DB)."""
    row = db.execute("SELECT is_active, is_admin FROM ols_users WHERE username = %s", (username,)).fetchone()
    if not row or not row["is_active"]:
        return {"active": False, "role": "NONE"}
    return {"active": True, "role": "ADMIN" if row["is_admin"] else "USER"}
```

---

## 6. Endpoints — `routes_auth.py`

```python
from flask import Blueprint, request, jsonify, g
from auth import require_auth, current_username, issue_app_token
import config

bp = Blueprint("auth", __name__, url_prefix="/api")

# ---- Mode B: direct username/password login (what AuthService.login() calls) ----
@bp.post("/auth/login")
def login():
    if config.AUTH_VALIDATE_TOKEN:
        # SSO is on → the SPA logs in at the IdP, not here.
        return jsonify({"detail": "Password login is disabled; use SSO."}), 404
    body = request.get_json(silent=True) or {}
    username, password = (body.get("username") or "").strip(), body.get("password") or ""
    if not username or not password:
        return jsonify({"detail": "Username and password are required"}), 400
    if not verify_credentials(username, password):     # ← your DB / LDAP check (hash compare)
        return jsonify({"detail": "Invalid username or password"}), 401
    info = fetch_user_role(username)
    if not info["active"]:
        return jsonify({"detail": "Account is inactive"}), 403
    profile = fetch_user_profile(username)             # {username, displayName, email} from your DB
    # ►► Shape MUST be LoginResponse = { token, user } (see §7).
    return jsonify({
        "token": issue_app_token(username),
        "user": {
            "username": username,
            "displayName": profile.get("display_name") or username,
            "email": profile.get("email"),
            "role": info["role"],
        },
    })

@bp.post("/auth/logout")
def logout():
    return jsonify({"success": True})                  # stateless JWT → nothing to invalidate server-side

# ---- Profile / authorization snapshot (both modes) ----
@bp.get("/access/me")
@require_auth
def me():
    username = g.username                              # from the verified token (Mode A or B)
    info = fetch_user_role(username)                   # role from ols_users
    profile = fetch_user_profile(username)
    return jsonify({
        "username": username,
        "active": info["active"],
        "role": info["role"],                         # ← Admin / Normal, FROM the DB
        "displayName": profile.get("display_name"),
        "email": profile.get("email"),
    })

# ---- Example protected write endpoint ----
@bp.post("/config/save")
@require_auth
def save_config():
    caller = g.username                                # real identity for RBAC + audit
    # … authorize with fetch_user_role(caller) and proceed …
    return jsonify({"status": "success"})
```

Wire it up + CORS for local dev:

```python
# app.py
from flask_cors import CORS
from routes_auth import bp as auth_bp

CORS(app, resources={r"/api/*": {"origins": ["http://localhost:4200"]}}, supports_credentials=True)
app.register_blueprint(auth_bp)
```

> `verify_credentials`, `fetch_user_profile` are yours: check the password hash (e.g. `bcrypt`/`argon2`)
> against your user store, and read the display name/email. **Never store or compare plaintext passwords.**

---

## 7. Deep-dive: the Angular `AuthService.login()` method

```ts
login(username: string, password: string): Observable<LoginResponse> {
  return this.api.post<LoginResponse>(API.auth.login, { username, password }).pipe(
    tap((res) => {
      localStorage.setItem(TOKEN_KEY, res.token);                       // 1
      localStorage.setItem(USER_KEY, JSON.stringify(res.user));         // 2
      localStorage.setItem(LOGIN_AT_KEY, new Date().toISOString());     // 3
      this.user.set(res.user);                                          // 4
      this.rbac.reset();                                                // 5
    })
  );
}
```

**When it runs:** only in **Mode B** — SSO **off**, with a real username/password **login form**. (In
Mode A the login button calls `signIn()`, which redirects to the IdP instead; there's also a pure
dev-bypass in `signIn()` that fabricates a local user without any backend call.)

**What it does, line by line:**

1. **POST the credentials** to `API.auth.login` = `POST /api/auth/login` with body `{ username, password }`.
   The backend (`§6`) verifies them and returns `LoginResponse`.
2. The response contract is:
   ```ts
   interface LoginResponse { token: string; user: AuthUser; }
   interface AuthUser { username: string; displayName: string; email?: string; role: string; }
   ```
3. Inside `tap` (runs on a **successful** response only — HTTP errors skip it and surface to the caller):
   - **(1)** store `res.token` under `TOKEN_KEY`. This is the app-signed JWT from `issue_app_token()`; the
     HTTP interceptor then attaches it as `Authorization: Bearer <token>` on every subsequent API call,
     and `auth.current_username()` verifies it (Mode B branch).
   - **(2)** store `res.user` (the identity: username/displayName/email/role) so the header/profile can
     render immediately after reload without another call.
   - **(3)** store an ISO **login timestamp** — used by the account menu's "signed in … ago".
   - **(4)** `this.user.set(res.user)` — update the reactive **signal** so the header greeting/avatar
     update instantly (zoneless-friendly).
   - **(5)** `this.rbac.reset()` — clear any cached access snapshot and trigger a fresh **`/api/access/me`**,
     so the app's role/permissions reflect **this** user (role from `ols_users`). Without this you could
     briefly show the previous user's menu.
4. It **returns the Observable** (doesn't subscribe). The login component subscribes to know when to
   navigate and to show validation errors:

```ts
// login.component.ts
onSubmit(): void {
  this.auth.login(this.username, this.password).subscribe({
    next:  () => this.router.navigateByUrl(this.returnUrl || '/home'),
    error: (e) => this.error.set(e?.error?.detail || 'Sign in failed'),
  });
}
```

**Identity vs role recap for the profile:**
- **username / displayName / email** come from `res.user` (Mode B: from your DB; Mode A: from the id_token).
- **role** shown on the profile is `rbac.roleLabel()` (the DB role from `/api/access/me`), falling back to
  `res.user.role`. So role is always DB-driven; `login()` just seeds a sensible initial value.

**Security notes for `login()`/Mode B:**
- Serve over **HTTPS**; the app JWT is a bearer token.
- Sign with a strong random `APP_JWT_SECRET`; keep the TTL modest.
- The token is **self-contained** (stateless). To force logout everywhere you'd add a token version/jti
  check in `_verify_app_token`; the simple version just lets tokens expire.
- Rate-limit `/api/auth/login` and return a generic "Invalid username or password" (don't reveal which).

---

## 8. Frontend (unchanged from the FastAPI guide)

The Angular side is **identical regardless of backend framework** — Flask just answers the same HTTP
contract. For the full SPA code (SSO service with Auth Code + PKCE, the `AuthService` facade, the callback
component, the HTTP interceptor, and the route guard) see **§5–§8 of `OPENID_SSO_GENERIC_GUIDE.md`**.

What the backend must satisfy, either way:
- **Mode A (SSO):** accept `Authorization: Bearer <id_token>` and validate it (`§4`).
- **Mode B (REST login):** `POST /api/auth/login {username,password}` → `{ token, user }` (`§6`), then
  accept `Authorization: Bearer <token>` (the app JWT) on later calls.
- **Both:** `GET /api/access/me` returns the role from your DB.

---

## 9. Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| 401 `Token is not a JWT (opaque)` | Mode A: the SPA sent the access_token — send the **id_token**. |
| 401 `Token audience mismatch` | Set `OIDC_AUDIENCE` to the SPA **client_id**, or clear it to skip. |
| `/api/auth/login` returns 404 | `AUTH_VALIDATE_TOKEN=1` (SSO on) disables password login — that's intended. Use SSO, or set it to `0`. |
| 401 right after a successful login | Mode B: `APP_JWT_SECRET` differs between the signer and verifier (e.g. changed/blank), or the interceptor isn't attaching the token. |
| CORS error in local dev | Add the `ng serve` origin to `flask-cors` (`http://localhost:4200`). |
| Everything 401 | FE `isSsoEnabled` and BE `AUTH_VALIDATE_TOKEN` are mismatched — align them per environment. |
| Role always the fallback | `/api/access/me` not returning the DB role, or `rbac.reset()` not called after login. |
```
