"""RBAC / access-control API.

One endpoint does the heavy lifting: ``POST /api/access/me`` returns the *resolved* access
snapshot for the signed-in user — the single thing the Angular app reads to decide what to show
and which write buttons to enable. A second, admin-only ``POST /api/access/effective`` is a
support/diagnostic view of "what can user X actually do, and why".

Model (see RBAC_DESIGN.md for the full handbook):

* **Gate 1 — active user.** The user must exist in ``ols_users`` with ``LGCL_DEL_FLG='N'``.
  ``ols_users`` is READ ONLY here (identity + base role live there); we never modify it.
* **Base role** comes from ``ols_users`` flags: ``IS_ADMIN`` / ``IS_READ`` / ``IS_SALT``.
    - ADMIN → sees everything + writes everywhere (ignores grants).
    - READ  → sees every screen read-only; servers & config tables are **opt-in** (granted);
              write only where a grant says so.
    - SALT  → a Config-Ops-only persona (Home + Config Ops), otherwise like READ.
* **Overrides** (the fine-grained grants) live in ``ols_app_access`` — additive READ/WRITE, or
  DENY to subtract. Resource types: SCREEN, SERVER, TABLE_CATEGORY, TABLE, SECTION.

Follows the same data-layer / API-layer split as ``oracle_cc_api.py``: ALL SQL is in
``database.py`` (``fetch_user_identity`` / ``fetch_user_grants``); this module only resolves the
rows into the UI contract. Reads the app's OWN database via ``request.app.state.app_db_config``.

SECURITY NOTE (production hardening — see RBAC_DESIGN.md §Security): the caller identity should be
derived from the validated SSO token server-side, NOT taken from the request body. This module
accepts ``username`` in the body to match the existing app wiring; wire the token check before go-live,
and re-check every WRITE action server-side (hidden buttons are UX, not security).
"""

from __future__ import annotations

from typing import Any

from env_loader import env_bool  # importing also loads backend/.env into os.environ

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import database  # data layer — ALL SQL lives here
from utils.logging import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/access", tags=["access"])

# 1 = return canned snapshots (dev / no app DB wired), 0 = read ols_users / ols_app_access.
ACCESS_USE_DUMMY = env_bool("ACCESS_USE_DUMMY", True)

# ---- The resource registry (mirror of the frontend rbac.config.ts) ----------
# OPT-IN model: a screen is visible only when a grant touches it. These are the grantable
# non-config screens (a `SCREEN` grant here, or a `SERVER` grant for log_analytics, reveals it).
# Config Ops is revealed by config-scope grants; Home appears whenever the user has ≥1 feature.
SCREEN_KEYS = ["log_analytics", "infra_health", "service_console", "oracle_command_center"]
# The three Config Ops sub-screens (scopes).
CONFIG_SCOPES = ["group", "cib", "retail"]
# Screens that actually have write actions (so a SCREEN/WRITE grant is meaningful).
WRITE_CAPABLE_SCREENS = ["service_console", "oracle_command_center"]

_CONFIG_PREFIX = "config_ops:"

