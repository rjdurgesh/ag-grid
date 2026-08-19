"""Oracle Command Center API — per-DB DBA monitoring (space, top segments, locks,
blocking, sessions + SID deep-dive).

Design goals baked in here:

* **Config-driven DB targets.** The tab list is derived from ``app.state.db_configs``
  (populated once in app.py from your ``connect_db`` loop) — a DB is exposed as a tab only
  when its scope key is present there. ``TARGET_CATALOG`` supplies just the display metadata
  per scope (label / instance / Diag-Pack, which gates ASH / AWR / SQL Monitor). Enable or
  disable a database from that ONE place (app.py) and every screen follows, no code here.

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

from env_loader import env_bool, env_int  # importing also loads backend/.env into os.environ

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from utils.logging import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/oracle_cc", tags=["oracle_cc"])

# All tunables come from the environment / backend/.env (see .env.example); the literals
# here are just the fallbacks when a var isn't set.
#   ORACLE_CC_USE_DUMMY   per-screen backend dummy switch (like the UI's apiMocks) — 1 = canned
#                         dummy data, 0 = run the real *_real SQL functions.
#   ORACLE_CC_WARN/CRIT_PCT   tablespace gauge colour thresholds (percent used).
#   ORACLE_CC_TOP_CHILD_LIMIT top-N biggest children per drill-down level (partitions have
#                             hundreds; only the largest space consumers matter).
ORACLE_CC_USE_DUMMY = env_bool("ORACLE_CC_USE_DUMMY", True)
WARN_PCT = env_int("ORACLE_CC_WARN_PCT", 85)
CRIT_PCT = env_int("ORACLE_CC_CRIT_PCT", 90)
TOP_CHILD_LIMIT = env_int("ORACLE_CC_TOP_CHILD_LIMIT", 10)


# --- config-driven DB targets ------------------------------------------------
#
# The SINGLE source of truth for "which databases exist" is ``app.state.db_configs``
# (populated in app.py from your ``connect_db`` loop, keyed by scope). This catalog only
# supplies the DISPLAY metadata (label / instance / Diag-Pack) per scope. A database becomes
# an OCC tab **only if its scope key is present (and truthy) in db_configs** — i.e. connect_db
# actually returned a connection for it. So enable/disable a DB from that ONE place (app.py);
# the tabs, the Home strip and every per-DB query follow. The scope key doubles as the ``db``
# path param AND the handle used to fetch that connection (``db_configs[target.connection]``).

class OracleTarget(BaseModel):
    key: str          # == db_configs scope key; used in the URL + UI tab
    label: str        # "OLS CIB"
    sub: str | None = None   # "BATCH" / "REPORTING"
    instance: str            # display instance name
    connection: str          # handle into app.state.db_configs (defaults to == key)
    diag_pack: bool = False   # Diagnostics/Tuning Pack licensed? gates ASH/AWR/SQL Monitor


# Per-scope DISPLAY metadata — only the bits a raw DB connection can't give you: the screen
# label/sub, the instance's friendly name, and whether the Diagnostics/Tuning Pack is licensed.
# **KEYS MUST MATCH your db_configs scopes (connect_db()).** Everything structural (`key`,
# `connection`) is the scope itself, so the catalog below is BUILT from this — not repeated.
# (If your real connection/config already carries `instance` or the pack flag, source them
# from there instead and drop them here — this map is just the hardcoded remainder.)
TARGET_META: dict[str, dict[str, Any]] = {
    "group":            {"label": "OLS GROUP",                        "instance": "OLSPRD1", "diag_pack": True},
    "cib_batch":        {"label": "OLS CIB",    "sub": "BATCH",       "instance": "CIBB1",   "diag_pack": True},
    "cib_reporting":    {"label": "OLS CIB",    "sub": "REPORTING",   "instance": "CIBR1",   "diag_pack": True},
    "retail_batch":     {"label": "OLS RETAIL", "sub": "BATCH",       "instance": "RTLB1",   "diag_pack": False},
    "retail_reporting": {"label": "OLS RETAIL", "sub": "REPORTING",   "instance": "RTLR1",   "diag_pack": False},
}

# Built dynamically: the scope key IS the target key AND the db_configs connection handle.
TARGET_CATALOG: dict[str, OracleTarget] = {
    scope: OracleTarget(
        key=scope,
        connection=scope,
        label=meta["label"],
        sub=meta.get("sub"),
        instance=meta.get("instance", scope.upper()),
        diag_pack=bool(meta.get("diag_pack", False)),
    )
    for scope, meta in TARGET_META.items()
}


def _enabled_target_keys(request: Request | None) -> list[str]:
    """Catalogued scopes to surface as tabs. Dummy mode shows every catalogued scope (no real
    connections exist in dev). Real mode shows a scope only if it's present AND truthy in
    ``app.state.db_configs`` (connect_db returned a connection). Order follows the catalog."""
    if ORACLE_CC_USE_DUMMY or request is None:
        return list(TARGET_CATALOG.keys())
    cfgs = getattr(request.app.state, "db_configs", {}) or {}
    return [k for k in TARGET_CATALOG if cfgs.get(k)]


def _target(db: str) -> OracleTarget:
    t = TARGET_CATALOG.get(db)
    if not t:
        raise HTTPException(status_code=404, detail=f"Unknown DB target '{db}'")
    return t


@router.get("/targets")
def list_targets(request: Request) -> dict:
    """The DB tabs the UI should render — driven by ``app.state.db_configs`` (see note above):
    add/remove a scope in app.py's loader and the tab list follows, no change needed here."""
    keys = _enabled_target_keys(request)
    return {"status": "success", "data": [TARGET_CATALOG[k].model_dump() for k in keys]}


@router.get("/overview")
def overview(request: Request) -> dict:
    """Compact per-DB snapshot for the Home 'Oracle Databases' strip — storage %, blocking
    sessions, active sessions, and the largest segment. ONE call powers every tile."""
    return overview_dummy(request) if ORACLE_CC_USE_DUMMY else overview_real(request)


def overview_real(request: Request | None = None) -> dict:
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


# --- Section 1: real (the actual query) ----------------------------------------

def space_real(t: OracleTarget) -> dict:
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


# ---------------------------------------------------------------------------
# Dummy-mode implementations live in oracle_cc_dummy (canned data, no routes). They
# import the shared contract/helpers from THIS module, so this import sits at the very
# bottom - after every shared name above is defined - to keep the cycle safe. It wires
# the routes' `*_dummy` calls (used when ORACLE_CC_USE_DUMMY is on).
from oracle_cc_dummy import (  # noqa: E402
    overview_dummy,
    space_dummy,
    top_segments_dummy,
    top_indexes_dummy,
    index_health_dummy,
    locks_dummy,
    kill_session_dummy,
    blocking_dummy,
    sessions_dummy,
    session_detail_dummy,
)
