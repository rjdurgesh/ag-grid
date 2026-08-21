"""Oracle Command Center - DUMMY data (canned responses only, NO routes).

Split out of ``oracle_cc_api.py`` so the router file stays lean. Each ``*_dummy`` here is the
canned counterpart of a ``*_real`` in the API module and returns the IDENTICAL payload shape.
The shared contract/helpers (column defs, row builders, payload wrappers, the target catalog)
live in ``oracle_cc_api`` and are imported below - this module holds only the fake data.

``oracle_cc_api`` imports these functions (at the bottom of that file, once the shared names
exist) and calls them when ``ORACLE_CC_USE_DUMMY`` is on.
"""

from __future__ import annotations

from typing import Any  # noqa: F401  (used in annotations)

from fastapi import Request  # noqa: F401  (used in annotations)

from oracle_cc_api import (
    TARGET_CATALOG,
    KillRequest,
    OracleTarget,
    SessionDetailQuery,
    _IDXH_COLS,
    _IDX_COLS,
    _SESS_COLS,
    _TOP_COLS,
    _blk_node,
    _blocking_payload,
    _enabled_target_keys,
    _lock_row,
    _locks_payload,
    _panel_rollback,
    _panel_table,
    _panel_text,
    _sess_row,
    _sev_for,
    _space_payload,
    _stats_cell,
    logger,
)


def overview_dummy(request: Request | None = None) -> dict:
    snap = {
        "group":            {"storage_pct": 79.2, "blocking": 1, "active": 3, "top_object": "TRADE_EVENTS",  "top_gb": 812.40},
        "cib_batch":        {"storage_pct": 88.6, "blocking": 0, "active": 5, "top_object": "POSITION_SNAP", "top_gb": 611.90},
        "cib_reporting":    {"storage_pct": 63.1, "blocking": 0, "active": 2, "top_object": "AUDIT_LOG",     "top_gb": 402.30},
        "retail_batch":     {"storage_pct": 91.4, "blocking": 2, "active": 4, "top_object": "FX_RATE_HIST",  "top_gb": 288.10},
        "retail_reporting": {"storage_pct": 45.7, "blocking": 0, "active": 1, "top_object": "REF_INSTRUMENT", "top_gb": 88.10},
    }
    data = []
    for key in _enabled_target_keys(request):
        t = TARGET_CATALOG[key]
        s = snap.get(key, {"storage_pct": 0.0, "blocking": 0, "active": 0, "top_object": "—", "top_gb": 0.0})
        data.append({
            "key": t.key, "label": t.label, "sub": t.sub, "instance": t.instance, "reachable": True,
            "storage_pct": s["storage_pct"], "storage_sev": _sev_for(s["storage_pct"]),
            "blocking": s["blocking"], "active": s["active"],
            "top_object": s["top_object"], "top_gb": s["top_gb"],
        })
    return {"status": "success", "data": data}


def space_dummy(t: OracleTarget) -> dict:
    """Canned space data. Same shape as space_real."""
    hot = t.key == "group"
    warm = t.key == "cib_batch"
    # (owner, tablespace, total_gb, used_gb) — total/free are tablespace-level, used is per owner.
    raw = [
        ("OLS",       "OLS_DATA", 2048, 1840.44 if hot else 1120.0),
        ("OLS",       "OLS_IDX",  1024, 902.10 if hot else 540.0),
        ("OLS",       "OLS_LOB",  512,  305.77),
        ("OLS_BATCH", "OLS_DATA", 2048, 118.30),
        ("OLS_ARCH",  "OLS_ARCH", 256,  148.20 if warm else 60.0),
        ("OLS",       "OLS_STG",  256,  17.30),
    ]
    # tablespace-level used = sum of owner rows in that tablespace
    ts_used: dict[str, float] = {}
    for _o, ts, _tot, used in raw:
        ts_used[ts] = ts_used.get(ts, 0.0) + used
    rows = []
    for owner, ts, total, used in raw:
        free = round(total - ts_used[ts], 2)
        pct = round(ts_used[ts] / total * 100, 1) if total else 0.0
        rows.append({
            "owner": owner, "tablespace": ts,
            "total_gb": float(total), "used_gb": round(used, 2), "free_gb": free, "used_pct": pct,
        })
    return _space_payload(rows)