# ---- Grant catalogue (drives the User Management pickers) --------------------
# Static registries for the resources a new screen/section still registers once (see §3 of the
# design). Data-driven lists (servers from ols_server_log_config, OCC DBs from db_configs) are
# merged in at request time by build_catalogue(); config tables stay category-driven + free-text.
SCREEN_CATALOGUE = [
    {"key": "log_analytics", "label": "Log Analytics", "write_capable": False},
    {"key": "infra_health", "label": "Infrastructure Health", "write_capable": False},
    {"key": "service_console", "label": "Service Console", "write_capable": True},
    {"key": "oracle_command_center", "label": "Oracle Command Center", "write_capable": True},
]
CONFIG_SCOPE_CATALOGUE = [
    {"key": "group", "label": "OLS GROUP"},
    {"key": "cib", "label": "OLS CIB"},
    {"key": "retail", "label": "OLS RETAIL"},
]
CONFIG_CATEGORIES = [
    {"key": "OMT-FUNCTIONAL", "label": "Functional tables"},
    {"key": "OMT-TECHNICAL", "label": "Technical tables"},
    {"key": "OMT-BOTH", "label": "All tables (both)"},
]
APP_CATALOGUE = [
    {"key": "OLS_GROUP", "label": "OLS GROUP"},
    {"key": "OLS_CIB", "label": "OLS CIB"},
    {"key": "OLS_RETAIL", "label": "OLS RETAIL"},
    {"key": "POSEIDON", "label": "POSEIDON"},
]
OCC_SECTION_CATALOGUE = [
    {"key": "space", "label": "Database Storage"},
    {"key": "top", "label": "Top Table Storage"},
    {"key": "topidx", "label": "Top Index Storage"},
    {"key": "idxhealth", "label": "Index Health"},
    {"key": "locks", "label": "Critical Locks"},
    {"key": "blocking", "label": "Blocking Sessions"},
    {"key": "temp", "label": "Temp Tablespace"},
    {"key": "sessions", "label": "Sessions Detail"},
    {"key": "sql_intelligence", "label": "SQL Intelligence"},
]
# Friendly labels for the OCC databases; the actual key list is db_configs at runtime.
OCC_DB_LABELS = {
    "group": "OLS GROUP", "cib_batch": "OLS CIB Batch", "cib_reporting": "OLS CIB Reporting",
    "retail_batch": "OLS RETAIL Batch", "retail_reporting": "OLS RETAIL Reporting",
}
APP_ENVS = ["PROD", "STG", "DEV", "*"]


def build_catalogue(server_names: list[str], db_keys: list[str]) -> dict:
    """Assemble the grantable-resource tree the User Management UI renders. Static registries +
    the two live lists (servers, OCC DBs) passed in. Config stays category + free-text."""
    databases = [{"key": k, "label": OCC_DB_LABELS.get(k, k.replace("_", " ").title())} for k in db_keys]
    return {
        "screens": SCREEN_CATALOGUE,
        "config": {"scopes": CONFIG_SCOPE_CATALOGUE, "categories": CONFIG_CATEGORIES, "tables": []},
        "servers": server_names,
        "apps": APP_CATALOGUE,
        "databases": databases,
        "sections": OCC_SECTION_CATALOGUE,
        "app_envs": APP_ENVS,
    }


class AccessQuery(BaseModel):
    username: str
    app_env: str = "PROD"


class EffectiveQuery(BaseModel):
    # `caller` must be an ADMIN — this is a support/diagnostic view of someone else's access.
    caller: str
    username: str
    app_env: str = "PROD"


# ---- User Management (ops-admin surface). `caller` is the acting ops-admin; every endpoint
# re-checks it against `ols_ops_access`. NOTE (go-live): `caller`/`granted_by` MUST come from the
# validated SSO token, not the body — see RBAC_DESIGN.md §Security. -----------
class AdminQuery(BaseModel):
    caller: str


class AdminUserQuery(BaseModel):
    caller: str
    uid: str
    app_env: str = "PROD"


class GrantBody(BaseModel):
    caller: str
    username: str
    resource_type: str
    resource_scope: str
    resource_key: str = "*"
    access_level: str = "READ"
    app_env: str = "PROD"


class GrantDeleteBody(BaseModel):
    caller: str
    username: str
    resource_type: str
    resource_scope: str
    resource_key: str
    app_env: str


class OpsAdminBody(BaseModel):
    caller: str
    action: str            # "list" | "add" | "remove"
    uid: str | None = None


# ---------------------------------------------------------------------------
# Resolution (shared by /me and /effective, and by the dummy path)
# ---------------------------------------------------------------------------

def _role_of(identity: dict | None) -> str:
    """ADMIN / READ / SALT / NONE from the ols_users flags (ADMIN wins, then READ, then SALT)."""
    if not identity:
        return "NONE"
    def flag(k: str) -> bool:
        return str(identity.get(k) or "").strip().upper() in ("Y", "YES", "1", "TRUE")
    if flag("is_admin"):
        return "ADMIN"
    if flag("is_read"):
        return "READ"
    if flag("is_salt"):
        return "SALT"
    return "NONE"


def _is_active(identity: dict | None) -> bool:
    """Gate 1: exists AND LGCL_DEL_FLG = 'N'."""
    return bool(identity) and str(identity.get("lgcl_del_flg") or "").strip().upper() == "N"


