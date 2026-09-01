"""Data layer for the Oracle Command Center.

**All SQL lives here, one self-contained function per fetch.** Each ``fetch_*`` opens a
connection (``connect``), runs its query (or the few queries a section needs, on ONE
connection), builds the rows, and returns them — nothing shared but ``connect``. The API layer
(``oracle_cc_api.py``) massages the raw rows into the UI contract; it holds no SQL.

Style: mirrors ``fetch_db_lock_data`` — connect → cursor → execute → dict rows → return, inside
a ``try/finally`` that closes the cursor and the connection. Multi-query sections (top segments,
sessions, SQL Intelligence) run each query on the same cursor and return the combined data at the
end. Tunables (owner schema, top-N, history days) are passed in as params.
"""

from __future__ import annotations

import datetime
import decimal
import os
import re
from typing import Any

import config_loader


def _lob_output_type_handler(cursor, *args):
    """Fetch CLOB/NCLOB as ``str`` and BLOB as ``bytes`` directly, so callers NEVER receive a LOB
    locator object. Without this, ``DBMS_XPLAN.DISPLAY_CURSOR``, ``REPORT_SQL_MONITOR``,
    ``sql_fulltext``, CLOB config columns and ``LISTAGG`` overflow come back as LOBs that break
    ``dict(zip(...))`` / JSON and go invalid once the cursor closes ("LOB variable no longer valid").

    Supports both python-oracledb signatures: 2.x ``(cursor, metadata)`` and the legacy
    ``(cursor, name, default_type, size, precision, scale)`` form."""
    import oracledb
    type_code = args[0].type_code if len(args) == 1 else args[1]
    if type_code in (oracledb.DB_TYPE_CLOB, oracledb.DB_TYPE_NCLOB):
        return cursor.var(oracledb.DB_TYPE_LONG, arraysize=cursor.arraysize)
    if type_code == oracledb.DB_TYPE_BLOB:
        return cursor.var(oracledb.DB_TYPE_LONG_RAW, arraysize=cursor.arraysize)
    return None


def _install_lob_handler(connection: Any) -> Any:
    """Attach the LOB→str/bytes handler to a connection (best-effort; no-op if unsupported)."""
    try:
        connection.outputtypehandler = _lob_output_type_handler
    except Exception:
        pass
    return connection


def connect(db_config: Any):
    """Open (or pass through) a DB connection for one scope's ``db_config``.

    Handles three shapes so it drops into most setups:
      * an already-live connection (has ``.cursor``)   → returned as-is (the caller won't close it);
      * a mapping with user/password/dsn               → ``oracledb.connect(**...)``;
      * a DSN / EZConnect string                       → ``oracledb.connect(dsn)``.
    Replace the body with your own connector if you connect differently.

    Every returned connection gets a LOB output-type handler so CLOB/BLOB columns come back as
    plain ``str``/``bytes`` (see ``_lob_output_type_handler``) — applied here ONCE so all queries
    in this module are covered.
    """
    if db_config is None:
        raise RuntimeError("No db_config for this scope (connection is None / DB unreachable).")
    if hasattr(db_config, "cursor"):          # already a live connection → reuse it
        return _install_lob_handler(db_config)
    import oracledb                            # lazy: the driver isn't needed in dummy mode
    if isinstance(db_config, dict):
        if not db_config:                      # empty stub (dev/dummy) — nothing to connect with
            raise RuntimeError("db_config is an empty stub; run with dummy mode, or provide real credentials.")
        return _install_lob_handler(oracledb.connect(
            user=db_config.get("user"),
            password=db_config.get("password"),
            dsn=db_config.get("dsn") or db_config.get("connect_string"),
        ))
    return _install_lob_handler(oracledb.connect(str(db_config)))    # a bare DSN / connect string


# =============================================================================
# Overview (Home strip) — one light snapshot per DB
# =============================================================================

def fetch_overview(db_config: Any, owner: str) -> dict:
    """One DB's Home-strip snapshot: {snap:{storage_pct,blocking,active}, top:{segment_name,size_gb}}."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT (SELECT ROUND(MAX(used_percent), 1) FROM dba_tablespace_usage_metrics)    AS storage_pct,
                   (SELECT COUNT(*) FROM v$session WHERE blocking_session IS NOT NULL)       AS blocking,
                   (SELECT COUNT(*) FROM v$session WHERE type = 'USER' AND status = 'ACTIVE') AS active
              FROM dual
        """)
        cols = [c[0].lower() for c in cursor.description]
        snap = [dict(zip(cols, row)) for row in cursor.fetchall()]

        cursor.execute("""
            SELECT segment_name, ROUND(SUM(bytes)/1024/1024/1024, 2) AS size_gb
              FROM dba_segments
             WHERE owner = :owner
             GROUP BY segment_name
             ORDER BY size_gb DESC
             FETCH FIRST 1 ROWS ONLY
        """, {"owner": owner})
        cols = [c[0].lower() for c in cursor.description]
        top = [dict(zip(cols, row)) for row in cursor.fetchall()]

        return {"snap": snap[0] if snap else {}, "top": top[0] if top else {}}
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


# =============================================================================
# Section 1 — tablespace space
# =============================================================================

def fetch_space(db_config: Any) -> list[dict]:
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            WITH c1 AS (
                SELECT a.tablespace_name,
                       ROUND(a.bytes_alloc     / (1024*1024*1024), 2) AS total_alloc_gb,
                       ROUND(a.physical_bytes  / (1024*1024*1024), 2) AS total_phys_gb,
                       ROUND(NVL(b.tot_used,0) / (1024*1024*1024), 2) AS used_gb
                  FROM (SELECT tablespace_name,
                               SUM(bytes) AS physical_bytes,
                               SUM(DECODE(autoextensible, 'NO', bytes, 'YES', maxbytes)) AS bytes_alloc
                          FROM dba_data_files
                         GROUP BY tablespace_name) a
                  LEFT JOIN (SELECT tablespace_name, SUM(bytes) AS tot_used
                               FROM dba_segments
                              GROUP BY tablespace_name) b
                    ON a.tablespace_name = b.tablespace_name
            )
            SELECT tablespace_name, total_alloc_gb, total_phys_gb, used_gb,
                   ROUND(total_phys_gb  - used_gb, 2)                   AS free_gb,
                   ROUND(total_alloc_gb - used_gb, 2)                   AS total_free_gb,
                   ROUND((used_gb / NULLIF(total_phys_gb, 0)) * 100, 2) AS used_pct
              FROM c1
             ORDER BY used_pct DESC
        """)
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, row)) for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


# =============================================================================
# Section 2 — top table storage consumers (table → top-N partitions)
# =============================================================================

def fetch_top_segments(db_config: Any, owner: str, top_n: int, child_limit: int) -> dict:
    """Three queries on one connection → {tables, stats, partitions}, all scoped to the top-N
    table names so the stats/partition scans never touch the whole schema. The API assembles
    the tree. (Example of the multi-query-in-one-function pattern.)"""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()

        # 1) Top-N tables by total data-segment bytes.
        cursor.execute("""
            SELECT segment_name, ROUND(SUM(bytes)/1024/1024/1024, 2) AS size_gb
              FROM dba_segments
             WHERE owner = :owner
               AND segment_type IN ('TABLE','TABLE PARTITION','TABLE SUBPARTITION')
             GROUP BY segment_name
             ORDER BY size_gb DESC
             FETCH FIRST :lim ROWS ONLY
        """, {"owner": owner, "lim": top_n})
        cols = [c[0].lower() for c in cursor.description]
        tables = [dict(zip(cols, row)) for row in cursor.fetchall()]

        names = [t["segment_name"] for t in tables]
        if not names:
            return {"tables": [], "stats": [], "partitions": []}

        # Bind the top-N names as an IN-list (:n0, :n1, …) so the next two queries touch ONLY
        # those tables — placeholders are tokens, names bind as values → injection-safe.
        ph = ", ".join(f":n{i}" for i in range(len(names)))
        name_binds = {f"n{i}": n for i, n in enumerate(names)}

        # 2) Stats for just those tables + their partitions.
        cursor.execute(f"""
            SELECT object_type, table_name, partition_name, num_rows, stale_stats,
                   TO_CHAR(last_analyzed, 'DD-Mon HH24:MI') AS last_analyzed
              FROM dba_tab_statistics
             WHERE owner = :owner AND object_type IN ('TABLE','PARTITION')
               AND table_name IN ({ph})
        """, {"owner": owner, **name_binds})
        cols = [c[0].lower() for c in cursor.description]
        stats = [dict(zip(cols, row)) for row in cursor.fetchall()]

        # 3) Top-N partitions per table in one windowed query.
        cursor.execute(f"""
            SELECT segment_name, partition_name, size_gb FROM (
                SELECT segment_name, partition_name,
                       ROUND(SUM(bytes)/1024/1024/1024, 2) AS size_gb,
                       ROW_NUMBER() OVER (PARTITION BY segment_name ORDER BY SUM(bytes) DESC) AS rn
                  FROM dba_segments
                 WHERE owner = :owner AND segment_name IN ({ph})
                   AND segment_type IN ('TABLE PARTITION','TABLE SUBPARTITION')
                 GROUP BY segment_name, partition_name
            ) WHERE rn <= :lim
            ORDER BY segment_name, size_gb DESC
        """, {"owner": owner, "lim": child_limit, **name_binds})
        cols = [c[0].lower() for c in cursor.description]
        partitions = [dict(zip(cols, row)) for row in cursor.fetchall()]

        return {"tables": tables, "stats": stats, "partitions": partitions}
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


# =============================================================================
# Section 3 — top index storage consumers (index → top-N partitions)
# =============================================================================

def fetch_top_indexes(db_config: Any, owner: str, top_n: int, child_limit: int) -> dict:
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()

        # Size the index segments FIRST (cheap group-by on one column against DBA_SEGMENTS),
        # take the top-N, and only THEN join the heavy DBA_INDEXES view — for those N rows.
        # The old shape joined DBA_INDEXES before grouping, so it was probed for every index
        # segment (all partitions/subpartitions) in the schema, then aggregated: the join, not
        # the size scan, was the cost. segment_name is unique per owner, so grouping by it alone
        # is equivalent to the old (segment_name, table_name, index_type) group.
        cursor.execute("""
            SELECT s.index_name, i.table_name, i.index_type AS kind, s.size_gb
              FROM (
                    SELECT segment_name AS index_name,
                           ROUND(SUM(bytes)/1024/1024/1024, 2) AS size_gb
                      FROM dba_segments
                     WHERE owner = :owner
                       AND segment_type IN ('INDEX','INDEX PARTITION','INDEX SUBPARTITION')
                     GROUP BY segment_name
                     ORDER BY SUM(bytes) DESC
                     FETCH FIRST :lim ROWS ONLY
                   ) s
              JOIN dba_indexes i
                ON i.owner = :owner AND i.index_name = s.index_name
             ORDER BY s.size_gb DESC
        """, {"owner": owner, "lim": top_n})
        cols = [c[0].lower() for c in cursor.description]
        indexes = [dict(zip(cols, row)) for row in cursor.fetchall()]

        names = [ix["index_name"] for ix in indexes]
        if not names:
            return {"indexes": [], "partitions": []}

        ph = ", ".join(f":n{i}" for i in range(len(names)))
        name_binds = {f"n{i}": n for i, n in enumerate(names)}

        cursor.execute(f"""
            SELECT segment_name, partition_name, size_gb FROM (
                SELECT segment_name, partition_name,
                       ROUND(SUM(bytes)/1024/1024/1024, 2) AS size_gb,
                       ROW_NUMBER() OVER (PARTITION BY segment_name ORDER BY SUM(bytes) DESC) AS rn
                  FROM dba_segments
                 WHERE owner = :owner AND segment_name IN ({ph})
                   AND segment_type IN ('INDEX PARTITION','INDEX SUBPARTITION')
                 GROUP BY segment_name, partition_name
            ) WHERE rn <= :lim
            ORDER BY segment_name, size_gb DESC
        """, {"owner": owner, "lim": child_limit, **name_binds})
        cols = [c[0].lower() for c in cursor.description]
        partitions = [dict(zip(cols, row)) for row in cursor.fetchall()]

        return {"indexes": indexes, "partitions": partitions}
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


# =============================================================================
# Section 4 — index health & stability
# =============================================================================

def fetch_index_health(db_config: Any, owner: str) -> list[dict]:
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
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
        """, {"owner": owner})
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, row)) for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


