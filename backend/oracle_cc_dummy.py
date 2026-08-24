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
    SqlFinderQuery,
    SqlFixApply,
    _SQLI_ASH_COLS,
    _SQLI_BINDS_COLS,
    _SQLI_FINDER_COLS,
    _SQLI_PERF_COLS,
    _WAIT_CLASS_SEV,
    _sql_monitor_payload,
    _sqli_analyse,
    _sqli_fix_payload,
    _sqli_overview_payload,
    _sqli_plan_analysis_payload,
    _sqli_plans_payload,
    _sqli_timeline_payload,
    _IDXH_COLS,
    _IDX_COLS,
    _SESS_COLS,
    _TOP_COLS,
    _blk_row,
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
    """Canned per-tablespace space. Same shape as space_real — free/used% vs physical alloc."""
    # (tablespace, alloc_max_gb, physical_alloc_gb, used_gb) — used <= physical.
    raw = [
        ("OLS_DATA", 2048.0, 2000.0, 1900.00),   # used 95%   → red
        ("OLS_IDX",  1024.0, 1000.0,  870.00),   # used 87%   → amber
        ("OLS_LOB",   512.0,  512.0,  305.77),   # used ~60%  → green
        ("OLS_ARCH",  256.0,  200.0,   60.00),   # used 30%   → green
        ("OLS_STG",   256.0,  128.0,   17.30),   # used ~14%  → green
    ]
    rows = []
    for ts, alloc, phys, used in raw:
        rows.append({"tablespace": ts, "total_alloc_gb": alloc, "total_phys_gb": phys,
                     "used_gb": round(used, 2), "free_gb": round(phys - used, 2),
                     "total_free_gb": round(alloc - used, 2),
                     "used_pct": round(used / phys * 100, 2) if phys else 0.0})
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
    upd_sql = ("UPDATE trade_events t SET t.status = :1, t.settled_dt = :2, t.last_upd_by = :3, "
               "t.last_upd_ts = SYSTIMESTAMP WHERE t.trade_id = :4 AND t.book IN (:5, :6, :7) "
               "AND t.as_of_date = :8 AND EXISTS (SELECT 1 FROM positions p WHERE p.trade_id = t.trade_id "
               "AND p.ccy = :9 AND p.amount > :10)")
    upd_binds = ("  :1 = 'SETTLED'\n  :2 = 2026-08-21\n  :3 = 'BATCH07'\n  :4 = 88711\n  :5 = 'FX-EUR'\n"
                 "  :6 = 'FX-USD'\n  :7 = 'FX-JPY'\n  :8 = 2026-08-21\n  :9 = 'EUR'\n  :10 = 1000000")
    rows = [
        _lock_row(locked_object="OLS.TRADE_EVENTS", object_type="TABLE", lock_type="TX", lock_mode="Exclusive (X)",
                  sid=845, serial=22931, username="OLS_BATCH", machine="batch07", held_for="14m 20s",
                  state="BLOCKING", sql_id="7ymz9qk4d3n1a", firstname="Ravi", surname="Menon",
                  sql_text=upd_sql, bind_values=upd_binds),
        _lock_row(locked_object="OLS.TRADE_EVENTS", object_type="TABLE", lock_type="TX", lock_mode="Row-X (RX)",
                  sid=512, serial=10233, username="OLS_APP", machine="wildfly02", held_for="13m 55s",
                  state="WAITING", sql_id="7ymz9qk4d3n1a", firstname="Aisha", surname="Khan",
                  sql_text=upd_sql, bind_values=upd_binds),
        _lock_row(locked_object="OLS.POSITION_SNAP", object_type="TABLE PARTITION", lock_type="TM", lock_mode="Row-X (SSX)",
                  sid=233, serial=4021, username="OLS", machine="etl01", held_for="02m 41s",
                  state="HELD", sql_id="9ab77tzp0q2mx",
                  sql_text="INSERT INTO position_snap (snap_id, trade_id, book, ccy, amount, as_of_date, created_ts) "
                           "SELECT s.snap_id, s.trade_id, s.book, s.ccy, s.amount, s.as_of_date, SYSTIMESTAMP "
                           "FROM stg_positions s WHERE s.load_batch = :1 AND s.status = 'READY'",
                  bind_values="  :1 = 20260821"),
    ]
    return _locks_payload(rows)


