# RBAC & User-Management Handbook

The access-control model for the OLS Dashboard — how it works, and **how to grant access**. This is
the operational handbook: to give a user access you INSERT rows into `ols_app_access` (§6 is a
copy-paste cookbook). No code change is needed to grant access, add a table, or add a server.

---

## 1. The two gates

1. **Active user** — the user must exist in `ols_users` with `LGCL_DEL_FLG = 'N'`. `ols_users` is
   **read-only** to this system (identity + base role live there); we never modify it.
2. **SSO** — OpenID authentication. The signed-in username is the key into everything below.

Fail either gate → No-Access / sign-out.

## 2. Base role (from `ols_users`)

The base role comes from the `ols_users` flags **`IS_ADMIN` / `IS_READ` / `IS_SALT`** (ADMIN wins,
then READ, then SALT):

| Role | Sees | Writes | Servers / config tables |
|---|---|---|---|
| **ADMIN** | everything | everywhere (kill, start/stop, add/edit/delete, apply) | all — **ignores grants** |
| **READ** (default) | every screen, read-only | only where a grant says so | **opt-in** — only what's granted |
| **SALT** | **Home + Config Ops only** | only where granted | opt-in |

- **ADMIN** is the top role — give a user `IS_ADMIN='Y'` in `ols_users` and they have full access.
- **READ** is the default working role: all screens are visible read-only, but Log Analytics servers
  and Config Ops tables are **opt-in** (invisible until granted), and every write button is hidden
  until a grant enables it.
- **SALT** is a Config-Ops-only persona (users who only need a few config tables) — Home + Config
  Ops, nothing else.

## 3. Overrides (grants) — `ols_app_access`

Everything finer-grained is a grant row. One table, generic shape so it never needs schema changes:

| Column | Meaning |
|---|---|
| `USERNAME` | the user (matched case-insensitively) |
| `RESOURCE_TYPE` | `SCREEN` \| `SERVER` \| `TABLE_CATEGORY` \| `TABLE` \| `SECTION` |
| `RESOURCE_SCOPE` | the screen/scope the resource lives in (see below) |
| `RESOURCE_KEY` | the specific resource id, or `*` for "all in scope" |
| `ACCESS_LEVEL` | `READ` \| `WRITE` \| `DENY` |
| `APP_ENV` | `PROD` / `STG` / `DEV`, or `*` for all environments |
| `IS_ACTIVE` | `Y` active, `N` = revoked (keep the row for audit) |
| `GRANTED_BY`, `GRANTED_ON`, `COMMENTS` | audit trail |

**`RESOURCE_SCOPE` values:** `log_analytics`, `config_ops:group`, `config_ops:cib`,
`config_ops:retail`, `service_console`, `oracle_command_center`.

### DDL + sample grants — runnable script

The complete `CREATE TABLE` + indexes + sample INSERTs live in
[`backend/sql/rbac_setup.sql`](backend/sql/rbac_setup.sql) — run it as the app schema owner. The DDL
is reproduced here for reference:

### Suggested DDL (Oracle)
```sql
CREATE TABLE ols_app_access (
  username       VARCHAR2(64)  NOT NULL,
  resource_type  VARCHAR2(20)  NOT NULL,   -- SCREEN | SERVER | TABLE_CATEGORY | TABLE | SECTION
  resource_scope VARCHAR2(64)  NOT NULL,
  resource_key   VARCHAR2(128) DEFAULT '*' NOT NULL,
  access_level   VARCHAR2(10)  NOT NULL,   -- READ | WRITE | DENY
  app_env        VARCHAR2(10)  DEFAULT 'PROD' NOT NULL,
  is_active      CHAR(1)       DEFAULT 'Y' NOT NULL,
  granted_by     VARCHAR2(64),
  granted_on     DATE          DEFAULT SYSDATE,
  comments       VARCHAR2(400),
  CONSTRAINT ols_app_access_ck_lvl CHECK (access_level IN ('READ','WRITE','DENY')),
  CONSTRAINT ols_app_access_ck_act CHECK (is_active   IN ('Y','N'))
);
CREATE INDEX ols_app_access_ix_user ON ols_app_access (UPPER(username), is_active);
```

## 4. Per-screen behaviour

| Screen | View | Write | Resource control |
|---|---|---|---|
| **Log Analytics** | read | (read-only screen) | **Servers opt-in** — user sees only granted `SERVER` rows |
| **Config Ops** (group/cib/retail) | a sub-screen appears only if the user has ≥1 grant in it | per-**table** (`TABLE`/`TABLE_CATEGORY` = `WRITE`) → the content modal's add/edit/delete/duplicate | **Tables opt-in** — category grant + per-table overrides |
| **Infra Health** | read, everyone | — | none |
| **Service Console** | read, everyone | `SCREEN … WRITE` → start/stop buttons | none |
| **Oracle Command Center** | read, everyone | `SCREEN … WRITE` → kill + apply-fix | **Sections opt-out** — a `SECTION … DENY` hides one (e.g. SQL Intelligence) |

### Config Ops resolution (category + per-table)
- **Category grant** `TABLE_CATEGORY` covers many tables at once (matched on `ols_master_table_config.table_category`):
  granting `OMT-BOTH` = all; `OMT-TECHNICAL` and `OMT-FUNCTIONAL` each also include `OMT-BOTH` tables.
- **Per-table grant** `TABLE` overrides the category for one table — a `WRITE` elevates it, a `DENY`
  carves it out.
- A config **sub-screen (scope)** is visible automatically when the user has any grant in it — no
  separate "open the screen" row needed. Grant only `group` → the user never sees `cib` / `retail`.

> **Requirement:** the `/api/config/{scope}/tables` catalogue must return a **`TABLE_CATEGORY`**
> column (from `ols_master_table_config`) — the UI resolves category grants against it.

