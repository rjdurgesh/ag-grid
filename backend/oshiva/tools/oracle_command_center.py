"""Oracle Command Center (OCC) tools — READ-ONLY views of live Oracle state.

Reuses the OCC data layer (``database.fetch_*``) in-process, per DB target (``db`` key, e.g. cib_batch);
scope is derived from the db key and authorized. Big outputs (an explain plan, a SQL Monitor report) are
written to a file and returned as a **download link** (they don't fit in chat). WRITE actions (kill session,
gather stats, MV refresh, rebuild index, compression, apply a SQL fix) are NOT performed here — the agent
politely refuses and links to the OCC screen (only the user, if they have access, does them there).

Dev serves small canned samples (ORACLE_CC_USE_DUMMY); prod calls the real functions.
"""

from __future__ import annotations

import re

from . import base

OCC_ROUTE = "/oracle_command_center"

# OCC databases are whatever THIS environment actually has — the real source is app.state.db_configs
# (load_db_configs(), per-env). We only use oracle_cc_api.TARGET_CATALOG for friendly LABELS. "cib"/"retail"
# alone is ambiguous (batch vs reporting) → ask.
def _occ_targets(ctx: dict) -> dict:
    """{db_key: label} of OCC databases available in this env. Keys come from app.state.db_configs (real);
    labels from TARGET_CATALOG when known. Falls back to the catalog in dummy/dev (empty db_configs)."""
    cfgs = (ctx or {}).get("db_configs") or {}
    labels: dict = {}
    try:
        from oracle_cc_api import TARGET_CATALOG
        for k, v in TARGET_CATALOG.items():
            labels[k] = (f"{v.label} {v.sub}".strip() if getattr(v, "sub", None) else v.label)
    except Exception:  # noqa: BLE001
        labels = {"group": "OLS GROUP", "cib_batch": "OLS CIB BATCH", "cib_reporting": "OLS CIB REPORTING",
                  "retail_batch": "OLS RETAIL BATCH", "retail_reporting": "OLS RETAIL REPORTING"}
    present = [k for k in labels if k in cfgs]           # actually-configured DBs this env
    keys = present or list(labels.keys())               # dummy/dev → whole catalog
    return {k: labels.get(k, k) for k in keys}


def _ask_db(targets: dict, hint: str = "") -> dict:
    extra = f" ('{hint}' is ambiguous — batch or reporting?)" if hint else ""
    return {"needs_input": True,
            "message": f"Which database?{extra} Please name one exactly: " + ", ".join(targets.values()) + "."}


def _resolve_occ_db(raw: str, ctx: dict):
    """Resolve a user's DB phrase to one available OCC key, or (None, ask). Accepts a key ('cib_batch'), a
    label ('OLS CIB Batch'), or phrases ('cib batch'); 'cib'/'retail' alone → ask. Availability from ctx."""
    targets = _occ_targets(ctx)
    r = (raw or "").lower()
    norm = re.sub(r"[^a-z]", " ", r)
    for k, label in targets.items():                    # exact key / label / key-with-spaces
        if k in r or k.replace("_", " ") in norm or label.lower() in r:
            return k, None
    batch, report = "batch" in norm, ("report" in norm or "reporting" in norm)

    def _pick(key):
        return (key, None) if key in targets else (None, _ask_db(targets))
    if "group" in norm and "group" in targets:
        return "group", None
    if "cib" in norm and batch:
        return _pick("cib_batch")
    if "cib" in norm and report:
        return _pick("cib_reporting")
    if "retail" in norm and batch:
        return _pick("retail_batch")
    if "retail" in norm and report:
        return _pick("retail_reporting")
    if "cib" in norm:
        return None, _ask_db(targets, "CIB")
    if "retail" in norm:
        return None, _ask_db(targets, "RETAIL")
    return None, _ask_db(targets)


def _occ():
    """(use_dummy, schema) from config."""
    import config_loader
    c = config_loader.occ_config()
    return bool(c.get("use_dummy", True)), c.get("schema", "OLS")


def _has_occ_write(caller: str, db_key: str, ctx: dict) -> bool:
    """Does the caller have WRITE on this OCC database (this DB tab, or all DBs)? From the real access
    snapshot (``oracle`` = {all_dbs, all_level, dbs, denied_dbs}). Dummy mode → permissive (dev)."""
    if _occ()[0]:
        return True
    try:
        import access_api
        import database
        app_db = (ctx or {}).get("app_db_config")
        grants = database.fetch_user_grants(app_db, caller) or []
        ident = database.fetch_user_identity(app_db, caller)
        occ = (access_api.build_snapshot(ident, grants, (ctx or {}).get("app_env") or "PROD")
               .get("oracle") or {})
        if db_key in (occ.get("denied_dbs") or []):
            return False
        if occ.get("all_dbs") and str(occ.get("all_level", "")).upper() == "WRITE":
            return True
        return str((occ.get("dbs") or {}).get(db_key, "")).upper() == "WRITE"
    except Exception:  # noqa: BLE001 — fail closed
        return False