def top_segments_dummy(t: OracleTarget) -> dict:
    rows = [
        {"object": "TRADE_EVENTS", "kind": "Table · RANGE", "size_gb": 812.40, "num_rows": 4120400000,
         "last_analyzed": "14-Aug 02:10", **_stats_cell(True), "__children": [
            {"object": "P_2026_08", "kind": "Partition", "size_gb": 96.20, "num_rows": 512000000,
             "last_analyzed": "14-Aug 02:10", **_stats_cell(False), "__children": [
                {"object": "SP_EUR", "kind": "Subpartition", "size_gb": 48.10, "num_rows": 256000000, "last_analyzed": "14-Aug", **_stats_cell(False)},
                {"object": "SP_USD", "kind": "Subpartition", "size_gb": 48.10, "num_rows": 256000000, "last_analyzed": "14-Aug", **_stats_cell(True)},
             ]},
            {"object": "P_2026_07", "kind": "Partition", "size_gb": 94.00, "num_rows": 500000000, "last_analyzed": "01-Aug", **_stats_cell(True)},
            {"object": "P_2026_06", "kind": "Partition", "size_gb": 90.70, "num_rows": 486000000, "last_analyzed": "01-Jul", **_stats_cell(True)},
         ]},
        {"object": "POSITION_SNAP", "kind": "Table · HASH", "size_gb": 611.90, "num_rows": 2980000000,
         "last_analyzed": "13-Aug 23:40", **_stats_cell(False), "__children": [
            {"object": "SYS_P4411", "kind": "Partition", "size_gb": 153.00, "num_rows": 745000000, "last_analyzed": "13-Aug", **_stats_cell(False)},
            {"object": "SYS_P4412", "kind": "Partition", "size_gb": 152.60, "num_rows": 742000000, "last_analyzed": "13-Aug", **_stats_cell(False)},
         ]},
        {"object": "AUDIT_LOG", "kind": "Table · Heap", "size_gb": 402.30, "num_rows": 1900000000, "last_analyzed": "14-Aug 02:22", **_stats_cell(True)},
        {"object": "REF_INSTRUMENT", "kind": "Table · Heap", "size_gb": 88.10, "num_rows": 42000000, "last_analyzed": "14-Aug 02:24", **_stats_cell(True)},
        {"object": "FX_RATE_HIST", "kind": "Table · RANGE", "size_gb": 61.50, "num_rows": 380000000, "last_analyzed": "10-Aug", **_stats_cell(False)},
    ]
    return {"status": "success", "columns": _TOP_COLS, "rows": rows}


def top_indexes_dummy(t: OracleTarget) -> dict:
    rows = [
        {"index_name": "IX_TRADE_EVENTS_TS", "table_name": "TRADE_EVENTS", "kind": "LOCAL · RANGE", "size_gb": 143.60, "__children": [
            {"index_name": "P_2026_08", "table_name": "TRADE_EVENTS", "kind": "Index partition", "size_gb": 18.40},
            {"index_name": "P_2026_07", "table_name": "TRADE_EVENTS", "kind": "Index partition", "size_gb": 17.90},
        ]},
        {"index_name": "PK_POSITION_SNAP", "table_name": "POSITION_SNAP", "kind": "GLOBAL", "size_gb": 96.10},
        {"index_name": "IX_AUDIT_LOG_DT", "table_name": "AUDIT_LOG", "kind": "NORMAL", "size_gb": 71.20},
        {"index_name": "IX_TRADE_INSTR", "table_name": "TRADE_EVENTS", "kind": "NORMAL", "size_gb": 40.30},
        {"index_name": "UK_REF_INSTRUMENT", "table_name": "REF_INSTRUMENT", "kind": "UNIQUE", "size_gb": 9.80},
    ]
    return {"status": "success", "columns": _IDX_COLS, "rows": rows}


