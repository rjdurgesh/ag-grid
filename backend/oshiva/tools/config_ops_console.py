"""Config Ops Console tools — READ-ONLY views of the config tables.

Reuses the SAME data functions the Config Ops screen uses (``database.config_table_content`` /
``config_column_detail`` / ``config_date_column``), in-process. All three business lines (CIB / RETAIL /
GROUP) are the same feature — ``scope`` is a parameter, not separate code.

Safety, by design:
  * **Read-only.** Writes (roll / upload / insert / update / delete) are deliberately NOT exposed — config
    changes stay in the UI with its write-gating.
  * **Per-scope authorization** via ``scope_access`` (a caller without CIB config gets the standard denial).
  * **Minimize secrets at the source** — ``get_config`` drops secret-named columns before returning; central
    redaction (``oshiva/security/redaction.py``) then masks any sensitive VALUES as a safety net.
  * **Size guard** — rows are capped low (``_ROW_CAP``) so we never feed a huge table into the model.
  * **Dev = dummy.** ``CONFIG_USE_DUMMY`` returns a clear placeholder here (no DB on the laptop); real rows
    appear in the live environment.
"""

from __future__ import annotations

from . import base

_ROW_CAP = 50       # keep tool output small — the model doesn't need thousands of rows (the UI is for that)
_PREVIEW_ROWS = 5   # query_table shows this many inline, then offers a full-CSV download link
_EXPORT_CAP = 100000  # export writes to a FILE (not the model), so a much larger cap is fine

# Exports are written here and served by GET /api/assistant/export/<file> (see oshiva/api.py). The DATA never
# goes to the model — only a download link + row count do.  backend/oshiva/tools/… → parents[2] = backend/
from pathlib import Path as _Path  # noqa: E402
_EXPORT_DIR = _Path(__file__).resolve().parents[2] / "assistant_data" / "exports"

# Accept a few common date formats defensively (the model normalises too, but be forgiving).
_DATE_FORMATS = ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d-%b-%Y", "%d %b %Y", "%d %B %Y", "%Y/%m/%d")


def _nearest(candidates: list, target: str, n: int = 3) -> list:
    """Closest names to `target` (case-insensitive) — for 'did you mean?' column/table suggestions."""
    import difflib
    if not target or not candidates:
        return []
    up = {str(c).upper(): str(c) for c in candidates}
    hits = difflib.get_close_matches(str(target).upper(), list(up), n=n, cutoff=0.5)
    return [up[h] for h in hits]


def _parse_date(s: str):
    """Parse a date in any of the common formats → datetime, or None if unrecognised."""
    from datetime import datetime
    s = (s or "").strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _resolve_db(scope: str, db_source: str, ctx: dict):
    """Pick the privileged config DB connection for this scope, mirroring config_api._source_db. Defaults to
    the scope's batch DB (where config lives). Returns (cfg, error_message)."""
    key = (db_source or f"ols_{scope}_batch").strip().lower()
    if not (key == f"ols_{scope}" or key.startswith(f"ols_{scope}_")):
        return None, f"db_source '{db_source}' does not belong to scope '{scope}'."
    cfgs = ctx.get("sql_db_configs") or ctx.get("db_configs") or {}
    cfg = cfgs.get(key)
    if cfg is None:
        return None, f"Config DB '{key}' is not reachable."
    return cfg, None