def _display_name(identity: dict) -> str:
    fn = (identity.get("firstname") or "").strip()
    ln = (identity.get("lastname") or "").strip()
    return (f"{fn} {ln}").strip() or (identity.get("username") or "")


def _scope_of(resource_scope: str | None) -> str | None:
    """'config_ops:cib' → 'cib'. Non-config scopes return None."""
    s = (resource_scope or "").strip().lower()
    return s[len(_CONFIG_PREFIX):] if s.startswith(_CONFIG_PREFIX) else None


def build_snapshot(identity: dict | None, grants: list[dict], app_env: str,
                   is_ops_admin: bool = False, can_sql: bool = False) -> dict:
    """Resolve identity + grants into the UI access snapshot. Pure — no I/O — so the dummy path
    and the real path share it. `is_ops_admin` (from the SEPARATE `ols_ops_access` gate) drives the
    User Management screen; `can_sql` (same table, assigned per user) drives S-Studio. Both are
    independent of the base role. See RBAC_DESIGN.md."""
    role = _role_of(identity)
    active = _is_active(identity) and role != "NONE"

    if not active:
        return {
            "status": "success", "active": False, "role": "NONE",
            "username": (identity or {}).get("username", ""),
            "display_name": "", "email": "", "app_env": app_env,
            "screens": [], "write_screens": [],
            "config": {"scopes": [], "all": False, "all_level": "READ", "category_grants": [], "table_grants": []},
            "servers": [], "all_servers": False, "denied_servers": [],
            "infra": {"all_apps": False, "apps": [], "denied_apps": []},
            "service": {"all_apps": False, "apps": [], "denied_apps": []},
            "oracle": {"all_dbs": False, "all_level": "READ", "dbs": {}, "denied_dbs": []},
            "denied_sections": [], "is_ops_admin": False, "can_sql": False,
        }

    username = identity.get("username", "")
    base = {
        "status": "success", "active": True, "role": role, "app_env": app_env,
        "username": username, "display_name": _display_name(identity),
        "email": (identity.get("emailid") or "").strip(),
        "is_ops_admin": bool(is_ops_admin),
        "can_sql": bool(can_sql and is_ops_admin),
    }

    # ADMIN: everything, grants ignored.
    if role == "ADMIN":
        base.update({
            "screens": ["home", "log_analytics", "config_ops_console", "infra_health",
                        "service_console", "oracle_command_center"],
            "write_screens": WRITE_CAPABLE_SCREENS,
            "config": {"scopes": list(CONFIG_SCOPES), "all": True, "all_level": "WRITE",
                       "category_grants": [], "table_grants": []},
            "servers": ["*"], "all_servers": True, "denied_servers": [],
            "infra": {"all_apps": True, "apps": [], "denied_apps": []},
            "service": {"all_apps": True, "apps": [], "denied_apps": []},
            "oracle": {"all_dbs": True, "all_level": "WRITE", "dbs": {}, "denied_dbs": []},
            "denied_sections": [],
        })
        return base

    # READ / SALT: OPT-IN. A screen is visible ONLY if a grant touches it — a SCREEN grant, a
    # SERVER grant (→ Log Analytics), or a TABLE/TABLE_CATEGORY/SCREEN grant in a config scope
    # (→ Config Ops). No grants → no screens → the app shows the "contact OLS Team" page.
    category_grants: list[dict] = []
    table_grants: list[dict] = []
    config_scopes: set[str] = set()
    config_all = False
    config_all_level = "READ"
    servers: list[str] = []
    all_servers = False
    write_screens: set[str] = set()
    granted_screens: set[str] = set()   # opt-in non-config screens the user may VIEW
    denied_sections: list[dict] = []
    infra_apps: set[str] = set()        # Infra Health: which apps (OLS_GROUP / OLS_CIB / …)
    all_infra_apps = False
    service_apps: set[str] = set()      # Service Console: which apps
    all_service_apps = False
    service_screen_grant = False
    oracle_dbs: dict[str, str] = {}     # OCC: per-DB access level {db_key: READ|WRITE}
    all_dbs = False
    all_db_level = "READ"
    full_read = False
    full_write = False
    # DENY (exclusion) sets — subtract a specific key from an "all" (`*`) grant, so
    # "all servers/apps/DBs EXCEPT these" is expressible. DENY never reveals a screen.
    denied_servers: set[str] = set()
    denied_infra_apps: set[str] = set()
    denied_service_apps: set[str] = set()
    denied_dbs: set[str] = set()

    for g in grants:
        rtype = (g.get("resource_type") or "").strip().upper()
        rscope = (g.get("resource_scope") or "").strip().lower()
        rkey = (g.get("resource_key") or "").strip()
        level = (g.get("access_level") or "").strip().upper()

        # Full-access wildcard: SCREEN / * / * → everything (READ = view-all, WRITE = act-all).
        if rtype == "SCREEN" and rscope == "*" and rkey == "*":
            if level != "DENY":
                full_read = True
                if level == "WRITE":
                    full_write = True
            continue

        if rtype == "SERVER" and rscope == "log_analytics":
            if level == "DENY":
                if rkey and rkey != "*":
                    denied_servers.add(rkey)                   # "all servers EXCEPT this one"
            else:
                granted_screens.add("log_analytics")          # any allow grant reveals the screen
                if rkey == "*":
                    all_servers = True
                elif rkey:
                    servers.append(rkey)
        elif rtype == "APP" and rscope == "infra_health":       # Infra Health, per app
            if level == "DENY":
                if rkey and rkey != "*":
                    denied_infra_apps.add(rkey.upper())
            else:
                granted_screens.add("infra_health")
                if rkey == "*":
                    all_infra_apps = True
                elif rkey:
                    infra_apps.add(rkey.upper())
        elif rtype == "APP" and rscope == "service_console":    # Service Console, per app
            if level == "DENY":
                if rkey and rkey != "*":
                    denied_service_apps.add(rkey.upper())
            else:
                granted_screens.add("service_console")
                if rkey == "*":
                    all_service_apps = True
                elif rkey:
                    service_apps.add(rkey.upper())
        elif rtype == "DB" and rscope == "oracle_command_center":  # OCC, per DB + per-DB level
            if level == "DENY":
                if rkey and rkey != "*":
                    denied_dbs.add(rkey.lower())
            elif rkey:
                granted_screens.add("oracle_command_center")
                if rkey == "*":
                    all_dbs = True
                    if level == "WRITE":
                        all_db_level = "WRITE"
                else:
                    k = rkey.lower()
                    oracle_dbs[k] = "WRITE" if (level == "WRITE" or oracle_dbs.get(k) == "WRITE") else "READ"
        elif rtype == "TABLE_CATEGORY":
            sc = _scope_of(rscope)
            if sc:
                category_grants.append({"scope": sc, "category": rkey.upper(), "level": level})
                if level != "DENY":
                    config_scopes.add(sc)
        elif rtype == "TABLE":
            sc = _scope_of(rscope)
            if sc:
                table_grants.append({"scope": sc, "table": rkey, "level": level})
                if level != "DENY":
                    config_scopes.add(sc)
        elif rtype == "SCREEN" and level != "DENY":
            sc = _scope_of(rscope)
            if sc:  # a config sub-screen grant (visibility even with no tables yet)
                config_scopes.add(sc)
            elif rscope == "infra_health":            # whole-screen grant → all apps
                granted_screens.add("infra_health")
                all_infra_apps = True
            elif rscope == "oracle_command_center":   # whole-screen grant → all DBs at this level
                granted_screens.add("oracle_command_center")
                all_dbs = True
                if level == "WRITE":
                    all_db_level = "WRITE"
            elif rscope in SCREEN_KEYS:               # log_analytics, service_console
                granted_screens.add(rscope)
                if rscope == "service_console":
                    service_screen_grant = True
                if level == "WRITE" and rscope in WRITE_CAPABLE_SCREENS:
                    write_screens.add(rscope)
        elif rtype == "SECTION" and level == "DENY" and rscope and rkey:
            # scope 'oracle_command_center' (global) or 'oracle_command_center:<db>' (that DB only)
            screen, _, db = rscope.partition(":")
            entry = {"screen": screen, "key": rkey}
            if db:
                entry["db"] = db
            denied_sections.append(entry)

    # A Service Console SCREEN grant with no specific APP grants = all apps.
    if service_screen_grant and not service_apps:
        all_service_apps = True

    # Full-access wildcard populates everything (grants above still merge on top).
    if full_read:
        granted_screens.update(SCREEN_KEYS)
        all_servers = all_infra_apps = all_service_apps = all_dbs = True
        config_all = True
        config_scopes.update(CONFIG_SCOPES)
        if full_write:
            config_all_level = "WRITE"
            all_db_level = "WRITE"
            write_screens.update(WRITE_CAPABLE_SCREENS)

    # DENY subtracts: drop explicitly-denied keys from the explicit allow-lists (defence in depth —
    # the frontend also honours the denied_* lists, which is what makes "all EXCEPT x" work).
    servers = [s for s in servers if s not in denied_servers]
    infra_apps -= denied_infra_apps
    service_apps -= denied_service_apps
    for k in denied_dbs:
        oracle_dbs.pop(k, None)

    # SALT is a Config-Ops-only persona — it never sees non-config screens, even if granted.
    if role == "SALT":
        granted_screens = set()
        write_screens.clear()
        infra_apps.clear(); all_infra_apps = False; denied_infra_apps.clear()
        service_apps.clear(); all_service_apps = False; denied_service_apps.clear()
        oracle_dbs.clear(); all_dbs = False; denied_dbs.clear()
        denied_servers.clear()

    screens = sorted(granted_screens)
    if config_scopes or config_all:
        screens.append("config_ops_console")
    if screens:                          # has ≥1 feature → give them Home (the landing) too
        screens = ["home"] + screens

    base.update({
        "screens": screens,
        "write_screens": sorted(write_screens),
        "config": {
            "scopes": sorted(config_scopes),
            "all": config_all,
            "all_level": config_all_level,
            "category_grants": category_grants,
            "table_grants": table_grants,
        },
        "servers": sorted(set(servers)),
        "all_servers": all_servers,
        "denied_servers": sorted(denied_servers),
        "infra": {"all_apps": all_infra_apps, "apps": sorted(infra_apps),
                  "denied_apps": sorted(denied_infra_apps)},
        "service": {"all_apps": all_service_apps, "apps": sorted(service_apps),
                    "denied_apps": sorted(denied_service_apps)},
        "oracle": {"all_dbs": all_dbs, "all_level": all_db_level, "dbs": oracle_dbs,
                   "denied_dbs": sorted(denied_dbs)},
        "denied_sections": denied_sections,
    })
    return base


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/me")
def access_me(request: Request, body: AccessQuery) -> dict:
    """The access snapshot for the signed-in user. Gate 1 (active in ols_users) is enforced here:
    an inactive/unknown user gets ``active:false`` and the UI signs them out / shows No-Access."""
    if ACCESS_USE_DUMMY:
        return _access_dummy(body.username, body.app_env)
    cfg = getattr(request.app.state, "app_db_config", None)
    try:
        identity = database.fetch_user_identity(cfg, body.username)
        active = _is_active(identity)
        grants = database.fetch_user_grants(cfg, body.username, body.app_env) if active else []
        is_ops = database.fetch_is_ops_admin(cfg, body.username) if active else False
        can_sql = database.fetch_can_sql(cfg, body.username) if is_ops else False
        return build_snapshot(identity, grants, body.app_env, is_ops_admin=is_ops, can_sql=can_sql)
    except Exception:
        logger.exception("access/me failed for %s", body.username)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/effective")
