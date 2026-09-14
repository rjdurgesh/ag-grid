"""OIDC access-token validation.

Verifies the incoming ``Authorization: Bearer <jwt>`` against the identity provider's JWKS
(signature) and its ``iss`` / ``aud`` / ``exp`` claims, then returns the caller's username **from
the validated token** — never from the request body (see RBAC_DESIGN.md §Security). Wire the
``current_username`` dependency into ``/api/access/me`` and every write endpoint so the server
trusts the token, not client-supplied identity.

DEV / DUMMY: while ``AUTH_VALIDATE_TOKEN`` is off (the default), ``current_username`` returns ``""``
so callers fall back to the body username exactly as before — and ``jwt`` is imported LAZILY, so the
backend runs without ``PyJWT`` installed. Flip ``AUTH_VALIDATE_TOKEN=1`` (and set the ``OIDC_*``
vars) to enforce real validation. Full go-live guide: AUTH_SETUP.md.

Config lives in ``backend/config/oidc_config.yml`` — ONE file with ``dev`` / ``stg`` / ``prod`` sections;
the section is chosen by ``APP_ENV`` (backend/.env), so .env stays generic and the config travels with the
code. All values are read ONCE at import, so restart after changing them. Precedence per key: the matching
env var (if set — break-glass / back-compat) → the YAML section → a built-in default. If PyYAML or the file
is absent, only env vars + defaults are used (the previous behaviour). Point elsewhere with OIDC_CONFIG_FILE.

  Key (YAML / env-var override)   Meaning
  validate_token / AUTH_VALIDATE_TOKEN   THE ON/OFF SWITCH. true(1) = OIDC ON — require + validate a bearer
                        token, identity from the token. false(0) = OIDC OFF (debug/dummy) — no token; the
                        caller is dev_user/AUTH_DEV_USER if set, else the request body's own username.
  dev_user / AUTH_DEV_USER   (only when OIDC is OFF) a hardcoded UID to authenticate AS while debugging —
                        give it access in ols_users / ols_app_access (or, under ACCESS_USE_DUMMY=1, a name
                        containing "ADMIN"). Blank = fall back to the body username.
  issuer / OIDC_ISSUER            the provider's issuer URL (validated against the token's ``iss``).
  audience / OIDC_AUDIENCE        expected ``aud`` (YAML list, or comma-separated env; empty = skip aud check).
  jwks_url / OIDC_JWKS_URL        the provider's JWKS endpoint (defaults to <issuer>/.well-known/jwks.json).
  username_claim / OIDC_USERNAME_CLAIM   claim carrying the corporate UID that matches ols_users.USERNAME
                        (default ``preferred_username``; falls back to ``sub``). Must be in the access token.
  algorithms / OIDC_ALGORITHMS    allowed signing algs (YAML list, or comma-separated env; default ``RS256``).
  leeway / OIDC_LEEWAY            seconds of clock-skew tolerance for exp/iat (default 30).
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import HTTPException, Request

import env_loader  # noqa: F401 — importing loads backend/.env into os.environ before we read APP_ENV etc.
from utils.logging import get_logger

logger = get_logger(__name__)

# --- per-environment OIDC config (backend/config/oidc_config.yml, section chosen by APP_ENV) ----------
# ONE YAML holds dev/stg/prod sections of NON-SECRET provider values, so .env stays generic (only APP_ENV
# changes per server) and the config travels with the code. Precedence per key: the OIDC_*/AUTH_* env var
# (if set — break-glass / back-compat) → the YAML section for APP_ENV → a built-in default. If PyYAML or the
# file is missing, we fall back to env vars + defaults only — i.e. exactly the previous behaviour.
_APP_ENV = os.getenv("APP_ENV", "PROD").strip().lower()


def _load_oidc_section() -> dict:
    """The oidc_config.yml section for APP_ENV (dev/stg/prod). {} on any problem (file/PyYAML/parse) so
    callers cleanly fall back to env vars + defaults."""
    path = Path(os.getenv("OIDC_CONFIG_FILE", str(Path(__file__).parent / "config" / "oidc_config.yml")))
    if not path.is_file():
        return {}
    try:
        import yaml
    except Exception:
        logger.warning("oidc_config.yml present but PyYAML is not installed — using OIDC_* env vars only.")
        return {}
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception as exc:  # noqa: BLE001
        logger.error("Could not parse %s: %s — using OIDC_* env vars only.", path, exc)
        return {}
    section = data.get(_APP_ENV) or data.get(_APP_ENV.upper()) or {}
    return section if isinstance(section, dict) else {}


_OIDC = _load_oidc_section()


def _cfg_str(env_key: str, yaml_key: str, default: str = "") -> str:
    """env var (non-empty) → YAML section value → default, as a trimmed string."""
    v = os.getenv(env_key)
    if v is not None and v.strip():
        return v.strip()
    yv = _OIDC.get(yaml_key)
    return str(yv).strip() if yv is not None and str(yv).strip() else default


def _cfg_bool(env_key: str, yaml_key: str, default: bool = False) -> bool:
    v = os.getenv(env_key)
    if v is not None and v.strip():
        return v.strip().lower() in ("1", "true", "yes", "on")
    yv = _OIDC.get(yaml_key)
    if isinstance(yv, bool):
        return yv
    if yv is not None and str(yv).strip():
        return str(yv).strip().lower() in ("1", "true", "yes", "on")
    return default


def _cfg_list(env_key: str, yaml_key: str, default: list[str]) -> list[str]:
    v = os.getenv(env_key)
    if v is not None and v.strip():
        return [x.strip() for x in v.split(",") if x.strip()]
    yv = _OIDC.get(yaml_key)
    if isinstance(yv, (list, tuple)):
        return [str(x).strip() for x in yv if str(x).strip()]
    if yv is not None and str(yv).strip():
        return [x.strip() for x in str(yv).split(",") if x.strip()]
    return list(default)


# THE ON/OFF SWITCH. false = OIDC off (debug/dummy) → no token; true = OIDC on → validate a bearer token.
AUTH_VALIDATE_TOKEN = _cfg_bool("AUTH_VALIDATE_TOKEN", "validate_token", False)
# When OIDC is OFF, authenticate as this fixed UID (give it real access in the tables). Blank → the
# request body's own username is used instead (so the frontend keeps working with no extra config).
AUTH_DEV_USER = _cfg_str("AUTH_DEV_USER", "dev_user", "")

OIDC_ISSUER = _cfg_str("OIDC_ISSUER", "issuer", "")
OIDC_AUDIENCE = _cfg_list("OIDC_AUDIENCE", "audience", [])
OIDC_JWKS_URL = _cfg_str("OIDC_JWKS_URL", "jwks_url", "") or (
    f"{OIDC_ISSUER.rstrip('/')}/.well-known/jwks.json" if OIDC_ISSUER else "")
OIDC_USERNAME_CLAIM = _cfg_str("OIDC_USERNAME_CLAIM", "username_claim", "preferred_username") or "preferred_username"
OIDC_ALGORITHMS = _cfg_list("OIDC_ALGORITHMS", "algorithms", ["RS256"])
OIDC_LEEWAY = int(_cfg_str("OIDC_LEEWAY", "leeway", "30") or 30)

# Lazily-built JWKS client (PyJWKClient caches fetched signing keys). Created on first real use so the
# module imports cleanly when PyJWT isn't installed and validation is off.
_jwks_client = None


def _get_jwks_client():
    """Build (once) the PyJWKClient. Raises a clear 500 if PyJWT is missing or JWKS isn't configured."""
    global _jwks_client
    if _jwks_client is None:
        if not OIDC_JWKS_URL:
            raise HTTPException(status_code=500, detail="OIDC not configured: set OIDC_ISSUER or OIDC_JWKS_URL.")
        try:
            from jwt import PyJWKClient
        except Exception as exc:  # PyJWT not installed
            logger.error("AUTH_VALIDATE_TOKEN is on but PyJWT is not installed: %s", exc)
            raise HTTPException(status_code=500, detail="Token validation library not installed (pip install 'PyJWT[crypto]').")
        _jwks_client = PyJWKClient(OIDC_JWKS_URL)
    return _jwks_client