def _list_config_tables(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    """The config tables the caller may work with for a scope (best-effort: their explicitly granted tables;
    category-level tables aren't enumerable, so naming a table directly always works)."""
    from ..auth import scope_access as authz
    scope = str(args.get("scope") or "").strip().lower()
    if not scope:
        return {"error": "A 'scope' is required (cib / retail / group)."}
    if not authz.scope_allowed(scopes, scope):
        return base.deny(scope, scopes)
    ctx = ctx or {}
    try:
        import config_api
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Config service unavailable ({exc})."}
    if config_api.CONFIG_USE_DUMMY:
        return {"scope": scope, "tables": [],
                "note": "Table listing isn't available in this environment — name a specific table and I can "
                        "read it in the live environment."}
    try:
        import access_api
        import database
        dbcfg = ctx.get("app_db_config")
        grants = database.fetch_user_grants(dbcfg, caller) or []
        ident = database.fetch_user_identity(dbcfg, caller)
        snap = access_api.build_snapshot(ident, grants, ctx.get("app_env") or "PROD")
        granted = [str(t) for t in ((snap.get("config") or {}).get("table_grants") or [])]
        return {"scope": scope, "granted_tables": granted,
                "note": "These are the config tables explicitly granted to you; category-level tables aren't "
                        "listed here — name any table you know and I can read it."}
    except Exception as exc:  # noqa: BLE001 — never crash; guide the user
        return {"scope": scope, "tables": [],
                "note": f"Couldn't list tables ({exc}); name a specific table and I can read it."}


def _describe_config_table(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    """Column definitions (name / type / nullable) for one config table."""
    from ..auth import scope_access as authz
    scope = str(args.get("scope") or "").strip().lower()
    table = str(args.get("table") or "").strip()
    db_source = str(args.get("db_source") or "").strip().lower()
    if not table:
        return {"needs_input": True, "message": "Which config table should I use?"}
    if not scope:
        return {"needs_input": True,
                "message": f"Which business line is `{table}` in — CIB, RETAIL, or GROUP?"}
    if not authz.scope_allowed(scopes, scope):
        return base.deny(scope, scopes)
    ctx = ctx or {}
    try:
        import config_api
        import database
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Config service unavailable ({exc})."}
    if config_api.CONFIG_USE_DUMMY:
        return {"scope": scope, "table": table, "columns": [],
                "note": "Config runs in dummy mode here; column details are available in the live environment."}
    cfg, err = _resolve_db(scope, db_source, ctx)
    if err:
        return {"error": err}
    try:
        return {"scope": scope, "table": table, "column_detail": database.config_column_detail(cfg, table)}
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Could not describe '{table}': {exc}"}


def _get_config(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    """Read a config table's rows (capped). For a COB (date-partitioned) table, pass ``business_date`` to
    filter to that day; otherwise the whole table is returned (capped). Secret columns are dropped."""
    from ..auth import scope_access as authz
    from ..security import redaction
    scope = str(args.get("scope") or "").strip().lower()
    table = str(args.get("table") or "").strip()
    db_source = str(args.get("db_source") or "").strip().lower()
    business_date = str(args.get("business_date") or "").strip()
    if not scope or not table:
        return {"error": "Both 'scope' and 'table' are required."}
    if not authz.scope_allowed(scopes, scope):
        return base.deny(scope, scopes)
    ctx = ctx or {}
    try:
        import config_api
        import database
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Config service unavailable ({exc})."}
    if config_api.CONFIG_USE_DUMMY:
        return {"scope": scope, "table": table, "columns": [], "rows": [],
                "note": "Config runs in dummy mode here; live rows are available in the real environment."}
    cfg, err = _resolve_db(scope, db_source, ctx)
    if err:
        return {"error": err}
    is_cob = bool(business_date)
    date_col = None
    start = None
    try:
        if is_cob:
            date_col = database.config_date_column(cfg, table)
            from datetime import datetime
            start = datetime.strptime(business_date, "%Y-%m-%d")
        content = database.config_table_content(cfg, table=table, date_col=date_col, is_cob=is_cob,
                                                start_date=start, end_date=None, date_range=None,
                                                row_cap=_ROW_CAP + 1)
    except ValueError as exc:
        return {"error": f"Bad request for '{table}': {exc}"}
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Could not read '{table}': {exc}"}

    cols = list(content.get("cols") or [])
    rows = list(content.get("Table_data") or [])
    # MINIMIZE: drop secret-named columns before returning (redaction still masks values centrally as a net).
    try:
        secret = {i for i, c in enumerate(cols) if redaction.is_secret_key(c)}
        if secret:
            keep = [i for i in range(len(cols)) if i not in secret]
            cols = [cols[i] for i in keep]
            rows = [[r[i] for i in keep] if isinstance(r, (list, tuple)) else
                    {k: v for k, v in r.items() if not redaction.is_secret_key(k)} if isinstance(r, dict) else r
                    for r in rows]
    except Exception:  # noqa: BLE001 — dropping is best-effort; central redaction is the guarantee
        pass
    truncated = len(rows) > _ROW_CAP
    return {"scope": scope, "table": table, "date_column": date_col, "columns": cols,
            "rows": rows[:_ROW_CAP], "row_count": min(len(rows), _ROW_CAP), "truncated": truncated}


def _query_table(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    """Look up rows by an exact column value, and/or count matching rows, choosing which columns to return.
    Optional business_date adds a COB day filter (and reports clearly if the table has no date column)."""
    from ..auth import scope_access as authz
    from ..security import redaction
    scope = str(args.get("scope") or "").strip().lower()
    table = str(args.get("table") or "").strip()
    match_column = str(args.get("match_column") or "").strip() or None
    match_value = args.get("match_value")
    business_date = str(args.get("business_date") or "").strip()
    count = bool(args.get("count"))
    columns = args.get("columns") if isinstance(args.get("columns"), list) else None
    db_source = str(args.get("db_source") or "").strip().lower()
    if not table:
        return {"needs_input": True, "message": "Which config table should I use?"}
    if not scope:
        return {"needs_input": True,
                "message": f"Which business line is `{table}` in — CIB, RETAIL, or GROUP?"}
    if not authz.scope_allowed(scopes, scope):
        return base.deny(scope, scopes)
    ctx = ctx or {}
    try:
        import config_api
        import database
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Config service unavailable ({exc})."}

    db_used = db_source or f"ols_{scope}_batch"     # the real config DB this runs against (per env)
    where_bits = []
    if match_column and match_value is not None:
        where_bits.append(f"{match_column} = '{match_value}'")
    if business_date:
        where_bits.append(f"business_date = '{business_date}'")
    where_disp = (" WHERE " + " AND ".join(where_bits)) if where_bits else ""

    if config_api.CONFIG_USE_DUMMY:
        # Sample data so the preview + download flow is demoable without a DB.
        cols = columns or ["LMA_CODE", "LMA_LABEL", "BUSINESS_DATE"]
        sel = ", ".join(cols)
        if count:
            return {"scope": scope, "table": table, "database": db_used, "count": 1287,
                    "sql": f"SELECT COUNT(*) FROM {table}{where_disp}"}
        rows = [{"LMA_CODE": f"IXLQA{90 + i}", "LMA_LABEL": f"Label {90 + i}",
                 "BUSINESS_DATE": business_date or "2026-09-20"} for i in range(7)]
        sql = f"SELECT {sel} FROM {table}{where_disp} FETCH FIRST {_EXPORT_CAP} ROWS ONLY"
    else:
        cfg, err = _resolve_db(scope, db_source, ctx)
        if err:
            return {"error": err}
        # Optional COB date filter — resolve the table's date column and confirm it actually exists.
        date_col = date_val = None
        if business_date:
            try:
                date_col = database.config_date_column(cfg, table)
                valid = {c["name"].upper() for c in database.config_table_columns(cfg, table)}
                if not date_col or date_col.upper() not in valid:
                    return {"scope": scope, "table": table,
                            "note": f"'{table}' has no date column, so it can't be filtered by date."}
            except Exception as exc:  # noqa: BLE001
                return {"error": f"Could not resolve the date column for '{table}': {exc}"}
            date_val = _parse_date(business_date)
            if date_val is None:
                return {"error": f"I couldn't read the date '{business_date}'. Please give it as YYYY-MM-DD."}
        if columns:  # never let a secret column be explicitly requested
            columns = [c for c in columns if not redaction.is_secret_key(c)]
        try:
            # Fetch up to the export cap so we can offer a full download; we only PREVIEW a few rows in chat.
            res = database.config_query_table(
                cfg, table=table, where_col=match_column, where_val=match_value,
                date_col=date_col, date_val=date_val, select_cols=columns or None,
                count_only=count, row_cap=(_ROW_CAP if count else _EXPORT_CAP))
        except ValueError as exc:   # bad table/column → suggest the nearest match instead of a dead end
            msg = str(exc)
            try:
                if "Unknown column" in msg:
                    names = [c["name"] for c in database.config_table_columns(cfg, table)]
                    want = match_column or (columns[0] if columns else "")
                    near = _nearest(names, want)
                    if near:
                        msg += " Did you mean: " + ", ".join(near) + "?"
                elif "has no columns" in msg or "does it exist" in msg:
                    sugg = database.config_find_similar_tables(cfg, table)
                    msg = f"I couldn't find a table named '{table}' in {scope.upper()}."
                    if sugg:
                        msg += " Did you mean: " + ", ".join(sugg) + "?"
            except Exception:  # noqa: BLE001
                pass
            return {"needs_input": True, "message": msg}
        except Exception as exc:  # noqa: BLE001
            return {"error": f"Query on '{table}' failed: {exc}"}
        if count:
            res["scope"] = scope
            res["database"] = db_used
            return res
        cols = list(res.get("cols") or [])
        rows = list(res.get("rows") or [])
        sql = res.get("sql", "")
    # MINIMIZE: drop secret-named columns (redaction still nets values as a fallback).
    try:
        secret = {i for i, c in enumerate(cols) if redaction.is_secret_key(c)}
        if secret:
            cols = [c for i, c in enumerate(cols) if i not in secret]
            rows = [{k: v for k, v in r.items() if not redaction.is_secret_key(k)} for r in rows]
    except Exception:  # noqa: BLE001
        pass

    total = len(rows)
    out = {"scope": scope, "table": table, "database": db_used, "query": sql, "columns": cols,
           "rows": rows[:_PREVIEW_ROWS], "row_count": total, "preview": min(total, _PREVIEW_ROWS)}
    if config_api.CONFIG_USE_DUMMY:
        out["note"] = "Sample data (dummy mode) — the live database returns the real rows."
    if total > _PREVIEW_ROWS:   # more than we show inline → offer a full CSV download
        try:
            import csv
            import io
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow(cols)
            for r in rows:
                w.writerow([r.get(c) if isinstance(r, dict) else "" for c in cols])
            fname = base.write_export(f"{table}_query", buf.getvalue(), ext="csv")
            out["download_url"] = f"{str(ctx.get('api_base') or '').rstrip('/')}/api/assistant/export/{fname}"
        except Exception:  # noqa: BLE001 — preview still works even if the file write fails
            pass
    return out


def _has_config_write(caller: str, scope: str, ctx: dict) -> bool:
    """WRITE access to this config scope (mirrors config_api._require_config_access write): full-access WRITE
    or a config_ops:<scope> WRITE grant. Dummy mode → allowed (dev)."""
    try:
        import config_api
        import database
    except Exception:  # noqa: BLE001
        return False
    if config_api.CONFIG_USE_DUMMY:
        return True
    want = f"config_ops:{scope}".lower()
    for g in (database.fetch_user_grants(ctx.get("app_db_config"), caller) or []):
        lvl = (g.get("access_level") or "").strip().upper()
        if lvl == "DENY":
            continue
        rs = (g.get("resource_scope") or "").lower()
        rk = (g.get("resource_key") or "").strip()
        full = (g.get("resource_type") or "").strip().upper() == "SCREEN" and rs == "*" and rk == "*"
        if (full or rs == want) and lvl == "WRITE":
            return True
    return False


def _roll_config(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    """WRITE — roll a COB table's rows from a source date to target date(s). Two-step by design: without
    ``confirm=true`` it returns a PREVIEW (never executes); the agent shows it and only re-calls with
    ``confirm=true`` after the user agrees. This confirm-gate is the safety net on top of the system-prompt
    policy — the tool cannot execute a roll that wasn't explicitly confirmed."""
    from datetime import timedelta

    from ..auth import scope_access as authz
    scope = str(args.get("scope") or "").strip().lower()
    table = str(args.get("table") or "").strip()
    from_date = str(args.get("from_date") or "").strip()
    to_dates = args.get("to_dates") if isinstance(args.get("to_dates"), list) else None
    range_from = str(args.get("range_from") or "").strip()
    range_to = str(args.get("range_to") or "").strip()
    confirm = bool(args.get("confirm"))
    db_source = str(args.get("db_source") or "").strip().lower()
    if not scope or not table or not from_date:
        return {"error": "'scope', 'table' and 'from_date' are required to roll."}
    if not authz.scope_allowed(scopes, scope):
        return base.deny(scope, scopes)
    ctx = ctx or {}
    if not _has_config_write(caller, scope, ctx):
        return {"denied": True, "message": f"Rolling config data needs WRITE access to {scope.upper()} config, "
                                           "which your account doesn't have."}

    src = _parse_date(from_date)
    if src is None:
        return {"error": f"I couldn't read the source date '{from_date}'. Please give it as YYYY-MM-DD."}

    targets: list = []
    mode = ""
    if range_from and range_to:
        rf, rt = _parse_date(range_from), _parse_date(range_to)
        if rf is None or rt is None:
            return {"error": "I couldn't read the range dates. Please give them as YYYY-MM-DD."}
        if rt < rf:
            rf, rt = rt, rf
        d = rf
        while d <= rt:
            targets.append(d)
            d += timedelta(days=1)
        mode = f"every day in the range {rf:%Y-%m-%d}..{rt:%Y-%m-%d}"
    elif to_dates:
        for x in to_dates:
            dt = _parse_date(str(x))
            if dt is None:
                return {"error": f"I couldn't read the date '{x}'. Please use YYYY-MM-DD."}
            targets.append(dt)
        mode = "these specific date(s)"
    else:
        return {"needs_input": True,
                "message": "Which target dates should I roll to? Give either specific dates, or a range "
                           "(range_from + range_to). If you named two dates, tell me whether you mean just "
                           "those two days or the whole range between them."}

    seen: set = set()
    tgt: list = []
    for d in targets:
        if d != src and d not in seen:
            seen.add(d)
            tgt.append(d)
    if not tgt:
        return {"error": "No target date that differs from the source date."}
    tgt_str = [f"{d:%Y-%m-%d}" for d in tgt]

    if not confirm:   # PREVIEW — do not execute
        return {"confirm_required": True, "action": "roll_config", "scope": scope, "table": table,
                "from_date": f"{src:%Y-%m-%d}", "to_dates": tgt_str,
                "message": (f"About to ROLL **{table}** ({scope.upper()}) from {src:%Y-%m-%d} to {mode}: "
                            f"{', '.join(tgt_str)}. This copies the source rows into each target date. "
                            "Reply 'yes' to proceed.")}

    # confirm == true → execute
    try:
        import config_api
        import database
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Config service unavailable ({exc})."}
    if config_api.CONFIG_USE_DUMMY:
        return {"status": "success", "executed": True, "scope": scope, "table": table,
                "source_date": f"{src:%Y-%m-%d}", "source_count": 0,
                "targets": [{"date": d, "status": "success", "count": 0} for d in tgt_str],
                "note": "(dummy) roll simulated — no data changed in this environment."}
    cfg, err = _resolve_db(scope, db_source, ctx)
    if err:
        return {"error": err}
    try:
        # result = {source_date, source_count, targets:[{date, status, count, error?}]}
        result = database.config_roll_dates(cfg, table=table, source_date=src, target_dates=tgt, uid=caller)
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Roll failed: {exc}"}
    return {"status": "success", "executed": True, "scope": scope, "table": table, **result}


def _find_tables_with_column(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    """Schema lookup — which config tables contain a given column (so the user needn't name the table)."""
    from ..auth import scope_access as authz
    scope = str(args.get("scope") or "").strip().lower()
    column = str(args.get("column") or "").strip()
    db_source = str(args.get("db_source") or "").strip().lower()
    if not scope or not column:
        return {"error": "Both 'scope' and 'column' are required."}
    if not authz.scope_allowed(scopes, scope):
        return base.deny(scope, scopes)
    ctx = ctx or {}
    try:
        import config_api
        import database
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Config service unavailable ({exc})."}
    if config_api.CONFIG_USE_DUMMY:
        return {"scope": scope, "column": column, "tables": [],
                "note": "Schema lookup runs against the live DB; in this (dummy) environment it returns "
                        "nothing. In prod it lists which tables contain the column."}
    cfg, err = _resolve_db(scope, db_source, ctx)
    if err:
        return {"error": err}
    try:
        return {"scope": scope, "column": column,
                "tables": database.config_find_tables_with_column(cfg, column)}
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Schema lookup failed: {exc}"}


def _export_config(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    """Export a config table to a CSV FILE and return a download link (the rows never go to the model). Works
    for a table with a date (pass business_date) or without (whole table). Secret columns are dropped."""
    import csv
    import re as _re
    import uuid

    from ..auth import scope_access as authz
    from ..security import redaction
    scope = str(args.get("scope") or "").strip().lower()
    table = str(args.get("table") or "").strip()
    business_date = str(args.get("business_date") or "").strip()
    date_from = str(args.get("date_from") or "").strip()
    date_to = str(args.get("date_to") or "").strip()
    db_source = str(args.get("db_source") or "").strip().lower()
    if not table:
        return {"needs_input": True, "message": "Which config table should I export?"}
    if not scope:
        return {"needs_input": True,
                "message": f"Which business line is `{table}` in — CIB, RETAIL, or GROUP?"}
    if not authz.scope_allowed(scopes, scope):
        return base.deny(scope, scopes)
    ctx = ctx or {}
    try:
        import config_api
        import database
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Config service unavailable ({exc})."}

    # Gather rows (data stays server-side).
    if config_api.CONFIG_USE_DUMMY:
        cols = ["SAMPLE_COL_A", "SAMPLE_COL_B"]
        rows = [{"SAMPLE_COL_A": "sample-1", "SAMPLE_COL_B": 101},
                {"SAMPLE_COL_A": "sample-2", "SAMPLE_COL_B": 102}]
        dummy = True
    else:
        cfg, err = _resolve_db(scope, db_source, ctx)
        if err:
            return {"error": err}
        # Table exists? If not, suggest the nearest matches.
        try:
            valid = {c["name"].upper() for c in database.config_table_columns(cfg, table)}
        except Exception:  # noqa: BLE001
            valid = set()
        if not valid:
            suggestions = []
            try:
                suggestions = database.config_find_similar_tables(cfg, table)
            except Exception:  # noqa: BLE001
                pass
            msg = f"I couldn't find a table named '{table}' in {scope.upper()}."
            if suggestions:
                msg += " Did you mean: " + ", ".join(suggestions) + "?"
            return {"needs_input": True, "message": msg}
        # Is this a COB (date-partitioned) table? Then it can be huge → require a date/range.
        date_col = database.config_date_column(cfg, table)
        is_cob = bool(date_col) and date_col.upper() in valid
        start = end = None
        date_range = False
        if is_cob:
            if not (business_date or date_from):
                return {"needs_input": True,
                        "message": f"`{table}` is date-partitioned (COB) and can be very large, so I won't "
                                   "export the whole table. Please give a business date (YYYY-MM-DD), or a "
                                   "range (from and to)."}
            if date_from and date_to:
                start, end, date_range = _parse_date(date_from), _parse_date(date_to), True
                if start is None or end is None:
                    return {"error": "I couldn't read the range dates. Use YYYY-MM-DD."}
            else:
                start = _parse_date(business_date or date_from)
                if start is None:
                    return {"error": f"I couldn't read the date '{business_date or date_from}'. Use YYYY-MM-DD."}
        try:
            content = database.config_table_content(
                cfg, table=table, date_col=(date_col if is_cob else None), is_cob=is_cob,
                start_date=start, end_date=end, date_range=date_range, row_cap=_EXPORT_CAP)
        except Exception as exc:  # noqa: BLE001
            return {"error": f"Could not read '{table}' for export: {exc}"}
        cols = list(content.get("cols") or [])
        rows = list(content.get("Table_data") or [])
        dummy = False

    cols = [c for c in cols if not redaction.is_secret_key(c)]   # never export secret columns
    safe_table = _re.sub(r"[^A-Za-z0-9_]", "_", table)[:40] or "table"
    fname = f"{safe_table}_{uuid.uuid4().hex}.csv"
    try:
        _EXPORT_DIR.mkdir(parents=True, exist_ok=True)
        with (_EXPORT_DIR / fname).open("w", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            w.writerow(cols)
            for r in rows:
                w.writerow([r.get(c) if isinstance(r, dict) else "" for c in cols])
    except OSError as exc:
        return {"error": f"Could not write the export file: {exc}"}

    api_base = str(ctx.get("api_base") or "").rstrip("/")
    dummy_note = ("(dummy) sample export — the live DB returns real rows. Note: for a date-partitioned (COB) "
                  "table I first ask for a business date or range, since those can be very large.")
    return {"status": "success", "scope": scope, "table": table, "row_count": len(rows),
            "download_url": f"{api_base}/api/assistant/export/{fname}", "filename": fname,
            "note": dummy_note if dummy else None}


SCHEMAS: list[dict] = [
    {"type": "function", "function": {
        "name": "list_config_tables",
        "description": "List the Config Ops tables the user may work with for a business line. Use for "
                       "'what config tables are there for CIB?'.",
        "parameters": {"type": "object", "properties": {
            "scope": {"type": "string", "enum": ["cib", "retail", "group"], "description": "Business line."},
        }, "required": ["scope"]},
    }},
    {"type": "function", "function": {
        "name": "describe_config_table",
        "description": "Show a config table's columns (name, type, nullable). Use for 'what columns does "
                       "OLS_PARAM have in CIB?'.",
        "parameters": {"type": "object", "properties": {
            "scope": {"type": "string", "enum": ["cib", "retail", "group"], "description": "Business line."},
            "table": {"type": "string", "description": "Config table name."},
            "db_source": {"type": "string",
                          "description": "Optional DB key like 'ols_cib_batch' (defaults to the scope's batch DB)."},
        }, "required": ["scope", "table"]},
    }},
    {"type": "function", "function": {
        "name": "get_config",
        "description": "Read a config table's rows (read-only, capped). For a date-partitioned (COB) table, "
                       "pass business_date to filter to that day. Use for 'show the OLS_PARAM config for CIB' "
                       "or '...for CIB on 2026-09-20'.",
        "parameters": {"type": "object", "properties": {
            "scope": {"type": "string", "enum": ["cib", "retail", "group"], "description": "Business line."},
            "table": {"type": "string", "description": "Config table name."},
            "business_date": {"type": "string",
                              "description": "Optional YYYY-MM-DD; only for COB (date-partitioned) tables."},
            "db_source": {"type": "string",
                          "description": "Optional DB key like 'ols_cib_batch' (defaults to the scope's batch DB)."},
        }, "required": ["scope", "table"]},
    }},
    {"type": "function", "function": {
        "name": "query_table",
        "description": "Look up rows in a config table by an EXACT column value, and/or COUNT matching rows, "
                       "choosing which columns to return. Use for 'the lma_label where lma_code is IXLQA90', "
                       "'how many rows in EMP', or 'how many rows in EMP for 2026-09-20'. To map a loose name "
                       "like 'lma code' to a real column, call describe_config_table first.",
        "parameters": {"type": "object", "properties": {
            "scope": {"type": "string", "enum": ["cib", "retail", "group"], "description": "Business line."},
            "table": {"type": "string", "description": "Config table name."},
            "match_column": {"type": "string", "description": "Column to filter on (exact match). Optional."},
            "match_value": {"type": "string", "description": "Value the match_column must equal. Optional."},
            "columns": {"type": "array", "items": {"type": "string"},
                        "description": "Which columns to return. Omit for all."},
            "count": {"type": "boolean", "description": "Return only the count of matching rows."},
            "business_date": {"type": "string",
                              "description": "Optional date (any common format) — filters a COB table to that day."},
            "db_source": {"type": "string",
                          "description": "Optional DB key like 'ols_cib_batch' (defaults to the scope's batch DB)."},
        }, "required": ["scope", "table"]},
    }},
    {"type": "function", "function": {
        "name": "find_tables_with_column",
        "description": "Find which config tables contain a column, when the user hasn't named a table (e.g. "
                       "'the lma_label for lma_code IXLQA90'). Returns candidate tables; then call query_table "
                       "on the right one.",
        "parameters": {"type": "object", "properties": {
            "scope": {"type": "string", "enum": ["cib", "retail", "group"], "description": "Business line."},
            "column": {"type": "string", "description": "The column name to search for (e.g. LMA_CODE)."},
            "db_source": {"type": "string", "description": "Optional DB key (defaults to the scope's batch DB)."},
        }, "required": ["scope", "column"]},
    }},
    {"type": "function", "function": {
        "name": "export_config",
        "description": "Export a config table to a downloadable CSV (rows go to a file, not into the chat). "
                       "Pass business_date for a COB table's day, or omit for the whole table (or a table with "
                       "no date). Use for 'export EMP for 2026-09-20' or 'download the CONFIG table'.",
        "parameters": {"type": "object", "properties": {
            "scope": {"type": "string", "enum": ["cib", "retail", "group"], "description": "Business line."},
            "table": {"type": "string", "description": "Config table to export."},
            "business_date": {"type": "string",
                              "description": "A single business date (YYYY-MM-DD). REQUIRED for a date-partitioned "
                                             "(COB) table, which can be huge; omit only for a non-COB table."},
            "date_from": {"type": "string", "description": "Range start (with date_to) for a COB table."},
            "date_to": {"type": "string", "description": "Range end (with date_from) for a COB table."},
            "db_source": {"type": "string", "description": "Optional DB key (defaults to the scope's batch DB)."},
        }, "required": ["scope", "table"]},
    }},
    {"type": "function", "function": {
        "name": "roll_config",
        "description": "WRITE — roll (copy) a COB config table's rows from a source date to target date(s). "
                       "ALWAYS confirm first: parse dates in any format; if the target dates are unclear ask; "
                       "if the user gives two dates, ask whether they mean those specific days or the whole "
                       "range between them; call with confirm=false to PREVIEW the exact action, then only "
                       "call again with confirm=true after the user explicitly agrees.",
        "parameters": {"type": "object", "properties": {
            "scope": {"type": "string", "enum": ["cib", "retail", "group"], "description": "Business line."},
            "table": {"type": "string", "description": "COB config table to roll."},
            "from_date": {"type": "string", "description": "Source date (any common format)."},
            "to_dates": {"type": "array", "items": {"type": "string"},
                         "description": "Specific target dates (use this OR range_from/range_to)."},
            "range_from": {"type": "string", "description": "Start of an inclusive target-date range."},
            "range_to": {"type": "string", "description": "End of an inclusive target-date range."},
            "confirm": {"type": "boolean",
                        "description": "Must be true to actually roll. Omit/false = preview only."},
            "db_source": {"type": "string", "description": "Optional DB key (defaults to the scope's batch DB)."},
        }, "required": ["scope", "table", "from_date"]},
    }},
]

TOOLS = {
    "list_config_tables": _list_config_tables,
    "describe_config_table": _describe_config_table,
    "get_config": _get_config,
    "query_table": _query_table,
    "find_tables_with_column": _find_tables_with_column,
    "export_config": _export_config,
    "roll_config": _roll_config,
}