def access_effective(request: Request, body: EffectiveQuery) -> dict:
    """Admin-only diagnostic: the resolved snapshot for ``username`` PLUS the raw grant rows, so a
    DBA can answer "why can't user X see table Y?". The caller must be an active ADMIN."""
    if ACCESS_USE_DUMMY:
        snap = _access_dummy(body.username, body.app_env)
        return {"status": "success", "snapshot": snap, "raw_grants": snap.get("_raw_grants", []),
                "identity": {"username": body.username, "note": "dummy mode"}}
    cfg = getattr(request.app.state, "app_db_config", None)
    try:
        caller = database.fetch_user_identity(cfg, body.caller)
        if _role_of(caller) != "ADMIN" or not _is_active(caller):
            raise HTTPException(status_code=403, detail="Admin access required")
        identity = database.fetch_user_identity(cfg, body.username)
        grants = database.fetch_user_grants(cfg, body.username, body.app_env)
        return {
            "status": "success",
            "identity": identity or {"username": body.username, "note": "not found"},
            "raw_grants": grants,
            "snapshot": build_snapshot(identity, grants, body.app_env),
        }
    except HTTPException:
        raise
    except Exception:
        logger.exception("access/effective failed for %s (caller %s)", body.username, body.caller)
        raise HTTPException(status_code=500, detail="Internal server error")