def _with_sql(result: dict, args: dict, caller: str, db_key: str, ctx: dict, sql_out: list | None) -> dict:
    """Attach the actual SQL to an OCC result ONLY when the user asked for it (``include_sql``) AND has WRITE
    access on that DB. Otherwise a polite note. On-request + write-gated, OCC-only."""
    if not args.get("include_sql"):
        return result
    if _has_occ_write(caller, db_key, ctx):
        if sql_out:
            result["query"] = "\n\n".join(sql_out)
        else:
            result["query_note"] = "The exact SQL is shown against the live database (not in this dummy env)."
    else:
        result["query_denied"] = ("The raw query is available only to users with WRITE access on this "
                                   "database. You have read access.")
    return result


def _prep(args: dict, scopes: set[str], ctx: dict):
    """Common: resolve+require an exact db, authorize by its scope, return
    (key, label, scope, cfg, use_dummy, schema) or an ask/deny/error dict."""
    from ..auth import scope_access as authz
    ctx = ctx or {}
    key, ask = _resolve_occ_db(str(args.get("db") or ""), ctx)
    if ask is not None:
        return None, ask
    label = _occ_targets(ctx).get(key, key)
    sc = base.scope_of_db(key)
    if sc and not authz.scope_allowed(scopes, sc):
        return None, base.deny(sc, scopes)
    use_dummy, schema = _occ()
    cfg = ctx.get("db_configs", {}).get(key) if not use_dummy else None
    if not use_dummy and cfg is None:
        return None, {"error": f"Database '{label}' is not reachable."}
    return (key, label, sc, cfg, use_dummy, schema), None