def kill_session_dummy(t: OracleTarget, body: KillRequest) -> dict:
    logger.info("DUMMY kill-session %s,%s on %s (immediate=%s)", body.sid, body.serial, t.key, body.immediate)
    # Session already gone (closed before the kill landed) → success no-op, not an error. Mirrors the
    # real path catching ORA-00030 (see kill_session in oracle_cc_api.py).
    if not any(r["sid"] == body.sid for r in _all_sessions()):
        return {"status": "success", "success": True, "gone": True,
                "message": f"Session {body.sid},{body.serial} had already ended — nothing to kill."}
    return {"status": "success", "success": True,
            "message": f"Session {body.sid},{body.serial} has been marked for kill on {t.instance}. "
                       "Its uncommitted work is being rolled back."}


def blocking_dummy(t: OracleTarget) -> dict:
    # Raw blocker↔victim pairs (same shape database.fetch_blocking returns) → massage via _blk_row.
    long_sql = ("UPDATE trade_events t SET t.status = :1, t.settled_dt = :2 WHERE t.trade_id = :3 "
                "AND t.book IN (:4, :5, :6) AND t.as_of_date = :7 AND EXISTS "
                "(SELECT 1 FROM positions p WHERE p.trade_id = t.trade_id AND p.ccy = :8)")
    long_binds = ("  :1 = 'SETTLED'\n  :2 = 2026-08-21\n  :3 = 88711\n  :4 = 'FX-EUR'\n  :5 = 'FX-USD'\n"
                  "  :6 = 'FX-JPY'\n  :7 = 2026-08-21\n  :8 = 'EUR'")
    raw = [
        {"blocker_sid": 845, "blocker_serial": 22931, "blocker_user": "OLS_BATCH", "blocker_name": None,
         "victim_name": None, "blocker_machine": "batch07", "object_being_held": "OLS.TRADE_EVENTS",
         "blocker_object_type": "TABLE", "blocker_sql_id": "7ymz9qk4d3n1a", "blocker_sql_text": long_sql,
         "blocker_bind_values": long_binds,
         "victim_sid": 512, "victim_serial": 10233, "victim_user": "OLS_APP",
         "wait_event": "enq: TX - row lock contention", "wait_time_seconds": 835,
         "victim_sql_id": "7ymz9qk4d3n1a", "victim_sql_text": long_sql, "victim_bind_values": long_binds},
        {"blocker_sid": 845, "blocker_serial": 22931, "blocker_user": "OLS_BATCH", "blocker_name": None,
         "victim_name": None, "blocker_machine": "batch07", "object_being_held": "OLS.TRADE_EVENTS",
         "blocker_object_type": "TABLE", "blocker_sql_id": "7ymz9qk4d3n1a", "blocker_sql_text": long_sql,
         "blocker_bind_values": long_binds,
         "victim_sid": 933, "victim_serial": 5561, "victim_user": "OLS_APP",
         "wait_event": "enq: TX - row lock contention", "wait_time_seconds": 552,
         "victim_sql_id": "3xk9p1v7c2rba", "victim_sql_text": long_sql, "victim_bind_values": long_binds},
        {"blocker_sid": 610, "blocker_serial": 3110, "blocker_user": "OLS", "blocker_name": None,
         "victim_name": None, "blocker_machine": "etl01", "object_being_held": "OLS.POSITION_SNAP",
         "blocker_object_type": "TABLE PARTITION", "blocker_sql_id": None, "blocker_sql_text": None,
         "blocker_bind_values": None,
         "victim_sid": 1002, "victim_serial": 7781, "victim_user": "OLS_RPT",
         "wait_event": "enq: TM - contention", "wait_time_seconds": 243,
         "victim_sql_id": "9ab77tzp0q2mx", "victim_sql_text": "SELECT * FROM position_snap WHERE as_of_date = :1",
         "victim_bind_values": "  :1 = 20260821"},
    ]
    return _blocking_payload([_blk_row(r) for r in raw])


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
    # Session no longer in v$session (it closed immediately) → clean "gone" response so the UI shows
    # a friendly "no longer active" message instead of a load error. Mirrors the real API path.
    if src is None:
        return {"status": "success", "available": False, "reason": "gone",
                "session": {"sid": q.sid, "serial": q.serial, "session": f"{q.sid},{q.serial}",
                            "sql_id": q.sql_id or "—"}, "panels": []}
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

    # Execution Plan panel + the generated Diagnosis card + the structured plan (reuses the
    # plan-analysis dummy, so the deep-dive shows per-line E/A-Rows + Time% + "Spent on").
    plan_panel = _panel_text("plan", "Execution Plan", plan_text)
    pa = sqli_plan_analysis_dummy(t, q.sql_id or "7ymz9qk4d3n1a")
    if pa.get("diagnosis") and (pa["diagnosis"].get("findings") or pa["diagnosis"].get("hint")):
        plan_panel["diagnosis"] = pa["diagnosis"]
    plan_panel["analysis"] = {"summary": pa["summary"], "has_actual": pa["has_actual"],
                              "plan": pa["plan"], "stats": pa["stats"]}

    panels = []
    # Killed sessions are (almost always) busy rolling back — surface that first.
    if status == "KILLED":
        panels.append(_panel_rollback())
    panels += [
        plan_panel,
        _panel_table("waits", "Wait Events", waits_cols, waits_rows),
        _panel_table("binds", "Bind Variables", binds_cols, binds_rows),
        _panel_table("ash", "Active Session History", ash_cols, ash_rows),
        _resource_panel_dummy(),
        _panel_text("monitor", "SQL Monitor", monitor_text),
        _panel_table("stats", "Object Statistics", stats_cols, stats_rows),
        _panel_table("locks", "Locks Held", locks_cols, locks_rows),
        _panel_table("awr", "AWR (DBA_HIST)", awr_cols, awr_rows),
    ]
    # Per-tab refresh: return only the requested panel (the real fn would run just that query).
    if q.panel:
        panels = [p for p in panels if p["key"] == q.panel]
    return {"status": "success", "session": session, "panels": panels}