# =============================================================================
# Section 5 — critical locks
# =============================================================================

def fetch_locks(db_config: Any) -> list[dict]:
    """Held/blocking TX/TM enqueue locks with the session, object, mode, held time and SQL.
    NOTE vs the first draft: `l.lmode` (not `l.mode`, reserved), `v$session` (not `v_session`),
    and `sql_text` via a scalar subquery (a plain v$sql join multiplies rows per child cursor).
    `held_secs` (raw ctime seconds) is returned alongside the INTERVAL so the API formats it."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT s.sid,
                   s.serial#          AS serial_no,
                   s.username,
                   NULL               AS firstname,
                   NULL               AS surname,
                   s.machine,
                   CASE WHEN s.blocking_session IS NOT NULL THEN 'WAITING'
                        WHEN s.sid IN (SELECT blocking_session FROM v$session WHERE blocking_session IS NOT NULL) THEN 'BLOCKING'
                        ELSE 'HELD' END AS session_state,
                   o.owner || '.' || o.object_name AS locked_object,
                   o.object_type,
                   l.type             AS lock_type,
                   DECODE(l.lmode, 0,'None', 1,'Null', 2,'Row-S (RS)', 3,'Row-X (RX)',
                                   4,'Share (S)', 5,'Row-X (SSX)', 6,'Exclusive (X)') AS lock_mode,
                   NUMTODSINTERVAL(l.ctime, 'SECOND') AS held_duration,
                   l.ctime            AS held_secs,
                   s.sql_id,
                   (SELECT q.sql_text FROM v$sql q WHERE q.sql_id = s.sql_id AND ROWNUM = 1) AS sql_text,
                   -- Captured bind values for this SQL (v$sql_bind_capture) — placeholders like :1
                   -- in sql_text map to these; the API appends them under the query in the popup.
                   (SELECT LISTAGG('  ' || bc.name || ' = ' || NVL(bc.value_string, 'NULL'),
                                   CHR(10) ON OVERFLOW TRUNCATE) WITHIN GROUP (ORDER BY bc.position)
                      FROM (SELECT DISTINCT name, position, value_string
                              FROM v$sql_bind_capture WHERE sql_id = s.sql_id) bc) AS bind_values
              FROM v$lock l
              JOIN v$session s        ON l.sid = s.sid
              LEFT JOIN v$locked_object lo ON s.sid = lo.session_id
              LEFT JOIN dba_objects o      ON lo.object_id = o.object_id
             WHERE l.type IN ('TX','TM')
               AND s.type != 'BACKGROUND'
             ORDER BY CASE WHEN l.block = 1 THEN 0
                           WHEN s.blocking_session IS NOT NULL THEN 1
                           ELSE 2 END, l.ctime DESC
        """)
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, row)) for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


# =============================================================================
# Section 6 — blocking sessions (flat blocker↔victim pairs)
# =============================================================================

def fetch_blocking(db_config: Any) -> list[dict]:
    """One row per blocking relationship: the blocker (+ its SQL and the object it holds) and the
    victim it's blocking (+ its SQL). Blocker SQL_ID is often NULL (idle in transaction)."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT blocker.sid          AS blocker_sid,
                   blocker.serial#      AS blocker_serial,
                   blocker.username     AS blocker_user,
                   NULL                 AS blocker_name,
                   NULL                 AS victim_name,
                   blocker.machine      AS blocker_machine,
                   blocker_obj.owner || '.' || blocker_obj.object_name AS object_being_held,
                   blocker_obj.object_type AS blocker_object_type,
                   blocker.sql_id       AS blocker_sql_id,
                   (SELECT SUBSTR(sql_text, 1, 10000) FROM v$sql
                     WHERE sql_id = blocker.sql_id AND ROWNUM = 1) AS blocker_sql_text,
                   (SELECT LISTAGG('  ' || bc.name || ' = ' || NVL(bc.value_string, 'NULL'),
                                   CHR(10) ON OVERFLOW TRUNCATE) WITHIN GROUP (ORDER BY bc.position)
                      FROM (SELECT DISTINCT name, position, value_string
                              FROM v$sql_bind_capture WHERE sql_id = blocker.sql_id) bc) AS blocker_bind_values,
                   waiter.sid           AS victim_sid,
                   waiter.serial#       AS victim_serial,
                   waiter.username      AS victim_user,
                   waiter.event         AS wait_event,
                   waiter.seconds_in_wait AS wait_time_seconds,
                   waiter.sql_id        AS victim_sql_id,
                   (SELECT SUBSTR(sql_text, 1, 10000) FROM v$sql
                     WHERE sql_id = waiter.sql_id AND ROWNUM = 1) AS victim_sql_text,
                   (SELECT LISTAGG('  ' || bc.name || ' = ' || NVL(bc.value_string, 'NULL'),
                                   CHR(10) ON OVERFLOW TRUNCATE) WITHIN GROUP (ORDER BY bc.position)
                      FROM (SELECT DISTINCT name, position, value_string
                              FROM v$sql_bind_capture WHERE sql_id = waiter.sql_id) bc) AS victim_bind_values
              FROM v$session waiter
              JOIN v$session blocker ON waiter.blocking_session = blocker.sid
              LEFT JOIN v$locked_object lo ON blocker.sid = lo.session_id
              LEFT JOIN dba_objects blocker_obj ON lo.object_id = blocker_obj.object_id
             WHERE waiter.blocking_session IS NOT NULL
             ORDER BY blocker.sid, waiter.seconds_in_wait DESC
        """)
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, row)) for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


# =============================================================================
# Section 6b — Temp tablespace usage (sessions holding temp / sort space)
# =============================================================================

def fetch_temp_usage(db_config: Any) -> list[dict]:
    """Sessions currently holding TEMP / sort segment space (V$TEMPSEG_USAGE), one row per
    session+tablespace, largest first — the candidates to kill when temp is exhausted. Joins
    V$SESSION / V$PROCESS / DBA_TABLESPACES (for the block size → MB), plus s.sql_id and
    last_call_et so you can see WHAT is using the space and for how long.

    ``ols_users`` is OPTIONAL: if it isn't visible to the monitoring user, the firstname/surname
    columns come back NULL and the table is left OUT of the join entirely (so a missing table can
    never break this query). Existence is checked against ALL_OBJECTS (table / view / synonym)."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()

        cursor.execute(
            "SELECT COUNT(*) FROM all_objects "
            "WHERE object_name = 'OLS_USERS' AND object_type IN ('TABLE','VIEW','SYNONYM')")
        has_users = (cursor.fetchone()[0] or 0) > 0

        # firstname/surname either come from ols_users (LEFT JOIN on osuser) or are NULL columns.
        name_cols = "u.firstname, u.surname" if has_users else "CAST(NULL AS VARCHAR2(64)) AS firstname, " \
                                                               "CAST(NULL AS VARCHAR2(64)) AS surname"
        name_join = "LEFT JOIN ols_users u ON UPPER(s.osuser) = UPPER(u.username)" if has_users else ""
        name_grp = ", u.firstname, u.surname" if has_users else ""

        cursor.execute(f"""
            SELECT s.sid, s.serial# AS serial, s.status, s.username, s.osuser,
                   {name_cols},
                   s.machine, s.module, p.program, p.spid,
                   s.sql_id, s.last_call_et AS secs,
                   t.tablespace,
                   ROUND(SUM(t.blocks) * ts.block_size / 1048576) AS mb_used,
                   COUNT(*) AS segments
              FROM v$tempseg_usage t
              JOIN v$session s        ON t.session_addr = s.saddr
              JOIN v$process p        ON s.paddr = p.addr
              JOIN dba_tablespaces ts ON t.tablespace = ts.tablespace_name
              {name_join}
             WHERE s.type = 'USER'
             GROUP BY s.sid, s.serial#, s.status, s.username, s.osuser{name_grp},
                      s.machine, s.module, p.program, p.spid, s.sql_id, s.last_call_et,
                      t.tablespace, ts.block_size
             ORDER BY mb_used DESC
        """)
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, row)) for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


# =============================================================================
# Section 7 — sessions inventory + per-state counts
# =============================================================================

def fetch_sessions(db_config: Any, status: str) -> dict:
    """Inventory rows (filtered by state) + the full per-state counts — two queries, one
    connection, returned together as {rows, counts}."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()

        cursor.execute("""
            SELECT s.sid, s.serial# AS serial, s.username, s.status, s.machine, s.program,
                   s.sql_id, NVL(s.event, 'ON CPU') AS event, s.last_call_et AS secs
              FROM v$session s
             WHERE s.type = 'USER'
               AND (:status = 'all' OR LOWER(s.status) = :status)
             ORDER BY DECODE(s.status,'ACTIVE',0,'INACTIVE',1,2), s.last_call_et DESC
        """, {"status": status})
        cols = [c[0].lower() for c in cursor.description]
        rows = [dict(zip(cols, row)) for row in cursor.fetchall()]

        cursor.execute("SELECT LOWER(status) AS st, COUNT(*) AS c FROM v$session WHERE type='USER' GROUP BY LOWER(status)")
        cols = [c[0].lower() for c in cursor.description]
        counts = [dict(zip(cols, row)) for row in cursor.fetchall()]

        return {"rows": rows, "counts": counts}
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


# =============================================================================
# Section 7 — SID deep-dive: each panel is its own self-contained fetch_session_* query;
#             fetch_session_detail is a thin orchestrator that shares ONE connection across
#             them (connect() passes a live connection through) and honours `panel` for per-tab refresh
# =============================================================================

