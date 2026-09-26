"""Tool-level authorization for OSHIVA.

Answers "which business scopes (group / cib / retail) may this caller see estate data for?" so a tool can
refuse anything outside the user's access (e.g. a user without CIB asking for CIB servers). This is the
"tools run as the user" principle from AI_ARCHITECTURE.md — the assistant can never surface data the person
couldn't see in the UI.

Resolution:
  * REAL mode (ACCESS_USE_DUMMY off): derive from the caller's RBAC — full-access wildcard → all scopes,
    else the caller's Config-Ops scopes from ``access_api.build_snapshot`` (used as the estate-scope proxy;
    refine per tool when tools go fully live).
  * DUMMY / dev mode: from ``oshiva/assistant.json`` — ``dummy_scope_grants`` maps a username to its scopes,
    falling back to ``dummy_default_scopes`` (default ["*"] = all). This lets us DEMONSTRATE denials in dev
    (e.g. give the dev user only retail+group and watch CIB get refused).

``{"*"}`` means "all scopes".
"""

from __future__ import annotations

from fastapi import Request

import access_api
import config_loader
import database
from env_loader import env_bool

_ACCESS_USE_DUMMY = env_bool("ACCESS_USE_DUMMY", True)
_ALL = {"*"}
_SCOPES = ("group", "cib", "retail")


def allowed_scopes(request: Request, caller: str) -> set[str]:
    """The business scopes this caller may query. ``{"*"}`` = all."""
    if _ACCESS_USE_DUMMY:
        cfg = config_loader.assistant_config()
        grants = cfg.get("dummy_scope_grants") or {}
        raw = grants.get(caller, cfg.get("dummy_default_scopes", ["*"]))
        vals = {str(s).strip().lower() for s in raw if str(s).strip()}
        return _ALL if "*" in vals else vals
    try:
        dbcfg = getattr(request.app.state, "app_db_config", None)
        gr = database.fetch_user_grants(dbcfg, caller) or []
        if access_api.grants_have_full_access(gr):
            return _ALL
        ident = database.fetch_user_identity(dbcfg, caller)
        snap = access_api.build_snapshot(ident, gr, getattr(request.app.state, "app_env", "PROD"))
        return {s for s in (snap.get("config", {}).get("scopes") or []) if s in _SCOPES}
    except Exception:  # noqa: BLE001 — fail CLOSED (no scopes) rather than leak on an RBAC error
        return set()


def scope_allowed(scopes: set[str], scope: str) -> bool:
    return "*" in scopes or (scope or "").strip().lower() in scopes


def describe(scopes: set[str]) -> str:
    """Natural-language list of scopes for a message, e.g. "GROUP or RETAIL", "GROUP, RETAIL, or CIB"."""
    if "*" in scopes:
        return "all business lines"
    names = [s.upper() for s in sorted(scopes)]
    if not names:
        return "none"
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f"{names[0]} or {names[1]}"
    return ", ".join(names[:-1]) + ", or " + names[-1]
