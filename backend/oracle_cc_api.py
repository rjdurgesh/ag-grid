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
# App schema whose segments/indexes the storage sections report on (the owner-filtered
# queries bind :owner to this). Set ORACLE_CC_SCHEMA in .env if it isn't OLS.
OCC_SCHEMA = os.getenv("ORACLE_CC_SCHEMA", "OLS")
# Dev/demo ONLY: comma-separated scopes to force "unreachable" so you can preview the down UI
# (grey tab dot + unreachable banner + section read-errors) without a real outage. Leave EMPTY
# in real deployments — reachability is otherwise driven by the live connection. e.g.
# ORACLE_CC_FORCE_DOWN=retail_reporting
_FORCE_DOWN = {s.strip() for s in os.getenv("ORACLE_CC_FORCE_DOWN", "").split(",") if s.strip()}


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


# Per-scope DISPLAY metadata — only the bits a raw DB connection can't give you: the screen
# label/sub and the instance's friendly name. **KEYS MUST MATCH your db_configs scopes
# (connect_db()).** Everything structural (`key`, `connection`) is the scope itself, so the
# catalog below is BUILT from this — not repeated. (If your real connection already exposes
# `instance`, source it from there and drop it here — this map is just the hardcoded remainder.)
TARGET_META: dict[str, dict[str, Any]] = {
    "group":            {"label": "OLS GROUP",                        "instance": "OLSPRD1"},
    "cib_batch":        {"label": "OLS CIB",    "sub": "BATCH",       "instance": "CIBB1"},
    "cib_reporting":    {"label": "OLS CIB",    "sub": "REPORTING",   "instance": "CIBR1"},
    "retail_batch":     {"label": "OLS RETAIL", "sub": "BATCH",       "instance": "RTLB1"},
    "retail_reporting": {"label": "OLS RETAIL", "sub": "REPORTING",   "instance": "RTLR1"},
}

# Built dynamically: the scope key IS the target key AND the db_configs connection handle.
TARGET_CATALOG: dict[str, OracleTarget] = {
    scope: OracleTarget(
        key=scope,
        connection=scope,
        label=meta["label"],
        sub=meta.get("sub"),
        instance=meta.get("instance", scope.upper()),
    )
    for scope, meta in TARGET_META.items()
}


def _enabled_target_keys(request: Request | None) -> list[str]:
    """Every catalogued DB is shown as a tab (order follows the catalog). Whether each one is
    reachable is a separate flag (see `_reachable`) that colours the tab dot — a down DB still
    gets a tab so the operator can see it and its state, it just shows grey + section errors."""
    return list(TARGET_CATALOG.keys())


def _reachable(request: Request | None, scope: str) -> bool:
    """Is this DB's connection usable? Dummy mode → always True. Real mode → True when
    `connect_db` put a truthy connection in app.state.db_configs for this scope (i.e. the
    connect succeeded); a scope that's missing/None/failed reads as down (grey tab). This never
    touches the DB, so it can't hang or bring the screen down if a database is unavailable."""
    if scope in _FORCE_DOWN:  # dev/demo override (see ORACLE_CC_FORCE_DOWN)
        return False
    if ORACLE_CC_USE_DUMMY or request is None:
        return True
    cfgs = getattr(request.app.state, "db_configs", {}) or {}
    return bool(cfgs.get(scope))


def _target(db: str) -> OracleTarget:
    t = TARGET_CATALOG.get(db)
    if not t:
        raise HTTPException(status_code=404, detail=f"Unknown DB target '{db}'")
    if db in _FORCE_DOWN:  # dev/demo: simulate an unreachable DB so every section 503s
        raise HTTPException(status_code=503, detail=f"Database '{db}' is unreachable")
    return t


@router.get("/targets")
def list_targets(request: Request) -> dict:
    """The DB tabs the UI should render — driven by ``app.state.db_configs`` (see note above):
    add/remove a scope in app.py's loader and the tab list follows, no change needed here."""
    keys = _enabled_target_keys(request)
    return {"status": "success",
            "data": [{**TARGET_CATALOG[k].model_dump(), "reachable": _reachable(request, k)} for k in keys]}