def fetch_session_base(db_config: Any, sid: int, serial: int) -> dict:
    """Identity/status facts for one session (the deep-dive header). Empty dict if not found."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT s.sid, s.serial# AS serial, s.username, s.status, s.machine, s.program,
                   s.sql_id, NVL(s.event, 'ON CPU') AS event, s.last_call_et AS secs,
                   s.osuser, s.module, TO_CHAR(s.logon_time, 'DD-Mon HH24:MI') AS logon_time
              FROM v$session s WHERE s.sid = :sid AND s.serial# = :serial
        """, {"sid": sid, "serial": serial})
        cols = [c[0].lower() for c in cursor.description]
        rows = [dict(zip(cols, row)) for row in cursor.fetchall()]
        return rows[0] if rows else {}
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_session_plan(db_config: Any, sql_id: str | None) -> list | None:
    """The live cursor's runtime plan (DBMS_XPLAN.DISPLAY_CURSOR ALLSTATS LAST). None without a sql_id."""
    if not sql_id:
        return None
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute(
            "SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(:s, NULL, 'ALLSTATS LAST +PEEKED_BINDS'))",
            {"s": sql_id})
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, row)).get("plan_table_output") for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_session_waits(db_config: Any, sid: int) -> list:
    """Cumulative wait events for the session (v$session_event)."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute(
            "SELECT event, wait_class, time_waited, total_waits, average_wait "
            "FROM v$session_event WHERE sid = :sid ORDER BY time_waited DESC",
            {"sid": sid})
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, row)) for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_session_binds(db_config: Any, sql_id: str | None) -> list | None:
    """Captured bind values for the SQL (v$sql_bind_capture). None without a sql_id."""
    if not sql_id:
        return None
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute(
            "SELECT name, position, datatype_string, value_string "
            "FROM v$sql_bind_capture WHERE sql_id = :s ORDER BY position",
            {"s": sql_id})
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, row)) for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_session_ash(db_config: Any, sid: int) -> list:
    """Last 10 min of ASH samples for the session (v$active_session_history)."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT TO_CHAR(sample_time,'HH24:MI:SS') AS sample_time, session_state, event, wait_class, sql_id
              FROM v$active_session_history
             WHERE session_id = :sid AND sample_time > SYSDATE - INTERVAL '10' MINUTE
             ORDER BY sample_time DESC FETCH FIRST 50 ROWS ONLY
        """, {"sid": sid})
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, row)) for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_session_monitor(db_config: Any, sid: int, serial: int) -> dict | None:
    """Real-time SQL Monitor for the session's most-recent monitored execution — a structured
    overview PLUS the full TEXT report. Precisely targeted to ONE execution by session_id +
    session_serial# + sql_id + sql_exec_id + sql_exec_start (not "whatever the session runs now"),
    and ``report_level => 'ALL'`` for the fullest report. ``type => 'TEXT'`` (self-contained, safe
    to embed — the 'ACTIVE' report needs Oracle's external CDN and can't render inside the app).
    ``None`` when the session has no monitored statement (SQL Monitor is live/recent only, and only
    for parallel or ≥5s runs). ``sql_text`` and the report are CLOBs → returned as ``str`` by the
    connection's LOB handler (see ``connect``)."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT m.status, m.sql_id, m.sql_exec_id, m.sql_plan_hash_value,
                   TO_CHAR(m.sql_exec_start,   'DD-Mon HH24:MI:SS') AS started,
                   TO_CHAR(m.last_refresh_time,'DD-Mon HH24:MI:SS') AS last_refresh,
                   ROUND(m.elapsed_time/1e6, 1) AS elapsed_s,
                   ROUND(m.cpu_time/1e6, 1)     AS cpu_s,
                   m.buffer_gets, m.disk_reads, m.sql_text,
                   DBMS_SQL_MONITOR.REPORT_SQL_MONITOR(
                       session_id     => m.sid,
                       session_serial => m.session_serial#,
                       sql_id         => m.sql_id,
                       sql_exec_id    => m.sql_exec_id,
                       sql_exec_start => m.sql_exec_start,
                       type           => 'TEXT',
                       report_level   => 'ALL') AS report
              FROM v$sql_monitor m
             WHERE m.sid = :sid AND m.session_serial# = :serial
               AND m.px_server# IS NULL                 -- the coordinator row, not each PX slave
             ORDER BY m.last_refresh_time DESC
             FETCH FIRST 1 ROWS ONLY
        """, {"sid": sid, "serial": serial})
        cols = [c[0].lower() for c in cursor.description]
        rows = [dict(zip(cols, row)) for row in cursor.fetchall()]
        if not rows:
            return None
        r = rows[0]
        report = r.pop("report", None)
        return {"overview": r, "report": str(report) if report is not None else ""}
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_session_stats(db_config: Any, owner: str, sql_id: str | None) -> list:
    """Table stats health for the tables in this SQL's plan (dba_tab_statistics)."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT table_name, num_rows, stale_stats, TO_CHAR(last_analyzed,'DD-Mon HH24:MI') AS last_analyzed
              FROM dba_tab_statistics
             WHERE owner = :owner AND object_type = 'TABLE'
               AND table_name IN (SELECT object_name FROM v$sql_plan
                                   WHERE sql_id = :s AND object_owner = :owner AND object_type LIKE 'TABLE%')
        """, {"owner": owner, "s": sql_id or ""})
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, row)) for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_session_locks(db_config: Any, sid: int) -> list:
    """TX/TM locks currently held by the session (v$lock)."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT DECODE(l.type,'TX','TX (Row)','TM','TM (DML)',l.type) AS type,
                   DECODE(l.lmode,6,'Exclusive (X)',5,'Row-X (SSX)',4,'Share (S)',3,'Row-X (RX)',2,'Row-S (RS)',TO_CHAR(l.lmode)) AS mode_held,
                   (SELECT o.owner||'.'||o.object_name FROM v$locked_object lo JOIN dba_objects o ON o.object_id = lo.object_id
                     WHERE lo.session_id = l.sid AND ROWNUM = 1) AS object,
                   CASE WHEN l.block = 1 THEN 'BLOCKING' ELSE 'HELD' END AS state
              FROM v$lock l WHERE l.sid = :sid AND l.type IN ('TX','TM') AND l.lmode > 0
        """, {"sid": sid})
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, row)) for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_session_awr(db_config: Any, sql_id: str | None) -> list | None:
    """Recent AWR history for the SQL (dba_hist_sqlstat). None without a sql_id."""
    if not sql_id:
        return None
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT TO_CHAR(s.begin_interval_time,'DD-Mon HH24:MI') AS snap,
                   st.elapsed_time_delta AS elapsed_time, st.cpu_time_delta AS cpu_time,
                   st.buffer_gets_delta AS buffer_gets, st.executions_delta
              FROM dba_hist_sqlstat st JOIN dba_hist_snapshot s ON s.snap_id = st.snap_id
             WHERE st.sql_id = :s ORDER BY s.begin_interval_time DESC FETCH FIRST 8 ROWS ONLY
        """, {"s": sql_id})
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, row)) for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_session_rollback(db_config: Any, sid: int) -> dict:
    """Rollback detail for a KILLED session mid-rollback — REAL numbers, nothing fabricated:
      * ``v$transaction`` (joined via s.taddr): ``used_ublk`` / ``used_urec`` = the undo blocks /
        records still held by the transaction (i.e. still to be rolled back), + whether a
        transaction is still open at all (``is_active``);
      * ``v$session_longops('Transaction Rollback')``: ``sofar`` / ``totalwork`` (undo blocks
        done / total → percent), plus REAL ``elapsed_seconds`` and ``time_remaining``.
    Returns everything the Rollback Monitor panel needs. When the transaction is gone the rollback
    is complete (100%)."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()

        # Open transaction for this session? Its undo is what remains to roll back.
        cursor.execute("""
            SELECT tr.used_ublk, tr.used_urec, tr.status
              FROM v$session s
              JOIN v$transaction tr ON tr.addr = s.taddr
             WHERE s.sid = :sid AND s.type = 'USER'
        """, {"sid": sid})
        tr = cursor.fetchone()
        is_active = tr is not None
        undo_blocks_remaining = int(tr[0] or 0) if tr else 0
        undo_records_remaining = int(tr[1] or 0) if tr else 0
        txn_status = (tr[2] if tr else None)

        # Rollback progress + REAL timing from V$SESSION_LONGOPS (most recent 'Transaction Rollback').
        # No `sofar < totalwork` filter, so a finished rollback reports 100% instead of vanishing to 0.
        cursor.execute("""
            SELECT NVL(sofar, 0)      AS sofar,
                   NVL(totalwork, 0)  AS totalwork,
                   NVL(ROUND(sofar * 100 / NULLIF(totalwork, 0)), 0) AS pct,
                   NVL(elapsed_seconds, 0) AS elapsed_seconds,
                   NVL(time_remaining, 0)  AS time_remaining
              FROM v$session_longops
             WHERE sid = :sid AND opname = 'Transaction Rollback'
             ORDER BY start_time DESC FETCH FIRST 1 ROWS ONLY
        """, {"sid": sid})
        lo = cursor.fetchone()
        if lo:
            sofar, total, pct, elapsed_s, remaining_s = (int(lo[0]), int(lo[1]), int(lo[2]),
                                                         int(lo[3]), int(lo[4]))
        else:
            sofar = total = elapsed_s = remaining_s = 0
            pct = 100 if not is_active else 0
        if not is_active:            # transaction gone → rollback finished
            pct = 100
        pct = max(0, min(100, pct))
        blocks_left = (total - sofar) if total else undo_blocks_remaining

        return {
            "percent": pct,
            "is_active": is_active,
            "txn_status": txn_status,
            "undo_blocks_total": total,
            "undo_blocks_done": sofar,
            "undo_blocks_left": max(blocks_left, 0),
            "undo_blocks_remaining": undo_blocks_remaining,   # from v$transaction (currently held)
            "undo_records_remaining": undo_records_remaining,
            "elapsed_seconds": elapsed_s,
            "time_remaining_seconds": remaining_s,
        }
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_session_detail(db_config: Any, sid: int, serial: int, sql_id: str | None,
                         owner: str, panel: str | None = None) -> dict:
    """Deep-dive bundle assembled on ONE shared connection. Opens the connection once, then hands
    that *live* connection to each ``fetch_session_*`` above (``connect()`` passes a live connection
    straight through, so none of them re-connect or close it). Keys: ``facts`` plus, per panel,
    ``plan/waits/binds/ash/monitor/stats/locks/awr/rollback_pct``; each panel call is wrapped in its
    own try/except so one bad query degrades only that panel (``errors[key]``). ``panel`` limits the
    work to facts + that one panel for per-tab refresh (the rollback tab accepts ``rollback`` too)."""
    connection = None
    out: dict[str, Any] = {"errors": {}}
    try:
        connection = connect(db_config)                       # opened ONCE for the whole bundle
        out["facts"] = fetch_session_base(connection, sid, serial)
        f = out["facts"]
        eff_sql_id = sql_id or (f.get("sql_id") if f.get("sql_id") not in (None, "—") else None)

        # key -> how to fetch that panel (each call reuses the shared, still-open `connection`)
        panels = {
            "plan":         lambda: fetch_session_plan(connection, eff_sql_id),
            "waits":        lambda: fetch_session_waits(connection, sid),
            "binds":        lambda: fetch_session_binds(connection, eff_sql_id),
            "ash":          lambda: fetch_session_ash(connection, sid),
            "monitor":      lambda: fetch_session_monitor(connection, sid, serial),
            "stats":        lambda: fetch_session_stats(connection, owner, eff_sql_id),
            "locks":        lambda: fetch_session_locks(connection, sid),
            "awr":          lambda: fetch_session_awr(connection, eff_sql_id),
            "rollback_pct": lambda: fetch_session_rollback(connection, sid),
        }
        for key, fetch in panels.items():
            # per-tab refresh sends one panel key; the rollback tab's key is 'rollback'
            wanted = panel is None or panel == key or (key == "rollback_pct" and panel == "rollback")
            if not wanted:
                continue
            try:
                out[key] = fetch()
            except Exception as exc:                 # one panel failing must not sink the rest
                out["errors"][key] = str(exc)
        return out
    finally:
        if connection is not None and connection is not db_config:
            connection.close()


# =============================================================================
# Section 8 — SQL Intelligence (AWR/ASH; every query capped to the passed `days` window)
# =============================================================================

def fetch_sql_finder(db_config: Any, days: int, order: str, like: str | None) -> list[dict]:
    order_col = {"elapsed": "elapsed_per_exec_s", "execs": "execs", "reads": "reads_pe",
                 "last": "last_ts"}.get(order, "elapsed_per_exec_s")
    filt = "AND (UPPER(st.module) LIKE UPPER(:like) OR st.sql_id LIKE :like)" if like else ""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute(f"""
            SELECT st.sql_id,
                   (SELECT TO_CHAR(SUBSTR(x.sql_text,1,1000)) FROM dba_hist_sqltext x
                     WHERE x.sql_id = st.sql_id AND ROWNUM = 1) AS sql_text,
                   MAX(st.module) AS module,
                   COUNT(DISTINCT st.plan_hash_value) AS plans,
                   SUM(st.executions_delta) AS execs,
                   ROUND(SUM(st.elapsed_time_delta)/1e6/NULLIF(SUM(st.executions_delta),0),3) AS elapsed_per_exec_s,
                   ROUND(SUM(st.disk_reads_delta)/NULLIF(SUM(st.executions_delta),0)) AS reads_pe,
                   TO_CHAR(MAX(s.end_interval_time),'DD-Mon HH24:MI') AS last_active
              FROM dba_hist_sqlstat st
              JOIN dba_hist_snapshot s ON s.snap_id = st.snap_id AND s.dbid = st.dbid
                                      AND s.instance_number = st.instance_number
             WHERE s.begin_interval_time >= SYSTIMESTAMP - INTERVAL '{int(days)}' DAY
               AND st.executions_delta > 0 {filt}
             GROUP BY st.sql_id
             ORDER BY {order_col} DESC NULLS LAST
             FETCH FIRST 50 ROWS ONLY
        """, {"like": like} if like else {})
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, row)) for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


# The per-plan aggregate query is reused by overview / timeline / plans / fix; kept as a small
# string builder so those four functions stay one-query-obvious without duplicating 12 lines.
def _sql_aggs_query(days: int) -> str:
    return f"""
        SELECT st.plan_hash_value AS phv,
               SUM(st.executions_delta) AS execs,
               ROUND(SUM(st.elapsed_time_delta)/1e6/NULLIF(SUM(st.executions_delta),0),3) AS elapsed_pe,
               ROUND(SUM(st.buffer_gets_delta)/NULLIF(SUM(st.executions_delta),0)) AS gets_pe,
               TO_CHAR(MIN(s.begin_interval_time),'DD-Mon HH24:MI') AS first_seen,
               TO_CHAR(MAX(s.end_interval_time),'DD-Mon HH24:MI') AS last_seen,
               TO_NUMBER(TO_CHAR(MAX(s.end_interval_time),'YYYYMMDDHH24MI')) AS last_ts
          FROM dba_hist_sqlstat st
          JOIN dba_hist_snapshot s ON s.snap_id = st.snap_id AND s.dbid = st.dbid
                                  AND s.instance_number = st.instance_number
         WHERE st.sql_id = :s AND st.plan_hash_value > 0
           AND s.begin_interval_time >= SYSTIMESTAMP - INTERVAL '{int(days)}' DAY
         GROUP BY st.plan_hash_value
    """


def fetch_sql_overview(db_config: Any, sql_id: str, days: int) -> dict:
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()

        cursor.execute("SELECT TO_CHAR(SUBSTR(sql_text,1,3900)) AS t FROM dba_hist_sqltext WHERE sql_id = :s AND ROWNUM = 1", {"s": sql_id})
        cols = [c[0].lower() for c in cursor.description]
        txt = [dict(zip(cols, row)) for row in cursor.fetchall()]

        cursor.execute(f"""
            SELECT MAX(st.parsing_schema_name) AS schema, MAX(st.module) AS module,
                   TO_CHAR(MIN(s.begin_interval_time),'DD-Mon HH24:MI') AS first_seen,
                   TO_CHAR(MAX(s.end_interval_time),'DD-Mon HH24:MI') AS last_seen,
                   SUM(st.executions_delta) AS execs
              FROM dba_hist_sqlstat st
              JOIN dba_hist_snapshot s ON s.snap_id = st.snap_id AND s.dbid = st.dbid
                                      AND s.instance_number = st.instance_number
             WHERE st.sql_id = :s AND s.begin_interval_time >= SYSTIMESTAMP - INTERVAL '{int(days)}' DAY
        """, {"s": sql_id})
        cols = [c[0].lower() for c in cursor.description]
        meta = [dict(zip(cols, row)) for row in cursor.fetchall()]

        cursor.execute(_sql_aggs_query(days), {"s": sql_id})
        cols = [c[0].lower() for c in cursor.description]
        aggs = [dict(zip(cols, row)) for row in cursor.fetchall()]

        return {"text": (txt[0].get("t") if txt else None), "meta": (meta[0] if meta else {}), "aggs": aggs}
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_sql_timeline(db_config: Any, sql_id: str, days: int) -> dict:
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()

        cursor.execute(f"""
            SELECT TO_CHAR(s.begin_interval_time,'DD-Mon HH24:MI') AS label,
                   TO_NUMBER(TO_CHAR(s.begin_interval_time,'YYYYMMDDHH24MI')) AS ts,
                   st.plan_hash_value AS phv,
                   ROUND(st.elapsed_time_delta/1e6/NULLIF(st.executions_delta,0),3) AS elapsed_pe,
                   st.executions_delta AS execs
              FROM dba_hist_sqlstat st
              JOIN dba_hist_snapshot s ON s.snap_id = st.snap_id AND s.dbid = st.dbid
                                      AND s.instance_number = st.instance_number
             WHERE st.sql_id = :s AND st.executions_delta > 0 AND st.plan_hash_value > 0
               AND s.begin_interval_time >= SYSTIMESTAMP - INTERVAL '{int(days)}' DAY
             ORDER BY s.begin_interval_time
        """, {"s": sql_id})
        cols = [c[0].lower() for c in cursor.description]
        points = [dict(zip(cols, row)) for row in cursor.fetchall()]

        cursor.execute(_sql_aggs_query(days), {"s": sql_id})
        cols = [c[0].lower() for c in cursor.description]
        aggs = [dict(zip(cols, row)) for row in cursor.fetchall()]

        return {"points": points, "aggs": aggs}
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_sql_plans(db_config: Any, sql_id: str, days: int) -> dict:
    """Per-plan aggregates + baseline/profile presence (used by both the Plans tab and Fix tab)."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()

        cursor.execute(_sql_aggs_query(days), {"s": sql_id})
        cols = [c[0].lower() for c in cursor.description]
        aggs = [dict(zip(cols, row)) for row in cursor.fetchall()]

        cursor.execute("SELECT DISTINCT sql_plan_baseline, sql_profile FROM v$sql WHERE sql_id = :s", {"s": sql_id})
        cols = [c[0].lower() for c in cursor.description]
        mgmt = [dict(zip(cols, row)) for row in cursor.fetchall()]

        return {"aggs": aggs, "mgmt": mgmt}
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