# --- blocking sessions -------------------------------------------------------
def _blocking_sessions(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    p, err = _prep(args, scopes, ctx or {})
    if err:
        return err
    db, db_label, sc, cfg, use_dummy, _ = p
    sql_out = [] if args.get("include_sql") else None
    if use_dummy:
        rows = [{"blocker_sid": 142, "blocker_user": "OLS_BATCH", "waiter_sid": 908, "waiter_user": "OLS_APP",
                 "wait_secs": 312, "object": "OLS_LCR_STAGE", "sql_id": "8gk2m1p4q7xza"}]
        return _with_sql({"db": db, "database": db_label, "count": len(rows), "blocking_sessions": rows},
                         args, caller, db, ctx or {}, sql_out)
    try:
        import database
        rows = database.fetch_blocking(cfg, sql_out=sql_out) or []
        return _with_sql({"db": db, "database": db_label, "count": len(rows), "blocking_sessions": rows},
                         args, caller, db, ctx or {}, sql_out)
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Blocking-sessions query failed: {exc}"}


# --- top tables / indexes / index health -------------------------------------
def _top_tables(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    p, err = _prep(args, scopes, ctx or {})
    if err:
        return err
    db, db_label, sc, cfg, use_dummy, schema = p
    limit = int(base.num(args.get("limit")) or 5)
    sql_out = [] if args.get("include_sql") else None
    if use_dummy:
        rows = [{"table": "OLS_LCR_STAGE", "size_gb": 812.4}, {"table": "OLS_POSITION", "size_gb": 344.1},
                {"table": "OLS_TRADE", "size_gb": 210.8}, {"table": "OLS_CASHFLOW", "size_gb": 190.2},
                {"table": "OLS_AUDIT", "size_gb": 88.7}]
        return _with_sql({"db": db, "database": db_label, "top_tables": rows[:limit]},
                         args, caller, db, ctx or {}, sql_out)
    try:
        import database
        raw = database.fetch_top_segments(cfg, schema, limit, 10, sql_out=sql_out)
        rows = [{"table": t["segment_name"], "size_gb": t["size_gb"]} for t in (raw.get("tables") or [])[:limit]]
        return _with_sql({"db": db, "database": db_label, "top_tables": rows}, args, caller, db, ctx or {}, sql_out)
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Top-tables query failed: {exc}"}


def _top_indexes(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    p, err = _prep(args, scopes, ctx or {})
    if err:
        return err
    db, db_label, sc, cfg, use_dummy, schema = p
    limit = int(base.num(args.get("limit")) or 5)
    sql_out = [] if args.get("include_sql") else None
    if use_dummy:
        rows = [{"index": "OLS_LCR_STAGE_PK", "table": "OLS_LCR_STAGE", "size_gb": 120.5},
                {"index": "OLS_POSITION_IX1", "table": "OLS_POSITION", "size_gb": 64.2}]
        return _with_sql({"db": db, "database": db_label, "top_indexes": rows[:limit]},
                         args, caller, db, ctx or {}, sql_out)
    try:
        import database
        raw = database.fetch_top_indexes(cfg, schema, limit, 10, sql_out=sql_out)
        rows = [{"index": i["index_name"], "table": i["table_name"], "size_gb": i["size_gb"]}
                for i in (raw.get("indexes") or [])[:limit]]
        return _with_sql({"db": db, "database": db_label, "top_indexes": rows}, args, caller, db, ctx or {}, sql_out)
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Top-indexes query failed: {exc}"}


def _unusable_indexes(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    """Index health — UNUSABLE / INVISIBLE / STALE-STATS. Filter to a state with the `state` arg."""
    p, err = _prep(args, scopes, ctx or {})
    if err:
        return err
    db, db_label, sc, cfg, use_dummy, schema = p
    want = str(args.get("state") or "unusable").strip().upper()
    sql_out = [] if args.get("include_sql") else None
    if use_dummy:
        rows = [{"index": "OLS_TRADE_IX2", "table": "OLS_TRADE", "state": "UNUSABLE",
                 "detail": "Offline — rebuild required"},
                {"index": "OLS_AUDIT_IX1", "table": "OLS_AUDIT", "state": "STALE STATS",
                 "detail": "Stats out of date"}]
    else:
        try:
            import database
            rows = [{"index": r["index_name"], "table": r["table_name"], "state": r["state"],
                     "detail": r.get("detail", "")} for r in database.fetch_index_health(cfg, schema, sql_out=sql_out)]
        except Exception as exc:  # noqa: BLE001
            return {"error": f"Index-health query failed: {exc}"}
    if want and want != "ALL":
        rows = [r for r in rows if want in str(r.get("state", "")).upper()]
    return _with_sql({"db": db, "database": db_label, "state": want, "indexes": rows},
                     args, caller, db, ctx or {}, sql_out)


# --- materialized views ------------------------------------------------------
def _mviews(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    """Materialized views + staleness. ``stale`` = only the stale/unstable ones."""
    p, err = _prep(args, scopes, ctx or {})
    if err:
        return err
    db, db_label, sc, cfg, use_dummy, schema = p
    stale_only = str(args.get("stale") or "").strip().lower() in ("1", "true", "yes", "y", "stale")
    sql_out = [] if args.get("include_sql") else None
    if use_dummy:
        rows = [{"mview": "MV_POSITION_SUMMARY", "last_refresh": "2026-09-23 02:10", "staleness": "FRESH",
                 "compile": "VALID"},
                {"mview": "MV_CASHFLOW_DAILY", "last_refresh": "2026-09-18 02:10", "staleness": "STALE",
                 "compile": "VALID"},
                {"mview": "MV_TRADE_ROLLUP", "last_refresh": "2026-09-10 02:10", "staleness": "STALE",
                 "compile": "NEEDS COMPILE"}]
    else:
        try:
            import database
            rows = list(database.fetch_mviews(cfg, schema, sql_out=sql_out) or [])
        except Exception as exc:  # noqa: BLE001
            return {"error": f"Materialized-views query failed: {exc}"}
    if stale_only:
        rows = [r for r in rows if str(r.get("staleness", "")).upper() != "FRESH"]
    return _with_sql({"db": db, "database": db_label, "stale_only": stale_only, "mviews": rows},
                     args, caller, db, ctx or {}, sql_out)


# --- sessions ----------------------------------------------------------------
def _list_sessions(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    p, err = _prep(args, scopes, ctx or {})
    if err:
        return err
    db, db_label, sc, cfg, use_dummy, _ = p
    status = str(args.get("status") or "").strip().upper() or "ACTIVE"
    sql_out = [] if args.get("include_sql") else None
    if use_dummy:
        rows = [{"sid": 908, "user": "OLS_APP", "status": "ACTIVE", "sql_id": "8gk2m1p4q7xza", "event": "enq: TX"},
                {"sid": 455, "user": "OLS_RPT", "status": "ACTIVE", "sql_id": "3fd9c0v1nb6ht", "event": "db file read"}]
        return _with_sql({"db": db, "database": db_label, "status": status, "count": len(rows), "sessions": rows},
                         args, caller, db, ctx or {}, sql_out)
    try:
        import database
        data = database.fetch_sessions(cfg, status, sql_out=sql_out) or {}
        rows = data.get("rows") if isinstance(data, dict) else (data or [])
        rows = rows or []
        return _with_sql({"db": db, "database": db_label, "status": status, "count": len(rows), "sessions": rows},
                         args, caller, db, ctx or {}, sql_out)
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Sessions query failed: {exc}"}


# --- sql_id investigation ----------------------------------------------------
_SQL_ASPECTS = ("overview", "plan", "monitor", "performance", "waits", "binds")


def _sql_detail(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    """Investigate a sql_id. ``aspect``: overview | plan | monitor | performance | waits | binds. Big text
    aspects (plan, monitor) are written to a file and returned as a download link."""
    p, err = _prep(args, scopes, ctx or {})
    if err:
        return err
    db, db_label, sc, cfg, use_dummy, _ = p
    sql_id = str(args.get("sql_id") or "").strip()
    aspect = str(args.get("aspect") or "overview").strip().lower()
    if not sql_id:
        return {"error": "A sql_id is required."}
    if aspect not in _SQL_ASPECTS:
        aspect = "overview"
    api_base = str((ctx or {}).get("api_base") or "").rstrip("/")

    def _download(text: str, label: str) -> dict:
        fname = base.write_export(f"{sql_id}_{aspect}", text, ext="txt")
        return {"db": db, "database": db_label, "sql_id": sql_id, "aspect": aspect, "label": label,
                "download_url": f"{api_base}/api/assistant/export/{fname}"}

    if use_dummy:
        if aspect == "plan":
            return _download(f"Explain plan for {sql_id} (sample)\n"
                             "-------------------------------------\n| Id | Operation | Name |\n"
                             "| 0 | SELECT STATEMENT | |\n| 1 |  TABLE ACCESS FULL | OLS_TRADE |\n", "explain plan")
        if aspect == "monitor":
            return _download(f"SQL Monitor report for {sql_id} (sample)\nStatus: DONE  Duration: 12s  Rows: 1.2M\n",
                             "SQL Monitor report")
        if aspect == "performance":
            return {"db": db, "database": db_label, "sql_id": sql_id, "aspect": aspect,
                    "rows": [{"snap": "2026-09-23 09:00", "execs": 42, "elapsed_s": 3.1, "buffer_gets": 90210}]}
        if aspect == "waits":
            return {"db": db, "database": db_label, "sql_id": sql_id, "aspect": aspect,
                    "rows": [{"event": "db file sequential read", "pct": 61.0}, {"event": "CPU", "pct": 29.0}]}
        if aspect == "binds":
            return {"db": db, "database": db_label, "sql_id": sql_id, "aspect": aspect,
                    "rows": [{"name": ":1", "value": "IXLQA90"}, {"name": ":2", "value": "2026-09-20"}]}
        return {"db": db, "database": db_label, "sql_id": sql_id, "aspect": "overview",
                "overview": {"sql_text": "SELECT ... FROM OLS_TRADE ...", "plans": 2, "verdict": "plan instability",
                             "execs_5d": 210, "avg_elapsed_s": 3.4}}
    # --- real ---
    try:
        import database
        days = 5
        if aspect == "plan":
            plans = database.fetch_sql_plans(cfg, sql_id, days)
            phv = (plans.get("plans") or [{}])[0].get("plan_hash_value") if isinstance(plans, dict) else None
            text = database.fetch_sql_plan_text(cfg, sql_id, int(phv)) if phv else "(no plan found)"
            return _download(str(text), "explain plan")
        if aspect == "monitor":
            return _download(str(database.fetch_sql_monitor(cfg, sql_id)), "SQL Monitor report")
        if aspect == "performance":
            return {"db": db, "database": db_label, "sql_id": sql_id, "aspect": aspect,
                    "rows": list(database.fetch_sql_perf(cfg, sql_id, days))}
        if aspect == "waits":
            return {"db": db, "database": db_label, "sql_id": sql_id, "aspect": aspect, "rows": database.fetch_sql_ash(cfg, sql_id, days)}
        if aspect == "binds":
            return {"db": db, "database": db_label, "sql_id": sql_id, "aspect": aspect,
                    "rows": list(database.fetch_sql_binds(cfg, sql_id, days))}
        return {"db": db, "database": db_label, "sql_id": sql_id, "aspect": "overview",
                "overview": database.fetch_sql_overview(cfg, sql_id, days)}
    except Exception as exc:  # noqa: BLE001
        return {"error": f"SQL {aspect} for {sql_id} failed: {exc}"}


SCHEMAS: list[dict] = [
    {"type": "function", "function": {
        "name": "blocking_sessions",
        "description": "List current blocking sessions on an Oracle database. Use for 'blocking sessions on the "
                       "CIB batch DB'.",
        "parameters": {"type": "object", "properties": {
            "db": {"type": "string", "description": "OCC database key, e.g. cib_batch, cib_reporting."},
        }, "required": ["db"]},
    }},
    {"type": "function", "function": {
        "name": "top_tables",
        "description": "Top space-consuming tables on a database. Use for 'top 5 largest tables in the CIB "
                       "batch DB'.",
        "parameters": {"type": "object", "properties": {
            "db": {"type": "string", "description": "OCC database key."},
            "limit": {"type": "number", "description": "How many (default 5)."},
        }, "required": ["db"]},
    }},
    {"type": "function", "function": {
        "name": "top_indexes",
        "description": "Top space-consuming indexes on a database. Use for 'largest / high-utilized indexes'.",
        "parameters": {"type": "object", "properties": {
            "db": {"type": "string", "description": "OCC database key."},
            "limit": {"type": "number", "description": "How many (default 5)."},
        }, "required": ["db"]},
    }},
    {"type": "function", "function": {
        "name": "unusable_indexes",
        "description": "Index health issues (UNUSABLE / INVISIBLE / STALE STATS). Use for 'list unusable "
                       "indexes' or 'indexes with stale stats'.",
        "parameters": {"type": "object", "properties": {
            "db": {"type": "string", "description": "OCC database key."},
            "state": {"type": "string", "description": "UNUSABLE (default), INVISIBLE, STALE, or ALL."},
        }, "required": ["db"]},
    }},
    {"type": "function", "function": {
        "name": "mviews",
        "description": "List materialized views and their staleness/compile state. Use for 'stale / unstable "
                       "materialized views' or 'MView refresh status'. Pass stale=true for only the stale ones.",
        "parameters": {"type": "object", "properties": {
            "db": {"type": "string", "description": "OCC database key."},
            "stale": {"type": "boolean", "description": "Only stale/unstable MViews."},
        }, "required": ["db"]},
    }},
    {"type": "function", "function": {
        "name": "list_sessions",
        "description": "List database sessions, optionally by status. Use for 'active sessions on the CIB "
                       "batch DB'.",
        "parameters": {"type": "object", "properties": {
            "db": {"type": "string", "description": "OCC database key."},
            "status": {"type": "string", "description": "ACTIVE (default) / INACTIVE / ALL."},
        }, "required": ["db"]},
    }},
    {"type": "function", "function": {
        "name": "sql_detail",
        "description": "Investigate a sql_id. aspect = overview | plan | monitor | performance | waits | binds. "
                       "Plan and monitor are large so they come back as a download link. Use for 'explain plan "
                       "for sql_id 8gk2m1p4q7xza' or 'sql monitor for that sql_id'.",
        "parameters": {"type": "object", "properties": {
            "db": {"type": "string", "description": "OCC database key."},
            "sql_id": {"type": "string", "description": "The sql_id to investigate."},
            "aspect": {"type": "string", "enum": list(_SQL_ASPECTS),
                       "description": "What to fetch (default overview)."},
        }, "required": ["db", "sql_id"]},
    }},
]

# Every OCC *read report* tool can surface the exact SQL it ran — but only to users who hold WRITE access on
# that OCC database, and only when they explicitly ask (include_sql). This is deliberately OCC-only. sql_detail
# is excluded: its plan/monitor/overview output already *is* the SQL analysis for the sql_id.
_INCLUDE_SQL_PARAM = {
    "type": "boolean",
    "description": "Set true ONLY when the user explicitly asks to see the actual SQL/query that was run "
                   "(e.g. 'show me the query', 'what SQL did you run'). The SQL is returned only to users "
                   "with WRITE access on that OCC database; read-only users get a polite refusal.",
}
for _schema in SCHEMAS:
    if _schema["function"]["name"] != "sql_detail":
        _schema["function"]["parameters"]["properties"]["include_sql"] = dict(_INCLUDE_SQL_PARAM)

TOOLS = {
    "blocking_sessions": _blocking_sessions,
    "top_tables": _top_tables,
    "top_indexes": _top_indexes,
    "unusable_indexes": _unusable_indexes,
    "list_sessions": _list_sessions,
    "mviews": _mviews,
    "sql_detail": _sql_detail,
}
