-- =============================================================================
-- Oracle Command Center — privileged ASYNC actions + status log
--
-- "Gather stats" (Session Details → Object Statistics) and "Force refresh"
-- (Materialized Views) can run for minutes, so the app must NOT block the HTTP
-- request on them. Each action is submitted as a one-off DBMS_SCHEDULER **background
-- job**; the endpoint returns immediately with an action_id, and the job records
-- RUNNING → SUCCESS/FAILED (with duration + error) in OLS_OCC_ACTION_LOG. The UI
-- live-polls that action_id and shows an Action History panel.
--
-- Deploy under the OLS utility schema (adjust `ols_util` / the owning schema).
-- Runs on a PRIVILEGED connection (app.state.sql_db_configs) — grant CREATE JOB +
-- EXECUTE on DBMS_STATS / DBMS_MVIEW, and SELECT on the log table to the read-only
-- monitor user (so it can show status/history). See database.py + oracle_cc_api.py.
-- =============================================================================

-- ---- status log + sequence --------------------------------------------------
CREATE SEQUENCE ols_occ_action_seq START WITH 1 INCREMENT BY 1 NOCACHE;

CREATE TABLE ols_occ_action_log (
    action_id      NUMBER        NOT NULL,
    action_type    VARCHAR2(20)  NOT NULL,          -- GATHER_STATS | MV_REFRESH | COMPRESS
    object_owner   VARCHAR2(128),
    object_name    VARCHAR2(128),
    partition_name VARCHAR2(128),                   -- COMPRESS only: the partition being moved/compressed
    subpartition_name VARCHAR2(128),                -- COMPRESS only: the subpartition (composite tables)
    method         VARCHAR2(30),                    -- MV: C|F|? ; COMPRESS: the compression type (BASIC/ADVANCED/QUERY HIGH…)
    requested_by   VARCHAR2(128),
    status         VARCHAR2(12)  NOT NULL,          -- RUNNING | SUCCESS | FAILED
    submitted_on   TIMESTAMP     DEFAULT SYSTIMESTAMP,
    started_on     TIMESTAMP,
    finished_on    TIMESTAMP,
    duration_secs  NUMBER,
    error_text     VARCHAR2(4000),
    job_name       VARCHAR2(128),
    CONSTRAINT ols_occ_action_log_pk PRIMARY KEY (action_id),
    CONSTRAINT ols_occ_action_type_ck CHECK (action_type IN ('GATHER_STATS','MV_REFRESH','COMPRESS')),
    CONSTRAINT ols_occ_action_status_ck CHECK (status IN ('RUNNING','SUCCESS','FAILED'))
);
CREATE INDEX ols_occ_action_log_ix ON ols_occ_action_log (submitted_on DESC);

