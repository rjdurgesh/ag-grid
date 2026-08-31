"""Per-feature config loader.

Screen-specific, non-secret settings live in ``backend/config/<feature>.json`` — one file per feature
(regression, occ, config_ops). These are **per-server** (paths/URLs differ per environment), so the real
files are gitignored; only the ``<feature>.example.json`` templates are committed.

What lives WHERE:
  * ``.env``  → GLOBAL (APP_ENV, CORS) and SECRETS (git tokens, DB passwords, CyberArk). Never here.
  * ``config/<feature>.json`` → that screen's non-secret settings (paths, URLs, thresholds), per scope
    where it matters (regression differs per cib/retail/group).

Resolution per key (backward-compatible): the JSON value wins; else the legacy ``.env`` var; else a
built-in default. So a deployment that still only has ``.env`` keeps working until it adopts the files.
Secrets are always read from ``.env`` regardless of the JSON.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import env_loader  # noqa: F401 — importing loads backend/.env into os.environ (env fallbacks + secrets)
from utils.logging import get_logger

logger = get_logger(__name__)

_CONFIG_DIR = Path(os.getenv("OLS_CONFIG_DIR", str(Path(__file__).parent / "config")))
_cache: dict[str, dict] = {}


def _load(name: str) -> dict:
    """Load + cache ``config/<name>.json`` (missing/invalid → {})."""
    if name in _cache:
        return _cache[name]
    p = _CONFIG_DIR / f"{name}.json"
    data: dict = {}
    if p.is_file():
        try:
            data = json.loads(p.read_text(encoding="utf-8")) or {}
        except Exception as exc:  # noqa: BLE001
            logger.error("config: could not parse %s: %s", p, exc)
    _cache[name] = data
    return data


def _coerce(val: Any, default: Any) -> Any:
    """Coerce ``val`` to the type of ``default`` (bool / int / list[str] / str)."""
    if isinstance(default, bool):
        return val if isinstance(val, bool) else str(val).strip().lower() in ("1", "true", "yes", "y", "on")
    if isinstance(default, int):
        try:
            return int(val)
        except (TypeError, ValueError):
            return default
    if isinstance(default, list):
        if isinstance(val, list):
            return val
        return [s.strip() for s in str(val).split(",") if s.strip()]
    return str(val)


def _pick(j: dict, key: str, env: str | None, default: Any) -> Any:
    """JSON value wins; else the legacy env var; else default. Typed to ``default``."""
    if key in j and j[key] not in (None, ""):
        return _coerce(j[key], default)
    raw = os.getenv(env) if env else None
    if raw not in (None, ""):
        return _coerce(raw, default)
    return default


# --- Oracle Command Center ---------------------------------------------------
def occ_config() -> dict:
    j = _load("occ")
    use_dummy = _pick(j, "use_dummy", "ORACLE_CC_USE_DUMMY", True)
    sqli = j.get("sqli", {}) if isinstance(j.get("sqli"), dict) else {}
    return {
        "use_dummy": use_dummy,
        "schema": _pick(j, "schema", "ORACLE_CC_SCHEMA", "OLS"),
        "warn_pct": _pick(j, "warn_pct", "ORACLE_CC_WARN_PCT", 85),
        "crit_pct": _pick(j, "crit_pct", "ORACLE_CC_CRIT_PCT", 90),
        "top_child_limit": _pick(j, "top_child_limit", "ORACLE_CC_TOP_CHILD_LIMIT", 10),
        "temp_warn_mb": _pick(j, "temp_warn_mb", "ORACLE_CC_TEMP_WARN_MB", 1024),
        "temp_crit_mb": _pick(j, "temp_crit_mb", "ORACLE_CC_TEMP_CRIT_MB", 5120),
        "force_down": _pick(j, "force_down", "ORACLE_CC_FORCE_DOWN", []),
        "sqli": {
            "use_dummy": _pick(sqli, "use_dummy", "SQLI_USE_DUMMY", use_dummy),
            "history_days": _pick(sqli, "history_days", "SQLI_HISTORY_DAYS", 5),
            "allow_apply": _pick(sqli, "allow_apply", "SQLI_ALLOW_APPLY", True),
            "misestimate_min_rows": _pick(sqli, "misestimate_min_rows", "SQLI_MISESTIMATE_MIN_ROWS", 1000),
            "misestimate_warn": _pick(sqli, "misestimate_warn", "SQLI_MISESTIMATE_WARN", 10),
            "misestimate_crit": _pick(sqli, "misestimate_crit", "SQLI_MISESTIMATE_CRIT", 100),
            "stats_stale_days": _pick(sqli, "stats_stale_days", "SQLI_STATS_STALE_DAYS", 7),
        },
    }


# --- Config Ops · CSV Upload & Load ------------------------------------------
def config_ops_config() -> dict:
    j = _load("config_ops")
    return {
        "archive_dir": _pick(j, "archive_dir", "CONFIG_UPLOAD_ARCHIVE_DIR", ""),
        "max_rows": _pick(j, "max_rows", "CONFIG_UPLOAD_MAX_ROWS", 200000),
        "max_mb": _pick(j, "max_mb", "CONFIG_UPLOAD_MAX_MB", 50),
        "batch_size": _pick(j, "batch_size", "CONFIG_UPLOAD_BATCH_SIZE", 5000),
        "audit_columns": _pick(j, "audit_columns", "CONFIG_UPLOAD_AUDIT_COLUMNS",
                               ["INSERTED_BY", "INSERTED_DATE", "INSERTED_ON", "UPDATED_BY", "UPDATED_DATE", "UPDATED_ON"]),
    }


# --- Documentation Center ----------------------------------------------------
def docs_config() -> dict:
    """Documentation Center settings: where the local ``.md`` files live, the external wiki links, and
    optional per-file metadata overrides. All non-secret → committed as ``docs.example.json``."""
    j = _load("docs")
    return {
        "base_dir": _pick(j, "base_dir", "DOCS_BASE_DIR", ""),
        "wikis": j.get("wikis", []) if isinstance(j.get("wikis"), list) else [],
        "overrides": j.get("overrides", {}) if isinstance(j.get("overrides"), dict) else {},
    }


# --- Regression (per scope: cib / retail / group) ----------------------------
def regression_defaults() -> dict:
    """Non-per-scope regression settings (same for every scope)."""
    j = _load("regression")
    d = j.get("defaults", {}) if isinstance(j.get("defaults"), dict) else {}
    return {
        "step_stale_minutes": _pick(d, "step_stale_minutes", "REGRESSION_STEP_STALE_MINUTES", 30),
        "batch_max_rows": _pick(d, "batch_max_rows", "REGRESSION_BATCH_MAX_ROWS", 100000),
    }


def regression_scope_config(scope: str) -> dict:
    """Per-scope regression settings (git repo, NAS/feed paths, log dir, …). The git TOKEN is a secret
    and always comes from ``.env`` (REGRESSION_GIT_TOKEN_<SCOPE>, else REGRESSION_GIT_TOKEN / _AUTH)."""
    scope = (scope or "cib").lower()
    j = _load("regression")
    defaults = j.get("defaults", {}) if isinstance(j.get("defaults"), dict) else {}
    scopes = j.get("scopes", {}) if isinstance(j.get("scopes"), dict) else {}
    s = scopes.get(scope, {}) if isinstance(scopes.get(scope), dict) else {}

    def val(key: str, env: str, default: Any) -> Any:
        # scope-JSON wins, else defaults-JSON, else legacy env, else built-in default
        if key in s and s[key] not in (None, ""):
            return _coerce(s[key], default)
        if key in defaults and defaults[key] not in (None, ""):
            return _coerce(defaults[key], default)
        return _pick({}, key, env, default)

    git_token = (os.getenv(f"REGRESSION_GIT_TOKEN_{scope.upper()}")
                 or os.getenv("REGRESSION_GIT_TOKEN")
                 or os.getenv("REGRESSION_GIT_AUTH", ""))
    return {
        "scope": scope,
        "log_dir": val("log_dir", "REGRESSION_LOG_DIR", ""),
        "git_url": val("git_url", "REGRESSION_GIT_URL", ""),
        "git_auth": git_token,                       # SECRET — from .env, never the JSON file
        "git_workdir": val("git_workdir", "REGRESSION_GIT_WORKDIR", ""),
        "branch_prefix": val("branch_prefix", "REGRESSION_BRANCH_PREFIX", "release/"),
        "sql_subdir": val("sql_subdir", "REGRESSION_SQL_SUBDIR", ""),
        "sqlplus_timeout": val("sqlplus_timeout", "REGRESSION_SQLPLUS_TIMEOUT", 3600),
        "git_timeout": val("git_timeout", "REGRESSION_GIT_TIMEOUT", 120),
        "filecopy_manifest": val("filecopy_manifest", "REGRESSION_FILECOPY_MANIFEST", ""),
        "refresh_url": val("refresh_url", "REGRESSION_REFRESH_URL", ""),
    }