# Fix uses the same aggs + mgmt bundle as plans.
fetch_sql_fix = fetch_sql_plans


def fetch_sql_perf(db_config: Any, sql_id: str, days: int) -> list[dict]:
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute(f"""
            SELECT TO_CHAR(s.begin_interval_time,'DD-Mon HH24:MI') AS snap, st.plan_hash_value AS phv,
                   st.executions_delta AS execs,
                   ROUND(st.elapsed_time_delta/1e6/NULLIF(st.executions_delta,0),3) AS elapsed_pe,
                   ROUND(st.cpu_time_delta/1e6/NULLIF(st.executions_delta,0),3) AS cpu_pe,
                   ROUND(st.buffer_gets_delta/NULLIF(st.executions_delta,0)) AS gets_pe,
                   ROUND(st.disk_reads_delta/NULLIF(st.executions_delta,0)) AS reads_pe,
                   ROUND(st.rows_processed_delta/NULLIF(st.executions_delta,0)) AS rows_pe
              FROM dba_hist_sqlstat st
              JOIN dba_hist_snapshot s ON s.snap_id = st.snap_id AND s.dbid = st.dbid
                                      AND s.instance_number = st.instance_number
             WHERE st.sql_id = :s AND st.executions_delta > 0
               AND s.begin_interval_time >= SYSTIMESTAMP - INTERVAL '{int(days)}' DAY
             ORDER BY s.begin_interval_time DESC
        """, {"s": sql_id})
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, row)) for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_sql_ash(db_config: Any, sql_id: str, days: int) -> list[dict]:
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute(f"""
            SELECT NVL(h.event,'ON CPU') AS event, NVL(h.wait_class,'CPU') AS wait_class, COUNT(*) AS samples
              FROM dba_hist_active_sess_history h
              JOIN dba_hist_snapshot s ON s.snap_id = h.snap_id AND s.dbid = h.dbid
                                      AND s.instance_number = h.instance_number
             WHERE h.sql_id = :s AND s.begin_interval_time >= SYSTIMESTAMP - INTERVAL '{int(days)}' DAY
             GROUP BY NVL(h.event,'ON CPU'), NVL(h.wait_class,'CPU')
             ORDER BY samples DESC FETCH FIRST 25 ROWS ONLY
        """, {"s": sql_id})
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, row)) for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_sql_binds(db_config: Any, sql_id: str, days: int) -> list[dict]:
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute(f"""
            SELECT TO_CHAR(b.last_captured,'DD-Mon HH24:MI') AS captured, b.name, b.position,
                   b.datatype_string, b.value_string, st.plan_hash_value AS phv
              FROM dba_hist_sqlbind b
              JOIN dba_hist_snapshot s ON s.snap_id = b.snap_id AND s.dbid = b.dbid
                                      AND s.instance_number = b.instance_number
              LEFT JOIN dba_hist_sqlstat st ON st.sql_id = b.sql_id AND st.snap_id = b.snap_id
                                           AND st.dbid = b.dbid AND st.instance_number = b.instance_number
             WHERE b.sql_id = :s AND b.was_captured = 'YES'
               AND s.begin_interval_time >= SYSTIMESTAMP - INTERVAL '{int(days)}' DAY
             ORDER BY b.last_captured DESC, b.position FETCH FIRST 50 ROWS ONLY
        """, {"s": sql_id})
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, row)) for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_sql_plan_text(db_config: Any, sql_id: str, phv: int) -> str:
    """One plan's DBMS_XPLAN text — from AWR, falling back to the live cursor cache."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()

        cursor.execute("SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY_AWR(:s, :phv, NULL, 'ALL'))",
                       {"s": sql_id, "phv": int(phv)})
        text = "\n".join(str(row[0] or "") for row in cursor.fetchall())

        if not text.strip():                        # not in AWR — try the live cursor cache
            cursor.execute("SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY_CURSOR(:s, NULL, 'ALLSTATS LAST'))",
                           {"s": sql_id})
            text = "\n".join(str(row[0] or "") for row in cursor.fetchall())

        return text
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_sql_plan_analysis(db_config: Any, sql_id: str) -> dict:
    """Runtime plan for the sql_id's most-recently-active cursor + the stats of the tables it
    touches → {plan, stats}. E-Rows come from `cardinality`; A-Rows / timings come from
    `last_*` (rowsource stats, only present when statistics_level=ALL or gather_plan_statistics
    was used). Live-cache only — a session that has aged out returns no plan rows."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()

        # 1) The plan, per line, for the child cursor that ran most recently (the current plan).
        cursor.execute("""
            SELECT p.id, p.parent_id, p.depth, p.operation, p.options,
                   p.object_owner, p.object_name, p.object_type,
                   p.cardinality AS e_rows, p.cost, p.plan_hash_value,
                   p.last_output_rows  AS a_rows,
                   p.last_elapsed_time AS elapsed_us,
                   p.last_cr_buffer_gets AS buffer_gets,
                   p.last_disk_reads   AS disk_reads,
                   p.last_starts       AS starts,
                   p.access_predicates, p.filter_predicates
              FROM v$sql_plan_statistics_all p
             WHERE p.sql_id = :s
               AND p.child_number = (SELECT child_number FROM v$sql
                                      WHERE sql_id = :s
                                      ORDER BY last_active_time DESC NULLS LAST FETCH FIRST 1 ROWS ONLY)
             ORDER BY p.id
        """, {"s": sql_id})
        cols = [c[0].lower() for c in cursor.description]
        plan = [dict(zip(cols, row)) for row in cursor.fetchall()]

        # 2) Table stats for every distinct table the plan accesses (scoped IN-list).
        objs = sorted({(r["object_owner"], r["object_name"]) for r in plan
                       if r.get("object_owner") and r.get("object_name")})
        stats: list[dict] = []
        if objs:
            conds, binds = [], {}
            for i, (owner, name) in enumerate(objs):
                conds.append(f"(owner = :o{i} AND table_name = :n{i})")
                binds[f"o{i}"] = owner
                binds[f"n{i}"] = name
            cursor.execute(f"""
                SELECT owner, table_name, num_rows, stale_stats,
                       TO_CHAR(last_analyzed, 'DD-Mon HH24:MI') AS last_analyzed,
                       ROUND(SYSDATE - last_analyzed) AS age_days
                  FROM dba_tab_statistics
                 WHERE object_type = 'TABLE' AND ({' OR '.join(conds)})
            """, binds)
            cs = [c[0].lower() for c in cursor.description]
            stats = [dict(zip(cs, row)) for row in cursor.fetchall()]

        # 3) Per-plan-line activity from ASH (last 30 min) — CPU vs each wait class, so the API can
        #    attribute "which operation spent the resource" to each plan line (the SQL-Monitor idea).
        activity = []
        try:
            cursor.execute("""
                SELECT sql_plan_line_id AS line_id,
                       CASE WHEN session_state = 'ON CPU' THEN 'CPU' ELSE NVL(wait_class, 'Other') END AS bucket,
                       COUNT(*) AS samples
                  FROM v$active_session_history
                 WHERE sql_id = :s AND sql_plan_line_id IS NOT NULL
                   AND sample_time > SYSDATE - INTERVAL '30' MINUTE
                 GROUP BY sql_plan_line_id,
                          CASE WHEN session_state = 'ON CPU' THEN 'CPU' ELSE NVL(wait_class, 'Other') END
            """, {"s": sql_id})
            ca = [c[0].lower() for c in cursor.description]
            activity = [dict(zip(ca, row)) for row in cursor.fetchall()]
        except Exception:
            activity = []

        return {"plan": plan, "stats": stats, "activity": activity}
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_session_resource(db_config: Any, sid: int, serial: int) -> dict:
    """Resource profile for one session: where its time went (ASH activity split: CPU vs each
    wait class), PGA memory (V$PROCESS), temp usage (V$TEMPSEG_USAGE) and active work areas
    (V$SQL_WORKAREA_ACTIVE — sort/hash memory + spill passes). Each part is guarded so a missing
    view/permission degrades only that part, not the whole panel."""
    connection = None
    cursor = None
    out: dict = {"activity": [], "pga": {}, "temp_mb": None, "workareas": [], "errors": {}}
    try:
        connection = connect(db_config)
        cursor = connection.cursor()

        def run(key: str, sql: str, binds: dict):
            try:
                cursor.execute(sql, binds)
                cs = [c[0].lower() for c in cursor.description]
                return [dict(zip(cs, row)) for row in cursor.fetchall()]
            except Exception as exc:
                out["errors"][key] = str(exc)
                return []

        # Activity split (last 10 min) — CPU vs wait class, from ASH.
        out["activity"] = run("activity", """
            SELECT CASE WHEN session_state = 'ON CPU' THEN 'CPU' ELSE NVL(wait_class, 'Other') END AS bucket,
                   COUNT(*) AS samples
              FROM v$active_session_history
             WHERE session_id = :sid AND session_serial# = :serial
               AND sample_time > SYSDATE - INTERVAL '10' MINUTE
             GROUP BY CASE WHEN session_state = 'ON CPU' THEN 'CPU' ELSE NVL(wait_class, 'Other') END
             ORDER BY samples DESC
        """, {"sid": sid, "serial": serial})

        pga = run("pga", """
            SELECT ROUND(p.pga_used_mem/1048576, 1)  AS pga_used_mb,
                   ROUND(p.pga_alloc_mem/1048576, 1) AS pga_alloc_mb,
                   ROUND(p.pga_max_mem/1048576, 1)   AS pga_max_mb
              FROM v$session s JOIN v$process p ON p.addr = s.paddr
             WHERE s.sid = :sid AND s.serial# = :serial
        """, {"sid": sid, "serial": serial})
        out["pga"] = pga[0] if pga else {}

        temp = run("temp", """
            SELECT ROUND(SUM(u.blocks) * ts.block_size / 1048576, 1) AS temp_mb
              FROM v$tempseg_usage u
              JOIN dba_tablespaces ts ON ts.tablespace_name = u.tablespace
              JOIN v$session s ON s.saddr = u.session_addr
             WHERE s.sid = :sid AND s.serial# = :serial
             GROUP BY ts.block_size
        """, {"sid": sid, "serial": serial})
        out["temp_mb"] = (temp[0].get("temp_mb") if temp else None)

        out["workareas"] = run("workareas", """
            SELECT operation_type AS operation,
                   ROUND(actual_mem_used/1048576, 1) AS mem_mb,
                   ROUND(max_mem_used/1048576, 1)    AS max_mb,
                   number_passes AS passes,
                   ROUND(tempseg_size/1048576, 1)    AS temp_mb
              FROM v$sql_workarea_active
             WHERE sid = :sid
             ORDER BY actual_mem_used DESC
        """, {"sid": sid})

        return out
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_sql_monitor(db_config: Any, sql_id: str) -> dict:
    """Real-time SQL Monitor for a sql_id — LIVE/recent only (GV$SQL_MONITOR keeps entries in
    memory while a statement runs, or briefly after, and only for parallel or ≥5s runs). Returns
    {monitored:False} when there's no monitored execution, else {monitored:True, overview, report}
    (the full DBMS_SQL_MONITOR text report)."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT status, sql_exec_id,
                   ROUND(elapsed_time/1e6, 1) AS elapsed_s, ROUND(cpu_time/1e6, 1) AS cpu_s,
                   buffer_gets, disk_reads, px_servers_allocated AS px,
                   TO_CHAR(sql_exec_start, 'DD-Mon HH24:MI:SS') AS started
              FROM gv$sql_monitor
             WHERE sql_id = :s AND px_server# IS NULL
             ORDER BY sql_exec_start DESC FETCH FIRST 1 ROWS ONLY
        """, {"s": sql_id})
        cs = [c[0].lower() for c in cursor.description]
        ov = [dict(zip(cs, row)) for row in cursor.fetchall()]
        if not ov:
            return {"monitored": False}
        cursor.execute("SELECT DBMS_SQL_MONITOR.REPORT_SQL_MONITOR(sql_id=>:s, type=>'TEXT') AS report FROM dual",
                       {"s": sql_id})
        rc = [c[0].lower() for c in cursor.description]
        rr = [dict(zip(rc, row)) for row in cursor.fetchall()]
        return {"monitored": True, "overview": ov[0], "report": (str(rr[0].get("report")) if rr else "")}
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


