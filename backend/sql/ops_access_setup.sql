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

-- The "privileged operators" table. TWO INDEPENDENT capabilities, so you can grant either alone:
--   can_users = User Management screen (hand out access — the "super admin")
--   can_sql   = S-Studio (Config Ops SQL console)
-- A row with can_users='N', can_sql='Y' is an S-Studio operator who is NOT a super admin.
CREATE TABLE ols_ops_access (
  username  VARCHAR2(64) NOT NULL,
  is_active CHAR(1) DEFAULT 'Y' NOT NULL,   -- master on/off for the whole row
  can_users CHAR(1) DEFAULT 'Y' NOT NULL,   -- User Management (super admin)
  can_sql   CHAR(1) DEFAULT 'N' NOT NULL,   -- S-Studio (raw SQL/DDL console)
  CONSTRAINT ols_ops_access_pk PRIMARY KEY (username),
  CONSTRAINT ols_ops_access_ck_act CHECK (is_active IN ('Y','N')),
  CONSTRAINT ols_ops_access_ck_usr CHECK (can_users IN ('Y','N')),
  CONSTRAINT ols_ops_access_ck_sql CHECK (can_sql   IN ('Y','N'))
);

-- Case-insensitive lookup (the app matches on UPPER(username)).
CREATE UNIQUE INDEX ols_ops_access_uix ON ols_ops_access (UPPER(username));

COMMENT ON TABLE  ols_ops_access           IS 'Privileged operators — User Management (can_users) and/or S-Studio (can_sql). See RBAC_DESIGN.md.';
COMMENT ON COLUMN ols_ops_access.username  IS 'UID of a privileged operator (matched case-insensitively).';
COMMENT ON COLUMN ols_ops_access.is_active IS 'Y = row active; N = disabled (kept only so it can be flipped back).';
COMMENT ON COLUMN ols_ops_access.can_users IS 'Y = User Management (hand out access — super admin). Default Y.';
COMMENT ON COLUMN ols_ops_access.can_sql   IS 'Y = S-Studio (Config Ops SQL console). Independent of can_users. Default N.';

-- Existing installs: add the columns without recreating the table -------------
--   ALTER TABLE ols_ops_access ADD (can_users CHAR(1) DEFAULT 'Y' NOT NULL);
--   ALTER TABLE ols_ops_access ADD CONSTRAINT ols_ops_access_ck_usr CHECK (can_users IN ('Y','N'));
--   ALTER TABLE ols_ops_access ADD (can_sql   CHAR(1) DEFAULT 'N' NOT NULL);   -- if not already present
--   ALTER TABLE ols_ops_access ADD CONSTRAINT ols_ops_access_ck_sql CHECK (can_sql IN ('Y','N'));

-- ---- BOOTSTRAP: make yourself a full privileged operator (User Management + S-Studio) ----
INSERT INTO ols_ops_access (username, is_active, can_users, can_sql) VALUES ('CHANGE_ME', 'Y', 'Y', 'Y');
COMMIT;

-- ---- S-Studio ONLY (no super-admin): give someone the SQL console but NOT User Management ----
--   (also grant them the Config Ops scope(s) whose DBs they'll run against — see access_examples.sql)
-- INSERT INTO ols_ops_access (username, is_active, can_users, can_sql) VALUES ('SOMEUID', 'Y', 'N', 'Y');
-- COMMIT;

--------------------------------------------------------------------------------
-- Handy ops
--   Who can use User Management:
--     SELECT username, is_active FROM ols_ops_access ORDER BY username;
--   Disable someone (keep the row):   UPDATE ols_ops_access SET is_active='N' WHERE UPPER(username)=UPPER('SOMEUID'); COMMIT;
--   Remove entirely (hard delete):    DELETE FROM ols_ops_access WHERE UPPER(username)=UPPER('SOMEUID'); COMMIT;
--------------------------------------------------------------------------------
