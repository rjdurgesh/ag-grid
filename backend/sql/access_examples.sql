--------------------------------------------------------------------------------
-- OLS Dashboard — ACCESS GRANT COOKBOOK (ols_app_access)
--
-- A ready-to-run set of INSERTs for every access pattern. Pick a block, replace
-- 'CHANGE_ME' with the real username, and run it. Model + full reference: RBAC_DESIGN.md.
--
--   * ADMIN users need NO rows here — set IS_ADMIN='Y' on ols_users for full access.
--     These grants are for READ / SALT users (opt-in: they see ONLY what's granted)…
--   * …EXCEPT the two DEFAULT screens: **Log Analytics** and **Infrastructure Health** are visible
--     to EVERY active OLS user with NO grant at all (ungated — all servers / all apps). Do NOT try
--     to grant or restrict them; the old SERVER / APP-infra_health grants are retired (ignored).
--   * WRITE includes read; READ is view-only.  DENY subtracts / hides.
--   * Table structure + the CHECK constraint (must allow all resource_type values below)
--     live in rbac_setup.sql. Revoke = UPDATE ... SET is_active='N' (keeps the audit row).
--
--   * VALIDATE ON SCREEN (dev, no DB needed): run in the browser console
--       localStorage.setItem('ols.devScenario','defaults_only'); location.reload();
--     scenarios: admin | defaults_only | not_provisioned | config_group_cib | occ_group_write |
--     service_console | ops_admin | sql_studio   (clear: localStorage.removeItem('ols.devScenario'))
--
-- resource_type : SCREEN | APP | DB | TABLE_CATEGORY | TABLE | SECTION
--   (SERVER and APP/infra_health are retired — Log Analytics + Infra Health are ungated defaults.)
--------------------------------------------------------------------------------
SET DEFINE OFF;   -- '&' in comments/values is literal, not a substitution prompt

--==============================================================================
-- 0) FULL ACCESS  (the SCREEN / '*' / '*' wildcard = everything, in ONE row)
--==============================================================================
-- Full READ — see every screen / tab / app / table, read-only (no write buttons anywhere)
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SCREEN','*','*','READ','PROD','ADMIN','FULL read access to everything');

-- Full READ + WRITE — everything, plus every action (kill, start/stop, add/edit/delete, apply)
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SCREEN','*','*','WRITE','PROD','ADMIN','FULL read+write access to everything');


--==============================================================================
-- 1) LOG ANALYTICS + INFRASTRUCTURE HEALTH   →   NO GRANT NEEDED (default screens)
--==============================================================================
-- Both are visible to EVERY active OLS user by default (ungated — all servers / all apps shown).
-- There is nothing to insert here, and no way to restrict them per-user. The old grants
--   ('SERVER','log_analytics',…)  and  ('APP','infra_health',…)  are RETIRED and ignored.
-- (See scenario 'defaults_only' to eyeball what a user with no other access sees.)


--==============================================================================
-- 2) CONFIG OPS CONSOLE   (3 scopes: group | cib | retail; access is per-table)
--    scope = config_ops:group | config_ops:cib | config_ops:retail
--    A scope becomes visible when the user has ≥1 grant in it. WRITE = add/edit/delete on
--    that table; READ = view only. Category keys: OMT-FUNCTIONAL | OMT-TECHNICAL | OMT-BOTH
--    (OMT-BOTH grant = ALL tables in the scope; TECHNICAL/FUNCTIONAL also include BOTH tables).
--==============================================================================
-- Read/write to ONLY the OLS GROUP and OLS CIB screens (all their tables; RETAIL hidden)
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','TABLE_CATEGORY','config_ops:group','OMT-BOTH','WRITE','PROD','ADMIN','Config: GROUP, all tables, write');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','TABLE_CATEGORY','config_ops:cib','OMT-BOTH','WRITE','PROD','ADMIN','Config: CIB, all tables, write');

-- Read/write to ONLY OLS GROUP and ALL its tables
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','TABLE_CATEGORY','config_ops:group','OMT-BOTH','WRITE','PROD','ADMIN','Config: GROUP, all tables, write');

-- Read/write to ONLY OLS GROUP and only the OMT-FUNCTIONAL tables
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','TABLE_CATEGORY','config_ops:group','OMT-FUNCTIONAL','WRITE','PROD','ADMIN','Config: GROUP, functional tables, write');

-- Read/write to GROUP: all OMT-FUNCTIONAL tables + one OMT-TECHNICAL table ("ABC_NAME")
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','TABLE_CATEGORY','config_ops:group','OMT-FUNCTIONAL','WRITE','PROD','ADMIN','Config: GROUP functional tables');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','TABLE','config_ops:group','ABC_NAME','WRITE','PROD','ADMIN','Config: GROUP + one technical table');