def _resource_panel_dummy() -> dict:
    """Canned Resource Profile: activity split (CPU vs waits) + PGA/temp + active work areas."""
    act_sev = {"CPU": "ok", "User I/O": "warn", "Concurrency": "crit", "System I/O": "warn"}
    act_rows = [
        {"bucket": "User I/O", "bucket__sev": "warn", "seconds": 612, "pct": 80.4},
        {"bucket": "CPU", "bucket__sev": "ok", "seconds": 118, "pct": 15.5},
        {"bucket": "Concurrency", "bucket__sev": "crit", "seconds": 31, "pct": 4.1},
    ]
    act_cols = [{"key": "bucket", "label": "Resource", "type": "chip"},
                {"key": "seconds", "label": "~Seconds", "type": "num"},
                {"key": "pct", "label": "Share", "type": "pct", "warn": 40, "crit": 70}]
    wa_cols = [{"key": "operation", "label": "Work area", "type": "mono"},
               {"key": "mem_mb", "label": "Mem (MB)", "type": "num"},
               {"key": "max_mb", "label": "Max (MB)", "type": "num"},
               {"key": "passes", "label": "Passes", "type": "num"},
               {"key": "temp_mb", "label": "Temp (MB)", "type": "num"}]
    wa_rows = [
        {"operation": "HASH JOIN", "mem_mb": 512.0, "max_mb": 512.0, "passes": 2, "temp_mb": 3840.0, "__sev": "warn"},
        {"operation": "SORT (v2)", "mem_mb": 64.0, "max_mb": 64.0, "passes": 0, "temp_mb": 0.0, "__sev": ""},
    ]
    resource = {
        "pga_used_mb": 690.4, "pga_alloc_mb": 742.1, "pga_max_mb": 980.0, "temp_mb": 3840.0,
        "activity": {"status": "success", "columns": act_cols, "rows": act_rows},
        "workareas": {"status": "success", "columns": wa_cols, "rows": wa_rows},
    }
    return {"key": "resource", "label": "Resource Profile", "kind": "resource", "available": True, "resource": resource}