## 5. How access is loaded & enforced

- One call, `POST /api/access/me` `{ username, app_env }` → the resolved **snapshot**
  (`access_api.py` assembles it from `database.fetch_user_identity` + `database.fetch_user_grants`).
- The Angular `RbacService` caches it and answers every gate: `canView` / `canWrite(screen)`,
  `configScopeVisible`, `configTableAccess` / `canWriteTable`, `serverAllowed`, `sectionAllowed`.
- UI helpers: the route `rbacGuard`, nav auto-filtering, and structural directives
  `*olsCanWrite="'<screen>'"` (write buttons) and `*olsIfSection="{screen,key}"` (hide a section).

## 6. Grant cookbook (each requirement = INSERT rows)

```sql
-- Log Analytics: user JDOE may see ONLY server eurv15
INSERT INTO ols_app_access (username,resource_type,resource_scope,resource_key,access_level,app_env,granted_by)
VALUES ('JDOE','SERVER','log_analytics','eurv15','READ','PROD','ADMIN1');

-- Config Ops: JDOE gets ALL functional tables in the Group scope, read
VALUES ('JDOE','TABLE_CATEGORY','config_ops:group','OMT-FUNCTIONAL','READ','PROD','ADMIN1');

-- Config Ops: MSMITH may EDIT one CIB table (also makes the CIB sub-screen visible)
VALUES ('MSMITH','TABLE','config_ops:cib','CIB_ACCOUNT_MASTER','WRITE','PROD','ADMIN1');

-- Config Ops: remove one table the category granted
VALUES ('JDOE','TABLE','config_ops:group','GRP_GL_MAPPING','DENY','PROD','ADMIN1');

-- Service Console: DBAUSER may start/stop services
VALUES ('DBAUSER','SCREEN','service_console','*','WRITE','PROD','ADMIN1');

-- Oracle Command Center: DBAUSER may kill sessions / apply fixes
VALUES ('DBAUSER','SCREEN','oracle_command_center','*','WRITE','PROD','ADMIN1');

-- Oracle Command Center: hide SQL Intelligence for JDOE
VALUES ('JDOE','SECTION','oracle_command_center','sql_intelligence','DENY','PROD','ADMIN1');

-- SALT user BOB (IS_SALT='Y' in ols_users): only two CIB config tables
VALUES ('BOB','TABLE','config_ops:cib','CIB_LIMIT_CONFIG','READ','PROD','ADMIN1');
VALUES ('BOB','TABLE','config_ops:cib','CIB_FX_RATES','READ','PROD','ADMIN1');
```
**Revoke** = `UPDATE ols_app_access SET is_active='N' WHERE …` (keeps the audit trail).

## 7. Extensibility — what a future change costs

| You add… | You do | Code? |
|---|---|---|
| A new Config Ops table | Nothing (a category grant auto-covers it) or one `TABLE` INSERT | **None** |
| A new Log Analytics server | One `SERVER` INSERT per user (opt-in → invisible until granted) | **None** |
| A new OCC section | Wrap it once with `*olsIfSection`; deny via `SECTION` rows | 1 line |
| A whole new screen | Register its key in `rbac.config.ts` + `data.screen` on the route (the one line you write to create any screen) | 1 line |
| Grant / revoke for a user | INSERT / flip `IS_ACTIVE` | **None** |

The grant table never needs an `ALTER` — the permission *vocabulary is data*.

## 8. Verifying access (support)

`POST /api/access/effective` `{ caller, username, app_env }` (caller must be an active ADMIN) →
the resolved snapshot **plus the raw grant rows** for `username`. Use it to answer "why can't user X
see table Y?" without guessing.

## 9. Security — non-negotiable for production

1. **UI hiding is not security.** Every write endpoint (config add/edit/delete, OCC kill, service
   start/stop, SQLI apply) MUST re-check the permission **server-side** from the SSO identity. The
   hidden buttons are UX; the backend check is the real gate.
2. **Trust the token, not the body.** Derive `username` server-side from the validated SSO token —
   do **not** take it from the request body (today `access_api` accepts it in the body to match the
   existing wiring; wire the token check before go-live). See the SECURITY NOTE in `access_api.py`.
3. **Fail closed.** A failed/empty access load = no access (the client already does this).
4. **Env-scoped grants.** A user can be WRITE in STG but READ in PROD (`APP_ENV`).
5. **Least privilege for the app DB user** that reads `ols_users` / `ols_app_access`.

## 10. Where it lives (code map)

| Layer | File |
|---|---|
| Data (SQL, read-only) | `backend/database.py` → `fetch_user_identity`, `fetch_user_grants` |
| API (resolve → snapshot) | `backend/access_api.py` → `POST /api/access/me`, `POST /api/access/effective` |
| App wiring | `backend/app.py` (`app.state.app_db_config`, `access_router`) |
| Contract | `src/app/shared/models.ts` → `AccessSnapshot`; `api-endpoints.ts` → `access.me/effective` |
| Engine | `src/app/auth/rbac.service.ts`; screen registry `rbac.config.ts` |
| UI gates | `rbac.guard.ts`, `can-write.directive.ts` (`*olsCanWrite`), `if-section.directive.ts` (`*olsIfSection`), nav filter in `default-layout.component.ts` |
| Screen wiring | Config Ops `config-scope.base.ts`; Log Analytics `log_analytics.component.ts`; OCC + Service Console templates |

Dev note: the frontend mock (`mock-api.interceptor.ts`) and backend dummy (`access_api._access_dummy`)
serve the snapshot from `environment.devRoles` / the username in dev — flip `devRoles` to
ADMIN / READ / SALT to exercise each role without a database.
