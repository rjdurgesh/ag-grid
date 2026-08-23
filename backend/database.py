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

from typing import Any


def connect(db_config: Any):
    """Open (or pass through) a DB connection for one scope's ``db_config``.

    Handles three shapes so it drops into most setups:
      * an already-live connection (has ``.cursor``)   → returned as-is (the caller won't close it);
      * a mapping with user/password/dsn               → ``oracledb.connect(**...)``;
      * a DSN / EZConnect string                       → ``oracledb.connect(dsn)``.
    Replace the body with your own connector if you connect differently.
    """
    if db_config is None:
        raise RuntimeError("No db_config for this scope (connection is None / DB unreachable).")
    if hasattr(db_config, "cursor"):          # already a live connection → reuse it
        return db_config
    import oracledb                            # lazy: the driver isn't needed in dummy mode
    if isinstance(db_config, dict):
        if not db_config:                      # empty stub (dev/dummy) — nothing to connect with
            raise RuntimeError("db_config is an empty stub; run with dummy mode, or provide real credentials.")
        return oracledb.connect(
            user=db_config.get("user"),
            password=db_config.get("password"),
            dsn=db_config.get("dsn") or db_config.get("connect_string"),
        )
    return oracledb.connect(str(db_config))    # a bare DSN / connect string


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

        cursor.execute("""
            SELECT s.segment_name AS index_name, i.table_name, i.index_type AS kind,
                   ROUND(SUM(s.bytes)/1024/1024/1024, 2) AS size_gb
              FROM dba_segments s
              JOIN dba_indexes  i ON i.owner = s.owner AND i.index_name = s.segment_name
             WHERE s.owner = :owner
               AND s.segment_type IN ('INDEX','INDEX PARTITION','INDEX SUBPARTITION')
             GROUP BY s.segment_name, i.table_name, i.index_type
             ORDER BY size_gb DESC
             FETCH FIRST :lim ROWS ONLY
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


def fetch_session_monitor(db_config: Any, sid: int) -> str | None:
    """Real-time SQL Monitor report for the session (DBMS_SQL_MONITOR.REPORT_SQL_MONITOR)."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute(
            "SELECT DBMS_SQL_MONITOR.REPORT_SQL_MONITOR(session_id=>:sid, type=>'TEXT') AS report FROM dual",
            {"sid": sid})
        cols = [c[0].lower() for c in cursor.description]
        rows = [dict(zip(cols, row)) for row in cursor.fetchall()]
        return rows[0].get("report") if rows else None
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


def fetch_session_rollback(db_config: Any, sid: int) -> int:
    """Rollback progress % for a KILLED session mid-rollback (v$session_longops). 0 if none."""
    connection = None
    cursor = None
    try:
        connection = connect(db_config)
        cursor = connection.cursor()
        cursor.execute("""
            SELECT NVL(ROUND(sofar * 100 / NULLIF(totalwork, 0)), 0) AS pct
              FROM v$session_longops
             WHERE sid = :sid AND opname = 'Transaction Rollback' AND sofar < totalwork
             ORDER BY start_time DESC FETCH FIRST 1 ROWS ONLY
        """, {"sid": sid})
        cols = [c[0].lower() for c in cursor.description]
        rows = [dict(zip(cols, row)) for row in cursor.fetchall()]
        return int(rows[0]["pct"]) if rows else 0
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
            "monitor":      lambda: fetch_session_monitor(connection, sid),
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
