--------------------------------------------------------------------------------
-- OLS Dashboard — USER MANAGEMENT gate table (ols_ops_access)
--
-- The "super-exclusive" gate for the User Management screen. It is DELIBERATELY
-- separate from ols_app_access (the grants) and from ols_users (identity/role):
--
--   * A user sees & uses User Management  <=>  their UID is in THIS table with
--     is_active='Y'. Nothing else grants it — not even IS_ADMIN in ols_users.
--   * From that screen they can hand out any ols_app_access grant to any active
--     OLS user, AND add/remove other ops-admins (this table).
--   * There is NO audit here by design — revoke = hard DELETE.
--
-- BOOTSTRAP: seed your own UID once by SQL (below). Until at least one active row
-- exists, nobody can open the screen (the chicken-and-egg is intentional).
--------------------------------------------------------------------------------
SET DEFINE OFF;

-- The "privileged operators" table. Capabilities:
--   can_users = User Management screen (hand out access — the "super admin")
--   sql_group / sql_cib / sql_retail = S-Studio (Config Ops SQL console), PER CONFIG SCOPE.
-- S-Studio is now PER-SCOPE: an operator may be granted the SQL console for any subset of the three
-- OLS lines. S-Studio is exclusive to FULL super admins — the sql_* flags only take effect when the
-- row is active AND can_users='Y' (see access_api.fetch_sql_scopes). The legacy single can_sql column
-- is kept for back-compat only and is NO LONGER the gate (use the per-scope flags).
CREATE TABLE ols_ops_access (
  username   VARCHAR2(64) NOT NULL,
  is_active  CHAR(1) DEFAULT 'Y' NOT NULL,   -- master on/off for the whole row
  can_users  CHAR(1) DEFAULT 'Y' NOT NULL,   -- User Management (super admin)
  can_sql    CHAR(1) DEFAULT 'N' NOT NULL,   -- DEPRECATED: legacy global S-Studio flag (not the gate)
  sql_group  CHAR(1) DEFAULT 'N' NOT NULL,   -- S-Studio on OLS GROUP
  sql_cib    CHAR(1) DEFAULT 'N' NOT NULL,   -- S-Studio on OLS CIB
  sql_retail CHAR(1) DEFAULT 'N' NOT NULL,   -- S-Studio on OLS RETAIL
  CONSTRAINT ols_ops_access_pk PRIMARY KEY (username),
  CONSTRAINT ols_ops_access_ck_act CHECK (is_active  IN ('Y','N')),
  CONSTRAINT ols_ops_access_ck_usr CHECK (can_users  IN ('Y','N')),
  CONSTRAINT ols_ops_access_ck_sql CHECK (can_sql    IN ('Y','N')),
  CONSTRAINT ols_ops_access_ck_sg  CHECK (sql_group  IN ('Y','N')),
  CONSTRAINT ols_ops_access_ck_sc  CHECK (sql_cib    IN ('Y','N')),
  CONSTRAINT ols_ops_access_ck_sr  CHECK (sql_retail IN ('Y','N'))
);

-- Case-insensitive lookup (the app matches on UPPER(username)).
CREATE UNIQUE INDEX ols_ops_access_uix ON ols_ops_access (UPPER(username));

COMMENT ON TABLE  ols_ops_access           IS 'Privileged operators — User Management (can_users) and/or S-Studio (can_sql). See RBAC_DESIGN.md.';
COMMENT ON COLUMN ols_ops_access.username  IS 'UID of a privileged operator (matched case-insensitively).';
COMMENT ON COLUMN ols_ops_access.is_active IS 'Y = row active; N = disabled (kept only so it can be flipped back).';
COMMENT ON COLUMN ols_ops_access.can_users  IS 'Y = User Management (hand out access — super admin). Default Y.';
COMMENT ON COLUMN ols_ops_access.can_sql    IS 'DEPRECATED legacy global S-Studio flag — no longer the gate; use sql_group/sql_cib/sql_retail.';
COMMENT ON COLUMN ols_ops_access.sql_group  IS 'Y = S-Studio on OLS GROUP. Only effective when is_active=Y AND can_users=Y.';
COMMENT ON COLUMN ols_ops_access.sql_cib    IS 'Y = S-Studio on OLS CIB. Only effective when is_active=Y AND can_users=Y.';
COMMENT ON COLUMN ols_ops_access.sql_retail IS 'Y = S-Studio on OLS RETAIL. Only effective when is_active=Y AND can_users=Y.';

-- Existing installs: add the columns without recreating the table -------------
--   ALTER TABLE ols_ops_access ADD (can_users CHAR(1) DEFAULT 'Y' NOT NULL);
--   ALTER TABLE ols_ops_access ADD CONSTRAINT ols_ops_access_ck_usr CHECK (can_users IN ('Y','N'));
--   ALTER TABLE ols_ops_access ADD (can_sql   CHAR(1) DEFAULT 'N' NOT NULL);   -- if not already present
--   ALTER TABLE ols_ops_access ADD CONSTRAINT ols_ops_access_ck_sql CHECK (can_sql IN ('Y','N'));
-- Per-scope S-Studio (2026 — replaces the single can_sql gate):
--   ALTER TABLE ols_ops_access ADD (sql_group  CHAR(1) DEFAULT 'N' NOT NULL);
--   ALTER TABLE ols_ops_access ADD (sql_cib    CHAR(1) DEFAULT 'N' NOT NULL);
--   ALTER TABLE ols_ops_access ADD (sql_retail CHAR(1) DEFAULT 'N' NOT NULL);
--   ALTER TABLE ols_ops_access ADD CONSTRAINT ols_ops_access_ck_sg CHECK (sql_group  IN ('Y','N'));
--   ALTER TABLE ols_ops_access ADD CONSTRAINT ols_ops_access_ck_sc CHECK (sql_cib    IN ('Y','N'));
--   ALTER TABLE ols_ops_access ADD CONSTRAINT ols_ops_access_ck_sr CHECK (sql_retail IN ('Y','N'));
--   -- carry the old global flag forward to all three scopes:
--   UPDATE ols_ops_access SET sql_group='Y', sql_cib='Y', sql_retail='Y' WHERE can_sql='Y'; COMMIT;

-- ---- BOOTSTRAP: make yourself a full privileged operator (User Management + S-Studio on all scopes) ----
INSERT INTO ols_ops_access (username, is_active, can_users, can_sql, sql_group, sql_cib, sql_retail)
VALUES ('CHANGE_ME', 'Y', 'Y', 'Y', 'Y', 'Y', 'Y');
COMMIT;

-- ---- S-Studio for a specific scope (still a full super admin — can_users=Y) ----
--   (also grant them the Config Ops scope(s) whose screens host the S-Studio tab — see access_examples.sql)
-- INSERT INTO ols_ops_access (username, is_active, can_users, sql_cib) VALUES ('SOMEUID', 'Y', 'Y', 'Y');
-- COMMIT;

--------------------------------------------------------------------------------
-- Handy ops
--   Who can use User Management:
--     SELECT username, is_active FROM ols_ops_access ORDER BY username;
--   Disable someone (keep the row):   UPDATE ols_ops_access SET is_active='N' WHERE UPPER(username)=UPPER('SOMEUID'); COMMIT;
--   Remove entirely (hard delete):    DELETE FROM ols_ops_access WHERE UPPER(username)=UPPER('SOMEUID'); COMMIT;
--------------------------------------------------------------------------------
