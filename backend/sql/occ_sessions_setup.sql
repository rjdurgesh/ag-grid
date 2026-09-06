-- =============================================================================
-- Oracle Command Center — Sessions query as a DB procedure (SYS_REFCURSOR)
--
-- Moves the big session-inventory SELECT out of database.py into the DB so a DBA can
-- tune it and add/remove columns WITHOUT an app redeploy. The Python side just calls
-- ols_util.occ_sessions(...) and reads the returned cursors — columns come from the
-- cursor's description, so **column pass-through still holds** (add a column here and it
-- auto-displays on the grid).
--
-- Two OPTIONAL lookups (OLS user names, batch-job description) are resolved HERE: the
-- candidate table names are owned by this proc; the first that exists (and is visible to
-- THIS proc's owner) is used, else that column is emitted as NULL and the join dropped —
-- so the column SET is stable regardless of which DB / which tables exist, and a missing
-- or renamed table can never break the query.
--
-- Deploy under the OLS utility schema (adjust `ols_util`). Definer's rights: the proc
-- owner must be able to SELECT the optional tables + the V$/DBA_* views used below (grant
-- SELECT accordingly). The read-only monitor user only needs EXECUTE on this proc.
-- To change/remove a column: edit the SELECT text below (no app change). Reference only —
-- the app still runs the frontend/backend dummy in dev; this proc is used against a real DB.
-- =============================================================================

-- First candidate (owner.table, or bare name) that EXISTS + is visible to this schema.
CREATE OR REPLACE FUNCTION ols_util.occ_first_existing_table(p_candidates IN SYS.ODCIVARCHAR2LIST)
    RETURN VARCHAR2
AS
    l_owner VARCHAR2(128);
    l_name  VARCHAR2(128);
    l_cnt   PLS_INTEGER;
BEGIN
    IF p_candidates IS NULL THEN
        RETURN NULL;
    END IF;
    FOR i IN 1 .. p_candidates.COUNT LOOP
        IF p_candidates(i) IS NULL OR TRIM(p_candidates(i)) IS NULL THEN
            CONTINUE;
        END IF;
        IF INSTR(p_candidates(i), '.') > 0 THEN
            l_owner := UPPER(TRIM(SUBSTR(p_candidates(i), 1, INSTR(p_candidates(i), '.') - 1)));
            l_name  := UPPER(TRIM(SUBSTR(p_candidates(i), INSTR(p_candidates(i), '.') + 1)));
            SELECT COUNT(*) INTO l_cnt FROM all_objects
             WHERE owner = l_owner AND object_name = l_name
               AND object_type IN ('TABLE', 'VIEW', 'SYNONYM', 'MATERIALIZED VIEW') AND ROWNUM = 1;
        ELSE
            l_name := UPPER(TRIM(p_candidates(i)));
            SELECT COUNT(*) INTO l_cnt FROM all_objects
             WHERE object_name = l_name
               AND object_type IN ('TABLE', 'VIEW', 'SYNONYM', 'MATERIALIZED VIEW') AND ROWNUM = 1;
        END IF;
        IF l_cnt > 0 THEN
            RETURN p_candidates(i);
        END IF;
    END LOOP;
    RETURN NULL;
END occ_first_existing_table;
/

-- The session inventory. p_rows = the rich list (filtered by p_status); p_counts = per-state
-- counts for the tab badges (same base filter). Both are SYS_REFCURSORs the app fetches.
CREATE OR REPLACE PROCEDURE ols_util.occ_sessions(
    p_status  IN  VARCHAR2         DEFAULT 'active',   -- active | inactive | killed | all
    p_rows    OUT SYS_REFCURSOR,
    p_counts  OUT SYS_REFCURSOR
)
AS
    -- >>> Candidate lists OWNED HERE — edit to change the per-DB table names. First accessible wins.
    c_users SYS.ODCIVARCHAR2LIST := SYS.ODCIVARCHAR2LIST('OLS.OLS_USERS', 'PSN.PSN_USERS');
    c_batch SYS.ODCIVARCHAR2LIST := SYS.ODCIVARCHAR2LIST('OLS.OLSBM_BATCH_JOB_RUN');

    l_users VARCHAR2(128) := ols_util.occ_first_existing_table(c_users);
    l_batch VARCHAR2(128) := ols_util.occ_first_existing_table(c_batch);
    l_base  VARCHAR2(1000);
    l_sql   CLOB;
BEGIN
    -- Base exclusions: real user sessions only, never the monitor's own session, and skip Oracle
    -- background OS sessions (unless the OLS app user). Used by BOTH the list and the counts.
    l_base := q'{se.username IS NOT NULL AND se.audsid <> SYS_CONTEXT('USERENV','SESSIONID') AND se.sid <> SYS_CONTEXT('USERENV','SID') AND (se.osuser <> 'oracle' OR se.username = 'OLS')}';

    l_sql :=
        q'{SELECT se.status, }'
     || CASE WHEN l_batch IS NOT NULL THEN 'r.job_desc' ELSE 'CAST(NULL AS VARCHAR2(400))' END
     || q'{ AS job_desc, pxs.qcsid AS parent, se.sid, se.serial# AS serial#, se.blocking_session AS waiting_for, se.username, se.sql_id, sq.plan_hash_value, se.osuser, }'
     || CASE WHEN l_users IS NOT NULL
             THEN q'{(SELECT INITCAP(firstname || ' ' || surname) FROM }' || l_users
                  || q'{ pu WHERE pu.username = UPPER(REGEXP_SUBSTR(se.osuser, '^[^@]+')))}'
             ELSE q'{CAST(NULL AS VARCHAR2(200))}' END
     || q'{ AS ols_user, se.service_name, se.module, se.action, (SELECT RTRIM(o2.owner || '.' || o2.object_name || '.' || o2.subobject_name, '.') FROM dba_objects o2 WHERE o2.object_id = se.row_wait_obj#) AS wait_object, se.lockwait, se.client_info, RTRIM(o.owner || '.' || o.object_name, '.') AS called_from, (SELECT REGEXP_SUBSTR(s.text, '[^ ().]+', 1, 1) FROM dba_source s WHERE s.owner = o.owner AND s.type = o.object_type AND s.name = o.object_name AND s.line < sq.program_line# AND REGEXP_LIKE(s.text, '^[[:space:]]*(PROCEDURE|FUNCTION)[[:space:]]', 'i') ORDER BY s.line DESC FETCH FIRST 1 ROW ONLY) AS subprogram, NULLIF(sq.program_line#, 0) AS called_from_line, (SELECT aa.name FROM audit_actions aa WHERE aa.action <> 0 AND aa.action = se.command + CASE WHEN se.command < 0 THEN 256 ELSE 0 END) AS command, se.program, TO_CHAR(se.logon_time, 'DD-MON-YYYY HH24:MI:SS') AS logon_time, TO_CHAR(se.sql_exec_start, 'DD-MON-YYYY HH24:MI:SS') AS sql_exec_start, REGEXP_SUBSTR(CAST(NUMTODSINTERVAL(SYSDATE - se.sql_exec_start, 'DAY') AS INTERVAL DAY(1) TO SECOND(0)), '..:..:..') AS sql_elapsed, se.state, se.wait_class, CASE WHEN se.wait_time = 0 THEN se.seconds_in_wait END AS current_wait_secs, CASE WHEN se.wait_time > 0 THEN se.seconds_in_wait - se.wait_time / 100 END AS secs_since_last_wait, se.event AS current_wait, (SELECT RTRIM(pe.object_name || '.' || pe.procedure_name, '.') FROM dba_procedures pe WHERE pe.object_id = se.plsql_entry_object_id AND pe.subprogram_id = se.plsql_entry_subprogram_id) AS entry_procedure, (SELECT RTRIM(pc.object_name || '.' || pc.procedure_name, '.') FROM dba_procedures pc WHERE pc.object_id = se.plsql_object_id AND pc.subprogram_id = se.plsql_subprogram_id) AS current_procedure, se.row_wait_obj#, se.pdml_status, se.pq_status, LTRIM(pxs.degree || ' (' || pxs.req_degree || ')', '() ') AS "Parallel (Requested)", se.current_queue_duration, se.client_identifier, RAWTOHEX(se.saddr) AS saddr, RAWTOHEX(se.paddr) AS paddr, se.audsid, RAWTOHEX(se.taddr) AS taddr, se.machine, se.terminal, RAWTOHEX(se.sql_address) AS sql_address, se.sql_hash_value, se.sql_child_number, se.sql_exec_id, se.prev_sql_id, se.prev_child_number, se.user#, ROUND(sm.cpu, 1) AS cpu, sm.physical_reads, sm.logical_reads, ROUND(sm.pga_memory / 1048576, 1) AS pga_memory_mb, sm.hard_parses, sm.soft_parses, ROUND(sm.physical_read_pct, 1) AS physical_read_pct, ROUND(sm.logical_read_pct, 1) AS logical_read_pct, (SELECT ROUND(SUM(tu.blocks) * ts.block_size / POWER(1024, 3), 1) FROM v$tempseg_usage tu JOIN dba_tablespaces ts ON ts.tablespace_name = tu.tablespace WHERE tu.session_addr = se.saddr AND tu.session_num = se.serial# GROUP BY ts.block_size) AS temp_gb, ROW_NUMBER() OVER (ORDER BY sm.cpu DESC NULLS LAST) AS rank_by_cpu, ROW_NUMBER() OVER (ORDER BY sm.physical_reads DESC NULLS LAST) AS rank_by_physical_reads, ROW_NUMBER() OVER (ORDER BY sm.logical_reads DESC NULLS LAST) AS rank_by_logical_reads, ROW_NUMBER() OVER (ORDER BY sm.pga_memory DESC NULLS LAST) AS rank_by_pga, ROW_NUMBER() OVER (ORDER BY sm.cpu DESC NULLS LAST) + ROW_NUMBER() OVER (ORDER BY sm.physical_reads DESC NULLS LAST) + ROW_NUMBER() OVER (ORDER BY sm.logical_reads DESC NULLS LAST) + ROW_NUMBER() OVER (ORDER BY sm.pga_memory DESC NULLS LAST) AS ranks_combined, sq.sql_text FROM v$session se LEFT JOIN v$sql sq ON sq.sql_id = se.sql_id AND sq.child_number = se.sql_child_number LEFT JOIN dba_objects o ON o.object_id = sq.program_id LEFT JOIN v$px_session pxs ON pxs.sid = se.sid AND pxs.serial# = se.serial# LEFT JOIN v$sessmetric sm ON sm.session_id = se.sid AND sm.session_serial_num = se.serial# LEFT JOIN v$transaction tr ON tr.addr = se.taddr }'
     || CASE WHEN l_batch IS NOT NULL
             THEN q'{LEFT JOIN }' || l_batch
                  || q'{ r ON r.sid = NVL(pxs.qcsid, se.sid) AND r.serial# = NVL(pxs.qcserial#, se.serial#) }'
             ELSE '' END
     || q'{WHERE }' || l_base
     || q'{ AND (:status = 'all' OR LOWER(se.status) = :status) ORDER BY pxs.qcsid NULLS FIRST, pxs.qcserial# NULLS FIRST, se.sql_exec_start}';

    OPEN p_rows FOR l_sql USING p_status, p_status;

    OPEN p_counts FOR
        q'{SELECT LOWER(se.status) AS st, COUNT(*) AS c FROM v$session se WHERE }'
        || l_base || q'{ GROUP BY LOWER(se.status)}';
END occ_sessions;
/