def index_health_dummy(t: OracleTarget) -> dict:
    rows = [
        {"index_name": "IX_TRADE_EVENTS_TS", "table_name": "TRADE_EVENTS", "state": "UNUSABLE", "state__sev": "crit",
         "detail": "Offline — not maintained; rebuild required", "last_analyzed": "14-Aug", "__sev": "crit"},
        {"index_name": "IX_STG_LOAD_TMP", "table_name": "STG_LOAD", "state": "INVISIBLE", "state__sev": "warn",
         "detail": "Maintained but hidden from optimizer (active/offline)", "last_analyzed": "12-Aug", "__sev": "warn"},
        {"index_name": "IX_POSITION_ACCT", "table_name": "POSITION_SNAP", "state": "STALE STATS", "state__sev": "warn",
         "detail": "32% rows modified since last gather", "last_analyzed": "09-Aug", "__sev": "warn"},
    ]
    return {"status": "success", "columns": _IDXH_COLS, "rows": rows}


def locks_dummy(t: OracleTarget) -> dict:
    rows = [
        _lock_row("OLS.TRADE_EVENTS", "TX (Row)", "Exclusive (X)", 845, 22931, "OLS_BATCH", "batch07", "14m 20s", "BLOCKING", "7ymz9qk4d3n1a"),
        _lock_row("OLS.TRADE_EVENTS", "TX (Row)", "Row-X (RX)",   512, 10233, "OLS_APP",   "wildfly02", "13m 55s", "WAITING",  "7ymz9qk4d3n1a"),
        _lock_row("OLS.POSITION_SNAP", "TM (DML)", "Row-X (SX)",  233,  4021, "OLS",       "etl01",    "02m 41s", "HELD",     "9ab77tzp0q2mx"),
    ]
    return _locks_payload(rows)


def kill_session_dummy(t: OracleTarget, body: KillRequest) -> dict:
    logger.info("DUMMY kill-session %s,%s on %s (immediate=%s)", body.sid, body.serial, t.key, body.immediate)
    return {"status": "success", "success": True,
            "message": f"Session {body.sid},{body.serial} has been marked for kill on {t.instance}. "
                       "Its uncommitted work is being rolled back."}


def blocking_dummy(t: OracleTarget) -> dict:
    rows = [
        _blk_node(845, 22931, "BLOCKER", "OLS_BATCH", "OLS.TRADE_EVENTS", "— holding TX row lock", "—", "7ymz9qk4d3n1a", "batch07",
                  children=[
                      _blk_node(512, 10233, "WAITER", "OLS_APP", "OLS.TRADE_EVENTS", "enq: TX - row lock contention", "13m 55s", "7ymz9qk4d3n1a", "wildfly02"),
                      _blk_node(933, 5561, "WAITER", "OLS_APP", "OLS.TRADE_EVENTS", "enq: TX - row lock contention", "09m 12s", "3xk9p1v7c2rba", "wildfly05",
                                children=[
                                    _blk_node(1002, 7781, "WAITER", "OLS_RPT", "OLS.TRADE_EVENTS", "enq: TX - row lock contention", "04m 03s", "3xk9p1v7c2rba", "rpt01"),
                                ]),
                  ]),
    ]
    return _blocking_payload(rows)


