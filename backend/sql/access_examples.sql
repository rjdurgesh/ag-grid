--------------------------------------------------------------------------------
-- OLS Dashboard — ACCESS GRANT COOKBOOK (ols_app_access)
--
-- A ready-to-run set of INSERTs for every access pattern. Pick a block, replace
-- 'CHANGE_ME' with the real username, and run it. Model + full reference: RBAC_DESIGN.md.
--
--   * ADMIN users need NO rows here — set IS_ADMIN='Y' on ols_users for full access.
--     These grants are for READ / SALT users (opt-in: they see ONLY what's granted).
--   * WRITE includes read; READ is view-only.  DENY subtracts / hides.
--   * Table structure + the CHECK constraint (must allow all resource_type values below)
--     live in rbac_setup.sql. Revoke = UPDATE ... SET is_active='N' (keeps the audit row).
--
-- resource_type : SCREEN | SERVER | APP | DB | TABLE_CATEGORY | TABLE | SECTION
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
-- 1) LOG ANALYTICS   (read-only screen; control = which servers)
--    resource_key = server name from ols_server_log_config.server_name, or '*' for all
--==============================================================================
-- All servers
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SERVER','log_analytics','*','READ','PROD','ADMIN','Log Analytics: all servers');

-- A specific single server
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SERVER','log_analytics','eur17','READ','PROD','ADMIN','Log Analytics: only server eur17');

-- (variety) A few specific servers — one row each
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SERVER','log_analytics','eur17','READ','PROD','ADMIN','Log Analytics: eur17');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SERVER','log_analytics','eur34','READ','PROD','ADMIN','Log Analytics: eur34');
-- NOTE: Log Analytics is a read-only tool — there is no write level here.


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
-- 3) INFRASTRUCTURE HEALTH   (read-only screen; control = which apps)
--    resource_key = OLS_GROUP | OLS_CIB | OLS_RETAIL | POSEIDON, or '*' for all apps
--==============================================================================
-- Monitor ONLY OLS GROUP and OLS RETAIL
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','APP','infra_health','OLS_GROUP','READ','PROD','ADMIN','Infra Health: OLS_GROUP');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','APP','infra_health','OLS_RETAIL','READ','PROD','ADMIN','Infra Health: OLS_RETAIL');

-- (variety) ALL apps (two equivalent ways)
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','APP','infra_health','*','READ','PROD','ADMIN','Infra Health: all apps');
-- or:  ('CHANGE_ME','SCREEN','infra_health','*','READ',...)   -- SCREEN grant = all apps too
-- NOTE: Infra Health is read-only — no write level.


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
--    '*' allow to open the screen). Works for SERVER, APP (infra & service), and DB.
--    (Config Ops has its own subtractive DENY at table/category level — see section 2.)
--==============================================================================
-- Log Analytics: ALL servers EXCEPT eur17
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SERVER','log_analytics','*','READ','PROD','ADMIN','Log Analytics: all servers...');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SERVER','log_analytics','eur17','DENY','PROD','ADMIN','...except eur17');

-- Infra Health: ALL apps EXCEPT POSEIDON
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','APP','infra_health','*','READ','PROD','ADMIN','Infra Health: all apps...');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','APP','infra_health','POSEIDON','DENY','PROD','ADMIN','...except POSEIDON');

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

-- (variety) DENY also trims an explicit allow-list, not just '*':
--   see eur10 and eur34 (but NOT eur17, even though it was granted)
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SERVER','log_analytics','eur10','READ','PROD','ADMIN','Log Analytics: eur10');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SERVER','log_analytics','eur17','READ','PROD','ADMIN','Log Analytics: eur17 (will be denied)');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SERVER','log_analytics','eur34','READ','PROD','ADMIN','Log Analytics: eur34');
INSERT INTO ols_app_access (username, resource_type, resource_scope, resource_key, access_level, app_env, granted_by, comments)
VALUES ('CHANGE_ME','SERVER','log_analytics','eur17','DENY','PROD','ADMIN','...but revoke eur17');


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