# ---------------------------------------------------------------------------
# User Management (ops-admin surface). Every endpoint re-checks the caller against
# `ols_ops_access` (the super-exclusive gate) — hiding the screen client-side is UX, not security.
# `granted_by` is the caller (from the token at go-live). See RBAC_DESIGN.md §User Management.
# ---------------------------------------------------------------------------

_RESOURCE_TYPES = {"SCREEN", "SERVER", "APP", "DB", "TABLE_CATEGORY", "TABLE", "SECTION"}


def no_ols_user_msg(uid: str) -> str:
    """The standard message when a grant/ops target is not an active user in `ols_users`."""
    return (f"The {uid} user does not exist in OLS. "
            "Please submit the appropriate provisioning request before proceeding.")


def _require_ops_admin(request: Request, caller: str):
    """Confirm `caller` is an active ops-admin, else 403. Returns the app DB config (None in dummy)."""
    if ACCESS_USE_DUMMY:
        if not _dummy_is_ops_admin(caller):
            raise HTTPException(status_code=403, detail="User Management is restricted to ops-admins")
        return None
    cfg = getattr(request.app.state, "app_db_config", None)
    if not database.fetch_is_ops_admin(cfg, caller):
        raise HTTPException(status_code=403, detail="User Management is restricted to ops-admins")
    return cfg


