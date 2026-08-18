"""Oracle Command Center API — per-DB DBA monitoring (space, top segments, locks,
blocking, sessions + SID deep-dive).

Design goals baked in here:

* **Config-driven DB targets.** ``ORACLE_TARGETS`` lists every database the screen
  exposes as a tab. Add a row → a new tab appears on the UI (which reads the same list
  from its own config) with zero query/UI code. Each target names a connection alias and
  whether the Diagnostics/Tuning Pack is licensed (gates ASH / AWR / SQL Monitor).

* **One self-describing payload for every tabular section** so the UI never hardcodes
  headers or column counts::

      { "status": "success",
        "columns": [ { "key","label","type","align?","format?" } ],
        "rows":    [ { <key>: value, ... } ],
        "summary": { ... optional per-section extras (gauges, totals, flags) } }

  Add a column to a query + its ``columns`` entry and it renders automatically.

* **Dummy ↔ real switch.** Every section has a ``*_dummy`` function (canned data, used
  now) and a ``*_real`` function that holds the actual SQL and returns the identical
  shape. Flip ``ORACLE_CC_USE_DUMMY`` (env ``ORACLE_CC_USE_DUMMY=0``) to go live once the
  read-only monitoring accounts are wired.

Connect with a dedicated **read-only monitoring user** (SELECT_CATALOG_ROLE), never OLS/SYS.
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from utils.logging import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/oracle_cc", tags=["oracle_cc"])

# Flip to False (or set env ORACLE_CC_USE_DUMMY=0) once real monitoring connections exist.
ORACLE_CC_USE_DUMMY = os.getenv("ORACLE_CC_USE_DUMMY", "1") != "0"

# GB threshold colours (percent used).
WARN_PCT = 85
CRIT_PCT = 90

# Drill-down keeps each level to the TOP-N biggest children by size (a table can have
# hundreds of partitions; only the largest space consumers matter). Bump if you want more.
TOP_CHILD_LIMIT = 10


# --- config-driven DB targets (the UI reads the same list) -------------------

class OracleTarget(BaseModel):
    key: str          # stable id used in the URL + UI tab
    label: str        # "OLS CIB"
    sub: str | None = None   # "BATCH" / "REPORTING"
    instance: str            # display instance name
    connection: str          # alias into your DB connection store (read-only monitor user)
    diag_pack: bool = False   # Diagnostics/Tuning Pack licensed? gates ASH/AWR/SQL Monitor


ORACLE_TARGETS: list[OracleTarget] = [
    OracleTarget(key="ols_group",         label="OLS GROUP",   instance="OLSPRD1", connection="ols_group_mon",  diag_pack=True),
    OracleTarget(key="ols_cib_batch",     label="OLS CIB",   sub="BATCH",     instance="CIBB1", connection="ols_cib_batch_mon",  diag_pack=True),
    OracleTarget(key="ols_cib_report",    label="OLS CIB",   sub="REPORTING", instance="CIBR1", connection="ols_cib_report_mon", diag_pack=True),
    OracleTarget(key="ols_retail_batch",  label="OLS RETAIL", sub="BATCH",    instance="RTLB1", connection="ols_retail_batch_mon", diag_pack=False),
    OracleTarget(key="ols_retail_report", label="OLS RETAIL", sub="REPORTING", instance="RTLR1", connection="ols_retail_report_mon", diag_pack=False),
]
_BY_KEY = {t.key: t for t in ORACLE_TARGETS}


def _target(db: str) -> OracleTarget:
    t = _BY_KEY.get(db)
    if not t:
        raise HTTPException(status_code=404, detail=f"Unknown DB target '{db}'")
    return t


@router.get("/targets")
def list_targets() -> dict:
    """The DB tabs the UI should render — config-driven, so a new DB is a one-line add."""
    return {"status": "success", "data": [t.model_dump() for t in ORACLE_TARGETS]}


@router.get("/overview")
def overview() -> dict:
    """Compact per-DB snapshot for the Home 'Oracle Databases' strip — storage %, blocking
    sessions, active sessions, and the largest segment. ONE call powers every tile."""
    return overview_dummy() if ORACLE_CC_USE_DUMMY else overview_real()


def overview_dummy() -> dict:
    snap = {
        "ols_group":         {"storage_pct": 79.2, "blocking": 1, "active": 3, "top_object": "TRADE_EVENTS",  "top_gb": 812.40},
        "ols_cib_batch":     {"storage_pct": 88.6, "blocking": 0, "active": 5, "top_object": "POSITION_SNAP", "top_gb": 611.90},
        "ols_cib_report":    {"storage_pct": 63.1, "blocking": 0, "active": 2, "top_object": "AUDIT_LOG",     "top_gb": 402.30},
        "ols_retail_batch":  {"storage_pct": 91.4, "blocking": 2, "active": 4, "top_object": "FX_RATE_HIST",  "top_gb": 288.10},
        "ols_retail_report": {"storage_pct": 45.7, "blocking": 0, "active": 1, "top_object": "REF_INSTRUMENT", "top_gb": 88.10},
    }
    data = []
    for t in ORACLE_TARGETS:
        s = snap.get(t.key, {"storage_pct": 0.0, "blocking": 0, "active": 0, "top_object": "—", "top_gb": 0.0})
        data.append({
            "key": t.key, "label": t.label, "sub": t.sub, "instance": t.instance, "diag_pack": t.diag_pack,
            "storage_pct": s["storage_pct"], "storage_sev": _sev_for(s["storage_pct"]),
            "blocking": s["blocking"], "active": s["active"],
            "top_object": s["top_object"], "top_gb": s["top_gb"],
        })
    return {"status": "success", "data": data}


def overview_real() -> dict:
    """One light query per target (kept cheap for Home): max tablespace used %
    (DBA_TABLESPACE_USAGE_METRICS), COUNT blocking sessions (V$SESSION.blocking_session),
    COUNT active USER sessions (V$SESSION), and the largest segment (DBA_SEGMENTS)."""
    raise RuntimeError("overview_real: wire _run() per target")


# =============================================================================
# Section 1 — Database / tablespace space
# =============================================================================

@router.post("/{db}/space")
def space(db: str) -> dict:
    """Consolidated space (gauge) + owner×tablespace breakdown for one DB."""
    t = _target(db)
    return space_dummy(t) if ORACLE_CC_USE_DUMMY else space_real(t)


# --- Section 1: dummy -----------------------------------------------------------

def space_dummy(t: OracleTarget) -> dict:
    """Canned space data. Same shape as space_real."""
    hot = t.key == "ols_group"
    warm = t.key == "ols_cib_batch"
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


# --- Section 1: real (the actual query) ----------------------------------------

def space_real(t: OracleTarget) -> dict:
    """Owner×tablespace space with autoextend-aware totals. Returns the same shape as
    space_dummy. Requires SELECT on DBA_SEGMENTS / DBA_TABLESPACES / DBA_DATA_FILES /
    DBA_FREE_SPACE (SELECT_CATALOG_ROLE).

    Total = autoextend MAXSIZE (what actually fills), not current allocation.
    Used  = that owner's segment bytes in the tablespace.
    Free  = tablespace max - tablespace total-used.
    """
    sql = """
        WITH ts_max AS (   -- autoextend-aware capacity per tablespace
            SELECT tablespace_name,
                   SUM(CASE WHEN autoextensible = 'YES' THEN GREATEST(bytes, maxbytes)
                            ELSE bytes END) AS max_bytes
              FROM dba_data_files
             GROUP BY tablespace_name
        ),
        ts_used AS (       -- total used per tablespace (all owners)
            SELECT tablespace_name, SUM(bytes) AS used_bytes
              FROM dba_segments
             GROUP BY tablespace_name
        ),
        own AS (           -- used per (owner, tablespace)
            SELECT owner, tablespace_name, SUM(bytes) AS owner_bytes
              FROM dba_segments
             GROUP BY owner, tablespace_name
        )
        SELECT o.owner,
               o.tablespace_name,
               ROUND(m.max_bytes    / 1024/1024/1024, 2) AS total_gb,
               ROUND(o.owner_bytes  / 1024/1024/1024, 2) AS used_gb,
               ROUND((m.max_bytes - u.used_bytes)/1024/1024/1024, 2) AS free_gb,
               ROUND(u.used_bytes * 100 / NULLIF(m.max_bytes,0), 1)  AS used_pct
          FROM own o
          JOIN ts_max  m ON m.tablespace_name = o.tablespace_name
          JOIN ts_used u ON u.tablespace_name = o.tablespace_name
         ORDER BY used_gb DESC
    """
    rows = [
        {"owner": r[0], "tablespace": r[1], "total_gb": r[2], "used_gb": r[3], "free_gb": r[4], "used_pct": r[5]}
        for r in _run(t, sql)
    ]
    return _space_payload(rows)


def _sev_for(pct: float) -> str:
    return "crit" if pct >= CRIT_PCT else "warn" if pct >= WARN_PCT else "ok"


def _space_payload(rows: list[dict]) -> dict:
    """Shared column contract + gauge summary for Section 1."""
    for r in rows:  # per-row tint (ok/warn/crit) for the UI
        r["__sev"] = _sev_for(float(r.get("used_pct") or 0))
    # gauge = per-tablespace totals (dedupe tablespace so we don't double-count owners)
    seen: dict[str, dict] = {}
    for r in rows:
        seen.setdefault(r["tablespace"], {"total": r["total_gb"], "pct": r["used_pct"]})
    total = round(sum(v["total"] for v in seen.values()), 2)
    # used derived from pct so the gauge matches the rows
    used = round(sum(v["total"] * v["pct"] / 100 for v in seen.values()), 2)
    free = round(total - used, 2)
    used_pct = round(used / total * 100, 1) if total else 0.0
    breached = sorted({r["tablespace"] for r in rows if r["used_pct"] >= WARN_PCT})
    return {
        "status": "success",
        "columns": [
            {"key": "owner", "label": "Owner", "type": "mono"},
            {"key": "tablespace", "label": "Tablespace", "type": "mono"},
            {"key": "total_gb", "label": "Total (GB)", "type": "num"},
            {"key": "used_gb", "label": "Used (GB)", "type": "num"},
            {"key": "free_gb", "label": "Free (GB)", "type": "num"},
            {"key": "used_pct", "label": "Used %", "type": "pct", "warn": WARN_PCT, "crit": CRIT_PCT},
        ],
        "rows": rows,
        "summary": {"total_gb": total, "used_gb": used, "free_gb": free, "used_pct": used_pct,
                    "breached": breached, "warn_pct": WARN_PCT, "crit_pct": CRIT_PCT},
    }


# =============================================================================
# Section 2 — Top table storage consumers (data segments only; part → subpart)
# =============================================================================

@router.post("/{db}/top_segments")
def top_segments(db: str) -> dict:
    t = _target(db)
    return top_segments_dummy(t) if ORACLE_CC_USE_DUMMY else top_segments_real(t)


_TOP_COLS = [
    {"key": "object", "label": "Object", "type": "mono"},
    {"key": "kind", "label": "Type", "type": "text"},
    {"key": "size_gb", "label": "Size (GB)", "type": "num"},
    {"key": "num_rows", "label": "Rows", "type": "num"},
    {"key": "last_analyzed", "label": "Last analyzed", "type": "text"},
    {"key": "stats", "label": "Stats", "type": "chip"},
]


def _stats_cell(fresh: bool) -> dict:
    # Stale rows carry `__sev:"warn"` so they hover-reveal amber (fresh rows stay on the
    # default blue hover); the Stats chip carries the meaning at rest.
    cell = {"stats": "FRESH" if fresh else "STALE", "stats__sev": "ok" if fresh else "warn"}
    if not fresh:
        cell["__sev"] = "warn"
    return cell


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


def top_segments_real(t: OracleTarget) -> dict:
    """Top-10 tables by DATA segment bytes (owner = the monitored schema), each drilling into
    its **top-{n} partitions by size**, and each partition into its **top-{n} subpartitions by
    size** — NOT every partition (a table can have hundreds; only the biggest consumers matter).
    Size = allocated segment bytes. Uses DBA_SEGMENTS (TABLE / TABLE PARTITION / TABLE
    SUBPARTITION) + DBA_TAB_STATISTICS for the stale flag; assemble the 3-level tree in Python,
    applying `FETCH FIRST {n} ROWS ONLY` (ordered by size DESC) at each child level.""".format(n=TOP_CHILD_LIMIT)
    sql_tables = """
        SELECT segment_name,
               ROUND(SUM(bytes)/1024/1024/1024, 2) AS size_gb
          FROM dba_segments
         WHERE owner = :owner
           AND segment_type IN ('TABLE','TABLE PARTITION','TABLE SUBPARTITION')
         GROUP BY segment_name
         ORDER BY size_gb DESC
         FETCH FIRST 10 ROWS ONLY
    """
    # (partition/subpartition detail + NUM_ROWS/STALE_STATS come from
    #  dba_segments by partition_name and dba_tab_statistics; assembled into __children)
    _ = sql_tables
    raise RuntimeError("top_segments_real: wire _run() to your monitoring connection")


# =============================================================================
# Section 3 — Top index storage consumers
# =============================================================================

@router.post("/{db}/top_indexes")
def top_indexes(db: str) -> dict:
    t = _target(db)
    return top_indexes_dummy(t) if ORACLE_CC_USE_DUMMY else top_indexes_real(t)


_IDX_COLS = [
    {"key": "index_name", "label": "Index", "type": "mono"},
    {"key": "table_name", "label": "Table", "type": "mono"},
    {"key": "kind", "label": "Type", "type": "text"},
    {"key": "size_gb", "label": "Size (GB)", "type": "num"},
]


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


def top_indexes_real(t: OracleTarget) -> dict:
    """Top-5 indexes by allocated bytes (DBA_SEGMENTS INDEX / INDEX PARTITION / INDEX
    SUBPARTITION), joined to DBA_INDEXES for table + type. Each partitioned index drills into
    its **top-{n} partitions by size** (ordered DESC, `FETCH FIRST {n} ROWS ONLY`), not every
    partition. Same {{columns, rows}} shape (partitions as __children).""".format(n=TOP_CHILD_LIMIT)
    sql = """
        SELECT s.segment_name AS index_name, i.table_name, i.index_type AS kind,
               ROUND(SUM(s.bytes)/1024/1024/1024, 2) AS size_gb
          FROM dba_segments s
          JOIN dba_indexes  i ON i.owner = s.owner AND i.index_name = s.segment_name
         WHERE s.owner = :owner
           AND s.segment_type IN ('INDEX','INDEX PARTITION','INDEX SUBPARTITION')
         GROUP BY s.segment_name, i.table_name, i.index_type
         ORDER BY size_gb DESC
         FETCH FIRST 5 ROWS ONLY
    """
    _ = sql
    raise RuntimeError("top_indexes_real: wire _run() to your monitoring connection")


# =============================================================================
# Section 4 — Index Health & Stability
# =============================================================================

@router.post("/{db}/index_health")
def index_health(db: str) -> dict:
    t = _target(db)
    return index_health_dummy(t) if ORACLE_CC_USE_DUMMY else index_health_real(t)


_IDXH_COLS = [
    {"key": "index_name", "label": "Index", "type": "mono"},
    {"key": "table_name", "label": "Table", "type": "mono"},
    {"key": "state", "label": "State", "type": "chip"},
    {"key": "detail", "label": "Detail", "type": "text"},
    {"key": "last_analyzed", "label": "Last analyzed", "type": "text"},
]


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


def index_health_real(t: OracleTarget) -> dict:
    """Unstable / offline indexes: UNUSABLE (DBA_INDEXES.status='UNUSABLE' and partition-level
    DBA_IND_PARTITIONS.status), INVISIBLE (DBA_INDEXES.visibility='INVISIBLE' — maintained but
    optimizer-hidden), and stale-stats (DBA_TAB_STATISTICS.stale_stats='YES'). One row each,
    with a state chip. Same {columns, rows} shape."""
    sql = """
        SELECT index_name, table_name,
               CASE WHEN status = 'UNUSABLE' THEN 'UNUSABLE'
                    WHEN visibility = 'INVISIBLE' THEN 'INVISIBLE'
                    ELSE 'STALE STATS' END AS state,
               last_analyzed
          FROM dba_indexes
         WHERE owner = :owner
           AND (status = 'UNUSABLE' OR visibility = 'INVISIBLE'
                OR index_name IN (SELECT object_name FROM dba_tab_statistics
                                   WHERE owner = :owner AND object_type LIKE 'INDEX%' AND stale_stats = 'YES'))
         ORDER BY state
    """
    _ = sql
    raise RuntimeError("index_health_real: wire _run() to your monitoring connection")


# =============================================================================
# Section 5 — Critical locks (currently held / blocking) + kill-session
# =============================================================================

@router.post("/{db}/locks")
def locks(db: str) -> dict:
    """Enqueue locks that matter to a DBA: TX row locks and TM DML locks, flagged
    BLOCKING / WAITING / HELD. Each row is killable (admin only, enforced in the UI)."""
    t = _target(db)
    return locks_dummy(t) if ORACLE_CC_USE_DUMMY else locks_real(t)


_LOCK_COLS = [
    {"key": "object", "label": "Locked object", "type": "mono"},
    {"key": "lock_type", "label": "Lock", "type": "text"},
    {"key": "mode_held", "label": "Mode held", "type": "text"},
    {"key": "sid_serial", "label": "SID,Serial#", "type": "mono"},
    {"key": "username", "label": "User", "type": "mono"},
    {"key": "machine", "label": "Machine", "type": "text"},
    {"key": "held_for", "label": "Held for", "type": "text"},
    {"key": "state", "label": "State", "type": "chip"},
    {"key": "sql_id", "label": "SQL_ID", "type": "mono"},
]

# State → row/chip severity. BLOCKING is the one to act on.
_LOCK_SEV = {"BLOCKING": "crit", "WAITING": "warn", "HELD": "ok"}


def _lock_row(object_: str, lock_type: str, mode_held: str, sid: int, serial: int,
              username: str, machine: str, held_for: str, state: str, sql_id: str) -> dict:
    """One lock row. `sid`/`serial` are carried as data (not columns) so the kill action
    has what it needs; `__actions:['kill']` tells the dyn-table to show the Kill button."""
    sev = _LOCK_SEV.get(state, "ok")
    # `__sev` drives the hover-reveal tint (BLOCKING → red, WAITING → amber on hover); rows
    # stay white at rest — the STATE chip carries the meaning.
    return {
        "object": object_, "lock_type": lock_type, "mode_held": mode_held,
        "sid_serial": f"{sid},{serial}", "username": username, "machine": machine,
        "held_for": held_for, "state": state, "state__sev": sev, "sql_id": sql_id,
        "__sev": sev, "__actions": ["kill"], "sid": sid, "serial": serial,
    }


def _locks_payload(rows: list[dict]) -> dict:
    blocking = sum(1 for r in rows if r.get("state") == "BLOCKING")
    waiting = sum(1 for r in rows if r.get("state") == "WAITING")
    return {"status": "success", "columns": _LOCK_COLS, "rows": rows,
            "summary": {"blocking": blocking, "waiting": waiting, "total": len(rows)}}


def locks_dummy(t: OracleTarget) -> dict:
    rows = [
        _lock_row("OLS.TRADE_EVENTS", "TX (Row)", "Exclusive (X)", 845, 22931, "OLS_BATCH", "batch07", "14m 20s", "BLOCKING", "7ymz9qk4d3n1a"),
        _lock_row("OLS.TRADE_EVENTS", "TX (Row)", "Row-X (RX)",   512, 10233, "OLS_APP",   "wildfly02", "13m 55s", "WAITING",  "7ymz9qk4d3n1a"),
        _lock_row("OLS.POSITION_SNAP", "TM (DML)", "Row-X (SX)",  233,  4021, "OLS",       "etl01",    "02m 41s", "HELD",     "9ab77tzp0q2mx"),
    ]
    return _locks_payload(rows)


def locks_real(t: OracleTarget) -> dict:
    """Held/blocking enqueue locks. V$LOCK (held rows: LMODE>0) joined to V$LOCKED_OBJECT +
    DBA_OBJECTS for the object name and V$SESSION for user/machine/sql; BLOCKING derived from
    V$SESSION.BLOCKING_SESSION_STATUS / V$LOCK.BLOCK. Same {columns, rows} shape as the dummy."""
    sql = """
        SELECT o.owner || '.' || o.object_name        AS object,
               DECODE(l.type, 'TX','TX (Row)', 'TM','TM (DML)', l.type) AS lock_type,
               DECODE(l.lmode, 6,'Exclusive (X)', 5,'Row-X (SSX)', 4,'Share (S)',
                               3,'Row-X (RX)', 2,'Row-S (RS)', TO_CHAR(l.lmode)) AS mode_held,
               s.sid, s.serial# AS serial, s.username, s.machine,
               NUMTODSINTERVAL(l.ctime, 'SECOND') AS held_for,
               CASE WHEN l.block = 1 THEN 'BLOCKING'
                    WHEN s.blocking_session IS NOT NULL THEN 'WAITING'
                    ELSE 'HELD' END AS state,
               s.sql_id
          FROM v$lock l
          JOIN v$session s        ON s.sid = l.sid
          LEFT JOIN v$locked_object lo ON lo.session_id = l.sid
          LEFT JOIN dba_objects o      ON o.object_id = lo.object_id
         WHERE l.type IN ('TX','TM')
           AND l.lmode > 0
         ORDER BY DECODE(state,'BLOCKING',0,'WAITING',1,2), l.ctime DESC
    """
    _ = sql
    raise RuntimeError("locks_real: wire _run() to your monitoring connection")


class KillRequest(BaseModel):
    sid: int
    serial: int
    immediate: bool = True


@router.post("/{db}/kill-session")
def kill_session(db: str, body: KillRequest) -> dict:
    """Kill one session (used by Locks / Blocking / Sessions). Destructive — the UI gates
    this behind an admin role + an explicit confirm before calling it."""
    t = _target(db)
    return kill_session_dummy(t, body) if ORACLE_CC_USE_DUMMY else kill_session_real(t, body)


def kill_session_dummy(t: OracleTarget, body: KillRequest) -> dict:
    logger.info("DUMMY kill-session %s,%s on %s (immediate=%s)", body.sid, body.serial, t.key, body.immediate)
    return {"status": "success", "success": True,
            "message": f"Session {body.sid},{body.serial} has been marked for kill on {t.instance}. "
                       "Its uncommitted work is being rolled back."}


def kill_session_real(t: OracleTarget, body: KillRequest) -> dict:
    """`ALTER SYSTEM KILL SESSION` takes no bind variables, so sid/serial are interpolated —
    they are ints validated by Pydantic, so this is injection-safe. NOTE: this needs ALTER
    SYSTEM, which the read-only monitor account deliberately lacks; run kills through a
    separate, privileged (and audited) connection alias — never widen the monitor grant."""
    stmt = f"ALTER SYSTEM KILL SESSION '{int(body.sid)},{int(body.serial)}'" + (" IMMEDIATE" if body.immediate else "")
    _ = stmt
    raise RuntimeError("kill_session_real: wire a privileged connection (ALTER SYSTEM) — not the read-only monitor")


# =============================================================================
# Section 6 — Blocking sessions (blocker → waiter tree)
# =============================================================================

@router.post("/{db}/blocking")
def blocking(db: str) -> dict:
    """The blocking hierarchy: each root is a final blocker, its `__children` are the sessions
    it blocks (recursively, so chained blocking shows as a tree). Every node is killable."""
    t = _target(db)
    return blocking_dummy(t) if ORACLE_CC_USE_DUMMY else blocking_real(t)


_BLK_COLS = [
    {"key": "session", "label": "Session (SID,Serial#)", "type": "mono"},
    {"key": "role", "label": "Role", "type": "chip"},
    {"key": "username", "label": "User", "type": "mono"},
    {"key": "object", "label": "Contended object", "type": "mono"},
    {"key": "event", "label": "Wait event", "type": "text"},
    {"key": "wait_time", "label": "Waiting", "type": "text"},
    {"key": "sql_id", "label": "SQL_ID", "type": "mono"},
    {"key": "machine", "label": "Machine", "type": "text"},
]


def _blk_node(sid: int, serial: int, role: str, username: str, object_: str, event: str,
              wait_time: str, sql_id: str, machine: str, children: list[dict] | None = None) -> dict:
    sev = "crit" if role == "BLOCKER" else "warn"
    # `__sev` drives the hover-reveal tint (blocker → red, waiter → amber on hover); rows
    # stay white at rest — the Role chip carries the meaning.
    node = {
        "session": f"{sid},{serial}", "role": role, "role__sev": sev,
        "username": username, "object": object_, "event": event,
        "wait_time": wait_time, "sql_id": sql_id, "machine": machine,
        "__sev": sev, "__actions": ["kill"], "sid": sid, "serial": serial,
    }
    if children:
        node["__children"] = children
    return node


def _blocking_payload(rows: list[dict]) -> dict:
    def _count(nodes: list[dict]) -> int:
        n = 0
        for r in nodes:
            n += 1 + _count(r.get("__children", []))
        return n
    waiters = _count(rows) - len(rows)
    return {"status": "success", "columns": _BLK_COLS, "rows": rows,
            "summary": {"chains": len(rows), "waiters": waiters}}


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


def blocking_real(t: OracleTarget) -> dict:
    """Build the blocker→waiter tree from V$SESSION.BLOCKING_SESSION (+ V$WAIT_CHAINS for
    depth if available). Roots = sessions blocking others but not blocked themselves; children
    = sessions whose BLOCKING_SESSION points at the parent. Same {columns, rows} shape."""
    sql = """
        SELECT s.sid, s.serial# AS serial, s.username, s.machine, s.sql_id,
               s.blocking_session AS blocked_by,
               s.event, s.seconds_in_wait,
               (SELECT o.owner || '.' || o.object_name
                  FROM v$locked_object lo JOIN dba_objects o ON o.object_id = lo.object_id
                 WHERE lo.session_id = s.sid AND ROWNUM = 1) AS object
          FROM v$session s
         WHERE s.blocking_session IS NOT NULL
            OR s.sid IN (SELECT blocking_session FROM v$session WHERE blocking_session IS NOT NULL)
    """
    # Assemble the tree in Python: index rows by sid, attach each to its blocker's __children,
    # collect the un-blocked blockers as roots.
    _ = sql
    raise RuntimeError("blocking_real: wire _run() to your monitoring connection")


# =============================================================================
# Section 7 — Sessions & performance deep-dive (list + SID drilldown + kill)
# =============================================================================

class SessionsQuery(BaseModel):
    # active | inactive | killed | all  (UI default = active)
    status: str = "active"


@router.post("/{db}/sessions")
def sessions(db: str, body: SessionsQuery | None = None) -> dict:
    """Session inventory filtered by state. The `summary` always carries the full per-state
    counts (regardless of the filter) so the UI can label the Active/Inactive/Killed/All tabs."""
    t = _target(db)
    status = (body.status if body else "active").lower()
    return sessions_dummy(t, status) if ORACLE_CC_USE_DUMMY else sessions_real(t, status)


_SESS_COLS = [
    {"key": "session", "label": "SID,Serial#", "type": "mono"},
    {"key": "username", "label": "User", "type": "mono"},
    {"key": "status", "label": "Status", "type": "chip"},
    {"key": "running_for", "label": "Running for", "type": "text"},
    {"key": "machine", "label": "Machine", "type": "text"},
    {"key": "program", "label": "Program", "type": "text"},
    {"key": "sql_id", "label": "SQL_ID", "type": "mono"},
    {"key": "event", "label": "Event / State", "type": "text"},
    {"key": "last_call", "label": "Last call", "type": "text"},
]

_SESS_CHIP = {"ACTIVE": "ok", "INACTIVE": "muted", "KILLED": "crit"}


def _fmt_dur(secs: int | None) -> str:
    """Seconds → compact human duration (LAST_CALL_ET for an ACTIVE session = how long its
    current call has been running). Mirrors the `last_call` string the dummy already uses."""
    if secs is None:
        return "—"
    h, rem = divmod(int(secs), 3600)
    m, s = divmod(rem, 60)
    return f"{h}h {m:02d}m" if h else f"{m:02d}m {s:02d}s"


def _sess_row(sid: int, serial: int, username: str, status: str, machine: str, program: str,
              sql_id: str | None, event: str, last_call: str, secs: int) -> dict:
    # Row severity is a hover-only cue in the UI: killed = red on hover. Long-running ACTIVE
    # sessions are surfaced by the explicit "Running for" column instead of an amber tint.
    row_sev = "crit" if status == "KILLED" else ""
    # "Running for" only makes sense for a session in a call — blank for inactive/killed.
    running_for = _fmt_dur(secs) if status == "ACTIVE" else "—"
    # Killed sessions can't be killed again — only offer the deep-dive there.
    actions = ["detail"] if status == "KILLED" else ["detail", "kill"]
    r = {
        "session": f"{sid},{serial}", "username": username, "status": status,
        "status__sev": _SESS_CHIP.get(status, "muted"), "running_for": running_for,
        "machine": machine, "program": program, "sql_id": sql_id or "—",
        "event": event, "last_call": last_call,
        "__actions": actions, "sid": sid, "serial": serial, "_secs": secs,
    }
    if row_sev:
        r["__sev"] = row_sev
    return r


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


def sessions_real(t: OracleTarget, status: str) -> dict:
    """V$SESSION (type='USER') for the inventory; STATUS is ACTIVE/INACTIVE/KILLED. `last_call`
    from LAST_CALL_ET. Full per-state counts computed with COUNT(*) GROUP BY status. Same shape."""
    sql = """
        SELECT s.sid, s.serial# AS serial, s.username, s.status, s.machine, s.program,
               s.sql_id, NVL(s.event, 'ON CPU') AS event, s.last_call_et AS secs
          FROM v$session s
         WHERE s.type = 'USER'
           AND (:status = 'all' OR LOWER(s.status) = :status)
         ORDER BY DECODE(s.status,'ACTIVE',0,'INACTIVE',1,2), s.last_call_et DESC
    """
    _ = sql
    raise RuntimeError("sessions_real: wire _run() to your monitoring connection")


class SessionDetailQuery(BaseModel):
    sid: int
    serial: int
    sql_id: str | None = None
    # When set, return just that one panel (per-tab refresh); omit for the full deep-dive.
    panel: str | None = None


@router.post("/{db}/session-detail")
def session_detail(db: str, body: SessionDetailQuery) -> dict:
    """The SID deep-dive: a self-describing list of panels (plan / ASH / SQL Monitor / stats /
    locks / AWR). Panels are either `kind:'text'` (monospace block) or `kind:'table'` (a normal
    dyn-table payload). ASH / SQL Monitor / AWR are `available:false` unless the target's
    Diagnostics+Tuning Pack is licensed (`diag_pack`), so we never query unlicensed features."""
    t = _target(db)
    return session_detail_dummy(t, body) if ORACLE_CC_USE_DUMMY else session_detail_real(t, body)


def _panel_text(key: str, label: str, text: str, *, requires: str | None = None, available: bool = True) -> dict:
    p = {"key": key, "label": label, "kind": "text", "available": available}
    if available:
        p["text"] = text
    if requires:
        p["requires"] = requires
    return p


def _panel_table(key: str, label: str, columns: list, rows: list, *, requires: str | None = None, available: bool = True) -> dict:
    p = {"key": key, "label": label, "kind": "table", "available": available}
    if available:
        p["table"] = {"status": "success", "columns": columns, "rows": rows}
    if requires:
        p["requires"] = requires
    return p


def _panel_rollback(percent: int = 63) -> dict:
    """Rollback progress for a killed session (undo being applied). Mirrors what
    V$SESSION_LONGOPS('Transaction Rollback') + V$TRANSACTION expose."""
    ublk_total, urec_total = 128_400, 5_120_000
    ublk_done = round(ublk_total * percent / 100)
    urec_done = round(urec_total * percent / 100)
    return {
        "key": "rollback", "label": "Rollback Monitor", "kind": "rollback", "available": True,
        "rollback": {
            "state": "ROLLING BACK" if percent < 100 else "COMPLETE",
            "percent": percent,
            "undo_blocks_total": ublk_total, "undo_blocks_done": ublk_done, "undo_blocks_left": ublk_total - ublk_done,
            "undo_records_total": urec_total, "undo_records_done": urec_done, "undo_records_left": urec_total - urec_done,
            "elapsed": "4m 12s", "est_remaining": "2m 30s",
            "note": "PMON is rolling back the killed transaction's uncommitted changes. "
                    "Don't restart the application on this instance until it completes.",
        },
    }


def session_detail_dummy(t: OracleTarget, q: SessionDetailQuery) -> dict:
    diag = t.diag_pack
    pack = "Diagnostics + Tuning Pack"
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
        _panel_table("ash", "Active Session History", ash_cols, ash_rows, requires=pack, available=diag),
        _panel_text("monitor", "SQL Monitor", monitor_text, requires=pack, available=diag),
        _panel_table("stats", "Object Statistics", stats_cols, stats_rows),
        _panel_table("locks", "Locks Held", locks_cols, locks_rows),
        _panel_table("awr", "AWR (DBA_HIST)", awr_cols, awr_rows, requires=pack, available=diag),
    ]
    # Per-tab refresh: return only the requested panel (the real fn would run just that query).
    if q.panel:
        panels = [p for p in panels if p["key"] == q.panel]
    return {"status": "success", "session": session, "panels": panels}


def session_detail_real(t: OracleTarget, q: SessionDetailQuery) -> dict:
    """Assemble the deep-dive from, per panel:
      * rollback— (killed sessions) V$SESSION_LONGOPS WHERE opname='Transaction Rollback'
                  (sofar/totalwork/time_remaining) + V$TRANSACTION.USED_UREC/USED_UBLK for the
                  undo still to apply. Include only when the session is KILLED / rolling back.
      * plan    — DBMS_XPLAN.DISPLAY_CURSOR(sql_id, child, 'ALLSTATS LAST +PEEKED_BINDS')
                  (Starts / E-Rows vs A-Rows / A-Time / Buffers / Reads pinpoint the bottleneck)
      * waits   — V$SESSION_EVENT for the SID (cumulative time per wait event + wait class)
      * binds   — DBMS_XPLAN peeked binds / V$SQL_BIND_CAPTURE (bind peeking / data skew)
      * ash     — V$ACTIVE_SESSION_HISTORY (last N min for the SID)          [diag pack]
      * monitor — DBMS_SQL_MONITOR.REPORT_SQL_MONITOR(session_id=>sid, type=>'TEXT') [tuning pack]
      * stats   — DBA_TAB_STATISTICS for the objects in the plan
      * locks   — V$LOCK / V$LOCKED_OBJECT for the SID
      * awr     — DBA_HIST_SQLSTAT for the sql_id                            [diag pack]
    Only run the pack-gated panels when t.diag_pack is true; otherwise return available:false."""
    raise RuntimeError("session_detail_real: wire _run() + DBMS_XPLAN/DBMS_SQL_MONITOR to your monitoring connection")


# --- DB access boundary (stand-in) --------------------------------------------

def _run(t: OracleTarget, sql: str, binds: dict | None = None) -> list[tuple]:
    """Execute a read-only query against the target's monitoring connection and return
    rows as tuples. Stand-in — swap the body for your real pool::

        import oracledb
        cfg  = CONNECTIONS[t.connection]          # dsn/user/password for the read-only monitor
        with oracledb.connect(**cfg) as con, con.cursor() as cur:
            cur.execute(sql, binds or {})
            return cur.fetchall()

    Kept separate so every *_real function is just SQL + a row-shape map.
    """
    raise RuntimeError(
        f"No live monitoring connection wired for '{t.connection}'. "
        "Set ORACLE_CC_USE_DUMMY=1 (default) or implement _run()."
    )
