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

import database  # data layer — ALL SQL lives here; this module only massages it for the UI
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

# --- Section 8 · SQL Intelligence tunables -----------------------------------
#   SQLI_USE_DUMMY     canned SQL-Intelligence data (defaults to the OCC dummy switch).
#   SQLI_HISTORY_DAYS  how far back every historical query looks (AWR window). Fixed to 5 per
#                      the requirement — every plan-timeline / perf / ASH / finder query is
#                      capped to SYSTIMESTAMP - INTERVAL '<days>' DAY. Needs AWR retention >= this.
#   SQLI_ALLOW_APPLY   show the ADMIN-only in-app "Apply fix" button. The recommended plan +
#                      copy-ready SQL is ALWAYS shown to everyone; this flag ONLY controls whether
#                      the app itself can write the change (via a separate privileged/audited
#                      connection). Set SQLI_ALLOW_APPLY=0 to make the tool recommend-only.
SQLI_USE_DUMMY = env_bool("SQLI_USE_DUMMY", ORACLE_CC_USE_DUMMY)
SQLI_HISTORY_DAYS = env_int("SQLI_HISTORY_DAYS", 5)
SQLI_ALLOW_APPLY = env_bool("SQLI_ALLOW_APPLY", True)


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
    """Compact per-DB snapshot for the Home 'Oracle Databases' strip — storage %, blocking +
    active sessions, largest segment. ONE call powers every tile. Dummy → canned; else one light
    snapshot per target (SQL in `database.fetch_overview`); a single down DB degrades to a grey
    tile, never failing the whole strip."""
    if ORACLE_CC_USE_DUMMY:
        return overview_dummy(request)
    cfgs = request.app.state.db_configs or {}
    data = []
    for key in _enabled_target_keys(request):
        tgt = TARGET_CATALOG[key]
        reachable = _reachable(request, key)
        tile = {"key": tgt.key, "label": tgt.label, "sub": tgt.sub, "instance": tgt.instance,
                "reachable": reachable, "storage_pct": 0.0, "storage_sev": "ok",
                "blocking": 0, "active": 0, "top_object": "—", "top_gb": 0.0}
        if reachable:
            try:  # a single down DB must not fail the whole strip
                raw = database.fetch_overview(cfgs.get(key), OCC_SCHEMA)
                snap, top = raw.get("snap") or {}, raw.get("top") or {}
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
def space(request: Request, db: str) -> dict:
    """Consolidated space gauge + per-tablespace breakdown. Free + Used % are vs PHYSICAL alloc
    (free = physical − used); Total Free is vs the autoextend-aware Alloc max. Massages
    `database.fetch_space` into the contract."""
    t = _target(db)
    if ORACLE_CC_USE_DUMMY:
        return space_dummy(t)
    try:
        rows = [
            {"tablespace": r["tablespace_name"], "total_alloc_gb": r["total_alloc_gb"],
             "total_phys_gb": r["total_phys_gb"], "used_gb": r["used_gb"], "free_gb": r["free_gb"],
             "total_free_gb": r["total_free_gb"], "used_pct": r["used_pct"]}
            for r in database.fetch_space(request.app.state.db_configs.get(db))
        ]
        return _space_payload(rows)
    except Exception:
        logger.exception("space failed for %s", db)
        raise HTTPException(status_code=500, detail="Internal server error")


def _sev_for(pct: float) -> str:
    return "crit" if pct >= CRIT_PCT else "warn" if pct >= WARN_PCT else "ok"


