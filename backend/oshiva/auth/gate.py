"""Screen-level access gate for OSHIVA — "may you use OSHIVA at all?".

THE single place that decides who can see/use the bot. Two config knobs in ``config/assistant.json``:
  1. ``enabled``       — MASTER on/off. false ⇒ OSHIVA is off for EVERYONE (even B27886).
  2. ``allowed_users`` — the access mode:
       · ["B27886"]  → PRIVATE BETA: only these exact usernames (RBAC is bypassed — the pin is tighter).
       · ["*"]       → PUBLIC: everyone (RBAC bypassed the other way).
       · []  (empty) → MANAGED BY RBAC: whoever holds a ``SCREEN/assistant`` grant (granted in User
                       Management, exactly like the other screens). ← flip to this to "go live" on RBAC.

So RBAC is fully wired (assistant is a grantable screen), but while the pin is set it takes precedence,
keeping OSHIVA to B27886 until you clear the list. NOTE: the username is the AUTHENTICATED caller — with SSO
ON it's the real person; with SSO OFF the app shares one dummy identity, so use ``enabled`` as the gate.

This is the "Authorisation — screen gate" box in AI_ARCHITECTURE.md. Phase 2.4 (widen access) is just
clearing ``allowed_users`` and granting the screen. The per-tool business-line check is the separate
``scope_access`` module.
"""

from __future__ import annotations

from fastapi import HTTPException, Request

import config_loader
import database
from env_loader import env_bool

_CFG = config_loader.assistant_config()
# Reuse the shared access dummy flag: in dummy mode there is no per-user grant DB, so the RBAC branch is
# permissive (like docs_api). The private-beta allow-list still applies on top.
_ACCESS_USE_DUMMY = env_bool("ACCESS_USE_DUMMY", True)


def _has_rbac_assistant(request: Request, caller: str) -> bool:
    """True if the caller holds a (non-DENY) SCREEN/assistant grant. Dummy mode → permissive (no grant DB)."""
    if _ACCESS_USE_DUMMY:
        return True
    cfg = getattr(request.app.state, "app_db_config", None)
    for g in (database.fetch_user_grants(cfg, caller) or []):
        if ((g.get("resource_type") or "").strip().upper() == "SCREEN"
                and (g.get("resource_scope") or "").strip().lower() == "assistant"
                and (g.get("access_level") or "").strip().upper() != "DENY"):
            return True
    return False


def is_allowed(request: Request, caller: str) -> bool:
    """Whether ``caller`` may use OSHIVA (visibility check — never raises)."""
    if not bool(_CFG.get("enabled", True)):
        return False
    allowed = {str(u).strip() for u in _CFG.get("allowed_users", [])}
    if "*" in allowed:
        return True                       # PUBLIC
    if allowed:
        return caller in allowed          # PRIVATE BETA pin (RBAC bypassed)
    return _has_rbac_assistant(request, caller)   # MANAGED BY RBAC


def require_assistant(request: Request, caller: str) -> None:
    """The single access chokepoint (RBAC-aware; pin takes precedence while set)."""
    if not is_allowed(request, caller):
        raise HTTPException(status_code=403, detail="OSHIVA is not enabled for your account.")