def _lookup_target(cfg, uid: str) -> tuple[bool, dict]:
    """Validate a grant target against ols_users (gate 1). (ok, payload) — ok False when the user is
    absent or LGCL_DEL_FLG != 'N' (payload carries the standard 'raise a request' message)."""
    identity = database.fetch_user_identity(cfg, uid)
    if not _is_active(identity):
        return False, {"exists": bool(identity), "active": False, "username": uid, "message": no_ols_user_msg(uid)}
    return True, {"exists": True, "active": True, "username": identity.get("username", uid),
                  "display_name": _display_name(identity), "email": (identity.get("emailid") or "").strip()}


@router.post("/admin/catalogue")
def admin_catalogue(request: Request, body: AdminQuery) -> dict:
    """The grantable-resource tree the User Management pickers render (ops-admin only)."""
    cfg = _require_ops_admin(request, body.caller)
    if ACCESS_USE_DUMMY:
        return {"status": "success", "catalogue": build_catalogue([], list(OCC_DB_LABELS.keys()))}
    try:
        try:
            servers = database.fetch_server_names(cfg)
        except Exception:
            servers = []      # best-effort: table missing / no rows → the UI still allows '*' + free-text
        db_keys = list(getattr(request.app.state, "db_configs", {}) or OCC_DB_LABELS)
        return {"status": "success", "catalogue": build_catalogue(servers, db_keys)}
    except HTTPException:
        raise
    except Exception:
        logger.exception("admin/catalogue failed")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/admin/user")
def admin_user(request: Request, body: AdminUserQuery) -> dict:
    """Look a user up (validated against ols_users) + return their current grants and resolved
    snapshot. `lookup.active=false` → the UI shows the 'raise a request' message, no grants."""
    cfg = _require_ops_admin(request, body.caller)
    if ACCESS_USE_DUMMY:
        ident = _dummy_identity(body.uid)
        grants = _dummy_grants(body.uid)
        snap = build_snapshot(ident, grants, body.app_env, is_ops_admin=_dummy_is_ops_admin(body.uid))
        return {"status": "success",
                "lookup": {"exists": True, "active": True, "username": body.uid,
                           "display_name": _display_name(ident), "email": (ident.get("emailid") or "").strip()},
                "grants": grants, "snapshot": snap}
    try:
        ok, lk = _lookup_target(cfg, body.uid)
        if not ok:
            return {"status": "success", "lookup": lk, "grants": [], "snapshot": None}
        ident = database.fetch_user_identity(cfg, body.uid)
        grants = database.fetch_all_grants(cfg, body.uid)
        env_grants = database.fetch_user_grants(cfg, body.uid, body.app_env)
        snap = build_snapshot(ident, env_grants, body.app_env,
                              is_ops_admin=database.fetch_is_ops_admin(cfg, body.uid))
        return {"status": "success", "lookup": lk, "grants": grants, "snapshot": snap}
    except HTTPException:
        raise
    except Exception:
        logger.exception("admin/user failed for %s", body.uid)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/admin/grant")