# =============================================================================
# RBAC / access control — reads only. `ols_users` is NEVER modified here (it holds
# the identity + base role: IS_ADMIN / IS_READ / IS_SALT + LGCL_DEL_FLG). Grants
# (the fine-grained overrides) live in `ols_app_access`. These two reads feed the
# access snapshot assembled in `access_api.py`. See RBAC_DESIGN.md.
# =============================================================================

def fetch_user_identity(db_config: Any, username: str) -> dict | None:
    """One row from `ols_users` for the signed-in user (case-insensitive match): identity +
    the active flag (LGCL_DEL_FLG) + the base-role flags. `None` when the user does not exist.
    The API layer treats LGCL_DEL_FLG != 'N' as inactive (gate 1). Read-only — no writes."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT username, firstname, lastname, emailid, lgcl_del_flg,
                   is_admin, is_read, is_salt
              FROM ols_users
             WHERE UPPER(username) = UPPER(:u)
        """, {"u": username})
        cols = [c[0].lower() for c in cursor.description]
        rows = [dict(zip(cols, row)) for row in cursor.fetchall()]
        return rows[0] if rows else None
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_user_grants(db_config: Any, username: str, app_env: str) -> list[dict]:
    """Active override grants for a user from `ols_app_access`, scoped to the given environment
    (rows where APP_ENV matches, or the wildcard '*'). Each row: resource_type, resource_scope,
    resource_key, access_level. The API layer resolves these into the effective snapshot."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT username, resource_type, resource_scope, resource_key, access_level, app_env
              FROM ols_app_access
             WHERE UPPER(username) = UPPER(:u)
               AND is_active = 'Y'
               AND (app_env = :env OR app_env = '*')
        """, {"u": username, "env": app_env})
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, row)) for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


# =============================================================================
# User Management — the ops-admin gate (`ols_ops_access`) + grant read/write.
#
# `ols_ops_access` is the super-exclusive gate for the User Management screen: a UID in it
# (is_active='Y') may open the screen AND hand out grants. It is SEPARATE from ols_users
# (identity/role) and ols_app_access (grants). No audit table by design — revoke = hard DELETE.
# These are the ONLY writes in the access system; every caller is re-checked as an ops-admin in
# the API layer, and `granted_by` should be the caller's token identity. See RBAC_DESIGN.md.
# =============================================================================