# =============================================================================
# Section 8 — SQL Intelligence (canned "plan flip / regression" story)
# =============================================================================
#
# Canonical demo sql_id is 7ymz9qk4d3n1a (the same id the locks dummy uses, so clicking a
# lock's SQL_ID in dummy mode lands on a populated investigation). ANY sql_id returns this same
# story so every search/click works in the demo. Narrative: a fast index plan (2094262487) ran
# for days, then on 19-Aug a full-scan plan (3765430022) took over -- ~15x slower -- driven by a
# skewed bind value. Best = the index plan; recommend pinning it.

_SQLI_GOOD_PHV = 2094262487
_SQLI_BAD_PHV = 3765430022


def _sqli_dummy_aggs() -> list[dict]:
    return [
        {"plan_hash_value": _SQLI_GOOD_PHV, "execs": 18450, "elapsed_per_exec_s": 0.82,
         "buffer_gets_per_exec": 9800, "first_seen": "16-Aug 02:00", "last_seen": "18-Aug 22:00",
         "last_seen_ts": 202608182200, "source": "AWR"},
        {"plan_hash_value": _SQLI_BAD_PHV, "execs": 6120, "elapsed_per_exec_s": 12.47,
         "buffer_gets_per_exec": 812400, "first_seen": "19-Aug 06:00", "last_seen": "21-Aug 09:00",
         "last_seen_ts": 202608210900, "source": "AWR"},
    ]


def _sqli_dummy_points() -> list[dict]:
    g, b = _SQLI_GOOD_PHV, _SQLI_BAD_PHV
    return [
        {"label": "16-Aug 02:00", "ts": 202608160200, "plan_hash_value": g, "elapsed_per_exec_s": 0.79, "execs": 3200},
        {"label": "16-Aug 14:00", "ts": 202608161400, "plan_hash_value": g, "elapsed_per_exec_s": 0.83, "execs": 3050},
        {"label": "17-Aug 02:00", "ts": 202608170200, "plan_hash_value": g, "elapsed_per_exec_s": 0.80, "execs": 3100},
        {"label": "17-Aug 14:00", "ts": 202608171400, "plan_hash_value": g, "elapsed_per_exec_s": 0.85, "execs": 2980},
        {"label": "18-Aug 02:00", "ts": 202608180200, "plan_hash_value": g, "elapsed_per_exec_s": 0.81, "execs": 3120},
        {"label": "18-Aug 22:00", "ts": 202608182200, "plan_hash_value": g, "elapsed_per_exec_s": 0.88, "execs": 3000},
        {"label": "19-Aug 06:00", "ts": 202608190600, "plan_hash_value": b, "elapsed_per_exec_s": 11.90, "execs": 1600},
        {"label": "19-Aug 18:00", "ts": 202608191800, "plan_hash_value": b, "elapsed_per_exec_s": 12.60, "execs": 1500},
        {"label": "20-Aug 12:00", "ts": 202608201200, "plan_hash_value": b, "elapsed_per_exec_s": 12.90, "execs": 1520},
        {"label": "21-Aug 09:00", "ts": 202608210900, "plan_hash_value": b, "elapsed_per_exec_s": 12.40, "execs": 1500},
    ]