def _all_sessions() -> list[dict]:
    return [
        _sess_row(845, 22931, "OLS_BATCH", "ACTIVE", "batch07", "sqlplus@batch07", "7ymz9qk4d3n1a", "ON CPU", "14m 20s", 860),
        _sess_row(512, 10233, "OLS_APP", "ACTIVE", "wildfly02", "JDBC Thin Client", "7ymz9qk4d3n1a", "enq: TX - row lock contention", "13m 55s", 835),
        _sess_row(233, 4021, "OLS", "ACTIVE", "etl01", "ETL_Loader", "9ab77tzp0q2mx", "db file scattered read", "00m 42s", 42),
        _sess_row(760, 882, "OLS_APP", "INACTIVE", "wildfly03", "JDBC Thin Client", None, "SQL*Net message from client", "22m 10s", 1330),
        _sess_row(611, 5567, "OLS_RPT", "INACTIVE", "rpt02", "BIPublisher", None, "SQL*Net message from client", "48m 03s", 2883),
        _sess_row(1002, 7781, "OLS_RPT", "KILLED", "rpt01", "BIPublisher", "3xk9p1v7c2rba", "KILLED — PMON cleanup", "01m 12s", 72),
    ]


def sessions_dummy(t: OracleTarget, status: str) -> dict:
    rows = _all_sessions()
    counts = {
        "active": sum(1 for r in rows if r["status"] == "ACTIVE"),
        "inactive": sum(1 for r in rows if r["status"] == "INACTIVE"),
        "killed": sum(1 for r in rows if r["status"] == "KILLED"),
        "total": len(rows),
    }
    if status != "all":
        rows = [r for r in rows if r["status"] == status.upper()]
    return {"status": "success", "columns": _SESS_COLS, "rows": rows, "summary": counts}