def admin_grant(request: Request, body: GrantBody) -> dict:
    """Grant (insert/update) ONE `ols_app_access` row for a user. Target must be an active OLS user."""
    cfg = _require_ops_admin(request, body.caller)
    rt = (body.resource_type or "").strip().upper()
    rs = (body.resource_scope or "").strip()
    rk = (body.resource_key or "*").strip() or "*"
    lvl = (body.access_level or "").strip().upper()
    env = (body.app_env or "PROD").strip() or "PROD"
    if rt not in _RESOURCE_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid resource_type '{rt}'")
    if lvl not in ("READ", "WRITE", "DENY"):
        raise HTTPException(status_code=400, detail=f"Invalid access_level '{lvl}'")
    if ACCESS_USE_DUMMY:
        return {"status": "success", "dummy": True}
    try:
        ok, _ = _lookup_target(cfg, body.username)
        if not ok:
            raise HTTPException(status_code=422, detail=no_ols_user_msg(body.username))
        database.grant_upsert(cfg, body.username, rt, rs, rk, lvl, env, body.caller)
        return {"status": "success", "grants": database.fetch_all_grants(cfg, body.username)}
    except HTTPException:
        raise
    except Exception:
        logger.exception("admin/grant failed for %s", body.username)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/admin/grant/delete")
def admin_grant_delete(request: Request, body: GrantDeleteBody) -> dict:
    """Revoke (hard-DELETE) ONE `ols_app_access` row by its natural key — no audit kept."""
    cfg = _require_ops_admin(request, body.caller)
    if ACCESS_USE_DUMMY:
        return {"status": "success", "dummy": True, "deleted": 1}
    try:
        n = database.grant_delete(cfg, body.username, (body.resource_type or "").strip().upper(),
                                  (body.resource_scope or "").strip(), (body.resource_key or "").strip(),
                                  (body.app_env or "").strip())
        return {"status": "success", "deleted": n, "grants": database.fetch_all_grants(cfg, body.username)}
    except HTTPException:
        raise
    except Exception:
        logger.exception("admin/grant/delete failed for %s", body.username)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/admin/ops")
def admin_ops(request: Request, body: OpsAdminBody) -> dict:
    """Manage the ops-admin gate itself (`ols_ops_access`): action = list | add | disable | enable |
    sql_on | sql_off | remove. `add` requires an active OLS user; `disable`/`enable` flip is_active
    (the "edit" action); `sql_on`/`sql_off` grant/revoke S-Studio (`can_sql`); `remove` hard-deletes.
    No self-lockout guard (you can disable/remove your own UID)."""
    cfg = _require_ops_admin(request, body.caller)
    action = (body.action or "").strip().lower()
    if ACCESS_USE_DUMMY:
        row = {"username": body.caller, "is_active": "Y", "can_sql": "Y"}
        return {"status": "success", "dummy": action != "list", "ops_admins": [row]}
    try:
        if action == "list":
            return {"status": "success", "ops_admins": database.fetch_ops_admins(cfg)}
        if not (body.uid or "").strip():
            raise HTTPException(status_code=400, detail="uid is required")
        if action == "add":
            ok, _ = _lookup_target(cfg, body.uid)
            if not ok:
                raise HTTPException(status_code=422, detail=no_ols_user_msg(body.uid))
            database.ops_admin_upsert(cfg, body.uid)
        elif action == "disable":
            database.ops_admin_set_active(cfg, body.uid, False)
        elif action == "enable":
            database.ops_admin_set_active(cfg, body.uid, True)
        elif action == "sql_on":
            database.ops_admin_set_sql(cfg, body.uid, True)
        elif action == "sql_off":
            database.ops_admin_set_sql(cfg, body.uid, False)
        elif action == "remove":
            database.ops_admin_delete(cfg, body.uid)
        else:
            raise HTTPException(status_code=400, detail=f"Invalid action '{action}'")
        return {"status": "success", "ops_admins": database.fetch_ops_admins(cfg)}
    except HTTPException:
        raise
    except Exception:
        logger.exception("admin/ops %s failed", action)
        raise HTTPException(status_code=500, detail="Internal server error")