def sqli_finder_dummy(t: OracleTarget, body: SqlFinderQuery) -> dict:
    rows = [
        {"sql_id": "7ymz9qk4d3n1a", "sql_text": "SELECT /*+ report */ t.trade_id, SUM(p.amount) FROM trade_events t JOIN positions p ON ...",
         "module": "RPT_EOD", "plans": 2, "execs": 24570, "elapsed_per_exec_s": 12.40,
         "last_active": "21-Aug 09:00", "flip": "MULTI", "flip__sev": "warn", "__sql_id": "7ymz9qk4d3n1a"},
        {"sql_id": "3n7kq0war9xub", "sql_text": "UPDATE position_snap SET status = :1 WHERE snap_id = :2",
         "module": "POS_LOAD", "plans": 1, "execs": 91200, "elapsed_per_exec_s": 0.14,
         "last_active": "21-Aug 08:40", "flip": "SINGLE", "flip__sev": "ok", "__sql_id": "3n7kq0war9xub"},
        {"sql_id": "b52kf9yq1m3dz", "sql_text": "SELECT * FROM audit_log WHERE event_dt >= :1 ORDER BY event_dt",
         "module": "AUDIT_UI", "plans": 3, "execs": 4120, "elapsed_per_exec_s": 3.85,
         "last_active": "21-Aug 07:10", "flip": "MULTI", "flip__sev": "warn", "__sql_id": "b52kf9yq1m3dz"},
        {"sql_id": "9audk2nq7wp1c", "sql_text": "SELECT ref_instrument.* FROM ref_instrument WHERE isin = :1",
         "module": "REF_SVC", "plans": 1, "execs": 220400, "elapsed_per_exec_s": 0.02,
         "last_active": "21-Aug 09:05", "flip": "SINGLE", "flip__sev": "ok", "__sql_id": "9audk2nq7wp1c"},
    ]
    if body and body.q:
        needle = body.q.strip().lower()
        filtered = [r for r in rows if needle in r["sql_id"].lower()
                    or needle in r["sql_text"].lower() or needle in r["module"].lower()]
        rows = filtered or rows
    return {"status": "success", "columns": _SQLI_FINDER_COLS, "rows": rows,
            "summary": {"days": 5, "count": len(rows)}}


def sqli_overview_dummy(t: OracleTarget, sql_id: str) -> dict:
    sql_text = ("SELECT /*+ report */ t.trade_id, t.book, SUM(p.amount) AS exposure\n"
                "  FROM trade_events t\n  JOIN positions p ON p.trade_id = t.trade_id\n"
                " WHERE t.as_of_date = :1 AND t.ccy = :2\n GROUP BY t.trade_id, t.book")
    meta = {"schema": "OLS", "module": "RPT_EOD", "first_seen": "16-Aug 02:00",
            "last_seen": "21-Aug 09:00", "execs": 24570}
    return _sqli_overview_payload(sql_id, sql_text, meta, _sqli_dummy_aggs())


def sqli_timeline_dummy(t: OracleTarget, sql_id: str) -> dict:
    return _sqli_timeline_payload(_sqli_dummy_points(), _sqli_dummy_aggs())


def sqli_plans_dummy(t: OracleTarget, sql_id: str) -> dict:
    return _sqli_plans_payload(_sqli_dummy_aggs(),
                               {"baseline": False, "profile": False, "baseline_phvs": [],
                                "detail": "No baseline or profile detected for this SQL_ID."})