def session_detail_dummy(t: OracleTarget, q: SessionDetailQuery) -> dict:
    # Look the session up so a KILLED one gets the rollback monitor + correct facts.
    src = next((r for r in _all_sessions() if r["sid"] == q.sid), None)
    status = src["status"] if src else "ACTIVE"
    sql_raw = src.get("sql_id") if src else None
    sql_id = q.sql_id or (sql_raw if sql_raw and sql_raw != "—" else None) or "7ymz9qk4d3n1a"

    session = {
        "sid": q.sid, "serial": q.serial, "session": f"{q.sid},{q.serial}",
        "username": src["username"] if src else "OLS_BATCH", "status": status,
        "machine": src["machine"] if src else "batch07",
        "program": src["program"] if src else "sqlplus@batch07",
        "logon_time": "16-Aug 13:31", "sql_id": sql_id,
        "osuser": (src["username"].lower() if src else "olsbatch"),
        "module": "COB_TRADE_UPDATE", "last_call": src["last_call"] if src else "14m 20s",
    }

    # DBMS_XPLAN.DISPLAY_CURSOR(:sql_id, :child, 'ALLSTATS LAST +PEEKED_BINDS') — the ACTUAL
    # execution stats (Starts / E-Rows vs A-Rows / A-Time / Buffers / Reads) are what pinpoint
    # the bottleneck, not the estimated plan.
    plan_text = (
        f"SQL_ID  {sql_id}, child number 0\n"
        "-------------------------------------\n"
        "UPDATE TRADE_EVENTS SET STATUS = :1 WHERE BOOK_ID = :2 AND TRADE_DT >= :3\n\n"
        "Plan hash value: 2847583921\n\n"
        "-------------------------------------------------------------------------------------------------\n"
        "| Id | Operation           | Name         | Starts | E-Rows | A-Rows |   A-Time   | Buffers | Reads |\n"
        "-------------------------------------------------------------------------------------------------\n"
        "|  0 | UPDATE STATEMENT    |              |      1 |        |      0 | 00:12:41.5 |   1204K |  980K |\n"
        "|  1 |  UPDATE             | TRADE_EVENTS |      1 |        |      0 | 00:12:41.5 |   1204K |  980K |\n"
        "|* 2 |   TABLE ACCESS FULL | TRADE_EVENTS |      1 |    412 |   8400K| 00:11:58.2 |   1201K |  980K |\n"
        "-------------------------------------------------------------------------------------------------\n\n"
        "Predicate Information (identified by operation id):\n"
        "   2 - filter(\"BOOK_ID\"=:2 AND \"TRADE_DT\">=:3)\n\n"
        "Note\n-----\n"
        "   - cardinality mis-estimate: E-Rows=412 vs A-Rows=8.4M on TABLE ACCESS FULL (Id 2)\n"
        "   - 980K physical reads / 1.2M buffer gets — the full scan is the bottleneck;\n"
        "     an index on (BOOK_ID, TRADE_DT) would make this an INDEX RANGE SCAN\n"
        "   - 11m58s of the 12m41s elapsed is spent on Id 2"
    )

    ash_cols = [
        {"key": "sample_time", "label": "Sample", "type": "text"},
        {"key": "session_state", "label": "State", "type": "chip"},
        {"key": "event", "label": "Event", "type": "text"},
        {"key": "wait_class", "label": "Wait class", "type": "text"},
        {"key": "sql_id", "label": "SQL_ID", "type": "mono"},
    ]
    ash_rows = [
        {"sample_time": "13:45:12", "session_state": "WAITING", "session_state__sev": "warn", "event": "enq: TX - row lock contention", "wait_class": "Application", "sql_id": sql_id},
        {"sample_time": "13:45:11", "session_state": "WAITING", "session_state__sev": "warn", "event": "enq: TX - row lock contention", "wait_class": "Application", "sql_id": sql_id},
        {"sample_time": "13:44:58", "session_state": "ON CPU", "session_state__sev": "ok", "event": "—", "wait_class": "CPU", "sql_id": sql_id},
        {"sample_time": "13:44:40", "session_state": "WAITING", "session_state__sev": "warn", "event": "db file scattered read", "wait_class": "User I/O", "sql_id": sql_id},
    ]

    monitor_text = (
        "Global Information\n"
        "------------------------------\n"
        f" Status              :  EXECUTING\n"
        f" SQL ID              :  {sql_id}\n"
        " Execution Started   :  16-Aug 13:31:02\n"
        " Elapsed Time        :  14.3m\n"
        " CPU Time            :  2.1m\n"
        " Wait Time           :  12.2m  (enq: TX - row lock contention)\n"
        " Buffer Gets         :  1,204,559\n"
        " Rows Processed      :  0 (blocked)\n"
    )

    # Wait Events — V$SESSION_EVENT (cumulative per SID): where the session's time actually goes.
    waits_cols = [
        {"key": "event", "label": "Wait event", "type": "mono"},
        {"key": "wait_class", "label": "Class", "type": "chip"},
        {"key": "time_waited_s", "label": "Time waited (s)", "type": "num"},
        {"key": "waits", "label": "Waits", "type": "num"},
        {"key": "avg_ms", "label": "Avg (ms)", "type": "num"},
    ]
    waits_rows = [
        {"event": "enq: TX - row lock contention", "wait_class": "Application", "wait_class__sev": "crit",
         "time_waited_s": 761.2, "waits": 1, "avg_ms": 761200.0, "__sev": "crit"},
        {"event": "db file scattered read", "wait_class": "User I/O", "wait_class__sev": "warn",
         "time_waited_s": 118.7, "waits": 41822, "avg_ms": 2.8, "__sev": "warn"},
        {"event": "db file sequential read", "wait_class": "User I/O", "wait_class__sev": "warn",
         "time_waited_s": 22.4, "waits": 9210, "avg_ms": 2.4},
        {"event": "log file sync", "wait_class": "Commit", "wait_class__sev": "ok", "time_waited_s": 1.1, "waits": 120, "avg_ms": 9.2},
        {"event": "SQL*Net message to client", "wait_class": "Idle", "wait_class__sev": "muted", "time_waited_s": 0.3, "waits": 5044, "avg_ms": 0.1},
    ]

    # Bind Variables — peeked binds (DBMS_XPLAN +PEEKED_BINDS) / V$SQL_BIND_CAPTURE: spot skew / bind peeking.
    binds_cols = [
        {"key": "name", "label": "Bind", "type": "mono"},
        {"key": "pos", "label": "Pos", "type": "num"},
        {"key": "datatype", "label": "Datatype", "type": "text"},
        {"key": "value", "label": "Peeked value", "type": "mono"},
    ]
    binds_rows = [
        {"name": ":1  (STATUS)", "pos": 1, "datatype": "VARCHAR2(16)", "value": "'SETTLED'"},
        {"name": ":2  (BOOK_ID)", "pos": 2, "datatype": "NUMBER", "value": "4021"},
        {"name": ":3  (TRADE_DT)", "pos": 3, "datatype": "DATE", "value": "2026-08-01 00:00:00"},
    ]

    stats_cols = [
        {"key": "object", "label": "Object", "type": "mono"},
        {"key": "num_rows", "label": "Rows", "type": "num"},
        {"key": "last_analyzed", "label": "Last analyzed", "type": "text"},
        {"key": "state", "label": "Stats", "type": "chip"},
    ]
    stats_rows = [
        {"object": "TRADE_EVENTS", "num_rows": 4120400000, "last_analyzed": "14-Aug 02:10", "state": "STALE", "state__sev": "warn"},
        {"object": "PK_TRADE_EV", "num_rows": 4120400000, "last_analyzed": "14-Aug 02:10", "state": "FRESH", "state__sev": "ok"},
    ]

    locks_cols = [
        {"key": "type", "label": "Lock", "type": "text"},
        {"key": "mode_held", "label": "Mode held", "type": "text"},
        {"key": "object", "label": "Object", "type": "mono"},
        {"key": "state", "label": "State", "type": "chip"},
    ]
    locks_rows = [
        {"type": "TX (Row)", "mode_held": "Exclusive (X)", "object": "OLS.TRADE_EVENTS", "state": "BLOCKING", "state__sev": "crit"},
    ]

    awr_cols = [
        {"key": "snap", "label": "Snap window", "type": "text"},
        {"key": "elapsed_s", "label": "Elapsed (s)", "type": "num"},
        {"key": "cpu_s", "label": "CPU (s)", "type": "num"},
        {"key": "buffer_gets", "label": "Buffer gets", "type": "num"},
        {"key": "executions", "label": "Execs", "type": "num"},
    ]
    awr_rows = [
        {"snap": "16-Aug 12:00–13:00", "elapsed_s": 512.4, "cpu_s": 88.1, "buffer_gets": 42118900, "executions": 1204},
        {"snap": "16-Aug 11:00–12:00", "elapsed_s": 498.7, "cpu_s": 84.7, "buffer_gets": 41008120, "executions": 1190},
    ]

    panels = []
    # Killed sessions are (almost always) busy rolling back — surface that first.
    if status == "KILLED":
        panels.append(_panel_rollback())
    panels += [
        _panel_text("plan", "Execution Plan", plan_text),
        _panel_table("waits", "Wait Events", waits_cols, waits_rows),
        _panel_table("binds", "Bind Variables", binds_cols, binds_rows),
        _panel_table("ash", "Active Session History", ash_cols, ash_rows),
        _panel_text("monitor", "SQL Monitor", monitor_text),
        _panel_table("stats", "Object Statistics", stats_cols, stats_rows),
        _panel_table("locks", "Locks Held", locks_cols, locks_rows),
        _panel_table("awr", "AWR (DBA_HIST)", awr_cols, awr_rows),
    ]
    # Per-tab refresh: return only the requested panel (the real fn would run just that query).
    if q.panel:
        panels = [p for p in panels if p["key"] == q.panel]
    return {"status": "success", "session": session, "panels": panels}
