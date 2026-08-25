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

CREATE TABLE ols_ops_access (
  username  VARCHAR2(64) NOT NULL,
  is_active CHAR(1) DEFAULT 'Y' NOT NULL,
  can_sql   CHAR(1) DEFAULT 'N' NOT NULL,   -- S-Studio (raw SQL/DDL console) — assigned per user
  CONSTRAINT ols_ops_access_pk PRIMARY KEY (username),
  CONSTRAINT ols_ops_access_ck_act CHECK (is_active IN ('Y','N')),
  CONSTRAINT ols_ops_access_ck_sql CHECK (can_sql   IN ('Y','N'))
);

-- Case-insensitive lookup (the app matches on UPPER(username)).
CREATE UNIQUE INDEX ols_ops_access_uix ON ols_ops_access (UPPER(username));

COMMENT ON TABLE  ols_ops_access           IS 'Super-exclusive gate for the User Management screen (see RBAC_DESIGN.md).';
COMMENT ON COLUMN ols_ops_access.username  IS 'UID that may open User Management + grant access (matched case-insensitively).';
COMMENT ON COLUMN ols_ops_access.is_active IS 'Y = can use the screen; N = disabled (kept only so a row can be flipped back).';
COMMENT ON COLUMN ols_ops_access.can_sql   IS 'Y = also sees S-Studio (Config Ops SQL console). Assigned specifically, default N.';

-- Existing installs: add the column without recreating the table --------------
--   ALTER TABLE ols_ops_access ADD (can_sql CHAR(1) DEFAULT 'N' NOT NULL);
--   ALTER TABLE ols_ops_access ADD CONSTRAINT ols_ops_access_ck_sql CHECK (can_sql IN ('Y','N'));

-- ---- BOOTSTRAP: make yourself an ops-admin (replace CHANGE_ME with your UID) ----
INSERT INTO ols_ops_access (username, is_active) VALUES ('CHANGE_ME', 'Y');
COMMIT;

--------------------------------------------------------------------------------
-- Handy ops
--   Who can use User Management:
--     SELECT username, is_active FROM ols_ops_access ORDER BY username;
--   Disable someone (keep the row):   UPDATE ols_ops_access SET is_active='N' WHERE UPPER(username)=UPPER('SOMEUID'); COMMIT;
--   Remove entirely (hard delete):    DELETE FROM ols_ops_access WHERE UPPER(username)=UPPER('SOMEUID'); COMMIT;
--------------------------------------------------------------------------------