def sqli_plan_analysis_dummy(t: OracleTarget, sql_id: str) -> dict:
    # The classic story: TRADE_EVENTS stats are stale (say 412 rows) so the optimizer estimates 412,
    # but reality is 8.4M → a TABLE ACCESS FULL becomes the time bottleneck (self 24s of 32.4s),
    # with 980K reads / 1.2M gets, filtered on BOOK_ID + TRADE_DT (→ index hint).
    # elapsed_us is CUMULATIVE per line (incl. children); the payload derives self-time from it.
    plan = [
        {"id": 0, "parent_id": None, "depth": 0, "operation": "SELECT STATEMENT", "options": None,
         "object_owner": None, "object_name": None, "object_type": None, "e_rows": 412, "cost": 25,
         "plan_hash_value": 3765430022, "a_rows": 8400000, "elapsed_us": 32400000,
         "buffer_gets": 1240000, "disk_reads": 988000, "starts": 1,
         "access_predicates": None, "filter_predicates": None},
        {"id": 1, "parent_id": 0, "depth": 1, "operation": "HASH JOIN", "options": None,
         "object_owner": None, "object_name": None, "object_type": None, "e_rows": 412, "cost": 25,
         "plan_hash_value": 3765430022, "a_rows": 8400000, "elapsed_us": 32000000,
         "buffer_gets": 1238000, "disk_reads": 986000, "starts": 1,
         "access_predicates": '"P"."TRADE_ID"="T"."TRADE_ID"', "filter_predicates": None},
        {"id": 2, "parent_id": 1, "depth": 2, "operation": "TABLE ACCESS", "options": "FULL",
         "object_owner": "OLS", "object_name": "TRADE_EVENTS", "object_type": "TABLE", "e_rows": 412,
         "cost": 12, "plan_hash_value": 3765430022, "a_rows": 8400000, "elapsed_us": 24000000,
         "buffer_gets": 1200000, "disk_reads": 980000, "starts": 1,
         "access_predicates": None, "filter_predicates": '"BOOK_ID"=:1 AND "TRADE_DT">=:2'},
        {"id": 3, "parent_id": 1, "depth": 2, "operation": "TABLE ACCESS", "options": "FULL",
         "object_owner": "OLS", "object_name": "POSITIONS", "object_type": "TABLE", "e_rows": 1180000,
         "cost": 8, "plan_hash_value": 3765430022, "a_rows": 1180000, "elapsed_us": 3000000,
         "buffer_gets": 38000, "disk_reads": 6000, "starts": 1,
         "access_predicates": None, "filter_predicates": None},
    ]
    stats = [
        {"owner": "OLS", "table_name": "TRADE_EVENTS", "num_rows": 412, "stale_stats": "YES",
         "last_analyzed": "12-Aug 02:10", "age_days": 12},
        {"owner": "OLS", "table_name": "POSITIONS", "num_rows": 1180000, "stale_stats": "NO",
         "last_analyzed": "23-Aug 01:00", "age_days": 0},
    ]
    # Per-line ASH activity: the full scan (Id 2) is mostly User I/O; the join (Id 1) is CPU.
    activity = [
        {"line_id": 2, "bucket": "User I/O", "samples": 610},
        {"line_id": 2, "bucket": "CPU", "samples": 90},
        {"line_id": 1, "bucket": "CPU", "samples": 118},
        {"line_id": 3, "bucket": "User I/O", "samples": 42},
    ]
    return _sqli_plan_analysis_payload({"plan": plan, "stats": stats, "activity": activity})