-- Read/write to GROUP: exactly one table from each category (name the actual tables)
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','TABLE','config_ops:group','GRP_COST_CENTER','WRITE','PROD','ADMIN','Config: 1 functional table');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','TABLE','config_ops:group','GRP_GL_MAPPING','WRITE','PROD','ADMIN','Config: 1 technical table');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','TABLE','config_ops:group','GRP_RISK_WEIGHTS','WRITE','PROD','ADMIN','Config: 1 OMT-BOTH table');

-- (variety) READ-ONLY instead of write: change ACCESS_LEVEL 'WRITE' -> 'READ' in any row above.
-- (variety) Mixed: category READ + one table WRITE (read many, edit one)
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','TABLE_CATEGORY','config_ops:group','OMT-FUNCTIONAL','READ','PROD','ADMIN','Config: functional read');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','TABLE','config_ops:group','GRP_COST_CENTER','WRITE','PROD','ADMIN','Config: edit just this one');

-- (variety) ONLY the OMT-TECHNICAL tables of a scope (standalone technical category)
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','TABLE_CATEGORY','config_ops:group','OMT-TECHNICAL','READ','PROD','ADMIN','Config: GROUP, technical tables, read');

-- (variety) Category grant BUT carve out one table (per-table DENY wins over the category)
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','TABLE','config_ops:group','GRP_GL_MAPPING','DENY','PROD','ADMIN','Config: hide this table from the category grant');

-- (variety) Grant the whole scope BUT hide an entire category (category-level DENY):
--   e.g. all GROUP tables EXCEPT the technical ones. The DENY category subtracts from OMT-BOTH.
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','TABLE_CATEGORY','config_ops:group','OMT-BOTH','WRITE','PROD','ADMIN','Config: GROUP, all tables, write');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','TABLE_CATEGORY','config_ops:group','OMT-TECHNICAL','DENY','PROD','ADMIN','Config: ...but hide ALL technical tables');

-- (variety) Make a scope VISIBLE with no tables yet (empty screen, add table grants later)
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SCREEN','config_ops:retail','*','READ','PROD','ADMIN','Config: RETAIL screen visible, no tables yet');


--==============================================================================
-- 3) INFRASTRUCTURE HEALTH   →   NO GRANT NEEDED (default screen — see section 1)
--==============================================================================
-- Ungated: every active user sees all apps. Nothing to insert; per-app restriction is retired.


--==============================================================================
-- 4) SERVICE CONSOLE   (control = which apps; WRITE = the start/stop buttons)
--    apps: OLS_GROUP | OLS_CIB | OLS_RETAIL | POSEIDON, or '*' for all
--==============================================================================
-- Read only, FULL (see every app's services, no start/stop)
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SCREEN','service_console','*','READ','PROD','ADMIN','Service Console: read-only, all apps');

-- Read/write (start/stop) but ONLY the OLS GROUP and OLS CIB apps
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SCREEN','service_console','*','WRITE','PROD','ADMIN','Service Console: start/stop allowed');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','APP','service_console','OLS_GROUP','READ','PROD','ADMIN','Service Console: only OLS_GROUP app');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','APP','service_console','OLS_CIB','READ','PROD','ADMIN','Service Console: only OLS_CIB app');

-- (variety) Read-only on specific apps only (APP grants, no SCREEN WRITE)
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','APP','service_console','OLS_GROUP','READ','PROD','ADMIN','Service Console: view OLS_GROUP only');


--==============================================================================
-- 5) ORACLE COMMAND CENTER (OCC)
--    DB tabs (control which + write level): resource_type='DB',
--      keys: group | cib_batch | cib_reporting | retail_batch | retail_reporting, or '*'
--      WRITE = kill session / apply-fix on that DB; READ = view only.
--    SECTIONS (hide a panel): resource_type='SECTION', DENY, key = section key below.
--      scope 'oracle_command_center'        -> hide on EVERY DB
--      scope 'oracle_command_center:<db>'   -> hide only on that DB
--      Section keys (display order):
--        space=Database Storage · top=Top Table Storage · topidx=Top Index Storage ·
--        idxhealth=Index Health · locks=Critical Locks · blocking=Blocking Sessions ·
--        temp=Temp Tablespace · sessions=Sessions Detail · sql_intelligence=SQL Intelligence
--==============================================================================
-- Read only, FULL OCC (all DB tabs, no kill, all sections)
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','DB','oracle_command_center','*','READ','PROD','ADMIN','OCC: read-only, all DBs');

-- Read/write, show sections 1..8 only (i.e. HIDE SQL Intelligence), and ONLY the OLS GROUP tab
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','DB','oracle_command_center','group','WRITE','PROD','ADMIN','OCC: only GROUP tab, write');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SECTION','oracle_command_center','sql_intelligence','DENY','PROD','ADMIN','OCC: hide SQL Intelligence everywhere');