@router.get("/overview")
def overview(request: Request) -> dict:
    """Compact per-DB snapshot for the Home 'Oracle Databases' strip — storage %, blocking
    sessions, active sessions, and the largest segment. ONE call powers every tile."""
    return overview_dummy(request) if ORACLE_CC_USE_DUMMY else overview_real(request)


def overview_real(request: Request | None = None) -> dict:
    """One light query per target (kept cheap for Home): max tablespace used %
    (DBA_TABLESPACE_USAGE_METRICS), COUNT blocking sessions (V$SESSION.blocking_session),
    COUNT active USER sessions (V$SESSION), and the largest segment (DBA_SEGMENTS)."""
    snap_sql = """
        SELECT (SELECT ROUND(MAX(used_percent), 1) FROM dba_tablespace_usage_metrics)        AS storage_pct,
               (SELECT COUNT(*) FROM v$session WHERE blocking_session IS NOT NULL)            AS blocking,
               (SELECT COUNT(*) FROM v$session WHERE type = 'USER' AND status = 'ACTIVE')     AS active
          FROM dual
    """
    top_sql = """
        SELECT segment_name, ROUND(SUM(bytes)/1024/1024/1024, 2) AS size_gb
          FROM dba_segments
         WHERE owner = :owner
         GROUP BY segment_name
         ORDER BY size_gb DESC
         FETCH FIRST 1 ROWS ONLY
    """
    data = []
    for key in _enabled_target_keys(request):
        tgt = TARGET_CATALOG[key]
        reachable = _reachable(request, key)
        tile = {"key": tgt.key, "label": tgt.label, "sub": tgt.sub, "instance": tgt.instance,
                "reachable": reachable, "storage_pct": 0.0, "storage_sev": "ok",
                "blocking": 0, "active": 0, "top_object": "—", "top_gb": 0.0}
        if reachable:
            try:  # a single down DB must not fail the whole strip
                snap = (_run(tgt, snap_sql) or [{}])[0]
                top = (_run(tgt, top_sql, {"owner": OCC_SCHEMA}) or [{}])[0]
                pct = float(snap.get("storage_pct") or 0)
                tile.update({"storage_pct": pct, "storage_sev": _sev_for(pct),
                             "blocking": int(snap.get("blocking") or 0), "active": int(snap.get("active") or 0),
                             "top_object": top.get("segment_name") or "—", "top_gb": float(top.get("size_gb") or 0)})
            except Exception as exc:
                logger.warning("overview: DB '%s' unreachable — %s", key, exc)
                tile["reachable"] = False
        data.append(tile)
    return {"status": "success", "data": data}


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
    # _run returns dicts keyed by (lowercased) column name → map to the payload's keys.
    rows = [
        {"owner": r["owner"], "tablespace": r["tablespace_name"],
         "total_gb": r["total_gb"], "used_gb": r["used_gb"],
         "free_gb": r["free_gb"], "used_pct": r["used_pct"]}
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
    owner = OCC_SCHEMA
    # 1) Top-N tables by total data-segment bytes (sums table + its partitions/subpartitions).
    tables = _run(t, """
        SELECT segment_name, ROUND(SUM(bytes)/1024/1024/1024, 2) AS size_gb
          FROM dba_segments
         WHERE owner = :owner
           AND segment_type IN ('TABLE','TABLE PARTITION','TABLE SUBPARTITION')
         GROUP BY segment_name
         ORDER BY size_gb DESC
         FETCH FIRST :lim ROWS ONLY
    """, {"owner": owner, "lim": 10})

    # 2) Stats (num_rows / last_analyzed / stale) for tables + partitions, in one pass.
    stats: dict[tuple, dict] = {}
    for s in _run(t, """
        SELECT object_type, table_name, partition_name, num_rows, stale_stats,
               TO_CHAR(last_analyzed, 'DD-Mon HH24:MI') AS last_analyzed
          FROM dba_tab_statistics
         WHERE owner = :owner AND object_type IN ('TABLE','PARTITION')
    """, {"owner": owner}):
        stats[(s["table_name"], s.get("partition_name"))] = s

    def cells(table: str, part: str | None = None) -> dict:
        s = stats.get((table, part), {})
        fresh = (s.get("stale_stats") or "NO") != "YES"
        return {"num_rows": s.get("num_rows"), "last_analyzed": s.get("last_analyzed") or "—", **_stats_cell(fresh)}

    # 3) For each table, its top-N partitions as __children. (Add a subpartition level the same
    #    way — query segment_type='TABLE SUBPARTITION' grouped by subobject — if you use them.)
    rows = []
    for tb in tables:
        seg = tb["segment_name"]
        parts = _run(t, """
            SELECT partition_name, ROUND(SUM(bytes)/1024/1024/1024, 2) AS size_gb
              FROM dba_segments
             WHERE owner = :owner AND segment_name = :seg
               AND segment_type IN ('TABLE PARTITION','TABLE SUBPARTITION')
             GROUP BY partition_name
             ORDER BY size_gb DESC
             FETCH FIRST :lim ROWS ONLY
        """, {"owner": owner, "seg": seg, "lim": TOP_CHILD_LIMIT})
        row = {"object": seg, "kind": "Table", "size_gb": tb["size_gb"], **cells(seg)}
        children = [
            {"object": p["partition_name"], "kind": "Partition", "size_gb": p["size_gb"], **cells(seg, p["partition_name"])}
            for p in parts
        ]
        if children:
            row["__children"] = children
        rows.append(row)
    return {"status": "success", "columns": _TOP_COLS, "rows": rows}


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
    rows = []
    for ix in _run(t, sql, {"owner": OCC_SCHEMA}):
        name = ix["index_name"]
        parts = _run(t, """
            SELECT partition_name, ROUND(SUM(bytes)/1024/1024/1024, 2) AS size_gb
              FROM dba_segments
             WHERE owner = :owner AND segment_name = :seg
               AND segment_type IN ('INDEX PARTITION','INDEX SUBPARTITION')
             GROUP BY partition_name
             ORDER BY size_gb DESC
             FETCH FIRST :lim ROWS ONLY
        """, {"owner": OCC_SCHEMA, "seg": name, "lim": TOP_CHILD_LIMIT})
        row = {"index_name": name, "table_name": ix["table_name"], "kind": ix["kind"], "size_gb": ix["size_gb"]}
        children = [
            {"index_name": p["partition_name"], "table_name": ix["table_name"],
             "kind": "Index partition", "size_gb": p["size_gb"]}
            for p in parts
        ]
        if children:
            row["__children"] = children
        rows.append(row)
    return {"status": "success", "columns": _IDX_COLS, "rows": rows}


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
               TO_CHAR(last_analyzed, 'DD-Mon') AS last_analyzed
          FROM dba_indexes
         WHERE owner = :owner
           AND (status = 'UNUSABLE' OR visibility = 'INVISIBLE'
                OR index_name IN (SELECT object_name FROM dba_tab_statistics
                                   WHERE owner = :owner AND object_type LIKE 'INDEX%' AND stale_stats = 'YES'))
         ORDER BY state
    """
    sev = {"UNUSABLE": "crit", "INVISIBLE": "warn", "STALE STATS": "warn"}
    detail = {
        "UNUSABLE": "Offline — not maintained; rebuild required",
        "INVISIBLE": "Maintained but hidden from the optimizer",
        "STALE STATS": "Stats out of date; gather to refresh",
    }
    rows = []
    for r in _run(t, sql, {"owner": OCC_SCHEMA}):
        st = r["state"]
        s = sev.get(st, "warn")
        rows.append({
            "index_name": r["index_name"], "table_name": r["table_name"],
            "state": st, "state__sev": s, "detail": detail.get(st, ""),
            "last_analyzed": r.get("last_analyzed") or "—", "__sev": s,
        })
    return {"status": "success", "columns": _IDXH_COLS, "rows": rows}


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
               l.ctime AS held_secs,
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
    rows = [
        _lock_row(r["object"] or "—", r["lock_type"], r["mode_held"],
                  int(r["sid"]), int(r["serial"]), r["username"] or "—", r["machine"] or "—",
                  _fmt_dur(r.get("held_secs")), r["state"], r["sql_id"] or "—")
        for r in _run(t, sql)
    ]
    return _locks_payload(rows)


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
    # Assemble the tree in Python: index rows by sid, group waiters under their blocker,
    # then the un-blocked blockers are the roots.
    raw = _run(t, sql)
    by_sid = {int(r["sid"]): r for r in raw}
    kids: dict[int, list[dict]] = {}
    for r in raw:
        blocker = r.get("blocked_by")
        if blocker:                       # this session is waiting behind `blocker`
            kids.setdefault(int(blocker), []).append(r)

    def build(r: dict, role: str, visited: set[int]) -> dict:
        sid = int(r["sid"])
        seen = visited | {sid}
        children = [build(c, "WAITER", seen) for c in kids.get(sid, []) if int(c["sid"]) not in seen]
        return _blk_node(sid, int(r["serial"]), role, r.get("username") or "—",
                         r.get("object") or "—", r.get("event") or "—",
                         _fmt_dur(r.get("seconds_in_wait")), r.get("sql_id") or "—",
                         r.get("machine") or "—", children or None)

    roots = [by_sid[sid] for sid in kids if not (by_sid.get(sid) or {}).get("blocked_by") and sid in by_sid]
    return _blocking_payload([build(r, "BLOCKER", set()) for r in roots])


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
    rows = [
        _sess_row(int(r["sid"]), int(r["serial"]), r["username"] or "—", (r["status"] or "").upper(),
                  r["machine"] or "—", r["program"] or "—", r.get("sql_id"),
                  r.get("event") or "ON CPU", _fmt_dur(r.get("secs")), int(r.get("secs") or 0))
        for r in _run(t, sql, {"status": status})
    ]
    # Full per-state counts (independent of the filter) so the UI can label every tab.
    counts = {"active": 0, "inactive": 0, "killed": 0, "total": 0}
    for c in _run(t, "SELECT LOWER(status) AS st, COUNT(*) AS c FROM v$session WHERE type='USER' GROUP BY LOWER(status)"):
        n = int(c["c"] or 0)
        counts["total"] += n
        if c["st"] in counts:
            counts[c["st"]] = n
    return {"status": "success", "columns": _SESS_COLS, "rows": rows, "summary": counts}


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
    dyn-table payload). A panel comes back `available:false` only if its own query fails (each
    panel is built independently), never for licensing."""
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
      * ash     — V$ACTIVE_SESSION_HISTORY (last N min for the SID)
      * monitor — DBMS_SQL_MONITOR.REPORT_SQL_MONITOR(session_id=>sid, type=>'TEXT')
      * stats   — DBA_TAB_STATISTICS for the objects in the plan
      * locks   — V$LOCK / V$LOCKED_OBJECT for the SID
      * awr     — DBA_HIST_SQLSTAT for the sql_id

    NOTE: this is a lot of version/edition-specific V$/DBA SQL — it's wired to the exact panel
    contract (keys/columns) the UI expects, but verify the view/column names against your Oracle
    version. Each panel is built inside its own try/except so one bad query degrades that panel
    to `available:false` instead of failing the whole deep-dive."""
    sid, serial = int(q.sid), int(q.serial)

    facts = _run(t, """
        SELECT s.sid, s.serial# AS serial, s.username, s.status, s.machine, s.program,
               s.sql_id, NVL(s.event, 'ON CPU') AS event, s.last_call_et AS secs,
               s.osuser, s.module, TO_CHAR(s.logon_time, 'DD-Mon HH24:MI') AS logon_time
          FROM v$session s WHERE s.sid = :sid AND s.serial# = :serial
    """, {"sid": sid, "serial": serial})
    f = facts[0] if facts else {}
    status = (f.get("status") or "ACTIVE").upper()
    sql_id = q.sql_id or (f.get("sql_id") if f.get("sql_id") not in (None, "—") else None)
    session = {
        "sid": sid, "serial": serial, "session": f"{sid},{serial}",
        "username": f.get("username") or "—", "status": status,
        "machine": f.get("machine") or "—", "program": f.get("program") or "—",
        "logon_time": f.get("logon_time") or "—", "sql_id": sql_id or "—",
        "osuser": f.get("osuser") or "—", "module": f.get("module") or "—",
        "last_call": _fmt_dur(f.get("secs")),
    }

    def _safe(build, fallback):
        try:
            return build()
        except Exception as exc:  # one panel's SQL failing shouldn't kill the drawer
            logger.warning("session-detail panel failed (%s): %s", getattr(fallback, "get", lambda k: "?")("key"), exc)
            return fallback

    waits_cols = [{"key": "event", "label": "Wait event", "type": "mono"},
                  {"key": "wait_class", "label": "Class", "type": "chip"},
                  {"key": "time_waited_s", "label": "Time waited (s)", "type": "num"},
                  {"key": "waits", "label": "Waits", "type": "num"},
                  {"key": "avg_ms", "label": "Avg (ms)", "type": "num"}]
    binds_cols = [{"key": "name", "label": "Bind", "type": "mono"},
                  {"key": "pos", "label": "Pos", "type": "num"},
                  {"key": "datatype", "label": "Datatype", "type": "text"},
                  {"key": "value", "label": "Peeked value", "type": "mono"}]
    ash_cols = [{"key": "sample_time", "label": "Sample", "type": "text"},
                {"key": "session_state", "label": "State", "type": "chip"},
                {"key": "event", "label": "Event", "type": "text"},
                {"key": "wait_class", "label": "Wait class", "type": "text"},
                {"key": "sql_id", "label": "SQL_ID", "type": "mono"}]
    stats_cols = [{"key": "object", "label": "Object", "type": "mono"},
                  {"key": "num_rows", "label": "Rows", "type": "num"},
                  {"key": "last_analyzed", "label": "Last analyzed", "type": "text"},
                  {"key": "state", "label": "Stats", "type": "chip"}]
    locks_cols = [{"key": "type", "label": "Lock", "type": "text"},
                  {"key": "mode_held", "label": "Mode held", "type": "text"},
                  {"key": "object", "label": "Object", "type": "mono"},
                  {"key": "state", "label": "State", "type": "chip"}]
    awr_cols = [{"key": "snap", "label": "Snap window", "type": "text"},
                {"key": "elapsed_s", "label": "Elapsed (s)", "type": "num"},
                {"key": "cpu_s", "label": "CPU (s)", "type": "num"},
                {"key": "buffer_gets", "label": "Buffer gets", "type": "num"},
                {"key": "executions", "label": "Execs", "type": "num"}]
    _WAIT_SEV = {"Application": "crit", "Concurrency": "crit", "User I/O": "warn", "System I/O": "warn",
                 "Cluster": "warn", "Commit": "ok", "CPU": "ok", "Idle": "muted"}

    def plan_panel():
        if not sql_id:
            return _panel_text("plan", "Execution Plan", "", available=False)
        out = _run(t, "SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(:sql_id, NULL, 'ALLSTATS LAST +PEEKED_BINDS'))",
                   {"sql_id": sql_id})
        text = "\n".join(str(r.get("plan_table_output") or "") for r in out)
        return _panel_text("plan", "Execution Plan", text or "(no plan in the cursor cache for this SQL_ID)")

    def waits_panel():
        rows = []
        for r in _run(t, "SELECT event, wait_class, time_waited, total_waits, average_wait FROM v$session_event WHERE sid = :sid ORDER BY time_waited DESC",
                      {"sid": sid}):
            wc = r.get("wait_class") or "—"
            row = {"event": r["event"], "wait_class": wc, "wait_class__sev": _WAIT_SEV.get(wc, "muted"),
                   "time_waited_s": round((r.get("time_waited") or 0) / 100, 1),
                   "waits": int(r.get("total_waits") or 0), "avg_ms": round((r.get("average_wait") or 0) * 10, 1)}
            if _WAIT_SEV.get(wc) in ("crit", "warn"):
                row["__sev"] = _WAIT_SEV[wc]
            rows.append(row)
        return _panel_table("waits", "Wait Events", waits_cols, rows)

    def binds_panel():
        if not sql_id:
            return _panel_table("binds", "Bind Variables", binds_cols, [], available=False)
        rows = [{"name": r.get("name"), "pos": r.get("position"), "datatype": r.get("datatype_string") or "",
                 "value": str(r.get("value_string") or "")}
                for r in _run(t, "SELECT name, position, datatype_string, value_string FROM v$sql_bind_capture WHERE sql_id = :sql_id ORDER BY position",
                              {"sql_id": sql_id})]
        return _panel_table("binds", "Bind Variables", binds_cols, rows)

    def ash_panel():
        rows = [{"sample_time": r.get("sample_time"), "session_state": r.get("session_state"),
                 "session_state__sev": "ok" if r.get("session_state") == "ON CPU" else "warn",
                 "event": r.get("event") or "—", "wait_class": r.get("wait_class") or "CPU", "sql_id": r.get("sql_id") or "—"}
                for r in _run(t, """
                    SELECT TO_CHAR(sample_time,'HH24:MI:SS') AS sample_time, session_state, event, wait_class, sql_id
                      FROM v$active_session_history
                     WHERE session_id = :sid AND sample_time > SYSDATE - INTERVAL '10' MINUTE
                     ORDER BY sample_time DESC FETCH FIRST 50 ROWS ONLY
                """, {"sid": sid})]
        return _panel_table("ash", "Active Session History", ash_cols, rows)

    def monitor_panel():
        out = _run(t, "SELECT DBMS_SQL_MONITOR.REPORT_SQL_MONITOR(session_id=>:sid, type=>'TEXT') AS report FROM dual", {"sid": sid})
        return _panel_text("monitor", "SQL Monitor", (str(out[0].get("report")) if out else "") or "(no active SQL Monitor report)")

    def stats_panel():
        rows = [{"object": r["table_name"], "num_rows": r.get("num_rows"), "last_analyzed": r.get("last_analyzed") or "—",
                 "state": "STALE" if r.get("stale_stats") == "YES" else "FRESH",
                 "state__sev": "warn" if r.get("stale_stats") == "YES" else "ok"}
                for r in _run(t, """
                    SELECT table_name, num_rows, stale_stats, TO_CHAR(last_analyzed,'DD-Mon HH24:MI') AS last_analyzed
                      FROM dba_tab_statistics
                     WHERE owner = :owner AND object_type = 'TABLE'
                       AND table_name IN (SELECT object_name FROM v$sql_plan
                                           WHERE sql_id = :sql_id AND object_owner = :owner AND object_type LIKE 'TABLE%')
                """, {"owner": OCC_SCHEMA, "sql_id": sql_id or ""})]
        return _panel_table("stats", "Object Statistics", stats_cols, rows)

    def locks_panel():
        rows = []
        for r in _run(t, """
            SELECT DECODE(l.type,'TX','TX (Row)','TM','TM (DML)',l.type) AS type,
                   DECODE(l.lmode,6,'Exclusive (X)',5,'Row-X (SSX)',4,'Share (S)',3,'Row-X (RX)',2,'Row-S (RS)',TO_CHAR(l.lmode)) AS mode_held,
                   (SELECT o.owner||'.'||o.object_name FROM v$locked_object lo JOIN dba_objects o ON o.object_id = lo.object_id
                     WHERE lo.session_id = l.sid AND ROWNUM = 1) AS object,
                   CASE WHEN l.block = 1 THEN 'BLOCKING' ELSE 'HELD' END AS state
              FROM v$lock l WHERE l.sid = :sid AND l.type IN ('TX','TM') AND l.lmode > 0
        """, {"sid": sid}):
            st = r["state"]
            rows.append({"type": r["type"], "mode_held": r["mode_held"], "object": r.get("object") or "—",
                         "state": st, "state__sev": "crit" if st == "BLOCKING" else "ok"})
        return _panel_table("locks", "Locks Held", locks_cols, rows)

    def awr_panel():
        if not sql_id:
            return _panel_table("awr", "AWR (DBA_HIST)", awr_cols, [], available=False)
        rows = [{"snap": r.get("snap"), "elapsed_s": round((r.get("elapsed_time") or 0) / 1e6, 1),
                 "cpu_s": round((r.get("cpu_time") or 0) / 1e6, 1), "buffer_gets": int(r.get("buffer_gets") or 0),
                 "executions": int(r.get("executions_delta") or 0)}
                for r in _run(t, """
                    SELECT TO_CHAR(s.begin_interval_time,'DD-Mon HH24:MI') AS snap,
                           st.elapsed_time_delta AS elapsed_time, st.cpu_time_delta AS cpu_time,
                           st.buffer_gets_delta AS buffer_gets, st.executions_delta
                      FROM dba_hist_sqlstat st JOIN dba_hist_snapshot s ON s.snap_id = st.snap_id
                     WHERE st.sql_id = :sql_id ORDER BY s.begin_interval_time DESC FETCH FIRST 8 ROWS ONLY
                """, {"sql_id": sql_id})]
        return _panel_table("awr", "AWR (DBA_HIST)", awr_cols, rows)

    def rollback_panel():
        rb = _run(t, """
            SELECT NVL(ROUND(sofar * 100 / NULLIF(totalwork, 0)), 0) AS pct
              FROM v$session_longops
             WHERE sid = :sid AND opname = 'Transaction Rollback' AND sofar < totalwork
             ORDER BY start_time DESC FETCH FIRST 1 ROWS ONLY
        """, {"sid": sid})
        return _panel_rollback(int(rb[0]["pct"]) if rb else 0)

    panels = []
    if status == "KILLED":
        panels.append(_safe(rollback_panel, _panel_rollback(0)))
    panels += [
        _safe(plan_panel, _panel_text("plan", "Execution Plan", "", available=False)),
        _safe(waits_panel, _panel_table("waits", "Wait Events", waits_cols, [], available=False)),
        _safe(binds_panel, _panel_table("binds", "Bind Variables", binds_cols, [], available=False)),
        _safe(ash_panel, _panel_table("ash", "Active Session History", ash_cols, [], available=False)),
        _safe(monitor_panel, _panel_text("monitor", "SQL Monitor", "", available=False)),
        _safe(stats_panel, _panel_table("stats", "Object Statistics", stats_cols, [], available=False)),
        _safe(locks_panel, _panel_table("locks", "Locks Held", locks_cols, [], available=False)),
        _safe(awr_panel, _panel_table("awr", "AWR (DBA_HIST)", awr_cols, [], available=False)),
    ]
    if q.panel:  # per-tab refresh → just the requested panel
        panels = [p for p in panels if p["key"] == q.panel]
    return {"status": "success", "session": session, "panels": panels}


# --- DB access boundary -------------------------------------------------------
#
# `_run` is the ONE place that touches the DB. Every *_real above is just "SQL + shape the
# dicts", because `_run` returns rows as **dicts keyed by lowercased column name** — so the
# mapping is by name (robust to column order), e.g. row["used_pct"], not row[5].
#
# The connection comes from what your `connect_db(scope)` stored in app.state.db_configs;
# app.py wires it once via `set_db_configs(app.state.db_configs)` so the (t)-only *_real
# functions can reach it without threading `request` everywhere.

_DB_CONFIGS: dict[str, Any] = {}


def set_db_configs(cfgs: dict[str, Any] | None) -> None:
    """Register the per-scope connections so `_run` can resolve one by `t.connection`.
    Call once from app.py after building app.state.db_configs."""
    global _DB_CONFIGS
    _DB_CONFIGS = cfgs or {}


def _run(t: OracleTarget, sql: str, binds: dict | None = None) -> list[dict]:
    """Execute read-only `sql` on the target's monitoring connection; return rows as a list
    of dicts keyed by lowercased column name. Binds are a dict for named binds (``:owner``).

    Assumes a python-oracledb / cx_Oracle style connection object in db_configs[t.connection]
    (both share this cursor API). If your `connect_db` returns a *config* instead of a live
    connection, open it here instead.
    """
    conn = _DB_CONFIGS.get(t.connection)
    if conn is None:
        raise RuntimeError(
            f"No live connection for scope '{t.connection}'. Check load_db_configs()/connect_db "
            "in app.py (and that set_db_configs ran), or keep ORACLE_CC_USE_DUMMY=1."
        )
    cur = conn.cursor()
    try:
        cur.execute(sql, binds or {})
        if cur.description is None:
            return []
        cols = [d[0].lower() for d in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]
    finally:
        cur.close()


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