def sqli_monitor_dummy(t: OracleTarget, sql_id: str) -> dict:
    # Demo as a live/monitored execution so the report format is visible (real mode returns
    # monitored:false with a message when the SQL isn't currently monitored).
    report = (
        "SQL Monitoring Report\n\n"
        "SQL Text\n------------------------------\n"
        "SELECT /*+ report */ t.trade_id, t.book, SUM(p.amount) FROM trade_events t JOIN positions p ...\n\n"
        "Global Information\n------------------------------\n"
        " Status              :  EXECUTING\n"
        " Duration            :  32s\n"
        " Instance ID         :  1\n"
        " SQL Execution ID    :  16777216\n\n"
        "Global Stats\n=====================================================\n"
        "| Elapsed | Cpu   | IO      | Buffer | Read  | Read  |\n"
        "| Time(s) | Time  | Waits(s)| Gets   | Reqs  | Bytes |\n"
        "=====================================================\n"
        "|    32   |  5.0  |  27     |  1.2M  | 120K  |  7GB  |\n\n"
        "SQL Plan Monitoring Details (Plan Hash Value=3765430022)\n"
        "==========================================================================================\n"
        "| Id | Operation            | Name         | Rows(Actual) | Activity % | Activity detail |\n"
        "==========================================================================================\n"
        "|  0 | SELECT STATEMENT     |              |         1180 |            |                 |\n"
        "|  1 |  HASH JOIN           |              |         1180 |     15.5   | Cpu (15%)       |\n"
        "|  2 |   TABLE ACCESS FULL  | TRADE_EVENTS |         8.4M |     80.4   | db file scattd  |\n"
        "|  3 |   TABLE ACCESS FULL  | POSITIONS    |         1.2M |      4.1   | db file scattd  |\n"
        "==========================================================================================\n")
    raw = {"monitored": True,
           "overview": {"status": "EXECUTING", "elapsed_s": 32.0, "cpu_s": 5.0, "buffer_gets": 1200000,
                        "disk_reads": 120000, "px": 0, "started": "23-Aug 05:41:07"},
           "report": report}
    return _sql_monitor_payload(raw)


def sqli_perf_dummy(t: OracleTarget, sql_id: str) -> dict:
    rows = []
    for p in reversed(_sqli_dummy_points()):
        bad = p["plan_hash_value"] == _SQLI_BAD_PHV
        rows.append({"snap": p["label"], "plan_hash_value": p["plan_hash_value"], "execs": p["execs"],
                     "elapsed_per_exec_s": p["elapsed_per_exec_s"],
                     "cpu_per_exec_s": round(p["elapsed_per_exec_s"] * (0.35 if bad else 0.85), 2),
                     "buffer_gets_per_exec": 812400 if bad else 9800,
                     "disk_reads_per_exec": 154200 if bad else 40,
                     "rows_per_exec": 1180})
    return {"status": "success", "columns": _SQLI_PERF_COLS, "rows": rows}


def sqli_ash_dummy(t: OracleTarget, sql_id: str) -> dict:
    raw = [("db file scattered read", "User I/O", 540), ("ON CPU", "CPU", 210),
           ("direct path read", "User I/O", 95), ("gc buffer busy acquire", "Cluster", 40),
           ("cursor: pin S wait on X", "Concurrency", 18)]
    total = sum(s for _, _, s in raw) or 1
    rows = [{"event": ev, "wait_class": wc, "wait_class__sev": _WAIT_CLASS_SEV.get(wc, "muted"),
             "samples": s, "pct": round(s / total * 100, 1)} for ev, wc, s in raw]
    return {"status": "success", "columns": _SQLI_ASH_COLS, "rows": rows}


def sqli_binds_dummy(t: OracleTarget, sql_id: str) -> dict:
    rows = [
        {"captured": "19-Aug 06:00", "name": ":2", "position": 2, "datatype": "VARCHAR2(3)",
         "value": "'EUR'", "plan_hash_value": _SQLI_BAD_PHV},
        {"captured": "19-Aug 06:00", "name": ":1", "position": 1, "datatype": "DATE",
         "value": "2026-08-19", "plan_hash_value": _SQLI_BAD_PHV},
        {"captured": "16-Aug 02:00", "name": ":2", "position": 2, "datatype": "VARCHAR2(3)",
         "value": "'JPY'", "plan_hash_value": _SQLI_GOOD_PHV},
        {"captured": "16-Aug 02:00", "name": ":1", "position": 1, "datatype": "DATE",
         "value": "2026-08-16", "plan_hash_value": _SQLI_GOOD_PHV},
    ]
    return {"status": "success", "columns": _SQLI_BINDS_COLS, "rows": rows}