def _bearer(request: Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    return auth[7:].strip() if auth.lower().startswith("bearer ") else None


def current_username(request: Request) -> str:
    """FastAPI dependency → the caller username, per the AUTH_VALIDATE_TOKEN switch.

    * ``AUTH_VALIDATE_TOKEN=0`` (OIDC off / debug): returns ``AUTH_DEV_USER`` if configured, else
      ``""`` so callers fall back to the body username. No token is required.
    * ``AUTH_VALIDATE_TOKEN=1`` (OIDC on): a missing / invalid / expired token → HTTP 401; otherwise
      the username claim from the verified token.
    """
    if not AUTH_VALIDATE_TOKEN:
        return AUTH_DEV_USER  # OIDC off: fixed debug identity (or "" → caller uses the body username)
    token = _bearer(request)
    if not token:
        raise HTTPException(status_code=401, detail="Missing bearer token")
    import jwt  # lazy — only needed when validation is enabled
    try:
        signing_key = _get_jwks_client().get_signing_key_from_jwt(token).key
        claims = jwt.decode(
            token,
            signing_key,
            algorithms=OIDC_ALGORITHMS,
            audience=OIDC_AUDIENCE or None,   # None → skip aud check when unset
            issuer=OIDC_ISSUER or None,
            leeway=OIDC_LEEWAY,
            options={"require": ["exp"], "verify_aud": bool(OIDC_AUDIENCE)},
        )
    except HTTPException:
        raise
    except Exception as exc:  # signature / exp / aud / iss failure
        logger.warning("token validation failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    uname = str(claims.get(OIDC_USERNAME_CLAIM) or claims.get("sub") or "").strip()
    if not uname:
        raise HTTPException(status_code=401, detail="Token has no username claim")
    return uname


def caller_or_body(token_user: str, body_value: str | None) -> str:
    """Resolve the effective caller: the validated token username when present (prod), else the
    body value (dev / dummy). Use in endpoints that currently read a ``caller``/``username`` field."""
    return token_user or (body_value or "")


def resolve_caller(request: Request, body_caller: str | None = "") -> str:
    """One-shot for write endpoints: the effective caller = validated token identity (OIDC on) →
    ``AUTH_DEV_USER`` (OIDC off, if set) → the body's own caller value. Raises 401 when OIDC is on and
    the token is missing/invalid, so calling this at the top of an endpoint also ENFORCES authentication.
    Assign it back (``body.caller = resolve_caller(request, body.caller)``) so the RBAC gate AND the audit
    trail both use the real identity, never a spoofable body field."""
    return caller_or_body(current_username(request), body_caller)