# ---------------------------------------------------------------------------
# Dummy (dev / no app DB) — canned identities + grants, resolved through the SAME
# build_snapshot() so the shape always matches production. The frontend's mock
# interceptor is the primary dev path; this mirrors it for backend-only testing.
# ---------------------------------------------------------------------------

def _dummy_identity(username: str) -> dict:
    u = (username or "").upper()
    admin = "ADMIN" in u
    salt = "SALT" in u
    return {
        "username": username, "firstname": username.title(), "lastname": "User",
        "emailid": f"{username.lower()}@example.com", "lgcl_del_flg": "N",
        "is_admin": "Y" if admin else "N",
        "is_read": "N" if (admin or salt) else "Y",
        "is_salt": "Y" if salt else "N",
    }


def _dummy_grants(username: str) -> list[dict]:
    """A READ user with a representative spread of grants; ADMIN/SALT need none/less."""
    u = (username or "").upper()
    if "ADMIN" in u:
        return []
    if "SALT" in u:  # config-ops-only persona: a couple of CIB tables
        return [
            {"resource_type": "TABLE", "resource_scope": "config_ops:cib", "resource_key": "CIB_LIMIT_CONFIG", "access_level": "READ", "app_env": "PROD"},
            {"resource_type": "TABLE", "resource_scope": "config_ops:cib", "resource_key": "CIB_FX_RATES", "access_level": "READ", "app_env": "PROD"},
        ]
    # default READ demo user (opt-in: Log Analytics + Config Ops(Group) + Service Console + OCC;
    # NOT Infrastructure Health, so it never shows)
    return [
        {"resource_type": "SERVER", "resource_scope": "log_analytics", "resource_key": "eurv15", "access_level": "READ", "app_env": "PROD"},
        {"resource_type": "TABLE_CATEGORY", "resource_scope": "config_ops:group", "resource_key": "OMT-FUNCTIONAL", "access_level": "READ", "app_env": "PROD"},
        {"resource_type": "TABLE", "resource_scope": "config_ops:group", "resource_key": "GRP_COST_CENTER", "access_level": "WRITE", "app_env": "PROD"},
        {"resource_type": "SCREEN", "resource_scope": "service_console", "resource_key": "*", "access_level": "WRITE", "app_env": "PROD"},
        {"resource_type": "APP", "resource_scope": "service_console", "resource_key": "OLS_GROUP", "access_level": "READ", "app_env": "PROD"},
        {"resource_type": "APP", "resource_scope": "service_console", "resource_key": "OLS_CIB", "access_level": "READ", "app_env": "PROD"},
        {"resource_type": "APP", "resource_scope": "infra_health", "resource_key": "OLS_GROUP", "access_level": "READ", "app_env": "PROD"},
        {"resource_type": "DB", "resource_scope": "oracle_command_center", "resource_key": "group", "access_level": "WRITE", "app_env": "PROD"},
        {"resource_type": "DB", "resource_scope": "oracle_command_center", "resource_key": "cib_batch", "access_level": "READ", "app_env": "PROD"},
        {"resource_type": "SECTION", "resource_scope": "oracle_command_center", "resource_key": "sql_intelligence", "access_level": "DENY", "app_env": "PROD"},
    ]


def _dummy_is_ops_admin(username: str) -> bool:
    """Dev-only stand-in for the `ols_ops_access` gate: ADMIN/OPS-ish UIDs are ops-admins."""
    u = (username or "").upper()
    return "ADMIN" in u or "OPS" in u


def _access_dummy(username: str, app_env: str) -> dict:
    identity = _dummy_identity(username)
    grants = _dummy_grants(username)
    is_ops = _dummy_is_ops_admin(username)
    snap = build_snapshot(identity, grants, app_env, is_ops_admin=is_ops, can_sql=is_ops)
    snap["_raw_grants"] = grants
    return snap
