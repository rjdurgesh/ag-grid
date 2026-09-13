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

Config (backend/.env — read ONCE at import, so restart after changing):
  AUTH_VALIDATE_TOKEN   THE ON/OFF SWITCH. 1 = OIDC ON — require + validate a bearer token, identity
                        comes from the token. 0 = OIDC OFF (debug/dummy) — no token needed; the caller
                        is AUTH_DEV_USER if set, else the request body's own username field.
  AUTH_DEV_USER         (only when OIDC is OFF) a hardcoded UID to authenticate AS while debugging —
                        give it the needed access in ols_users / ols_app_access (or, under
                        ACCESS_USE_DUMMY=1, a name containing "ADMIN" for the canned admin). Blank =
                        fall back to the body username (the frontend keeps working unchanged).
  OIDC_ISSUER           the provider's issuer URL (validated against the token's ``iss``).
  OIDC_AUDIENCE         expected ``aud`` (comma-separated allowed; empty = skip the aud check).
  OIDC_JWKS_URL         the provider's JWKS endpoint (defaults to <issuer>/.well-known/jwks.json).
  OIDC_USERNAME_CLAIM   claim carrying the corporate UID that matches ols_users.USERNAME
                        (default ``preferred_username``; falls back to ``sub``). Must be present in
                        the ACCESS token, which is what the SPA sends as the bearer.
  OIDC_ALGORITHMS       allowed signing algs (default ``RS256``; comma-separated).
  OIDC_LEEWAY           seconds of clock-skew tolerance for exp/iat (default 30).
"""

from __future__ import annotations

import os

from fastapi import HTTPException, Request

from env_loader import env_bool  # importing also loads backend/.env into os.environ
from utils.logging import get_logger

logger = get_logger(__name__)

# THE ON/OFF SWITCH. 0 = OIDC off (debug/dummy) → no token; 1 = OIDC on → validate a bearer token.
AUTH_VALIDATE_TOKEN = env_bool("AUTH_VALIDATE_TOKEN", False)
# When OIDC is OFF, authenticate as this fixed UID (give it real access in the tables). Blank → the
# request body's own username is used instead (so the frontend keeps working with no extra config).
AUTH_DEV_USER = os.getenv("AUTH_DEV_USER", "").strip()

OIDC_ISSUER = os.getenv("OIDC_ISSUER", "").strip()
OIDC_AUDIENCE = [a.strip() for a in os.getenv("OIDC_AUDIENCE", "").split(",") if a.strip()]
OIDC_JWKS_URL = os.getenv("OIDC_JWKS_URL", "").strip() or (
    f"{OIDC_ISSUER.rstrip('/')}/.well-known/jwks.json" if OIDC_ISSUER else "")
OIDC_USERNAME_CLAIM = os.getenv("OIDC_USERNAME_CLAIM", "preferred_username").strip() or "preferred_username"
OIDC_ALGORITHMS = [a.strip() for a in os.getenv("OIDC_ALGORITHMS", "RS256").split(",") if a.strip()]
OIDC_LEEWAY = int(os.getenv("OIDC_LEEWAY", "30") or 30)

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