-- ---- MIGRATION (existing installs only) — run if ols_occ_action_log predates COMPRESS -------
-- Adds the two partition columns, widens method, and allows the COMPRESS action_type. Safe to skip
-- on a fresh CREATE above. (Oracle can't modify a CHECK condition in place → drop + re-add.)
--   ALTER TABLE ols_occ_action_log ADD (partition_name VARCHAR2(128), subpartition_name VARCHAR2(128));
--   ALTER TABLE ols_occ_action_log MODIFY (method VARCHAR2(30));
--   ALTER TABLE ols_occ_action_log DROP CONSTRAINT ols_occ_action_type_ck;
--   ALTER TABLE ols_occ_action_log ADD  CONSTRAINT ols_occ_action_type_ck
--     CHECK (action_type IN ('GATHER_STATS','MV_REFRESH','COMPRESS'));

-- ---- worker: run one queued action, recording status/timing/errors ----------
-- Called by the scheduler job (never directly). Reads the queued row, does the work
-- at the right granularity / method, and stamps SUCCESS or FAILED + the ORA error.
CREATE OR REPLACE PROCEDURE ols_util.occ_run_action(p_action_id IN NUMBER) AS
    v_type    VARCHAR2(20);
    v_owner   VARCHAR2(128);
    v_object  VARCHAR2(128);
    v_method  VARCHAR2(30);
    v_part    VARCHAR2(128);
    v_subp    VARCHAR2(128);
    v_start   TIMESTAMP := SYSTIMESTAMP;
    v_partd   VARCHAR2(3);
    v_subpart VARCHAR2(30);
    v_gran    VARCHAR2(20);
    v_clause  VARCHAR2(60);
    v_ddl     VARCHAR2(600);
BEGIN
    SELECT action_type, object_owner, object_name, method, partition_name, subpartition_name
      INTO v_type, v_owner, v_object, v_method, v_part, v_subp
      FROM ols_occ_action_log WHERE action_id = p_action_id;

    UPDATE ols_occ_action_log SET status = 'RUNNING', started_on = v_start
     WHERE action_id = p_action_id;
    COMMIT;

    IF v_type = 'GATHER_STATS' THEN
        SELECT partitioned INTO v_partd
          FROM dba_tables WHERE owner = v_owner AND table_name = v_object;
        IF v_partd = 'YES' THEN
            SELECT subpartitioning_type INTO v_subpart
              FROM dba_part_tables WHERE owner = v_owner AND table_name = v_object;
            IF v_subpart IS NOT NULL AND v_subpart <> 'NONE' THEN
                v_gran := 'ALL';        -- partition + subpartition (+ global)
            ELSE
                v_gran := 'PARTITION';  -- partitions only
            END IF;
        ELSE
            v_gran := 'AUTO';           -- plain (non-partitioned) table
        END IF;
        DBMS_STATS.gather_table_stats(ownname => v_owner, tabname => v_object,
                                      granularity => v_gran, cascade => TRUE, no_invalidate => FALSE);
    ELSIF v_type = 'MV_REFRESH' THEN
        DBMS_MVIEW.REFRESH(list => v_owner || '.' || v_object, method => v_method, atomic_refresh => TRUE);
    ELSIF v_type = 'COMPRESS' THEN
        -- Map the UI compression type → storage clause. ROW STORE = heap (Advanced Compression option
        -- for ADVANCED/OLTP); COLUMN STORE = Hybrid Columnar Compression (Exadata / ZFSSA / licensed).
        CASE UPPER(v_method)
            WHEN 'BASIC'        THEN v_clause := 'ROW STORE COMPRESS BASIC';
            WHEN 'ADVANCED'     THEN v_clause := 'ROW STORE COMPRESS ADVANCED';
            WHEN 'OLTP'         THEN v_clause := 'ROW STORE COMPRESS ADVANCED';
            WHEN 'QUERY LOW'    THEN v_clause := 'COLUMN STORE COMPRESS FOR QUERY LOW';
            WHEN 'QUERY HIGH'   THEN v_clause := 'COLUMN STORE COMPRESS FOR QUERY HIGH';
            WHEN 'ARCHIVE LOW'  THEN v_clause := 'COLUMN STORE COMPRESS FOR ARCHIVE LOW';
            WHEN 'ARCHIVE HIGH' THEN v_clause := 'COLUMN STORE COMPRESS FOR ARCHIVE HIGH';
            ELSE v_clause := 'ROW STORE COMPRESS ADVANCED';
        END CASE;
        -- MOVE rebuilds the segment so EXISTING data is compressed. Identifiers are ENQUOTE_NAME'd
        -- (injection-safe). Add ONLINE before the clause if licensed (EE 12.2+) to avoid locking;
        -- UPDATE INDEXES keeps indexes usable. A DBA can tune this DDL (parallel, online, etc.).
        IF v_subp IS NOT NULL THEN
            v_ddl := 'ALTER TABLE ' || DBMS_ASSERT.ENQUOTE_NAME(v_owner) || '.' ||
                     DBMS_ASSERT.ENQUOTE_NAME(v_object) || ' MOVE SUBPARTITION ' ||
                     DBMS_ASSERT.ENQUOTE_NAME(v_subp) || ' ' || v_clause || ' UPDATE INDEXES';
        ELSE
            v_ddl := 'ALTER TABLE ' || DBMS_ASSERT.ENQUOTE_NAME(v_owner) || '.' ||
                     DBMS_ASSERT.ENQUOTE_NAME(v_object) || ' MOVE PARTITION ' ||
                     DBMS_ASSERT.ENQUOTE_NAME(v_part) || ' ' || v_clause || ' UPDATE INDEXES';
        END IF;
        EXECUTE IMMEDIATE v_ddl;
    END IF;

    UPDATE ols_occ_action_log
       SET status = 'SUCCESS', finished_on = SYSTIMESTAMP,
           duration_secs = ROUND((CAST(SYSTIMESTAMP AS DATE) - CAST(v_start AS DATE)) * 86400)
     WHERE action_id = p_action_id;
    COMMIT;
EXCEPTION
    WHEN OTHERS THEN
        UPDATE ols_occ_action_log
           SET status = 'FAILED', finished_on = SYSTIMESTAMP,
               duration_secs = ROUND((CAST(SYSTIMESTAMP AS DATE) - CAST(v_start AS DATE)) * 86400),
               error_text = SUBSTR(SQLERRM, 1, 4000)
         WHERE action_id = p_action_id;
        COMMIT;
        RAISE;   -- also mark the scheduler job run FAILED
END occ_run_action;
/

-- ---- submit: queue an action + kick off its background job -------------------
-- Both entry points INSERT a RUNNING row and create a one-off auto-drop job that
-- calls occ_run_action. They return the action_id so the API can hand it to the UI
-- for polling. p_type is set per entry point.
CREATE OR REPLACE PROCEDURE ols_util.occ_submit_gather(
    p_owner IN VARCHAR2, p_table IN VARCHAR2, p_by IN VARCHAR2, p_action_id OUT NUMBER
) AS
BEGIN
    p_action_id := ols_occ_action_seq.NEXTVAL;
    INSERT INTO ols_occ_action_log(action_id, action_type, object_owner, object_name, method,
                                   requested_by, status, submitted_on, job_name)
    VALUES (p_action_id, 'GATHER_STATS', p_owner, p_table, NULL, p_by, 'RUNNING', SYSTIMESTAMP,
            'OCC_ACT_' || p_action_id);
    COMMIT;
    DBMS_SCHEDULER.create_job(
        job_name   => 'OCC_ACT_' || p_action_id,
        job_type   => 'PLSQL_BLOCK',
        job_action => 'BEGIN ols_util.occ_run_action(' || p_action_id || '); END;',
        start_date => SYSTIMESTAMP, enabled => TRUE, auto_drop => TRUE);
END occ_submit_gather;
/

CREATE OR REPLACE PROCEDURE ols_util.occ_submit_mv_refresh(
    p_owner IN VARCHAR2, p_mview IN VARCHAR2, p_method IN VARCHAR2, p_by IN VARCHAR2, p_action_id OUT NUMBER
) AS
BEGIN
    p_action_id := ols_occ_action_seq.NEXTVAL;
    INSERT INTO ols_occ_action_log(action_id, action_type, object_owner, object_name, method,
                                   requested_by, status, submitted_on, job_name)
    VALUES (p_action_id, 'MV_REFRESH', p_owner, p_mview, p_method, p_by, 'RUNNING', SYSTIMESTAMP,
            'OCC_ACT_' || p_action_id);
    COMMIT;
    DBMS_SCHEDULER.create_job(
        job_name   => 'OCC_ACT_' || p_action_id,
        job_type   => 'PLSQL_BLOCK',
        job_action => 'BEGIN ols_util.occ_run_action(' || p_action_id || '); END;',
        start_date => SYSTIMESTAMP, enabled => TRUE, auto_drop => TRUE);
END occ_submit_mv_refresh;
/

-- Compress ONE partition or subpartition (the app submits one call per selected target). p_subpart is
-- NULL for a partition-level compress; p_type is the UI compression type (BASIC/ADVANCED/QUERY HIGH…).
CREATE OR REPLACE PROCEDURE ols_util.occ_submit_compress(
    p_owner IN VARCHAR2, p_table IN VARCHAR2, p_partition IN VARCHAR2,
    p_subpartition IN VARCHAR2, p_type IN VARCHAR2, p_by IN VARCHAR2, p_action_id OUT NUMBER
) AS
BEGIN
    p_action_id := ols_occ_action_seq.NEXTVAL;
    INSERT INTO ols_occ_action_log(action_id, action_type, object_owner, object_name, partition_name,
                                   subpartition_name, method, requested_by, status, submitted_on, job_name)
    VALUES (p_action_id, 'COMPRESS', p_owner, p_table, p_partition, p_subpartition, p_type, p_by,
            'RUNNING', SYSTIMESTAMP, 'OCC_ACT_' || p_action_id);
    COMMIT;
    DBMS_SCHEDULER.create_job(
        job_name   => 'OCC_ACT_' || p_action_id,
        job_type   => 'PLSQL_BLOCK',
        job_action => 'BEGIN ols_util.occ_run_action(' || p_action_id || '); END;',
        start_date => SYSTIMESTAMP, enabled => TRUE, auto_drop => TRUE);
END occ_submit_compress;
/