def fetch_is_ops_admin(db_config: Any, username: str) -> bool:
    """True iff `username` may use User Management — an active row with can_users='Y'. Independent
    of can_sql (S-Studio), so an S-Studio-only operator is NOT an ops-admin."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT 1 FROM ols_ops_access
             WHERE UPPER(username) = UPPER(:u) AND is_active = 'Y' AND can_users = 'Y'
        """, {"u": username})
        return cursor.fetchone() is not None
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_ops_admins(db_config: Any) -> list[dict]:
    """Every row in `ols_ops_access` (who may use User Management + their S-Studio flag), active
    first then by name."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT username, is_active, can_users, can_sql FROM ols_ops_access
             ORDER BY is_active DESC, UPPER(username)
        """)
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, row)) for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_can_sql(db_config: Any, username: str) -> bool:
    """True iff `username` is an ACTIVE ops-admin WITH `can_sql='Y'` — the S-Studio gate."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT 1 FROM ols_ops_access
             WHERE UPPER(username) = UPPER(:u) AND is_active = 'Y' AND can_sql = 'Y'
        """, {"u": username})
        return cursor.fetchone() is not None
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def ops_admin_set_users(db_config: Any, username: str, allowed: bool) -> int:
    """Grant/revoke User Management (`can_users`) for an existing operator. Returns rows changed.
    Commits. WRITE — ops-admin only."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            UPDATE ols_ops_access SET can_users = :flag WHERE UPPER(username) = UPPER(:u)
        """, {"flag": "Y" if allowed else "N", "u": username})
        n = cursor.rowcount
        connection.commit()
        return n
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def ops_admin_set_sql(db_config: Any, username: str, allowed: bool) -> int:
    """Grant/revoke S-Studio (`can_sql`) for an existing operator. Returns rows changed. Commits.
    WRITE — ops-admin only."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            UPDATE ols_ops_access SET can_sql = :flag WHERE UPPER(username) = UPPER(:u)
        """, {"flag": "Y" if allowed else "N", "u": username})
        n = cursor.rowcount
        connection.commit()
        return n
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_all_grants(db_config: Any, username: str) -> list[dict]:
    """Every ACTIVE `ols_app_access` grant for one user across all environments — the rows the
    User Management screen lists (and can revoke). Ordered for a stable display."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT username, resource_type, resource_scope, resource_key, access_level, app_env
              FROM ols_app_access
             WHERE UPPER(username) = UPPER(:u) AND is_active = 'Y'
             ORDER BY resource_type, resource_scope, UPPER(resource_key), app_env
        """, {"u": username})
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, row)) for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def fetch_server_names(db_config: Any) -> list[str]:
    """Distinct Log-Analytics server names from `ols_server_log_config` — feeds the grant
    catalogue's server picker. Best-effort: the caller wraps this so a missing table just yields
    an empty list (the UI still allows '*' and free-text)."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT DISTINCT server_name FROM ols_server_log_config
             WHERE server_name IS NOT NULL ORDER BY server_name
        """)
        return [row[0] for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def grant_upsert(db_config: Any, username: str, resource_type: str, resource_scope: str,
                 resource_key: str, access_level: str, app_env: str, granted_by: str) -> None:
    """Insert or update ONE `ols_app_access` grant (idempotent on its natural key). Re-granting the
    same resource updates the level and re-activates the row. Commits. WRITE — ops-admin only."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            MERGE INTO ols_app_access t
            USING (SELECT :u username, :rt resource_type, :rs resource_scope, :rk resource_key,
                          :lvl access_level, :env app_env, :gb granted_by FROM dual) s
               ON (UPPER(t.username) = UPPER(s.username) AND t.resource_type = s.resource_type
                   AND t.resource_scope = s.resource_scope
                   AND UPPER(t.resource_key) = UPPER(s.resource_key) AND t.app_env = s.app_env)
            WHEN MATCHED THEN UPDATE SET t.access_level = s.access_level, t.is_active = 'Y',
                                         t.granted_by = s.granted_by, t.granted_on = SYSDATE
            WHEN NOT MATCHED THEN
                INSERT (username, resource_type, resource_scope, resource_key,
                        access_level, app_env, is_active, granted_by, granted_on)
                VALUES (s.username, s.resource_type, s.resource_scope, s.resource_key,
                        s.access_level, s.app_env, 'Y', s.granted_by, SYSDATE)
        """, {"u": username, "rt": resource_type, "rs": resource_scope, "rk": resource_key,
              "lvl": access_level, "env": app_env, "gb": granted_by})
        connection.commit()
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def grant_delete(db_config: Any, username: str, resource_type: str, resource_scope: str,
                 resource_key: str, app_env: str) -> int:
    """Hard-DELETE one `ols_app_access` grant by its natural key (no audit kept). Returns the number
    of rows removed. Commits. WRITE — ops-admin only."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            DELETE FROM ols_app_access
             WHERE UPPER(username) = UPPER(:u) AND resource_type = :rt AND resource_scope = :rs
               AND UPPER(resource_key) = UPPER(:rk) AND app_env = :env
        """, {"u": username, "rt": resource_type, "rs": resource_scope, "rk": resource_key, "env": app_env})
        n = cursor.rowcount
        connection.commit()
        return n
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def ops_admin_upsert(db_config: Any, username: str) -> None:
    """Add (or re-activate) an ops-admin in `ols_ops_access`. Commits. WRITE — ops-admin only."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            MERGE INTO ols_ops_access t
            USING (SELECT :u username FROM dual) s
               ON (UPPER(t.username) = UPPER(s.username))
            WHEN MATCHED THEN UPDATE SET t.is_active = 'Y'
            WHEN NOT MATCHED THEN INSERT (username, is_active) VALUES (s.username, 'Y')
        """, {"u": username})
        connection.commit()
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def ops_admin_set_active(db_config: Any, username: str, active: bool) -> int:
    """Enable/disable an existing ops-admin by flipping `is_active` (the "edit" action — the row stays,
    access is turned off/on). Returns rows changed. Commits. WRITE — ops-admin only."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            UPDATE ols_ops_access SET is_active = :flag WHERE UPPER(username) = UPPER(:u)
        """, {"flag": "Y" if active else "N", "u": username})
        n = cursor.rowcount
        connection.commit()
        return n
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def ops_admin_delete(db_config: Any, username: str) -> int:
    """Hard-DELETE an ops-admin from `ols_ops_access` (no audit). Returns rows removed. Commits.
    WRITE — ops-admin only. (No self-lockout guard: the UI may remove any UID, incl. the caller's.)"""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("DELETE FROM ols_ops_access WHERE UPPER(username) = UPPER(:u)", {"u": username})
        n = cursor.rowcount
        connection.commit()
        return n
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


# =============================================================================
# S-Studio — raw SQL / PL-SQL console (Config Ops, ops-admins with can_sql only).
#
# Runs whatever the operator types against ONE target database. SELECT → columns+rows;
# DML/DDL/anonymous-PL-SQL/deploy → a status message; Oracle errors → the ORA-xxxxx text.
# MANUAL COMMIT: the connection has autocommit OFF and is CLOSED after each run, so uncommitted
# DML rolls back — nothing persists unless the operator's script includes an explicit COMMIT
# (DDL still auto-commits in Oracle). SECURITY: `db_config` here MUST be a PRIVILEGED connection,
# separate from the OCC read-only monitor (see RBAC_DESIGN.md). The API layer re-checks can_sql.
# =============================================================================

SQL_STUDIO_MAX_ROWS = int(os.environ.get("SQL_STUDIO_MAX_ROWS", "1000"))


def _cell(v: Any) -> Any:
    """Make one result cell JSON-safe for the UI grid."""
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.isoformat(sep=" ") if isinstance(v, datetime.datetime) else v.isoformat()
    if isinstance(v, (bytes, bytearray)):
        return f"({len(v)} bytes)"
    return str(v)


def _looks_like_plsql(text: str) -> bool:
    """True for an anonymous block or a stored-object CREATE (executed as ONE unit, not ;-split)."""
    head = text.lstrip().upper()
    if head.startswith("BEGIN") or head.startswith("DECLARE"):
        return True
    return bool(re.match(
        r"CREATE\s+(OR\s+REPLACE\s+)?(EDITIONABLE\s+|NONEDITIONABLE\s+)?"
        r"(PACKAGE\s+BODY|PACKAGE|PROCEDURE|FUNCTION|TRIGGER|TYPE\s+BODY|TYPE)\b", head))


def _split_sql_statements(text: str) -> list[str]:
    """Split a plain-SQL script on `;`, ignoring semicolons inside single-quoted strings and
    `--` line comments. (PL/SQL blocks are handled whole by _looks_like_plsql, not split here.)"""
    out: list[str] = []
    buf: list[str] = []
    i, n = 0, len(text)
    in_quote = False
    while i < n:
        c = text[i]
        if in_quote:
            buf.append(c)
            if c == "'":
                in_quote = False
            i += 1
            continue
        if c == "'":
            in_quote = True
            buf.append(c)
            i += 1
            continue
        if c == "-" and i + 1 < n and text[i + 1] == "-":     # -- line comment
            while i < n and text[i] != "\n":
                buf.append(text[i])
                i += 1
            continue
        if c == ";":
            out.append("".join(buf))
            buf = []
            i += 1
            continue
        buf.append(c)
        i += 1
    tail = "".join(buf)
    out.append(tail)
    return [s for s in (st.strip() for st in out) if s]


def _exec_message(stmt: str, rowcount: int | None) -> str:
    """Friendly status for a non-SELECT statement."""
    head = stmt.lstrip().upper()
    verb = head.split(None, 1)[0] if head else "STATEMENT"
    dml = {"INSERT": "inserted", "UPDATE": "updated", "DELETE": "deleted", "MERGE": "merged"}
    if verb in dml:
        rc = rowcount if (rowcount or 0) >= 0 else 0
        return f"{rc} row{'' if rc == 1 else 's'} {dml[verb]}."
    if verb == "COMMIT":
        return "Commit complete."
    if verb == "ROLLBACK":
        return "Rollback complete."
    return f"{verb.title()} succeeded."


def _plsql_message(text: str) -> str:
    head = text.lstrip().upper()
    if head.startswith("BEGIN") or head.startswith("DECLARE"):
        return "PL/SQL procedure successfully completed."
    m = re.match(
        r"CREATE\s+(OR\s+REPLACE\s+)?(EDITIONABLE\s+|NONEDITIONABLE\s+)?"
        r"(PACKAGE\s+BODY|PACKAGE|PROCEDURE|FUNCTION|TRIGGER|TYPE\s+BODY|TYPE)\b", head)
    obj = m.group(3).title() if m else "Object"
    return f"{obj} created."


def execute_sql(db_config: Any, sql: str) -> dict:
    """Run one statement / block / script against `db_config` and return a UI-ready result:
      SELECT  → {kind:'select', columns, rows, row_count, truncated}
      other   → {kind:'exec',   message, rows_affected, statements}
      failure → {kind:'error',  error}   (the ORA-xxxxx message)
    Autocommit is OFF and the connection is closed after the run (manual COMMIT — see module note)."""
    text = (sql or "").strip()
    if not text:
        return {"kind": "error", "error": "No SQL to run."}
    text = text.rstrip().rstrip("/").rstrip()      # tolerate a trailing SQL*Plus '/'
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        if _looks_like_plsql(text):
            cursor.execute(text)
            rc = cursor.rowcount
            return {"kind": "exec", "message": _plsql_message(text),
                    "rows_affected": rc if (rc or 0) > 0 else None, "statements": 1}
        result: dict | None = None
        executed = 0
        for stmt in _split_sql_statements(text):
            cursor.execute(stmt)
            executed += 1
            if cursor.description:                 # a row source → SELECT-like
                cols = [d[0] for d in cursor.description]
                rows = cursor.fetchmany(SQL_STUDIO_MAX_ROWS + 1)
                truncated = len(rows) > SQL_STUDIO_MAX_ROWS
                rows = rows[:SQL_STUDIO_MAX_ROWS]
                result = {"kind": "select", "columns": cols,
                          "rows": [[_cell(v) for v in r] for r in rows],
                          "row_count": len(rows), "truncated": truncated, "statement": stmt}
            else:
                result = {"kind": "exec", "message": _exec_message(stmt, cursor.rowcount),
                          "rows_affected": cursor.rowcount if (cursor.rowcount or 0) >= 0 else None,
                          "statement": stmt}
        if result is None:
            return {"kind": "exec", "message": "Nothing to run.", "statements": 0}
        result["statements"] = executed
        return result
    except Exception as e:                          # includes oracledb.Error → the ORA-xxxxx text
        return {"kind": "error", "error": str(e).strip()}
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


# =============================================================================
# Regression screen — run + audit log (ols_regression_run / ols_regression_log) and the batch
# monitor query. DDL: sql/regression_setup.sql. OS-level ops (git/sqlplus/copy) live in
# regression_ops.py; ALL SQL for the feature is here (see RBAC_DESIGN.md / Regression screen).
# =============================================================================