def sqli_plan_text_dummy(t: OracleTarget, sql_id: str, phv: int) -> dict:
    if int(phv) == _SQLI_GOOD_PHV:
        text = (f"Plan hash value: {_SQLI_GOOD_PHV}\n\n"
                "----------------------------------------------------------------------------------\n"
                "| Id | Operation                     | Name              | Rows | Cost | A-Rows |\n"
                "----------------------------------------------------------------------------------\n"
                "|  0 | SELECT STATEMENT              |                   |      |  842 |        |\n"
                "|  1 |  HASH GROUP BY                |                   | 1180 |  842 |   1180 |\n"
                "|  2 |   NESTED LOOPS                |                   | 1180 |  840 |   1180 |\n"
                "|  3 |    TABLE ACCESS BY INDEX ROWID| TRADE_EVENTS      |  590 |  120 |    590 |\n"
                "|* 4 |     INDEX RANGE SCAN          | IX_TRADE_ASOF_CCY |  590 |    6 |    590 |\n"
                "|  5 |    TABLE ACCESS BY INDEX ROWID| POSITIONS         |    2 |    3 |   1180 |\n"
                "|* 6 |     INDEX RANGE SCAN          | IX_POS_TRADE      |    2 |    2 |   1180 |\n"
                "----------------------------------------------------------------------------------\n"
                "Note: index-driven -- 9,800 buffer gets/exec, ~0.82s. This is the plan to pin.")
    else:
        text = (f"Plan hash value: {_SQLI_BAD_PHV}\n\n"
                "-------------------------------------------------------------------------\n"
                "| Id | Operation             | Name         | Rows | Cost  | A-Rows |Reads|\n"
                "-------------------------------------------------------------------------\n"
                "|  0 | SELECT STATEMENT      |              |      | 68120 |        |     |\n"
                "|  1 |  HASH GROUP BY        |              |  41M | 68120 |   1180 |     |\n"
                "|* 2 |   HASH JOIN           |              |  41M | 61000 |    41M | 154K|\n"
                "|  3 |    TABLE ACCESS FULL  | TRADE_EVENTS |  22M | 30200 |    22M |  74K|\n"
                "|  4 |    TABLE ACCESS FULL  | POSITIONS    |  38M | 30800 |    38M |  80K|\n"
                "-------------------------------------------------------------------------\n"
                "Note: full-scan HASH JOIN -- 812,400 buffer gets/exec, 154K reads, ~12.5s.\n"
                "Cardinality misestimate after bind peeking on a skewed :2 value (EUR) flipped\n"
                "the optimizer away from the index. THIS is the regressed plan.")
    return {"status": "success", "plan_hash_value": int(phv), "source": "AWR", "text": text}


def sqli_fix_dummy(t: OracleTarget, sql_id: str) -> dict:
    advisor = {"available": True,
               "note": "SQL Tuning Advisor recommends accepting the index plan; re-gathering stale column "
                       "stats on TRADE_EVENTS.CCY would also correct the cardinality estimate.",
               "findings": [
                   "Cardinality misestimate on TRADE_EVENTS (bind peeking on a skewed :2).",
                   "Column stats on TRADE_EVENTS.CCY are stale (histogram missing).",
                   "Index IX_TRADE_ASOF_CCY is available and yields the best plan.",
               ]}
    return _sqli_fix_payload(sql_id, _sqli_analyse(_sqli_dummy_aggs()),
                             {"baseline": False, "profile": False,
                              "detail": "No baseline or profile detected for this SQL_ID."},
                             advisor)


def sqli_apply_fix_dummy(t: OracleTarget, body: SqlFixApply) -> dict:
    return {"status": "success",
            "message": (f"(dummy) Would pin plan {body.plan_hash_value} for {body.sql_id} as a fixed SQL Plan "
                        f"Baseline via a privileged, audited connection. No change made in dummy mode.")}