-- Write on GROUP, read-only on CIB BATCH, and on CIB BATCH show ONLY sections space/top/topidx.
--   OCC "write" is per-DB (kill/apply); the other sections are read-only displays. So this is:
--   DB group=WRITE, DB cib_batch=READ, and on cib_batch DENY every section except the 3 to keep.
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','DB','oracle_command_center','group','WRITE','PROD','ADMIN','OCC: write on GROUP');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','DB','oracle_command_center','cib_batch','READ','PROD','ADMIN','OCC: read-only on CIB BATCH');
-- keep space/top/topidx on CIB BATCH -> deny the rest ON cib_batch only:
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SECTION','oracle_command_center:cib_batch','idxhealth','DENY','PROD','ADMIN','CIB BATCH: hide Index Health');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SECTION','oracle_command_center:cib_batch','locks','DENY','PROD','ADMIN','CIB BATCH: hide Locks');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SECTION','oracle_command_center:cib_batch','blocking','DENY','PROD','ADMIN','CIB BATCH: hide Blocking');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SECTION','oracle_command_center:cib_batch','temp','DENY','PROD','ADMIN','CIB BATCH: hide Temp');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SECTION','oracle_command_center:cib_batch','sessions','DENY','PROD','ADMIN','CIB BATCH: hide Sessions');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SECTION','oracle_command_center:cib_batch','sql_intelligence','DENY','PROD','ADMIN','CIB BATCH: hide SQL Intelligence');

-- Deny the SQL Investigation (SQL Intelligence) section for a user (everything else stays)
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SECTION','oracle_command_center','sql_intelligence','DENY','PROD','ADMIN','OCC: hide SQL Intelligence');

-- (variety) See two DBs, write on one, read on the other
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','DB','oracle_command_center','group','WRITE','PROD','ADMIN','OCC: write GROUP');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','DB','oracle_command_center','retail_batch','READ','PROD','ADMIN','OCC: read RETAIL BATCH');

-- (variety) All DBs, write everywhere (equivalent to SCREEN/oracle_command_center/*/WRITE)
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','DB','oracle_command_center','*','WRITE','PROD','ADMIN','OCC: all DBs, write');


--==============================================================================
-- 6) DENY / EXCLUSION  ("ALL ... EXCEPT these")
--    Pattern: grant '*' (all) on the resource, then add a DENY row per key to exclude.
--    DENY wins over the '*' grant, and NEVER reveals a screen on its own (you still need the
--    '*' allow to open the screen). Applies to APP (Service Console) and DB (OCC).
--    (Config Ops has its own subtractive DENY at table/category level — see section 2.
--     Log Analytics + Infra Health are ungated defaults, so exclusion does not apply there.)
--==============================================================================
-- Service Console: start/stop on ALL apps EXCEPT OLS_RETAIL
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SCREEN','service_console','*','WRITE','PROD','ADMIN','Service Console: write, all apps...');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','APP','service_console','OLS_RETAIL','DENY','PROD','ADMIN','...except OLS_RETAIL (hidden)');

-- OCC: ALL DB tabs with write EXCEPT retail_batch (that tab is hidden entirely)
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','DB','oracle_command_center','*','WRITE','PROD','ADMIN','OCC: all DBs, write...');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','DB','oracle_command_center','retail_batch','DENY','PROD','ADMIN','...except RETAIL BATCH');


--==============================================================================
-- 7) S-STUDIO (the Config Ops SQL console) — lives in ols_ops_access, NOT ols_app_access
--==============================================================================
-- S-Studio is gated by ols_ops_access.can_sql='Y'. This is INDEPENDENT of User Management
-- (can_users) — you can give someone S-Studio WITHOUT making them a super-admin. The operator also
-- needs a Config Ops grant (section 2) for each scope whose DBs they'll run against, because
-- S-Studio lives inside the scope screen. Assign from the User Management screen, or by SQL:
--
--   -- S-Studio ONLY (not a super-admin):
--   INSERT INTO ols_ops_access (username, is_active, can_users, can_sql)
--   VALUES ('CHANGE_ME','Y','N','Y');
--   -- + the Config Ops scope(s) they'll query (so the scope screen — and its S-Studio tab — appears):
--   INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
--   VALUES ('CHANGE_ME','TABLE_CATEGORY','config_ops:group','OMT-BOTH','READ','PROD','ADMIN','see GROUP scope for S-Studio');
--   COMMIT;
--
--   -- Turn S-Studio on/off for an EXISTING operator:
--   UPDATE ols_ops_access SET can_sql='Y' WHERE UPPER(username)=UPPER('CHANGE_ME'); COMMIT;
-- (Table + all columns: ops_access_setup.sql.)


COMMIT;

--------------------------------------------------------------------------------
-- Handy checks
--   See everything a user has:
--     SELECT resource_type, resource_scope, resource_key, access_level, app_env, is_active
--       FROM ols_app_access WHERE UPPER(username)=UPPER('CHANGE_ME') ORDER BY 1,2,3;
--   Revoke one grant (keep the audit row):
--     UPDATE ols_app_access SET is_active='N'
--      WHERE UPPER(username)=UPPER('CHANGE_ME') AND resource_type='DB' AND resource_key='group'; COMMIT;
--------------------------------------------------------------------------------