def regression_run_start(db_config: Any, app_env: str, started_by: str) -> int:
    """Open a new regression run for this env; returns run_id. Commits."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        rid = cursor.var(int)
        cursor.execute("""
            INSERT INTO ols_regression_run (app_env, status, started_by)
            VALUES (:env, 'in_progress', :sb)
            RETURNING run_id INTO :rid
        """, {"env": app_env, "sb": started_by, "rid": rid})
        connection.commit()
        return int(rid.getvalue()[0])
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def regression_run_finish(db_config: Any, run_id: int, status: str = "complete") -> None:
    """Close out a regression run: set its status + end_time. Commits."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("UPDATE ols_regression_run SET status = :st, end_time = SYSTIMESTAMP WHERE run_id = :r",
                       {"st": status, "r": run_id})
        connection.commit()
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def regression_run_current(db_config: Any, app_env: str) -> dict | None:
    """The latest in-progress run for this env + the current status of each step (latest log row
    per step_key). Returns {run, steps:{step_key:{status,...}}} or None."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT run_id, app_env, status, started_by, start_time
              FROM ols_regression_run
             WHERE app_env = :env AND status = 'in_progress'
             ORDER BY run_id DESC FETCH FIRST 1 ROW ONLY
        """, {"env": app_env})
        row = cursor.fetchone()
        if not row:
            return None
        cols = [c[0].lower() for c in cursor.description]
        run = dict(zip(cols, row))
        rid = run["run_id"]
        cursor.execute("""
            SELECT step_key, status, performed_by, forced_by, start_time, end_time, task_completion_time
              FROM ols_regression_log l
             WHERE run_id = :r
               AND log_id = (SELECT MAX(log_id) FROM ols_regression_log
                              WHERE run_id = :r AND step_key = l.step_key)
        """, {"r": rid})
        scols = [c[0].lower() for c in cursor.description]
        steps = {r[0]: dict(zip(scols, r)) for r in cursor.fetchall()}
        # Flag any step that has been "in_progress" longer than the stale threshold — it may be stuck
        # (server/connection dropped between marking in_progress and writing the result).
        stale_secs = config_loader.regression_defaults()["step_stale_minutes"] * 60
        now = datetime.datetime.now()
        for s in steps.values():
            started = s.get("start_time")
            if s.get("status") == "in_progress" and isinstance(started, datetime.datetime):
                age = int((now - started).total_seconds())
                s["age_seconds"] = age
                s["stale"] = age > stale_secs
            else:
                s["stale"] = False
        return {"run": run, "steps": steps}
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def regression_step_state(db_config: Any, run_id: int, step_key: str) -> dict | None:
    """Latest {status, performed_by, start_time, age_seconds} for one step — the concurrency lock reads
    this to decide whether the step is already running (and, if in_progress, how long)."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT status, performed_by, start_time
              FROM ols_regression_log
             WHERE run_id = :r AND step_key = :k
             ORDER BY log_id DESC FETCH FIRST 1 ROW ONLY
        """, {"r": run_id, "k": step_key})
        row = cursor.fetchone()
        if not row:
            return None
        status, performed_by, start_time = row
        age = None
        if status == "in_progress" and isinstance(start_time, datetime.datetime):
            age = int((datetime.datetime.now() - start_time).total_seconds())
        return {"status": status, "performed_by": performed_by, "start_time": start_time, "age_seconds": age}
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def regression_log_write(db_config: Any, run_id: int, step_key: str, action: str, status: str,
                         performed_by: str, business_line: str | None = None,
                         forced_by: str | None = None, comments: str | None = None,
                         start_time: Any = None, end_time: Any = None) -> None:
    """Append one audit row. task_completion_time = end-start (seconds) when both given.
    Commits. `comments` is the CLOB describing what was done."""
    duration = None
    if start_time and end_time:
        try:
            duration = int((end_time - start_time).total_seconds())
        except Exception:  # noqa: BLE001
            duration = None
    connection = None
    cursor = None
    try:
        import oracledb
        connection = connect(db_config)
        cursor = connection.cursor()
        # bind `comments` as CLOB so long file-copy / sqlplus logs (>4000 bytes) persist without ORA-01461
        cursor.setinputsizes(det=oracledb.DB_TYPE_CLOB)
        cursor.execute("""
            INSERT INTO ols_regression_log
                (run_id, business_line, step_key, action, status, performed_by,
                 start_time, end_time, task_completion_time, forced_by, comments)
            VALUES (:r, :bl, :sk, :ac, :st, :sb,
                    COALESCE(:so, SYSTIMESTAMP), :fo, :dur, :fb, :det)
        """, {"r": run_id, "bl": business_line, "sk": step_key, "ac": action, "st": status,
              "sb": performed_by, "so": start_time, "fo": end_time, "dur": duration,
              "fb": forced_by, "det": comments})
        connection.commit()
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def regression_activity(db_config: Any, run_id: int | None = None, limit: int = 200) -> list[dict]:
    """Recent audit rows for the Regression Activity grid (optionally scoped to one run)."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        where = "WHERE run_id = :r" if run_id else ""
        binds = {"lim": limit}
        if run_id:
            binds["r"] = run_id
        cursor.execute(f"""
            SELECT load_dt, log_id, run_id, business_line, step_key, action, status, performed_by,
                   start_time, end_time, task_completion_time, forced_by, comments
              FROM ols_regression_log
              {where}
             ORDER BY log_id DESC FETCH FIRST :lim ROWS ONLY
        """, binds)
        cols = [c[0].lower() for c in cursor.description]
        return [dict(zip(cols, [_cell(v) for v in row])) for row in cursor.fetchall()]
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


# Batch-monitor query — REPLACE the SQL body with your real batch-status query. It runs against the
# selected DB and its result set is shown as-is in the "Monitoring Batches" grid.
BATCH_MONITOR_SQL = """
    SELECT g.group_name       AS business_line,
           j.job_name         AS batch,
           j.status_id        AS status_id,
           j.last_start_time  AS started,
           j.last_end_time    AS finished
      FROM bm_job_utils j
      LEFT JOIN bm_groups g ON g.group_id = j.group_id
     ORDER BY g.group_name, j.job_name