def _space_payload(rows: list[dict]) -> dict:
    """Shared column contract + gauge summary for Section 1. Each input row carries
    tablespace / total_alloc_gb / total_phys_gb / used_gb / free_gb / used_pct / datafiles.
    Used % (last column, a bar) is against PHYSICAL allocation = used / physical."""
    for r in rows:
        r["__sev"] = _sev_for(float(r.get("used_pct") or 0))   # hover tint; bar colours itself too
    total = round(sum(float(r.get("total_phys_gb") or 0) for r in rows), 2)   # physical capacity
    used = round(sum(float(r.get("used_gb") or 0) for r in rows), 2)
    free = round(total - used, 2)
    used_pct = round(used / total * 100, 1) if total else 0.0
    breached = sorted({r["tablespace"] for r in rows if float(r.get("used_pct") or 0) >= WARN_PCT})
    return {
        "status": "success",
        "columns": [
            {"key": "tablespace", "label": "Tablespace", "type": "mono"},
            {"key": "total_alloc_gb", "label": "Alloc max (GB)", "type": "num"},
            {"key": "total_phys_gb", "label": "Physical Alloc (GB)", "type": "num"},
            {"key": "total_free_gb", "label": "Total Free (GB)", "type": "num"},
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
def top_segments(request: Request, db: str) -> dict:
    """Top tables by segment bytes → their top-N partitions (tree), with a stale-stats chip.
    Massages `database.fetch_top_segments`."""
    t = _target(db)
    if ORACLE_CC_USE_DUMMY:
        return top_segments_dummy(t)
    try:
        raw = database.fetch_top_segments(request.app.state.db_configs.get(db), OCC_SCHEMA, 10, TOP_CHILD_LIMIT)
        tables = raw.get("tables") or []
        if not tables:
            return {"status": "success", "columns": _TOP_COLS, "rows": []}
        stats = {(s["table_name"], s.get("partition_name")): s for s in raw.get("stats") or []}
        parts_by_table: dict[str, list[dict]] = {}
        for p in raw.get("partitions") or []:
            parts_by_table.setdefault(p["segment_name"], []).append(p)

        def cells(table: str, part: str | None = None) -> dict:
            s = stats.get((table, part), {})
            fresh = (s.get("stale_stats") or "NO") != "YES"
            return {"num_rows": s.get("num_rows"), "last_analyzed": s.get("last_analyzed") or "—", **_stats_cell(fresh)}

        rows = []
        for tb in tables:
            seg = tb["segment_name"]
            row = {"object": seg, "kind": "Table", "size_gb": tb["size_gb"], **cells(seg)}
            children = [
                {"object": p["partition_name"], "kind": "Partition", "size_gb": p["size_gb"], **cells(seg, p["partition_name"])}
                for p in parts_by_table.get(seg, [])
            ]
            if children:
                row["__children"] = children
            rows.append(row)
        return {"status": "success", "columns": _TOP_COLS, "rows": rows}
    except Exception:
        logger.exception("top_segments failed for %s", db)
        raise HTTPException(status_code=500, detail="Internal server error")


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


# =============================================================================
# Section 3 — Top index storage consumers
# =============================================================================

_IDX_COLS = [
    {"key": "index_name", "label": "Index", "type": "mono"},
    {"key": "table_name", "label": "Table", "type": "mono"},
    {"key": "kind", "label": "Type", "type": "text"},
    {"key": "size_gb", "label": "Size (GB)", "type": "num"},
]


@router.post("/{db}/top_indexes")
def top_indexes(request: Request, db: str) -> dict:
    """Top indexes by allocated bytes → their top-N partitions (tree). Massages
    `database.fetch_top_indexes`."""
    t = _target(db)
    if ORACLE_CC_USE_DUMMY:
        return top_indexes_dummy(t)
    try:
        raw = database.fetch_top_indexes(request.app.state.db_configs.get(db), OCC_SCHEMA, 5, TOP_CHILD_LIMIT)
        idx = raw.get("indexes") or []
        if not idx:
            return {"status": "success", "columns": _IDX_COLS, "rows": []}
        parts_by_index: dict[str, list[dict]] = {}
        for p in raw.get("partitions") or []:
            parts_by_index.setdefault(p["segment_name"], []).append(p)

        rows = []
        for ix in idx:
            name = ix["index_name"]
            row = {"index_name": name, "table_name": ix["table_name"], "kind": ix["kind"], "size_gb": ix["size_gb"]}
            children = [
                {"index_name": p["partition_name"], "table_name": ix["table_name"],
                 "kind": "Index partition", "size_gb": p["size_gb"]}
                for p in parts_by_index.get(name, [])
            ]
            if children:
                row["__children"] = children
            rows.append(row)
        return {"status": "success", "columns": _IDX_COLS, "rows": rows}
    except Exception:
        logger.exception("top_indexes failed for %s", db)
        raise HTTPException(status_code=500, detail="Internal server error")


# =============================================================================
# Section 4 — Index Health & Stability
# =============================================================================

_IDXH_COLS = [
    {"key": "index_name", "label": "Index", "type": "mono"},
    {"key": "table_name", "label": "Table", "type": "mono"},
    {"key": "state", "label": "State", "type": "chip"},
    {"key": "detail", "label": "Detail", "type": "text"},
    {"key": "last_analyzed", "label": "Last analyzed", "type": "text"},
]


@router.post("/{db}/index_health")
def index_health(request: Request, db: str) -> dict:
    """UNUSABLE / INVISIBLE / STALE-STATS indexes, with a state chip. Massages
    `database.fetch_index_health`."""
    t = _target(db)
    if ORACLE_CC_USE_DUMMY:
        return index_health_dummy(t)
    sev = {"UNUSABLE": "crit", "INVISIBLE": "warn", "STALE STATS": "warn"}
    detail = {
        "UNUSABLE": "Offline — not maintained; rebuild required",
        "INVISIBLE": "Maintained but hidden from the optimizer",
        "STALE STATS": "Stats out of date; gather to refresh",
    }
    try:
        rows = []
        for r in database.fetch_index_health(request.app.state.db_configs.get(db), OCC_SCHEMA):
            st = r["state"]
            s = sev.get(st, "warn")
            rows.append({
                "index_name": r["index_name"], "table_name": r["table_name"],
                "state": st, "state__sev": s, "detail": detail.get(st, ""),
                "last_analyzed": r.get("last_analyzed") or "—", "__sev": s,
            })
        return {"status": "success", "columns": _IDXH_COLS, "rows": rows}
    except Exception:
        logger.exception("index_health failed for %s", db)
        raise HTTPException(status_code=500, detail="Internal server error")


# =============================================================================
# Section 5 — Critical locks (currently held / blocking) + kill-session
# =============================================================================

@router.post("/{db}/locks")
def locks(request: Request, db: str) -> dict:
    """Enqueue locks that matter to a DBA: TX row + TM DML locks, flagged BLOCKING/WAITING/HELD;
    each row killable (admin, UI-gated). Massages `database.fetch_locks` into the lock-row contract."""
    t = _target(db)
    if ORACLE_CC_USE_DUMMY:
        return locks_dummy(t)
    try:
        rows = [
            _lock_row(
                locked_object=r.get("locked_object") or "—", object_type=r.get("object_type") or "—",
                lock_type=r.get("lock_type") or "—", lock_mode=r.get("lock_mode") or "—",
                sid=int(r["sid"]), serial=int(r["serial_no"]),
                username=r.get("username") or "—", machine=r.get("machine") or "—",
                held_for=_fmt_dur(_dur_secs(r)), state=r.get("session_state") or "HELD",
                sql_id=r.get("sql_id") or "—",
                firstname=r.get("firstname"), surname=r.get("surname"),
                sql_text=r.get("sql_text"), bind_values=r.get("bind_values"),
            )
            for r in database.fetch_locks(request.app.state.db_configs.get(db))
        ]
        return _locks_payload(rows)
    except Exception:
        logger.exception("locks failed for %s", db)
        raise HTTPException(status_code=500, detail="Internal server error")


_LOCK_COLS = [
    {"key": "locked_object", "label": "Locked object", "type": "mono"},
    {"key": "object_type", "label": "Object type", "type": "text"},
    {"key": "lock_type", "label": "Lock", "type": "text"},
    {"key": "lock_mode", "label": "Mode held", "type": "text"},
    {"key": "sid_serial", "label": "SID,Serial#", "type": "mono"},
    {"key": "username", "label": "User", "type": "mono"},
    {"key": "firstname", "label": "First name", "type": "text"},
    {"key": "surname", "label": "Surname", "type": "text"},
    {"key": "machine", "label": "Machine", "type": "text"},
    {"key": "held_for", "label": "Held for", "type": "text"},
    {"key": "state", "label": "State", "type": "chip"},
    {"key": "sql_id", "label": "SQL_ID", "type": "mono"},
    {"key": "sql_text", "label": "SQL text", "type": "clob"},
]

# State → row/chip severity. BLOCKING is the one to act on.
_LOCK_SEV = {"BLOCKING": "crit", "WAITING": "warn", "HELD": "ok"}


def _append_binds(sql_text: str | None, bind_values: str | None) -> str:
    """SQL text with the captured bind values appended (Oracle stores placeholders `:1` in the SQL
    and the actual values separately in v$sql_bind_capture — so we show both, not a fake inline
    substitution). Shown in the CLOB popup."""
    s = (sql_text or "").rstrip()
    bv = (bind_values or "").strip()
    if bv:
        s = f"{s}\n\n-- Bind variables (captured):\n{bind_values.rstrip()}" if s else bind_values.rstrip()
    return s or "—"


def _lock_row(*, locked_object: str, object_type: str, lock_type: str, lock_mode: str,
              sid: int, serial: int, username: str, machine: str, held_for: str, state: str,
              sql_id: str, firstname: str | None = None, surname: str | None = None,
              sql_text: str | None = None, bind_values: str | None = None) -> dict:
    """One lock row (keyword-only). `sid`/`serial` are carried as data (not columns) so the kill
    action has what it needs; `__actions:['kill']` shows the Kill button. `sql_text` gets the
    captured bind values appended (see `_append_binds`)."""
    sev = _LOCK_SEV.get(state, "ok")
    # `__sev` drives the hover-reveal tint (BLOCKING → red, WAITING → amber on hover); rows
    # stay white at rest — the STATE chip carries the meaning.
    return {
        "locked_object": locked_object, "object_type": object_type or "—",
        "lock_type": lock_type, "lock_mode": lock_mode,
        "sid_serial": f"{sid},{serial}", "username": username, "machine": machine,
        "held_for": held_for, "state": state, "state__sev": sev, "sql_id": sql_id,
        "firstname": firstname or "—", "surname": surname or "—",
        "sql_text": _append_binds(sql_text, bind_values),
        "__sev": sev, "__actions": ["kill"], "sid": sid, "serial": serial,
    }


def _locks_payload(rows: list[dict]) -> dict:
    blocking = sum(1 for r in rows if r.get("state") == "BLOCKING")
    waiting = sum(1 for r in rows if r.get("state") == "WAITING")
    return {"status": "success", "columns": _LOCK_COLS, "rows": rows,
            "summary": {"blocking": blocking, "waiting": waiting, "total": len(rows)}}


def _dur_secs(r: dict) -> int | None:
    """Held duration in seconds — prefer the raw `held_secs` (l.ctime); fall back to parsing the
    `held_duration` INTERVAL (oracledb returns it as a timedelta)."""
    v = r.get("held_secs")
    if v is not None:
        try:
            return int(v)
        except (TypeError, ValueError):
            pass
    d = r.get("held_duration")
    if hasattr(d, "total_seconds"):
        return int(d.total_seconds())
    return None


class KillRequest(BaseModel):
    sid: int
    serial: int
    immediate: bool = True


@router.post("/{db}/kill-session")
def kill_session(db: str, body: KillRequest) -> dict:
    """Kill one session (Locks / Blocking / Sessions). Destructive — UI-gated behind admin + a
    confirm. The real kill needs a SEPARATE privileged, audited connection (ALTER SYSTEM), which
    the read-only monitor deliberately lacks — wire it here; never widen the monitor grant."""
    t = _target(db)
    if ORACLE_CC_USE_DUMMY:
        return kill_session_dummy(t, body)
    # ALTER SYSTEM KILL SESSION takes no binds; sid/serial are Pydantic-validated ints (injection-safe).
    stmt = f"ALTER SYSTEM KILL SESSION '{int(body.sid)},{int(body.serial)}'" + (" IMMEDIATE" if body.immediate else "")
    _ = stmt
    # Wire a SEPARATE privileged connection here, then run `stmt` on it. Handle the
    # "already gone" case as a SUCCESS no-op (the goal is met — the session is not there) so the UI
    # never shows an error for a session that vanished between listing and killing:
    #
    #   import oracledb
    #   try:
    #       priv = get_privileged_connection(t)        # ALTER SYSTEM privilege; NOT the read-only monitor
    #       with priv.cursor() as cur:
    #           cur.execute(stmt)
    #       return {"status": "success", "success": True,
    #               "message": f"Session {body.sid},{body.serial} has been marked for kill."}
    #   except oracledb.DatabaseError as exc:
    #       (err,) = exc.args
    #       # ORA-00030 (user session ID does not exist) / ORA-00020 (no session) → already gone.
    #       if getattr(err, "code", None) in (30, 20):
    #           return {"status": "success", "success": True, "gone": True,
    #                   "message": f"Session {body.sid},{body.serial} had already ended — nothing to kill."}
    #       raise
    raise RuntimeError("kill_session: wire a privileged connection (ALTER SYSTEM) — not the read-only monitor")


# =============================================================================
# Section 6 — Blocking sessions (blocker → waiter tree)
# =============================================================================

_BLK_COLS = [
    {"key": "blocker", "label": "Blocker (SID,Serial#)", "type": "mono"},
    {"key": "blocker_user", "label": "Blocker user", "type": "mono"},
    {"key": "blocker_name", "label": "Blocker name", "type": "text"},
    {"key": "blocker_machine", "label": "Blocker machine", "type": "text"},
    {"key": "object_being_held", "label": "Object held", "type": "mono"},
    {"key": "blocker_object_type", "label": "Object type", "type": "text"},
    {"key": "blocker_sql_id", "label": "Blocker SQL_ID", "type": "mono"},
    {"key": "blocker_sql_text", "label": "Blocker SQL text", "type": "clob"},
    {"key": "victim", "label": "Victim (SID,Serial#)", "type": "mono"},
    {"key": "victim_user", "label": "Victim user", "type": "mono"},
    {"key": "victim_name", "label": "Victim name", "type": "text"},
    {"key": "wait_event", "label": "Wait event", "type": "text"},
    {"key": "wait_time", "label": "Waiting", "type": "text"},
    {"key": "victim_sql_id", "label": "Victim SQL_ID", "type": "mono"},
    {"key": "victim_sql_text", "label": "Victim SQL text", "type": "clob"},
]


def _blk_row(r: dict) -> dict:
    """One blocker↔victim row. The Kill action targets the BLOCKER (killing it frees the victim),
    so `sid`/`serial` carry the blocker's; the whole row hover-tints red (it's always critical)."""
    bsid, bser = int(r["blocker_sid"]), int(r["blocker_serial"])
    return {
        "blocker": f"{bsid},{bser}", "blocker_user": r.get("blocker_user") or "—",
        "blocker_name": r.get("blocker_name") or "—", "blocker_machine": r.get("blocker_machine") or "—",
        "object_being_held": r.get("object_being_held") or "—",
        "blocker_object_type": r.get("blocker_object_type") or "—",
        "blocker_sql_id": r.get("blocker_sql_id") or "—",
        "blocker_sql_text": _append_binds(r.get("blocker_sql_text"), r.get("blocker_bind_values")),
        "victim": f"{int(r['victim_sid'])},{int(r['victim_serial'])}", "victim_user": r.get("victim_user") or "—",
        "victim_name": r.get("victim_name") or "—", "wait_event": r.get("wait_event") or "—",
        "wait_time": _fmt_dur(r.get("wait_time_seconds")), "victim_sql_id": r.get("victim_sql_id") or "—",
        "victim_sql_text": _append_binds(r.get("victim_sql_text"), r.get("victim_bind_values")),
        "__sev": "crit", "__actions": ["kill"], "sid": bsid, "serial": bser,
    }


def _blocking_payload(rows: list[dict]) -> dict:
    blockers = len({r["blocker"] for r in rows})
    return {"status": "success", "columns": _BLK_COLS, "rows": rows,
            "summary": {"chains": blockers, "waiters": len(rows)}}


@router.post("/{db}/blocking")
def blocking(request: Request, db: str) -> dict:
    """Flat blocker↔victim pairs (one row per blocking relationship); kill targets the blocker.
    Massages `database.fetch_blocking`."""
    t = _target(db)
    if ORACLE_CC_USE_DUMMY:
        return blocking_dummy(t)
    try:
        return _blocking_payload([_blk_row(r) for r in database.fetch_blocking(request.app.state.db_configs.get(db))])
    except Exception:
        logger.exception("blocking failed for %s", db)
        raise HTTPException(status_code=500, detail="Internal server error")


# =============================================================================
# Section 7 — Sessions & performance deep-dive (list + SID drilldown + kill)
# =============================================================================

# --- Temp tablespace usage (Section 6b) --------------------------------------
TEMP_WARN_MB = env_int("ORACLE_CC_TEMP_WARN_MB", 1024)   # amber tint at ≥ 1 GB of temp held
TEMP_CRIT_MB = env_int("ORACLE_CC_TEMP_CRIT_MB", 5120)   # red tint at ≥ 5 GB

_TEMP_COLS = [
    {"key": "sid_serial", "label": "SID,Serial#", "type": "mono"},
    {"key": "status", "label": "Status", "type": "chip"},
    {"key": "username", "label": "User", "type": "mono"},
    {"key": "osuser", "label": "OS user", "type": "text"},
    {"key": "firstname", "label": "First name", "type": "text"},
    {"key": "surname", "label": "Surname", "type": "text"},
    {"key": "machine", "label": "Machine", "type": "text"},
    {"key": "program", "label": "Program", "type": "text"},
    {"key": "sql_id", "label": "SQL_ID", "type": "mono"},
    {"key": "tablespace", "label": "Temp TS", "type": "text"},
    {"key": "mb_used", "label": "Temp (MB)", "type": "num", "warn": TEMP_WARN_MB, "crit": TEMP_CRIT_MB},
    {"key": "running_for", "label": "Running for", "type": "text"},
    {"key": "segments", "label": "Segments", "type": "num"},
]


def _temp_row(r: dict) -> dict:
    """One temp-usage row → the contract. `mb_used` drives the row severity tint; each row is
    killable (`__actions:['kill']`), and `sid`/`serial` ride along for the kill call. firstname/
    surname are `—` when ols_users wasn't available."""
    sid, serial = int(r["sid"]), int(r["serial"])
    mb = int(r.get("mb_used") or 0)
    sev = "crit" if mb >= TEMP_CRIT_MB else "warn" if mb >= TEMP_WARN_MB else "ok"
    status = (r.get("status") or "—")
    return {
        "sid_serial": f"{sid},{serial}",
        "status": status, "status__sev": "warn" if status == "INACTIVE" else "ok",
        "username": r.get("username") or "—", "osuser": r.get("osuser") or "—",
        "firstname": r.get("firstname") or "—", "surname": r.get("surname") or "—",
        "machine": r.get("machine") or "—", "program": r.get("program") or "—",
        "sql_id": r.get("sql_id") or "—", "tablespace": r.get("tablespace") or "—",
        "mb_used": mb, "running_for": _fmt_dur(r.get("secs")),
        "segments": int(r.get("segments") or 0),
        "__sev": sev if sev != "ok" else "", "__actions": ["kill"], "sid": sid, "serial": serial,
    }


@router.post("/{db}/temp-usage")
def temp_usage(request: Request, db: str) -> dict:
    """Sessions holding TEMP/sort space (V$TEMPSEG_USAGE), largest first — the ones to kill when
    temp is exhausted. Each row killable (admin, UI-gated). `ols_users` is optional (see
    `database.fetch_temp_usage`). `summary` totals the temp held + session count."""
    t = _target(db)
    if ORACLE_CC_USE_DUMMY:
        return temp_usage_dummy(t)
    try:
        rows = [_temp_row(r) for r in database.fetch_temp_usage(request.app.state.db_configs.get(db))]
        total_mb = sum(int(r.get("mb_used") or 0) for r in rows)
        return {"status": "success", "columns": _TEMP_COLS, "rows": rows,
                "summary": {"sessions": len(rows), "total_mb": total_mb}}
    except Exception:
        logger.exception("temp-usage failed for %s", db)
        raise HTTPException(status_code=500, detail="Internal server error")


class SessionsQuery(BaseModel):
    # active | inactive | killed | all  (UI default = active)
    status: str = "active"


@router.post("/{db}/sessions")
def sessions(request: Request, db: str, body: SessionsQuery | None = None) -> dict:
    """Session inventory filtered by state; `summary` carries the full per-state counts (for the
    Active/Inactive/Killed/All tab badges) regardless of the filter. Massages
    `database.fetch_sessions`."""
    t = _target(db)
    status = (body.status if body else "active").lower()
    if ORACLE_CC_USE_DUMMY:
        return sessions_dummy(t, status)
    try:
        raw = database.fetch_sessions(request.app.state.db_configs.get(db), status)
        rows = [
            _sess_row(int(r["sid"]), int(r["serial"]), r["username"] or "—", (r["status"] or "").upper(),
                      r["machine"] or "—", r["program"] or "—", r.get("sql_id"),
                      r.get("event") or "ON CPU", _fmt_dur(r.get("secs")), int(r.get("secs") or 0))
            for r in raw.get("rows") or []
        ]
        counts = {"active": 0, "inactive": 0, "killed": 0, "total": 0}
        for c in raw.get("counts") or []:
            n = int(c["c"] or 0)
            counts["total"] += n
            if c["st"] in counts:
                counts[c["st"]] = n
        return {"status": "success", "columns": _SESS_COLS, "rows": rows, "summary": counts}
    except Exception:
        logger.exception("sessions failed for %s", db)
        raise HTTPException(status_code=500, detail="Internal server error")


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


class SessionDetailQuery(BaseModel):
    sid: int
    serial: int
    sql_id: str | None = None
    # When set, return just that one panel (per-tab refresh); omit for the full deep-dive.
    panel: str | None = None


@router.post("/{db}/session-detail")
def session_detail(request: Request, db: str, body: SessionDetailQuery) -> dict:
    """The SID deep-dive: a self-describing list of panels (plan / waits / binds / ASH / SQL
    Monitor / stats / locks / AWR, + rollback for KILLED). Massages `database.fetch_session_detail`
    (facts + raw per-panel data). The data layer runs each panel's SQL in its own try/except — one
    bad query degrades only that panel to `available:false` — and honours `body.panel` for per-tab
    refresh. Panels are `kind:'text'` (monospace), `kind:'table'`, or `kind:'rollback'`."""
    t = _target(db)
    if ORACLE_CC_USE_DUMMY:
        return session_detail_dummy(t, body)
    q = body
    sid, serial = int(q.sid), int(q.serial)
    cfg = request.app.state.db_configs.get(db)
    try:
        raw = database.fetch_session_detail(cfg, sid, serial, q.sql_id, OCC_SCHEMA, q.panel)
    except Exception:
        logger.exception("session-detail failed for %s (%s,%s)", db, sid, serial)
        raise HTTPException(status_code=500, detail="Internal server error")
    errors = raw.get("errors") or {}
    f = raw.get("facts") or {}
    # The session vanished between listing it and drilling in (it closed immediately) → there is no
    # row in v$session, so there is nothing to deep-dive. Return a clean "gone" response (HTTP 200)
    # so the UI shows a friendly "no longer active" message instead of the generic load error.
    if not f:
        return {
            "status": "success", "available": False, "reason": "gone",
            "session": {"sid": sid, "serial": serial, "session": f"{sid},{serial}",
                        "sql_id": q.sql_id or "—"},
            "panels": [],
        }
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

    def got(key: str) -> bool:
        """The data layer fetched this panel and produced usable data (not None, not errored)."""
        return key in raw and raw[key] is not None and key not in errors

    def emit(key: str) -> bool:
        """Include this panel in the response (all panels, or just the one asked for)."""
        return q.panel is None or q.panel == key

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
        if not got("plan"):
            return _panel_text("plan", "Execution Plan", "", available=False)
        text = "\n".join(str(x or "") for x in (raw.get("plan") or []))
        panel = _panel_text("plan", "Execution Plan", text or "(no plan in the cursor cache for this SQL_ID)")
        # Attach a generated Diagnosis (misestimate / bottleneck / I/O + cautious index hint) from
        # the same V$SQL_PLAN_STATISTICS_ALL engine SQL Intelligence uses. Best-effort — a failure
        # here just leaves the raw plan without the card.
        if sql_id:
            try:
                analysis = _sqli_plan_analysis_payload(database.fetch_sql_plan_analysis(cfg, sql_id))
                diag = analysis.get("diagnosis") or {}
                if diag.get("findings") or diag.get("hint"):
                    panel["diagnosis"] = diag
                if (analysis.get("plan") or {}).get("rows"):
                    panel["analysis"] = {"summary": analysis["summary"], "has_actual": analysis["has_actual"],
                                         "plan": analysis["plan"], "stats": analysis["stats"]}
            except Exception as exc:
                logger.warning("session-detail plan analysis failed (%s,%s): %s", sid, serial, exc)
        return panel

    def waits_panel():
        if not got("waits"):
            return _panel_table("waits", "Wait Events", waits_cols, [], available=False)
        rows = []
        for r in raw["waits"]:
            wc = r.get("wait_class") or "—"
            row = {"event": r["event"], "wait_class": wc, "wait_class__sev": _WAIT_SEV.get(wc, "muted"),
                   "time_waited_s": round((r.get("time_waited") or 0) / 100, 1),
                   "waits": int(r.get("total_waits") or 0), "avg_ms": round((r.get("average_wait") or 0) * 10, 1)}
            if _WAIT_SEV.get(wc) in ("crit", "warn"):
                row["__sev"] = _WAIT_SEV[wc]
            rows.append(row)
        return _panel_table("waits", "Wait Events", waits_cols, rows)

    def binds_panel():
        if not got("binds"):
            return _panel_table("binds", "Bind Variables", binds_cols, [], available=False)
        rows = [{"name": r.get("name"), "pos": r.get("position"), "datatype": r.get("datatype_string") or "",
                 "value": str(r.get("value_string") or "")} for r in raw["binds"]]
        return _panel_table("binds", "Bind Variables", binds_cols, rows)

    def ash_panel():
        if not got("ash"):
            return _panel_table("ash", "Active Session History", ash_cols, [], available=False)
        rows = [{"sample_time": r.get("sample_time"), "session_state": r.get("session_state"),
                 "session_state__sev": "ok" if r.get("session_state") == "ON CPU" else "warn",
                 "event": r.get("event") or "—", "wait_class": r.get("wait_class") or "CPU", "sql_id": r.get("sql_id") or "—"}
                for r in raw["ash"]]
        return _panel_table("ash", "Active Session History", ash_cols, rows)

    def monitor_panel():
        if not got("monitor"):
            return _panel_text("monitor", "SQL Monitor", "", available=False)
        m = raw["monitor"] or {}
        report = m.get("report") or "(no active SQL Monitor report)"
        panel = _panel_text("monitor", "SQL Monitor", report)
        ov = m.get("overview") or {}
        if ov:
            panel["overview"] = _monitor_tiles(ov)
        return panel

    def stats_panel():
        if not got("stats"):
            return _panel_table("stats", "Object Statistics", stats_cols, [], available=False)
        rows = [{"object": r["table_name"], "num_rows": r.get("num_rows"), "last_analyzed": r.get("last_analyzed") or "—",
                 "state": "STALE" if r.get("stale_stats") == "YES" else "FRESH",
                 "state__sev": "warn" if r.get("stale_stats") == "YES" else "ok"} for r in raw["stats"]]
        return _panel_table("stats", "Object Statistics", stats_cols, rows)

    def locks_panel():
        if not got("locks"):
            return _panel_table("locks", "Locks Held", locks_cols, [], available=False)
        rows = []
        for r in raw["locks"]:
            st = r["state"]
            rows.append({"type": r["type"], "mode_held": r["mode_held"], "object": r.get("object") or "—",
                         "state": st, "state__sev": "crit" if st == "BLOCKING" else "ok"})
        return _panel_table("locks", "Locks Held", locks_cols, rows)

    def awr_panel():
        if not got("awr"):
            return _panel_table("awr", "AWR (DBA_HIST)", awr_cols, [], available=False)
        rows = [{"snap": r.get("snap"), "elapsed_s": round((r.get("elapsed_time") or 0) / 1e6, 1),
                 "cpu_s": round((r.get("cpu_time") or 0) / 1e6, 1), "buffer_gets": int(r.get("buffer_gets") or 0),
                 "executions": int(r.get("executions_delta") or 0)} for r in raw["awr"]]
        return _panel_table("awr", "AWR (DBA_HIST)", awr_cols, rows)

    def resource_panel():
        try:
            res = database.fetch_session_resource(cfg, sid, serial)
        except Exception as exc:
            logger.warning("session-detail resource failed (%s,%s): %s", sid, serial, exc)
            return {"key": "resource", "label": "Resource Profile", "kind": "resource", "available": False}
        act = res.get("activity") or []
        total = sum(int(r.get("samples") or 0) for r in act) or 1
        act_sev = {"CPU": "ok", "User I/O": "warn", "System I/O": "warn", "Concurrency": "crit",
                   "Application": "crit", "Cluster": "warn", "Commit": "ok", "Configuration": "warn",
                   "Scheduler": "warn", "Other": "muted"}
        act_cols = [{"key": "bucket", "label": "Resource", "type": "chip"},
                    {"key": "seconds", "label": "~Seconds", "type": "num"},
                    {"key": "pct", "label": "Share", "type": "pct", "warn": 40, "crit": 70}]
        act_rows = [{"bucket": r.get("bucket"), "bucket__sev": act_sev.get(r.get("bucket"), "muted"),
                     "seconds": int(r.get("samples") or 0),
                     "pct": round(int(r.get("samples") or 0) / total * 100, 1)} for r in act]
        wa_cols = [{"key": "operation", "label": "Work area", "type": "mono"},
                   {"key": "mem_mb", "label": "Mem (MB)", "type": "num"},
                   {"key": "max_mb", "label": "Max (MB)", "type": "num"},
                   {"key": "passes", "label": "Passes", "type": "num"},
                   {"key": "temp_mb", "label": "Temp (MB)", "type": "num"}]
        wa_rows = [{"operation": r.get("operation"), "mem_mb": r.get("mem_mb"), "max_mb": r.get("max_mb"),
                    "passes": int(r.get("passes") or 0), "temp_mb": r.get("temp_mb"),
                    "__sev": ("warn" if int(r.get("passes") or 0) >= 1 else "")} for r in res.get("workareas") or []]
        pga = res.get("pga") or {}
        resource = {
            "pga_used_mb": pga.get("pga_used_mb"), "pga_alloc_mb": pga.get("pga_alloc_mb"),
            "pga_max_mb": pga.get("pga_max_mb"), "temp_mb": res.get("temp_mb"),
            "activity": {"status": "success", "columns": act_cols, "rows": act_rows},
            "workareas": {"status": "success", "columns": wa_cols, "rows": wa_rows},
        }
        return {"key": "resource", "label": "Resource Profile", "kind": "resource", "available": True, "resource": resource}

    panels = []
    if status == "KILLED" and emit("rollback"):
        panels.append(_panel_rollback(raw.get("rollback_pct")))
    builders = [("plan", plan_panel), ("waits", waits_panel), ("binds", binds_panel),
                ("ash", ash_panel), ("resource", resource_panel), ("monitor", monitor_panel),
                ("stats", stats_panel), ("locks", locks_panel), ("awr", awr_panel)]
    panels += [build() for key, build in builders if emit(key)]
    return {"status": "success", "session": session, "panels": panels}


def _panel_text(key: str, label: str, text: str, *, requires: str | None = None, available: bool = True) -> dict:
    p = {"key": key, "label": label, "kind": "text", "available": available}
    if available:
        p["text"] = text
    if requires:
        p["requires"] = requires
    return p


def _monitor_tiles(ov: dict) -> list:
    """Shape a SQL Monitor overview row (from database.fetch_session_monitor) into label/value tiles
    for the deep-dive monitor panel — an at-a-glance header above the full text report."""
    def num(v):
        try:
            return f"{int(v):,}"
        except (TypeError, ValueError):
            return "—"
    def secs(v):
        return f"{v}s" if v not in (None, "") else "—"
    return [
        {"label": "Status", "value": str(ov.get("status") or "—")},
        {"label": "SQL_ID", "value": str(ov.get("sql_id") or "—")},
        {"label": "Plan hash", "value": str(ov.get("sql_plan_hash_value") or "—")},
        {"label": "Elapsed", "value": secs(ov.get("elapsed_s"))},
        {"label": "CPU", "value": secs(ov.get("cpu_s"))},
        {"label": "Buffer gets", "value": num(ov.get("buffer_gets"))},
        {"label": "Disk reads", "value": num(ov.get("disk_reads"))},
        {"label": "Started", "value": str(ov.get("started") or "—")},
        {"label": "Last refresh", "value": str(ov.get("last_refresh") or "—")},
    ]


def _panel_table(key: str, label: str, columns: list, rows: list, *, requires: str | None = None, available: bool = True) -> dict:
    p = {"key": key, "label": label, "kind": "table", "available": available}
    if available:
        p["table"] = {"status": "success", "columns": columns, "rows": rows}
    if requires:
        p["requires"] = requires
    return p


def _panel_rollback(rb: dict | None = None) -> dict:
    """Rollback Monitor for a killed session, from the REAL `database.fetch_session_rollback` dict
    (V$TRANSACTION undo still held + V$SESSION_LONGOPS progress/elapsed/remaining). Blocks show
    done/total/left; records show what's still held (V$TRANSACTION gives remaining, not a total)."""
    rb = rb or {}
    pct = max(0, min(100, int(rb.get("percent") or 0)))
    is_active = rb.get("is_active", True)
    remaining_s = rb.get("time_remaining_seconds")
    blocks_left = rb.get("undo_blocks_left")
    if blocks_left is None:
        blocks_left = rb.get("undo_blocks_remaining") or 0
    return {
        "key": "rollback", "label": "Rollback Monitor", "kind": "rollback", "available": True,
        "rollback": {
            "state": "COMPLETE" if (pct >= 100 or not is_active) else "ROLLING BACK",
            "percent": pct,
            "undo_blocks_total": int(rb.get("undo_blocks_total") or 0),
            "undo_blocks_done": int(rb.get("undo_blocks_done") or 0),
            "undo_blocks_left": int(blocks_left or 0),
            "undo_records_remaining": int(rb.get("undo_records_remaining") or 0),
            "elapsed": _fmt_dur(rb.get("elapsed_seconds")),
            "est_remaining": _fmt_dur(remaining_s) if remaining_s else "—",
            "note": "PMON is rolling back the killed transaction's uncommitted changes. "
                    "Don't restart the application on this instance until it completes.",
        },
    }


# =============================================================================
# Section 8 — SQL Intelligence (investigate a SQL_ID after the session is gone)
# =============================================================================
#
# Anchored on a sql_id (the only mandatory input) so a completed session can still be
# investigated. Everything historical reads AWR/ASH (DBA_HIST_*) and is HARD-CAPPED to the
# last SQLI_HISTORY_DAYS days. The centrepiece is plan instability: "same SQL, different plan
# tomorrow" shows up as a plan_hash_value change with an elapsed/exec jump.
#
# Fix policy: the recommended plan + copy-ready SQL is returned to EVERY user (read-only). The
# in-app "apply" is admin-only AND behind SQLI_ALLOW_APPLY, and (like kill-session) must run on
# a separate privileged/audited connection — never the read-only monitor.

_WAIT_CLASS_SEV = {"Application": "crit", "Concurrency": "crit", "User I/O": "warn",
                   "System I/O": "warn", "Cluster": "warn", "Commit": "ok", "CPU": "ok",
                   "Scheduler": "warn", "Configuration": "warn", "Idle": "muted"}


class SqlFinderQuery(BaseModel):
    q: str | None = None          # optional text/sql_id/module filter
    order: str = "elapsed"        # elapsed | execs | reads | last


class PhvBody(BaseModel):
    plan_hash_value: int


class SqlFixApply(BaseModel):
    sql_id: str
    plan_hash_value: int
    method: str = "baseline"      # baseline | profile


_SQLI_FINDER_COLS = [
    {"key": "sql_id", "label": "SQL_ID", "type": "mono"},
    {"key": "sql_text", "label": "SQL text", "type": "clob"},
    {"key": "module", "label": "Module", "type": "text"},
    {"key": "plans", "label": "Plans", "type": "num"},
    {"key": "execs", "label": "Execs", "type": "num"},
    {"key": "elapsed_per_exec_s", "label": "Elapsed/exec (s)", "type": "num", "warn": 1, "crit": 5},
    {"key": "last_active", "label": "Last active", "type": "text"},
    {"key": "flip", "label": "Plans", "type": "chip"},
]
_SQLI_PLANS_COLS = [
    {"key": "plan_hash_value", "label": "Plan hash", "type": "mono"},
    {"key": "source", "label": "Source", "type": "text"},
    {"key": "first_seen", "label": "First seen", "type": "text"},
    {"key": "last_seen", "label": "Last seen", "type": "text"},
    {"key": "execs", "label": "Execs", "type": "num"},
    {"key": "elapsed_per_exec_s", "label": "Elapsed/exec (s)", "type": "num", "warn": 1, "crit": 5},
    {"key": "buffer_gets_per_exec", "label": "Gets/exec", "type": "num"},
    {"key": "status", "label": "Status", "type": "chip"},
]
_SQLI_PERF_COLS = [
    {"key": "snap", "label": "Snap window", "type": "text"},
    {"key": "plan_hash_value", "label": "Plan hash", "type": "mono"},
    {"key": "execs", "label": "Execs", "type": "num"},
    {"key": "elapsed_per_exec_s", "label": "Elapsed/exec (s)", "type": "num", "warn": 1, "crit": 5},
    {"key": "cpu_per_exec_s", "label": "CPU/exec (s)", "type": "num"},
    {"key": "buffer_gets_per_exec", "label": "Gets/exec", "type": "num"},
    {"key": "disk_reads_per_exec", "label": "Reads/exec", "type": "num"},
    {"key": "rows_per_exec", "label": "Rows/exec", "type": "num"},
]
_SQLI_ASH_COLS = [
    {"key": "event", "label": "Event", "type": "mono"},
    {"key": "wait_class", "label": "Wait class", "type": "chip"},
    {"key": "samples", "label": "Samples", "type": "num"},
    {"key": "pct", "label": "% of activity", "type": "pct"},
]
_SQLI_BINDS_COLS = [
    {"key": "captured", "label": "Captured", "type": "text"},
    {"key": "name", "label": "Bind", "type": "mono"},
    {"key": "position", "label": "Pos", "type": "num"},
    {"key": "datatype", "label": "Datatype", "type": "text"},
    {"key": "value", "label": "Value", "type": "mono"},
    {"key": "plan_hash_value", "label": "Plan hash", "type": "mono"},
]


def _sqli_analyse(aggs: list[dict]) -> dict:
    """From per-plan aggregates decide best plan, current plan, whether the plan flipped, and a
    plain-language verdict. Shared by real + dummy so the story is identical. Each agg needs:
    plan_hash_value, execs, elapsed_per_exec_s, last_seen_ts (sortable)."""
    usable = [p for p in aggs if (p.get("execs") or 0) > 0 and p.get("elapsed_per_exec_s") is not None]
    if not usable:
        return {"best_phv": None, "current_phv": None, "flip": False,
                "verdict": {"sev": "ok", "headline": "No execution history",
                            "detail": f"No AWR rows for this SQL_ID in the last {SQLI_HISTORY_DAYS} days."}}
    best = min(usable, key=lambda p: p["elapsed_per_exec_s"])
    current = max(usable, key=lambda p: p.get("last_seen_ts", 0))
    flip = len({p["plan_hash_value"] for p in usable}) > 1
    best_e = best["elapsed_per_exec_s"] or 0.0
    cur_e = current["elapsed_per_exec_s"] or 0.0
    ratio = (cur_e / best_e) if best_e else 1.0
    if flip and current["plan_hash_value"] != best["plan_hash_value"] and ratio >= 2:
        verdict = {"sev": "crit" if ratio >= 5 else "warn",
                   "headline": f"Plan regression — current plan is {ratio:.1f}× slower than the best seen",
                   "detail": (f"Best plan {best['plan_hash_value']} ran {best_e:.2f}s/exec; the current plan "
                              f"{current['plan_hash_value']} runs {cur_e:.2f}s/exec. Pinning the best plan "
                              f"stabilises it.")}
    elif flip:
        verdict = {"sev": "warn", "headline": "Multiple plans in use",
                   "detail": (f"{len({p['plan_hash_value'] for p in usable})} distinct plans in the last "
                              f"{SQLI_HISTORY_DAYS} days; currently running on the best (or near-best) plan.")}
    else:
        verdict = {"sev": "ok", "headline": "Stable single plan",
                   "detail": f"One plan in the last {SQLI_HISTORY_DAYS} days, steady at {best_e:.2f}s/exec."}
    return {"best_phv": best["plan_hash_value"], "current_phv": current["plan_hash_value"],
            "flip": flip, "verdict": verdict}


def _sqli_overview_payload(sql_id: str, sql_text: str, meta: dict, aggs: list[dict]) -> dict:
    a = _sqli_analyse(aggs)
    usable = [p for p in aggs if (p.get("execs") or 0) > 0]
    best_e = min((p["elapsed_per_exec_s"] for p in usable), default=0.0)
    cur = next((p for p in aggs if p["plan_hash_value"] == a["current_phv"]), None)
    cur_e = cur["elapsed_per_exec_s"] if cur else 0.0
    kpis = [
        {"label": "Distinct plans", "value": len({p["plan_hash_value"] for p in aggs}),
         "sev": "warn" if a["flip"] else "ok"},
        {"label": f"Executions · {SQLI_HISTORY_DAYS}d", "value": sum(p["execs"] for p in aggs)},
        {"label": "Best elapsed/exec", "value": f"{best_e:.2f}s", "sev": "ok"},
        {"label": "Current elapsed/exec", "value": f"{cur_e:.2f}s", "sev": a["verdict"]["sev"]},
    ]
    return {"status": "success",
            "identity": {"sql_id": sql_id, "sql_text": (sql_text or "").strip() or "(SQL text not in AWR)",
                         "schema": meta.get("schema") or "—", "module": meta.get("module") or "—",
                         "first_seen": meta.get("first_seen") or "—", "last_seen": meta.get("last_seen") or "—",
                         "executions": int(meta.get("execs") or sum(p["execs"] for p in aggs))},
            "verdict": a["verdict"], "best_phv": a["best_phv"], "current_phv": a["current_phv"], "kpis": kpis}


def _sqli_plans_payload(aggs: list[dict], mgmt: dict) -> dict:
    a = _sqli_analyse(aggs)
    baseline_phvs = set(mgmt.get("baseline_phvs") or [])
    rows = []
    for p in sorted(aggs, key=lambda x: x.get("last_seen_ts", 0), reverse=True):
        phv = p["plan_hash_value"]
        if phv == a["best_phv"]:
            status, sev = "BEST", "ok"
        elif a["flip"] and phv == a["current_phv"] and phv != a["best_phv"]:
            status, sev = "CURRENT ⚠", "crit"
        else:
            status, sev = "—", "muted"
        if phv in baseline_phvs:
            status = "BASELINE" if status == "—" else status + " · BASELINE"
        rows.append({"plan_hash_value": phv, "source": p.get("source", "AWR"),
                     "first_seen": p.get("first_seen") or "—", "last_seen": p.get("last_seen") or "—",
                     "execs": p["execs"], "elapsed_per_exec_s": p["elapsed_per_exec_s"],
                     "buffer_gets_per_exec": p.get("buffer_gets_per_exec", 0),
                     "status": status, "status__sev": sev,
                     "__phv": phv, "__best": phv == a["best_phv"]})
    return {"status": "success", "columns": _SQLI_PLANS_COLS, "rows": rows,
            "summary": {"best_phv": a["best_phv"], "current_phv": a["current_phv"], "flip": a["flip"]}}


def _sqli_timeline_payload(pts: list[dict], aggs: list[dict]) -> dict:
    a = _sqli_analyse(aggs)
    order: dict[int, int] = {}
    for p in pts:
        order.setdefault(p["plan_hash_value"], len(order))
    plans = [{"plan_hash_value": phv, "idx": i, "best": phv == a["best_phv"]} for phv, i in order.items()]
    flip = None
    for i in range(1, len(pts)):
        if pts[i]["plan_hash_value"] != pts[i - 1]["plan_hash_value"]:
            flip = {"label": pts[i]["label"], "from_phv": pts[i - 1]["plan_hash_value"],
                    "to_phv": pts[i]["plan_hash_value"]}
            break
    return {"status": "success", "points": pts, "plans": plans, "flip": flip,
            "verdict": a["verdict"], "best_phv": a["best_phv"], "current_phv": a["current_phv"]}


def _sqli_fix_scripts(sql_id: str, best_phv, days: int) -> list[dict]:
    """Copy-ready SQL shown to everyone. Version-specific — treat as a validated starting point."""
    return [
        {"key": "baseline",
         "label": f"Pin plan {best_phv} as a SQL Plan Baseline (from AWR)",
         "sql": (f"-- Load plan {best_phv} for {sql_id} from AWR as an ACCEPTED, FIXED baseline.\n"
                 f"-- Run as a privileged user; validate in non-prod first.\n"
                 f"DECLARE n PLS_INTEGER;\nBEGIN\n"
                 f"  n := DBMS_SPM.LOAD_PLANS_FROM_AWR(\n"
                 f"         begin_snap   => (SELECT MIN(snap_id) FROM dba_hist_snapshot\n"
                 f"                           WHERE begin_interval_time >= SYSTIMESTAMP - INTERVAL '{days}' DAY),\n"
                 f"         end_snap     => (SELECT MAX(snap_id) FROM dba_hist_snapshot),\n"
                 f"         basic_filter => q'[sql_id = '{sql_id}' AND plan_hash_value = {best_phv}]');\n"
                 f"  DBMS_OUTPUT.PUT_LINE('Plans loaded: '||n);\nEND;\n/")},
        {"key": "advisor",
         "label": "Run SQL Tuning Advisor (Tuning Pack) for recommendations",
         "sql": (f"-- Creates + runs a tuning task, then prints the report.\n"
                 f"DECLARE tname VARCHAR2(64);\nBEGIN\n"
                 f"  tname := DBMS_SQLTUNE.CREATE_TUNING_TASK(sql_id => '{sql_id}', task_name => 'sqli_{sql_id}');\n"
                 f"  DBMS_SQLTUNE.EXECUTE_TUNING_TASK('sqli_{sql_id}');\nEND;\n/\n"
                 f"SET LONG 1000000 LONGCHUNKSIZE 1000000 PAGESIZE 0 LINESIZE 200\n"
                 f"SELECT DBMS_SQLTUNE.REPORT_TUNING_TASK('sqli_{sql_id}') AS recommendations FROM dual;")},
    ]


def _sqli_fix_payload(sql_id: str, analysis: dict, exists: dict, advisor: dict) -> dict:
    best = analysis.get("best_phv")
    return {
        "status": "success",
        "recommended": {"plan_hash_value": best, "sev": analysis["verdict"]["sev"],
                        "rationale": analysis["verdict"]["detail"]},
        "verdict": analysis["verdict"],
        "exists": exists,                       # {baseline, profile, detail}
        "scripts": _sqli_fix_scripts(sql_id, best, SQLI_HISTORY_DAYS),
        "advisor": advisor,                     # {available, note, findings?}
        "allow_apply": SQLI_ALLOW_APPLY,        # admin-only apply button visible?
        "warning": ("Applying a fix changes the optimizer's plan choice for this SQL. It runs on a "
                    "separate privileged, audited connection. Validate the chosen plan in non-prod first."),
    }


_PLAN_COLS = [
    {"key": "id", "label": "Id", "type": "num"},
    {"key": "operation", "label": "Operation", "type": "mono"},
    {"key": "object", "label": "Object", "type": "mono"},
    {"key": "e_rows", "label": "E-Rows", "type": "num"},
    {"key": "a_rows", "label": "A-Rows", "type": "num"},
    {"key": "estimate", "label": "Est. accuracy", "type": "chip"},
    {"key": "time_pct", "label": "Time %", "type": "pct", "warn": 25, "crit": 50},
    {"key": "dominant", "label": "Spent on", "type": "chip"},
]
# ASH activity bucket → chip severity (CPU is fine; I/O amber; contention red).
_ACT_SEV = {"CPU": "ok", "User I/O": "warn", "System I/O": "warn", "Cluster": "warn",
            "Concurrency": "crit", "Application": "crit", "Commit": "ok", "Configuration": "warn",
            "Scheduler": "warn", "Other": "muted"}
_PLAN_STATS_COLS = [
    {"key": "object", "label": "Table", "type": "mono"},
    {"key": "last_analyzed", "label": "Last analyzed", "type": "text"},
    {"key": "age_days", "label": "Age (days)", "type": "num"},
    {"key": "num_rows", "label": "Stats say (rows)", "type": "num"},
    {"key": "actual_rows", "label": "Actual (A-Rows)", "type": "num"},
    {"key": "state", "label": "Stats", "type": "chip"},
]
# Flag a plan line only when the volume matters AND the estimate is badly off.
_MISEST_MIN_ROWS = env_int("SQLI_MISESTIMATE_MIN_ROWS", 1000)
_MISEST_WARN = env_int("SQLI_MISESTIMATE_WARN", 10)
_MISEST_CRIT = env_int("SQLI_MISESTIMATE_CRIT", 100)
_STATS_STALE_DAYS = env_int("SQLI_STATS_STALE_DAYS", 7)


def _fmt_ratio(ratio: float) -> str:
    if ratio >= 1:
        return f"{int(round(ratio)):,}×"
    return f"{ratio:.2f}×"


def _sqli_plan_analysis_payload(raw: dict) -> dict:
    """Shape the runtime plan (V$SQL_PLAN_STATISTICS_ALL) + table stats into the Plan-Analysis
    contract: a per-line plan with the estimate-accuracy chip + a self-time bar (the biggest bar =
    the bottleneck), and a stats-health table correlating each table's staleness with actual rows.
    Shared by the live route + the dummy so both render identically."""
    plan_raw = raw.get("plan") or []
    stats_raw = raw.get("stats") or []
    has_actual = any(r.get("a_rows") is not None for r in plan_raw)

    root = next((r for r in plan_raw if int(r.get("id") or 0) == 0), None)
    total_us = float(root.get("elapsed_us") or 0) if root else 0.0

    # self-time per line = own elapsed − sum(direct children elapsed) → isolates the true hotspot.
    child_us: dict = {}
    for r in plan_raw:
        pid = r.get("parent_id")
        if pid is not None:
            child_us[pid] = child_us.get(pid, 0.0) + float(r.get("elapsed_us") or 0)
    self_us = {r.get("id"): max(float(r.get("elapsed_us") or 0) - child_us.get(r.get("id"), 0.0), 0.0)
               for r in plan_raw}
    bottleneck_id = (max(self_us, key=self_us.get) if self_us and has_actual and total_us > 0 else None)

    # Per-line ASH activity → which line spent the resource, and on what (CPU vs a wait class).
    act_rows = raw.get("activity") or []
    act_total = sum(int(a.get("samples") or 0) for a in act_rows) or 0
    line_samples: dict = {}
    line_buckets: dict = {}
    for a in act_rows:
        lid = a.get("line_id")
        s = int(a.get("samples") or 0)
        line_samples[lid] = line_samples.get(lid, 0) + s
        line_buckets.setdefault(lid, {})[a.get("bucket")] = line_buckets.get(lid, {}).get(a.get("bucket"), 0) + s
    line_dominant = {lid: max(b, key=b.get) for lid, b in line_buckets.items() if b}
    # If rowsource stats are missing, fall back to ASH sample share for the Time % bar.
    if not (has_actual and total_us > 0) and act_total > 0 and not bottleneck_id:
        bottleneck_id = max(line_samples, key=line_samples.get) if line_samples else None

    rows = []
    actual_by_obj: dict = {}
    for r in plan_raw:
        rid = r.get("id")
        e = float(r.get("e_rows") or 0)
        starts = int(r.get("starts") or 1) or 1
        est_total = e * starts                       # E-Rows is per-start; A-Rows is the total
        a = r.get("a_rows")
        op = ("  " * int(r.get("depth") or 0)) + " ".join(x for x in (r.get("operation"), r.get("options")) if x)
        obj = (f'{r.get("object_owner")}.{r.get("object_name")}'
               if r.get("object_owner") and r.get("object_name") else "—")
        if r.get("object_owner") and r.get("object_name") and a is not None:
            key = (r["object_owner"], r["object_name"])
            actual_by_obj[key] = max(actual_by_obj.get(key, 0), int(a))
        if has_actual and total_us > 0:
            time_pct = round(self_us.get(rid, 0.0) / total_us * 100, 1)
        elif act_total > 0:                          # no rowsource stats → use ASH sample share
            time_pct = round(line_samples.get(rid, 0) / act_total * 100, 1)
        else:
            time_pct = 0.0
        dom = line_dominant.get(rid)
        row = {"id": rid, "operation": op or "—", "object": obj, "e_rows": int(e),
               "a_rows": (int(a) if a is not None else None), "time_pct": time_pct,
               "dominant": dom or "—", "dominant__sev": (_ACT_SEV.get(dom, "muted") if dom else "muted")}
        if a is None:
            row["estimate"], row["estimate__sev"] = "N/A", "muted"
        else:
            ratio = (a / est_total) if est_total > 0 else float(a or 1)
            off = max(ratio, (1 / ratio) if ratio > 0 else 1)
            if a >= _MISEST_MIN_ROWS and off >= _MISEST_CRIT:
                row["estimate"], row["estimate__sev"] = _fmt_ratio(ratio), "crit"
            elif a >= _MISEST_MIN_ROWS and off >= _MISEST_WARN:
                row["estimate"], row["estimate__sev"] = _fmt_ratio(ratio), "warn"
            else:
                row["estimate"], row["estimate__sev"] = "OK", "ok"
        if rid == bottleneck_id:
            row["operation"] = "🔥 " + row["operation"]
            row["__sev"] = "crit"
        elif row.get("estimate__sev") in ("warn", "crit"):
            row["__sev"] = row["estimate__sev"]
        rows.append(row)

    srows = []
    for s in stats_raw:
        owner, name = s.get("owner"), s.get("table_name")
        age = int(s.get("age_days") or 0)
        stale = (s.get("stale_stats") == "YES") or age > _STATS_STALE_DAYS
        srows.append({"object": f"{owner}.{name}", "last_analyzed": s.get("last_analyzed") or "—",
                      "age_days": age, "num_rows": int(s.get("num_rows") or 0),
                      "actual_rows": actual_by_obj.get((owner, name)),
                      "state": "STALE" if stale else "FRESH", "state__sev": "warn" if stale else "ok",
                      "__sev": "warn" if stale else ""})

    summary = {
        "e_rows": int(root.get("e_rows") or 0) if root else 0,
        "cost": int(root.get("cost") or 0) if root else 0,
        "a_rows": (int(root.get("a_rows")) if root and root.get("a_rows") is not None else None),
        "elapsed_s": round(total_us / 1e6, 2) if total_us else None,
        "buffer_gets": int(root.get("buffer_gets") or 0) if root else 0,
        "disk_reads": int(root.get("disk_reads") or 0) if root else 0,
    }
    note = None if has_actual else (
        "Row-source statistics weren't collected for this cursor, so A-Rows / timings aren't "
        "available (only the optimizer's estimates). Re-run the statement with a "
        "/*+ gather_plan_statistics */ hint (or statistics_level=ALL in a test session) to capture "
        "actuals — or use the Plan Timeline tab for the regression.")
    diagnosis = _plan_diagnosis(plan_raw, self_us, total_us, bottleneck_id, has_actual, srows, line_dominant)
    return {"status": "success", "has_actual": has_actual, "note": note,
            "plan_hash_value": (root.get("plan_hash_value") if root else None),
            "summary": summary, "diagnosis": diagnosis,
            "plan": {"status": "success", "columns": _PLAN_COLS, "rows": rows},
            "stats": {"status": "success", "columns": _PLAN_STATS_COLS, "rows": srows}}


def _plan_diagnosis(plan_raw: list[dict], self_us: dict, total_us: float,
                    bottleneck_id, has_actual: bool, srows: list[dict],
                    line_dominant: dict | None = None) -> dict:
    """Plain-language findings for the plan: the bottleneck line (self-time + I/O), the worst
    cardinality mis-estimate (and whether its table's stats are stale), and a cautious index hint
    from the bottleneck's predicates. Reliable facts only — the authoritative index recommendation
    is deferred to SQL Tuning Advisor (Fix tab)."""
    findings: list[str] = []
    sev = "ok"
    by_id = {r.get("id"): r for r in plan_raw}

    if has_actual and total_us > 0 and bottleneck_id is not None:
        b = by_id.get(bottleneck_id, {})
        op = " ".join(x for x in (b.get("operation"), b.get("options")) if x)
        obj = (f'{b.get("object_owner")}.{b.get("object_name")}'
               if b.get("object_owner") and b.get("object_name") else None)
        pct = round(self_us.get(bottleneck_id, 0.0) / total_us * 100)
        dom = (line_dominant or {}).get(bottleneck_id)
        spent = f" — mostly {dom}" if dom else ""
        findings.append(f"{op}{(' on ' + obj) if obj else ''} (Id {bottleneck_id}) is the bottleneck — "
                        f"{round(self_us.get(bottleneck_id, 0.0) / 1e6, 1)}s of {round(total_us / 1e6, 1)}s ({pct}%){spent}.")
        reads, gets = int(b.get("disk_reads") or 0), int(b.get("buffer_gets") or 0)
        if reads or gets:
            findings.append(f"{reads:,} physical reads / {gets:,} buffer gets on Id {bottleneck_id}.")
        sev = "crit" if pct >= 50 else "warn"

    # worst cardinality mis-estimate — only on real object-access lines (a table/index scan is
    # actionable; SELECT STATEMENT / joins just inherit the skew, so don't attribute it there).
    worst, worst_off = None, 0.0
    for r in plan_raw:
        a = r.get("a_rows")
        if a is None or int(a) < _MISEST_MIN_ROWS:
            continue
        if not (r.get("object_owner") and r.get("object_name")):
            continue
        e = float(r.get("e_rows") or 0) * (int(r.get("starts") or 1) or 1)
        ratio = (int(a) / e) if e > 0 else float(a)
        off = max(ratio, (1 / ratio) if ratio > 0 else 1)
        if off > worst_off and off >= _MISEST_WARN:
            worst, worst_off = r, off
    if worst:
        wop = " ".join(x for x in (worst.get("operation"), worst.get("options")) if x)
        findings.append(f"Cardinality mis-estimate: E-Rows={int(float(worst.get('e_rows') or 0)):,} vs "
                        f"A-Rows={int(worst.get('a_rows')):,} on {wop} (Id {worst.get('id')}) — {_fmt_ratio(worst_off)} off.")
        sev = "crit"
        wobj = f'{worst.get("object_owner")}.{worst.get("object_name")}'
        stale = next((s for s in srows if s["object"] == wobj and s["state"] == "STALE"), None)
        if stale:
            actual = stale.get("actual_rows")
            findings.append(f"{wobj} statistics are stale (analyzed {stale['age_days']}d ago; stats say "
                            f"{stale['num_rows']:,} rows"
                            + (f", actual {int(actual):,}" if actual is not None else "")
                            + ") — re-gather them and re-check.")

    hint = None
    if has_actual and bottleneck_id is not None:
        b = by_id.get(bottleneck_id, {})
        if "FULL" in ((b.get("options") or "") + (b.get("operation") or "")):
            pred = (b.get("filter_predicates") or b.get("access_predicates") or "").strip()
            if pred:
                hint = (f"Id {bottleneck_id} is a full scan filtered on {pred[:200]} — an index on those columns "
                        f"may turn it into a range scan. Confirm with SQL Tuning Advisor (Fix tab) before creating it.")

    return {"sev": sev, "findings": findings, "hint": hint}


def _sql_monitor_payload(raw: dict) -> dict:
    """Shape the (live-only) SQL Monitor result. `monitored:false` → a clear message that it needs
    a running / recently-completed run; else the overview tiles + the full text report."""
    if not raw or not raw.get("monitored"):
        return {"status": "success", "monitored": False,
                "note": ("This SQL isn't currently being monitored. Real-time SQL Monitoring captures a "
                         "run only while it executes (or briefly after), and only for statements that ran "
                         "in parallel or for ≥5 seconds — so it can't show a past/aged-out execution. Use "
                         "the Plan Analysis or Plan Timeline tabs for the historical view.")}
    ov = raw.get("overview") or {}
    return {"status": "success", "monitored": True,
            "overview": {"status": ov.get("status"), "elapsed_s": ov.get("elapsed_s"), "cpu_s": ov.get("cpu_s"),
                         "buffer_gets": int(ov.get("buffer_gets") or 0), "disk_reads": int(ov.get("disk_reads") or 0),
                         "px": int(ov.get("px") or 0), "started": ov.get("started")},
            "report": raw.get("report") or "(report unavailable)"}


# --- routes ------------------------------------------------------------------

@router.post("/{db}/sql_finder")
def sql_finder(request: Request, db: str, body: SqlFinderQuery | None = None) -> dict:
    """Locate a sql_id when you only know 'the slow report yesterday' — top SQL by elapsed /
    execs / reads over the last SQLI_HISTORY_DAYS days. Each row is click-through to the dossier."""
    t = _target(db)
    body = body or SqlFinderQuery()
    if SQLI_USE_DUMMY:
        return sqli_finder_dummy(t, body)
    try:
        days = int(SQLI_HISTORY_DAYS)
        like = f"%{body.q.strip()}%" if body.q and body.q.strip() else None
        rows = []
        for r in database.fetch_sql_finder(request.app.state.db_configs.get(db), days, body.order, like):
            plans = int(r.get("plans") or 0)
            rows.append({"sql_id": r["sql_id"], "sql_text": (r.get("sql_text") or "").strip() or "—",
                         "module": r.get("module") or "—", "plans": plans, "execs": int(r.get("execs") or 0),
                         "elapsed_per_exec_s": float(r.get("elapsed_per_exec_s") or 0),
                         "last_active": r.get("last_active") or "—",
                         "flip": "MULTI" if plans > 1 else "SINGLE", "flip__sev": "warn" if plans > 1 else "ok",
                         "__sql_id": r["sql_id"]})
        return {"status": "success", "columns": _SQLI_FINDER_COLS, "rows": rows,
                "summary": {"days": days, "count": len(rows)}}
    except Exception:
        logger.exception("sql_finder failed for %s", db)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/{db}/sql/{sql_id}/overview")
def sqli_overview(request: Request, db: str, sql_id: str) -> dict:
    """Identity + verdict + KPIs for a sql_id. Massages `database.fetch_sql_overview`."""
    t = _target(db)
    if SQLI_USE_DUMMY:
        return sqli_overview_dummy(t, sql_id)
    try:
        raw = database.fetch_sql_overview(request.app.state.db_configs.get(db), sql_id, int(SQLI_HISTORY_DAYS))
        return _sqli_overview_payload(sql_id, raw.get("text") or "", raw.get("meta") or {},
                                      _sqli_norm_aggs(raw.get("aggs") or []))
    except Exception:
        logger.exception("sqli_overview failed for %s / %s", db, sql_id)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/{db}/sql/{sql_id}/plan_timeline")
def sqli_plan_timeline(request: Request, db: str, sql_id: str) -> dict:
    """Plan-instability timeline. Massages `database.fetch_sql_timeline`."""
    t = _target(db)
    if SQLI_USE_DUMMY:
        return sqli_timeline_dummy(t, sql_id)
    try:
        raw = database.fetch_sql_timeline(request.app.state.db_configs.get(db), sql_id, int(SQLI_HISTORY_DAYS))
        pts = [{"label": r["label"], "ts": int(r.get("ts") or 0), "plan_hash_value": int(r["phv"]),
                "elapsed_per_exec_s": float(r.get("elapsed_pe") or 0), "execs": int(r.get("execs") or 0)}
               for r in raw.get("points") or []]
        return _sqli_timeline_payload(pts, _sqli_norm_aggs(raw.get("aggs") or []))
    except Exception:
        logger.exception("sqli_plan_timeline failed for %s / %s", db, sql_id)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/{db}/sql/{sql_id}/plans")
def sqli_plans(request: Request, db: str, sql_id: str) -> dict:
    """Distinct plans + baseline/profile presence. Massages `database.fetch_sql_plans`."""
    t = _target(db)
    if SQLI_USE_DUMMY:
        return sqli_plans_dummy(t, sql_id)
    try:
        raw = database.fetch_sql_plans(request.app.state.db_configs.get(db), sql_id, int(SQLI_HISTORY_DAYS))
        return _sqli_plans_payload(_sqli_norm_aggs(raw.get("aggs") or []), _sqli_norm_mgmt(raw.get("mgmt") or []))
    except Exception:
        logger.exception("sqli_plans failed for %s / %s", db, sql_id)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/{db}/sql/{sql_id}/plan_analysis")
def sqli_plan_analysis(request: Request, db: str, sql_id: str) -> dict:
    """Runtime plan with the bottleneck (self-time bar) + E-Rows vs A-Rows misestimate flag,
    correlated with the stale-stats status of each table. Live-cache only. Massages
    `database.fetch_sql_plan_analysis`."""
    t = _target(db)
    if SQLI_USE_DUMMY:
        return sqli_plan_analysis_dummy(t, sql_id)
    try:
        return _sqli_plan_analysis_payload(database.fetch_sql_plan_analysis(request.app.state.db_configs.get(db), sql_id))
    except Exception:
        logger.exception("sqli_plan_analysis failed for %s / %s", db, sql_id)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/{db}/sql/{sql_id}/sql_monitor")
def sqli_monitor(request: Request, db: str, sql_id: str) -> dict:
    """Real-time SQL Monitor for the sql_id — LIVE/recent only. `monitored:false` (with a message)
    when there's no running/recent monitored execution. Massages `database.fetch_sql_monitor`."""
    t = _target(db)
    if SQLI_USE_DUMMY:
        return sqli_monitor_dummy(t, sql_id)
    try:
        return _sql_monitor_payload(database.fetch_sql_monitor(request.app.state.db_configs.get(db), sql_id))
    except Exception:
        logger.exception("sqli_monitor failed for %s / %s", db, sql_id)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/{db}/sql/{sql_id}/plan_text")
def sqli_plan_text(request: Request, db: str, sql_id: str, body: PhvBody) -> dict:
    """One plan's DBMS_XPLAN text. Massages `database.fetch_sql_plan_text`."""
    t = _target(db)
    if SQLI_USE_DUMMY:
        return sqli_plan_text_dummy(t, sql_id, body.plan_hash_value)
    try:
        text = database.fetch_sql_plan_text(request.app.state.db_configs.get(db), sql_id, int(body.plan_hash_value))
        return {"status": "success", "plan_hash_value": int(body.plan_hash_value), "source": "AWR",
                "text": text or "(plan not found in AWR or the cursor cache)"}
    except Exception:
        logger.exception("sqli_plan_text failed for %s / %s", db, sql_id)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/{db}/sql/{sql_id}/perf")
def sqli_perf(request: Request, db: str, sql_id: str) -> dict:
    """Per-snapshot performance table. Massages `database.fetch_sql_perf`."""
    t = _target(db)
    if SQLI_USE_DUMMY:
        return sqli_perf_dummy(t, sql_id)
    try:
        rows = [{"snap": r["snap"], "plan_hash_value": int(r.get("phv") or 0), "execs": int(r.get("execs") or 0),
                 "elapsed_per_exec_s": float(r.get("elapsed_pe") or 0), "cpu_per_exec_s": float(r.get("cpu_pe") or 0),
                 "buffer_gets_per_exec": int(r.get("gets_pe") or 0), "disk_reads_per_exec": int(r.get("reads_pe") or 0),
                 "rows_per_exec": int(r.get("rows_pe") or 0)}
                for r in database.fetch_sql_perf(request.app.state.db_configs.get(db), sql_id, int(SQLI_HISTORY_DAYS))]
        return {"status": "success", "columns": _SQLI_PERF_COLS, "rows": rows}
    except Exception:
        logger.exception("sqli_perf failed for %s / %s", db, sql_id)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/{db}/sql/{sql_id}/ash")
def sqli_ash(request: Request, db: str, sql_id: str) -> dict:
    """ASH breakdown (top waits). Massages `database.fetch_sql_ash`."""
    t = _target(db)
    if SQLI_USE_DUMMY:
        return sqli_ash_dummy(t, sql_id)
    try:
        raw = database.fetch_sql_ash(request.app.state.db_configs.get(db), sql_id, int(SQLI_HISTORY_DAYS))
        total = sum(int(r.get("samples") or 0) for r in raw) or 1
        rows = [{"event": r["event"], "wait_class": r["wait_class"],
                 "wait_class__sev": _WAIT_CLASS_SEV.get(r["wait_class"], "muted"),
                 "samples": int(r.get("samples") or 0),
                 "pct": round(int(r.get("samples") or 0) / total * 100, 1)} for r in raw]
        return {"status": "success", "columns": _SQLI_ASH_COLS, "rows": rows}
    except Exception:
        logger.exception("sqli_ash failed for %s / %s", db, sql_id)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/{db}/sql/{sql_id}/binds")
def sqli_binds(request: Request, db: str, sql_id: str) -> dict:
    """Captured bind variables. Massages `database.fetch_sql_binds`."""
    t = _target(db)
    if SQLI_USE_DUMMY:
        return sqli_binds_dummy(t, sql_id)
    try:
        rows = [{"captured": r.get("captured") or "—", "name": r.get("name"), "position": r.get("position"),
                 "datatype": r.get("datatype_string") or "", "value": str(r.get("value_string") or ""),
                 "plan_hash_value": int(r.get("phv") or 0)}
                for r in database.fetch_sql_binds(request.app.state.db_configs.get(db), sql_id, int(SQLI_HISTORY_DAYS))]
        return {"status": "success", "columns": _SQLI_BINDS_COLS, "rows": rows}
    except Exception:
        logger.exception("sqli_binds failed for %s / %s", db, sql_id)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/{db}/sql/{sql_id}/fix")
def sqli_fix(request: Request, db: str, sql_id: str) -> dict:
    """Read-only fix recommendation: best plan + copy-ready SQL + advisor pointer. Shown to ALL
    section users. The actual apply is a separate, gated endpoint. Massages `database.fetch_sql_fix`."""
    t = _target(db)
    if SQLI_USE_DUMMY:
        return sqli_fix_dummy(t, sql_id)
    try:
        raw = database.fetch_sql_fix(request.app.state.db_configs.get(db), sql_id, int(SQLI_HISTORY_DAYS))
        mgmt = _sqli_norm_mgmt(raw.get("mgmt") or [])
        advisor = {"available": True,
                   "note": "Run the SQL Tuning Advisor script below for optimizer recommendations (it creates a tuning task).",
                   "findings": []}
        return _sqli_fix_payload(sql_id, _sqli_analyse(_sqli_norm_aggs(raw.get("aggs") or [])),
                                 {"baseline": mgmt["baseline"], "profile": mgmt["profile"], "detail": mgmt["detail"]},
                                 advisor)
    except Exception:
        logger.exception("sqli_fix failed for %s / %s", db, sql_id)
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/{db}/sql/{sql_id}/apply_fix")
def sqli_apply_fix(db: str, sql_id: str, body: SqlFixApply) -> dict:
    """WRITE. Admin-gated in the UI and disable-able server-side via SQLI_ALLOW_APPLY. Must run on
    a SEPARATE privileged/audited connection (like kill-session) — never the read-only monitor."""
    t = _target(db)
    if not SQLI_ALLOW_APPLY:
        raise HTTPException(status_code=403,
                            detail="In-app fix apply is disabled (SQLI_ALLOW_APPLY=0). Copy the SQL and apply it via your DBA process.")
    if SQLI_USE_DUMMY:
        return sqli_apply_fix_dummy(t, body)
    raise RuntimeError("sqli_apply_fix: wire a privileged (audited) connection for DBMS_SPM/DBMS_SQLTUNE — not the read-only monitor")


# --- shaping helpers shared by the SQL-Intelligence routes + the dummy module -----

def _sqli_norm_aggs(rows: list[dict]) -> list[dict]:
    """Normalise `database` per-plan agg rows into the shape `_sqli_analyse` / the payloads expect."""
    return [{"plan_hash_value": int(r["phv"]), "execs": int(r.get("execs") or 0),
             "elapsed_per_exec_s": float(r.get("elapsed_pe") or 0), "buffer_gets_per_exec": int(r.get("gets_pe") or 0),
             "first_seen": r.get("first_seen"), "last_seen": r.get("last_seen"),
             "last_seen_ts": int(r.get("last_ts") or 0), "source": "AWR"} for r in rows]


def _sqli_norm_mgmt(rows: list[dict]) -> dict:
    """Baseline/profile presence from the raw v$sql rows (keyed by sql_id via the cursor cache)."""
    baseline = any(r.get("sql_plan_baseline") for r in rows)
    profile = any(r.get("sql_profile") for r in rows)
    detail = []
    if baseline:
        detail.append("A SQL Plan Baseline is attached (seen in the cursor cache).")
    if profile:
        detail.append("A SQL Profile is attached.")
    if not detail:
        detail.append("No baseline or profile detected for this SQL_ID in the cursor cache.")
    return {"baseline": baseline, "profile": profile, "baseline_phvs": [], "detail": " ".join(detail)}


# --- Two-layer split ----------------------------------------------------------
#
# **All SQL lives in `database.py`** (the data layer). Each route above is ONE self-contained
# function: dummy-check → `database.fetch_*(request.app.state.db_configs.get(db), …)` → massage the
# raw rows into the UI contract. No separate `*_real` layer. The small shaping helpers
# (`_lock_row`, `_blk_row`, `_sess_row`, `_panel_*`, `_sqli_*_payload`, …) are shared with the dummy
# module so both the live and dummy paths return the identical shape.


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
    temp_usage_dummy,
    sessions_dummy,
    session_detail_dummy,
    sqli_finder_dummy,
    sqli_overview_dummy,
    sqli_timeline_dummy,
    sqli_plans_dummy,
    sqli_plan_analysis_dummy,
    sqli_monitor_dummy,
    sqli_plan_text_dummy,
    sqli_perf_dummy,
    sqli_ash_dummy,
    sqli_binds_dummy,
    sqli_fix_dummy,
    sqli_apply_fix_dummy,
)
