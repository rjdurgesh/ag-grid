"""Regression tools — READ-ONLY status of the CIB regression workflow.

Reuses the SAME data functions the Regression screen uses (``database.regression_*`` / ``fetch_batch_monitor``)
in-process. The Regression feature is **CIB-only** and **DEV/STG-only**, so these tools enforce CIB scope and
(in real mode) that env. Read-only: the gated workflow *actions* (start / mark / refresh / file-copy / trigger)
stay in the screen with their locks + audit — a future bot **write phase** with restate-and-confirm.

Answers: "is a regression running / who started it / which steps are done", "batch status", "downstream
extract for a date", "recent activity".
"""

from __future__ import annotations

from . import base

_REG_SCOPE = "cib"   # regression is scoped to CIB

# Canned dummy (mirrors the regression_api dummy) so it's demoable on the laptop.
_DUMMY_BATCH = {
    "columns": ["BUSINESS_LINE", "BATCH", "STATUS_ID", "STARTED", "FINISHED"],
    "rows": [["CB", "CB_LOAD", 2, "2026-08-28 09:00", "2026-08-28 09:12"],
             ["CB", "CB_VALUATION", 1, "2026-08-28 09:12", None],
             ["ALMT", "ALMT_ETL", 2, "2026-08-28 08:40", "2026-08-28 09:05"],
             ["FI", "FI_POST", 3, "2026-08-28 08:30", "2026-08-28 08:31"]],
}
_DUMMY_EXTRACT = [
    {"business_date": "2026-08-28", "post_dt": "2026-08-28 09:35:00", "load_id": 910244,
     "business_line": "CB", "filename": "CB_POSITION_20260828.csv", "filerowcount": 24813},
    {"business_date": "2026-08-28", "post_dt": "2026-08-28 09:32:00", "load_id": 910243,
     "business_line": "ALMT", "filename": "ALMT_PNL_20260828.csv", "filerowcount": 12890},
]


def _gate(scopes: set[str], ctx: dict):
    """CIB scope check (+ DEV/STG only in real mode). Returns (dummy, deny_or_error_or_None)."""
    from ..auth import scope_access as authz
    if not authz.scope_allowed(scopes, _REG_SCOPE):
        return False, base.deny(_REG_SCOPE, scopes)
    try:
        import regression_api
    except Exception as exc:  # noqa: BLE001
        return False, {"error": f"Regression service unavailable ({exc})."}
    if regression_api.REGRESSION_USE_DUMMY:
        return True, None                       # dummy mode → serve canned data
    env = str((ctx or {}).get("app_env") or "").upper()
    if env not in ("DEV", "STG"):
        return False, {"note": "Regression runs only in DEV/STG environments."}
    return False, None


def _regression_status(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    dummy, stop = _gate(scopes, ctx or {})
    if stop is not None:
        return stop
    if dummy:
        return {"note": "No regression run is active in this environment (dummy). In DEV/STG this shows the "
                        "current run, who started it, its change number, and each step's state."}
    import database
    ctx = ctx or {}
    data = database.regression_run_current(ctx.get("app_db_config"), ctx.get("app_env")) or {}
    run = data.get("run")
    if not run:
        return {"run": None, "message": "No regression run is currently open."}
    return {"run": run, "steps": data.get("steps", {})}


def _regression_activity(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    dummy, stop = _gate(scopes, ctx or {})
    if stop is not None:
        return stop
    if dummy:
        return {"rows": [], "note": "No recent regression activity in this environment (dummy)."}
    import database
    ctx = ctx or {}
    run_id = args.get("run_id")
    return {"rows": database.regression_activity(ctx.get("app_db_config"), run_id)}


def _regression_batch_status(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    dummy, stop = _gate(scopes, ctx or {})
    if stop is not None:
        return stop
    if dummy:
        return dict(_DUMMY_BATCH)
    import database
    ctx = ctx or {}
    db = str(args.get("db") or "").strip()
    cfgs = ctx.get("sql_db_configs") or ctx.get("db_configs") or {}
    cfg = cfgs.get(db) if db else None
    if cfg is None:
        return {"error": f"Please name the regression database to check (unknown db '{db}')."}
    try:
        return database.fetch_batch_monitor(cfg)
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Batch monitor failed: {exc}"}


def _regression_downstream_extract(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    dummy, stop = _gate(scopes, ctx or {})
    if stop is not None:
        return stop
    bd = str(args.get("business_date") or "").strip() or None
    if dummy:
        rows = [r for r in _DUMMY_EXTRACT if not bd or r["business_date"] == bd]
        return {"rows": rows, "business_date": bd}
    import database
    ctx = ctx or {}
    try:
        return {"rows": database.regression_downstream_extract(ctx.get("app_db_config"), bd), "business_date": bd}
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Downstream extract failed: {exc}"}


SCHEMAS: list[dict] = [
    {"type": "function", "function": {
        "name": "regression_status",
        "description": "The current CIB regression run: whether one is active, who started it, its change "
                       "number, and each step's state. Use for 'is a regression running?' / 'what's the "
                       "regression state?'.",
        "parameters": {"type": "object", "properties": {}},
    }},
    {"type": "function", "function": {
        "name": "regression_activity",
        "description": "Recent regression activity (who did what, and when). Use for 'who is working on the "
                       "regression?'.",
        "parameters": {"type": "object", "properties": {
            "run_id": {"type": "integer", "description": "Optional run id; omit for the current run."},
        }},
    }},
    {"type": "function", "function": {
        "name": "regression_batch_status",
        "description": "Batch monitor for the regression: each business line's batch, status, start/finish. "
                       "Use for 'batch status' / 'what's running / completed'.",
        "parameters": {"type": "object", "properties": {
            "db": {"type": "string", "description": "The regression database key to check (e.g. ols_cib_batch)."},
        }},
    }},
    {"type": "function", "function": {
        "name": "regression_downstream_extract",
        "description": "Downstream extract rows produced by the regression (files, row counts), optionally "
                       "for a business date. Use for 'downstream extract' / 'what files were extracted'.",
        "parameters": {"type": "object", "properties": {
            "business_date": {"type": "string", "description": "Optional date (any common format)."},
        }},
    }},
]

TOOLS = {
    "regression_status": _regression_status,
    "regression_activity": _regression_activity,
    "regression_batch_status": _regression_batch_status,
    "regression_downstream_extract": _regression_downstream_extract,
}