"""


def fetch_batch_monitor(db_config: Any, max_rows: int | None = None) -> dict:
    """Run BATCH_MONITOR_SQL against `db_config`; return {columns, rows} for the grid. Returns the whole
    result set (the UI paginates/filters/sorts client-side). ``max_rows`` is only a safety ceiling —
    default from ``REGRESSION_BATCH_MAX_ROWS`` (100000); the grid is virtualized, so this is effectively
    'all'. Raise the env value if a batch-status query can legitimately exceed it."""
    cap = max_rows or config_loader.regression_defaults()["batch_max_rows"]
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute(BATCH_MONITOR_SQL)
        columns = [d[0] for d in cursor.description]
        rows = cursor.fetchmany(cap)
        return {"columns": columns, "rows": [[_cell(v) for v in r] for r in rows], "row_count": len(rows)}
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


# =============================================================================
# Config Ops — CSV Upload & Load (see GUIDE.md §4, "Config Ops — CSV Upload & Load")
# Identifiers (table/columns) are interpolated (Oracle can't bind them), so they MUST be validated
# against the catalogue by the API layer AND regex-checked here (defense in depth). Values are bound.
# =============================================================================

_IDENT_RE = re.compile(r"^[A-Za-z0-9_$#]+$")


def _is_ident(name: str) -> bool:
    return bool(name) and bool(_IDENT_RE.match(str(name)))


def config_table_columns(db_config: Any, table_name: str) -> list[dict]:
    """Authoritative column list for a table from the data dictionary (ALL_TAB_COLUMNS), in column
    order: [{name, type, nullable, data_length, data_scale}]. This — not a client list — is what the
    upload validates/casts against."""
    if not _is_ident(table_name):
        raise ValueError(f"Invalid table name: {table_name}")
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT column_name, data_type, nullable, data_length, data_scale, data_precision
              FROM all_tab_columns
             WHERE table_name = UPPER(:t)
             ORDER BY column_id
        """, {"t": table_name})
        out = []
        for name, dtype, nullable, dlen, dscale, dprec in cursor.fetchall():
            out.append({"name": name, "type": dtype, "nullable": nullable == "Y",
                        "data_length": dlen, "data_scale": dscale, "data_precision": dprec})
        return out
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def config_date_column(db_config: Any, table_name: str) -> str:
    """Return a table's date column via the customer's existing DB function
    ``ols_util.get_date_column(<table>)`` → 'COB_DT' / 'REPORTING_DT'. Defaults to 'COB_DT' when the
    function returns nothing."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        val = cursor.callfunc("ols_util.get_date_column", str, [table_name])
        return str(val).strip() if val and str(val).strip() else "COB_DT"
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def config_partition_status(db_config: Any, table: str, date_col: str, cob_dt: Any) -> dict:
    """Detect whether a load date's partition exists (detect-and-report; NO DDL). Returns a dict with
    ``covered``:
      True  → safe to load (not partitioned, INTERVAL/auto, partitioned by another key, has a MAXVALUE
              partition, or a real partition covers the date);
      False → the date is beyond the created RANGE partitions (partition/subpartition must be created);
      None  → couldn't determine → don't block (let the load run; any error surfaces to the UI).
    Also returns ``last_high`` (date the last partition covers up to) + scheme flags. Conservative: only
    returns False when it is confident a RANGE-by-date partition is missing."""
    if not (_is_ident(table) and _is_ident(date_col)):
        return {"covered": None}
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("SELECT partitioning_type, interval FROM all_part_tables WHERE table_name = UPPER(:t)", {"t": table})
        row = cursor.fetchone()
        if not row:
            return {"partitioned": False, "covered": True}          # not partitioned
        ptype, interval = row
        if interval:
            return {"partitioned": True, "interval": True, "covered": True}   # Oracle auto-creates on insert
        if str(ptype or "").upper() != "RANGE":
            return {"partitioned": True, "covered": True}           # LIST/HASH → not a "future date" concern
        cursor.execute("""SELECT column_name FROM all_part_key_columns
                          WHERE name = UPPER(:t) AND object_type = 'TABLE' ORDER BY column_position""", {"t": table})
        keys = [r[0].upper() for r in cursor.fetchall()]
        if not keys or keys[0] != date_col.upper():
            return {"partitioned": True, "covered": True}           # partitioned by something else
        cursor.execute("SELECT high_value FROM all_tab_partitions WHERE table_name = UPPER(:t)", {"t": table})
        max_dt = None
        for (hv,) in cursor.fetchall():
            if not hv:
                continue
            hv = str(hv)
            if "MAXVALUE" in hv.upper():
                return {"partitioned": True, "covered": True}       # a catch-all partition exists
            try:
                cursor.execute(f"SELECT ({hv}) FROM dual")          # hv is dictionary-sourced, not user input
                d = cursor.fetchone()[0]
                if isinstance(d, datetime.datetime) and (max_dt is None or d > max_dt):
                    max_dt = d
            except Exception:  # noqa: BLE001 — skip an unparseable bound, stay conservative
                continue
        if max_dt is None:
            return {"partitioned": True, "covered": None}
        # RANGE partitions are VALUES LESS THAN (high) → the date is covered iff it's below the last upper bound.
        return {"partitioned": True, "interval": False, "covered": cob_dt < max_dt, "last_high": max_dt.isoformat()[:10]}
    except Exception:  # noqa: BLE001 — never let the check itself block a load
        return {"covered": None}
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def config_load_table(db_config: Any, *, table: str, columns: list[str], rows: list,
                      mode: str, date_col: str | None = None, cob_dt: Any = None,
                      system_defaults: dict | None = None, lock_key: str | None = None,
                      locked_by: str | None = None, batch_size: int = 5000) -> dict:
    """Atomically load ``rows`` into ``table`` in ONE transaction (rolls back on any error):
      mode='append'  → INSERT only (no delete)
      mode='replace' → DELETE (whole table if date_col is None, else WHERE date_col = cob_dt) then INSERT.
    ``columns`` = ordered target columns (the file's columns); ``rows`` = tuples matching ``columns``
    (already type-cast by the API layer). ``system_defaults`` = {col: value} appended to every row
    (e.g. INSERTED_BY). Serializes concurrent loads of the same target via ``lock_key`` (SELECT FOR
    UPDATE NOWAIT). Returns {rows_deleted, rows_loaded}."""
    import oracledb
    if not _is_ident(table):
        raise ValueError(f"Invalid table name: {table}")
    for c in columns:
        if not _is_ident(c):
            raise ValueError(f"Invalid column name: {c}")
    if date_col is not None and not _is_ident(date_col):
        raise ValueError(f"Invalid date column: {date_col}")
    sys_cols = list((system_defaults or {}).keys())
    for c in sys_cols:
        if not _is_ident(c):
            raise ValueError(f"Invalid system column: {c}")
    sys_vals = [system_defaults[c] for c in sys_cols]
    all_cols = list(columns) + sys_cols

    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        # 1. serialize concurrent loads of the same target (auto-releases at commit/rollback)
        if lock_key:
            cursor.execute(
                "MERGE INTO ols_upload_lock l USING (SELECT :k AS lock_key FROM dual) s "
                "ON (l.lock_key = s.lock_key) "
                "WHEN NOT MATCHED THEN INSERT (lock_key) VALUES (s.lock_key)", {"k": lock_key})
            try:
                cursor.execute("SELECT locked_by FROM ols_upload_lock WHERE lock_key = :k FOR UPDATE NOWAIT", {"k": lock_key})
            except oracledb.DatabaseError as exc:
                if exc.args and getattr(exc.args[0], "code", None) == 54:  # ORA-00054 resource busy
                    raise RuntimeError(f"A load into '{table}' is already in progress. Try again shortly.") from exc
                raise
            cursor.execute("UPDATE ols_upload_lock SET locked_by = :sb, locked_on = SYSTIMESTAMP WHERE lock_key = :k",
                           {"sb": locked_by, "k": lock_key})
        # 2. delete per mode
        rows_deleted = 0
        if mode == "replace":
            if date_col:
                cursor.execute(f"DELETE FROM {table} WHERE {date_col} = :d", {"d": cob_dt})
            else:
                cursor.execute(f"DELETE FROM {table}")
            rows_deleted = cursor.rowcount or 0
        # 3. batched insert
        placeholders = ", ".join(f":{i + 1}" for i in range(len(all_cols)))
        sql = f"INSERT INTO {table} ({', '.join(all_cols)}) VALUES ({placeholders})"
        rows_loaded = 0
        for i in range(0, len(rows), batch_size):
            batch = rows[i:i + batch_size]
            cursor.executemany(sql, [tuple(r) + tuple(sys_vals) for r in batch])
            rows_loaded += len(batch)
        connection.commit()
        return {"rows_deleted": rows_deleted, "rows_loaded": rows_loaded}
    except Exception:
        if connection is not None:
            try:
                connection.rollback()
            except Exception:  # noqa: BLE001
                pass
        raise
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def config_roll_dates(db_config: Any, *, table: str, source_date: Any, target_dates: list,
                      uid: str | None = None, tablespace: str | None = None) -> dict:
    """Roll ``source_date`` into each ``target_date`` by calling the customer's standard
    ``ols_util.roll_static_data(table, fromdt, todt_list, tablespace, uid, errmsg OUT, rows OUT, src_rows OUT)``
    procedure ONCE. We hand it the five inputs — table, from date, the LIST of target dates (a
    ``SYS.ODCIVARCHAR2LIST`` of 'YYYY-MM-DD' strings), tablespace and uid — and the package does the rest
    (loops per date, TO_DATEs, commits, and counts rows using the date column it resolves internally).
    Three OUTs come back, all index-aligned with the input dates: ``errmsg`` (NULL = rolled, else the
    Oracle error → that date skipped, rest continue), ``rows`` (row count at each target after the roll),
    and ``src_rows`` (row count at the source date). The UI flags a target whose count differs from the
    source. Returns {source_date, source_count, targets:[{date, status, count, error?}]}."""
    import oracledb
    if not _is_ident(table):
        raise ValueError("Invalid table.")

    def _d(x: Any) -> str:                     # → 'YYYY-MM-DD' string
        return (x.isoformat() if hasattr(x, "isoformat") else str(x))[:10]

    def _n(x: Any) -> int | None:
        return int(x) if x is not None else None

    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        # all target dates in one built-in collection → the proc loops over them internally
        todt_list = connection.gettype("SYS.ODCIVARCHAR2LIST").newobject()
        todt_list.extend([_d(t) for t in target_dates])
        err_out = cursor.var(connection.gettype("SYS.ODCIVARCHAR2LIST"))   # per-date error (NULL = ok)
        rows_out = cursor.var(connection.gettype("SYS.ODCINUMBERLIST"))    # per-date row count after roll
        src_out = cursor.var(oracledb.DB_TYPE_NUMBER)                      # rows at the source date
        cursor.callproc("ols_util.roll_static_data",
                        [table, _d(source_date), todt_list, tablespace, uid, err_out, rows_out, src_out])
        errs = err_out.getvalue()
        err_list = errs.aslist() if errs is not None else []
        rws = rows_out.getvalue()
        rows_list = rws.aslist() if rws is not None else []
        source_count = _n(src_out.getvalue())
        targets = []
        for i, t in enumerate(target_dates):
            emsg = err_list[i] if i < len(err_list) else None
            cnt = rows_list[i] if i < len(rows_list) else None
            if emsg:
                targets.append({"date": _d(t), "status": "failed", "count": None, "error": str(emsg)})
            else:
                targets.append({"date": _d(t), "status": "success", "count": _n(cnt)})
        return {"source_date": _d(source_date), "source_count": source_count, "targets": targets}
    except Exception:
        if connection is not None:
            try:
                connection.rollback()          # best-effort; the proc commits per target internally
            except Exception:  # noqa: BLE001
                pass
        raise
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def config_upload_audit_write(db_config: Any, **f) -> int:
    """Write one ols_upload_audit row via the ``ols_upload_audit_write`` DB procedure and return the
    generated load_id. This layer holds NO column list — every audit field the caller passes is
    forwarded as a ``p_<name>`` param, so adding an audit column means changing only the proc (+ the
    caller that supplies the value), never this function. The proc runs as an autonomous transaction,
    so the row persists even when a failed load's own transaction rolls back. error_desc bound as CLOB."""
    import oracledb
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        params = {f"p_{k}": v for k, v in f.items()}     # forward whatever the caller supplied
        params["p_load_id"] = load_id = cursor.var(oracledb.DB_TYPE_NUMBER)
        if "p_error_desc" in params:
            cursor.setinputsizes(p_error_desc=oracledb.DB_TYPE_CLOB)
        cursor.callproc("ols_upload_audit_write", keyword_parameters=params)
        return int(load_id.getvalue())
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def config_column_detail(db_config: Any, table_name: str) -> dict:
    """Down-arrow expand detail → the table's **column definitions** from the data dictionary as a plain
    ``{cols, rows}`` (rendered as-is by the nested grid). Reuses ``config_table_columns``. If your real
    ``columnretrieve`` should return something else (e.g. related config rows), swap the body here."""
    coldefs = config_table_columns(db_config, table_name)
    cols = ["COLUMN_NAME", "DATA_TYPE", "NULLABLE", "DATA_LENGTH", "DATA_PRECISION", "DATA_SCALE"]
    rows = [[c["name"], c["type"], "Y" if c["nullable"] else "N",
             c["data_length"], c["data_precision"], c["data_scale"]] for c in coldefs]
    return {"cols": cols, "rows": rows}


def _content_scalar(v: Any):
    """Make a fetched cell JSON-safe for the self-describing content response: datetimes → ISO strings,
    BLOB/RAW bytes → a short base64 preview (the grid shows a token anyway), Decimal → float. CLOBs are
    already converted to str by the connection's LOB output handler; JSON columns come back as dict/list."""
    if v is None or isinstance(v, (str, int, float, bool, dict, list)):
        return v
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.isoformat()
    if isinstance(v, bytes):
        import base64
        return "data:application/octet-stream;base64," + base64.b64encode(v[:4096]).decode("ascii")
    from decimal import Decimal
    if isinstance(v, Decimal):
        return float(v)
    return str(v)


def config_table_content(db_config: Any, *, table: str, date_col: str | None = None, is_cob: bool = False,
                         start_date: Any = None, end_date: Any = None, date_range: bool = False,
                         row_cap: int = 5000) -> dict:
    """Read a config table's rows for the eye-view — **self-describing** ``{cols, cols_data_types,
    Table_data}``. Each ``Table_data`` record is keyed by column name PLUS a hidden ``rowid`` (used by
    update/delete). For a COB table the resolved ``date_col`` is filtered by the chosen date(s): a
    ``date_range`` uses ``>= start AND < end+1``; otherwise the two discrete days are matched. Non-COB
    tables return the whole table, capped at ``row_cap`` (day boundaries computed in Python so the
    predicate stays index/partition friendly)."""
    if not _is_ident(table):
        raise ValueError(f"Invalid table name: {table}")
    where = ""
    binds: dict = {}
    if is_cob and date_col and start_date is not None:
        if not _is_ident(date_col):
            raise ValueError(f"Invalid date column: {date_col}")
        d1 = start_date
        d2 = end_date if end_date is not None else start_date
        one = datetime.timedelta(days=1)
        if date_range:
            where = f" WHERE {date_col} >= :d1 AND {date_col} < :d2"
            binds = {"d1": d1, "d2": d2 + one}
        else:
            where = (f" WHERE ({date_col} >= :d1 AND {date_col} < :d1e)"
                     f" OR ({date_col} >= :d2 AND {date_col} < :d2e)")
            binds = {"d1": d1, "d1e": d1 + one, "d2": d2, "d2e": d2 + one}
    cap = int(row_cap) if (row_cap and int(row_cap) > 0) else 5000
    sql = f"SELECT t.ROWID AS OLS_ROWID, t.* FROM {table} t{where} FETCH FIRST {cap} ROWS ONLY"
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute(sql, binds)
        names = [d[0] for d in cursor.description]           # [OLS_ROWID, col1, col2, …]
        cols = names[1:]
        cols_types = [str(d[1]) for d in cursor.description[1:]]
        table_data = []
        for row in cursor.fetchall():
            rec = {names[i]: _content_scalar(row[i]) for i in range(1, len(names))}
            rec["rowid"] = str(row[0])
            table_data.append(rec)
        return {"cols": cols, "cols_data_types": cols_types, "Table_data": table_data}
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def config_update_rows(db_config: Any, *, table: str, updates: list, audit: dict | None = None) -> int:
    """UPDATE rows **by ROWID** in one transaction. ``updates`` = ``[{ "<rowid>": { COL: value } }]``
    (values already type-cast by the API layer). ``audit`` = {col: value} merged into every SET (e.g.
    UPDATED_BY/UPDATED_DATE, for the audit columns that exist). Rolls back on any error. Returns the
    number of rows updated."""
    if not _is_ident(table):
        raise ValueError(f"Invalid table name: {table}")
    audit = audit or {}
    for c in audit:
        if not _is_ident(c):
            raise ValueError(f"Invalid audit column: {c}")
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        total = 0
        for upd in updates:
            if not upd:
                continue
            rowid, changes = next(iter(upd.items()))
            change_cols = list(changes.keys())
            for c in change_cols:
                if not _is_ident(c):
                    raise ValueError(f"Invalid column name: {c}")
            set_cols = change_cols + list(audit.keys())
            if not set_cols:
                continue
            set_sql = ", ".join(f"{c} = :{i + 1}" for i, c in enumerate(set_cols))
            binds = [changes[c] for c in change_cols] + [audit[c] for c in audit]
            binds.append(str(rowid))                      # WHERE ROWID = :<last>
            cursor.execute(f"UPDATE {table} SET {set_sql} WHERE ROWID = :{len(set_cols) + 1}", binds)
            total += cursor.rowcount or 0
        connection.commit()
        return total
    except Exception:
        if connection is not None:
            try:
                connection.rollback()
            except Exception:  # noqa: BLE001
                pass
        raise
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()


def config_delete_rows(db_config: Any, *, table: str, rowids: list) -> int:
    """DELETE rows **by ROWID** in one transaction (batched). Rolls back on any error. Returns the
    number of rows deleted. (DELETE, never TRUNCATE — atomic + rollback-safe.)"""
    if not _is_ident(table):
        raise ValueError(f"Invalid table name: {table}")
    ids = [(str(r),) for r in rowids if r not in (None, "")]
    if not ids:
        return 0
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.executemany(f"DELETE FROM {table} WHERE ROWID = :1", ids)
        deleted = cursor.rowcount or 0
        connection.commit()
        return deleted
    except Exception:
        if connection is not None:
            try:
                connection.rollback()
            except Exception:  # noqa: BLE001
                pass
        raise
    finally:
        if cursor:
            cursor.close()
        if connection is not None and connection is not db_config:
            connection.close()
