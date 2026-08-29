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

| Role | Sees | Writes | Everything is |
|---|---|---|---|
| **ADMIN** | everything | everywhere (kill, start/stop, add/edit/delete, apply) | granted — **ignores grants** |
| **READ** | **only screens it's granted** | only where a grant says so | **opt-in** |
| **SALT** | **Config Ops only** (whatever config it's granted) | only where granted | opt-in, config-only |

**Two default screens for everyone; the rest opt-in.** Every **active** user (in `ols_users`,
`LGCL_DEL_FLG='N'`) sees **Log Analytics** and **Infrastructure Health** by default — these two are
**ungated** (no RBAC, all servers / all apps shown). Everything else (Config Ops, Service Console,
Oracle Command Center) is opt-in: visible ONLY if a grant touches it — there is no "default read-all"
for those.

**Two No-Access cases** (both share `/no-access`, which shows the right message via
`RbacService.snapshot().active`):
1. **Not provisioned** — the UID is not an active user in `ols_users` (gate 1 fail) →
   *"You don't have access to OLS — submit a provisioning request."*
2. **Signed in, no features** — active but nothing assigned. With the two default screens above this
   effectively never happens for an active user, but the message *"No features assigned yet — reach
   out to the OLS Team"* remains as a fallback.

- **ADMIN** — `IS_ADMIN='Y'` in `ols_users` → full access, grants ignored.
- **READ** — Log Analytics + Infra Health by default; plus exactly the opt-in screens granted (a
  `SCREEN` grant, or a config grant → Config Ops, a `DB` grant → OCC). Home appears whenever the user
  has ≥1 feature and shows only the sections they can access (RBAC on Home).
- **SALT** — Config-Ops-only persona (plus the two default screens): stray non-config grants ignored;
  sees only the config scopes/tables granted to it.

**How a screen becomes visible** (READ/SALT): a `SCREEN` grant for it · a `SERVER` grant (→ Log
Analytics) · a `TABLE`/`TABLE_CATEGORY`/`SCREEN` grant in a `config_ops:<scope>` (→ Config Ops).
`SECTION`/`DENY` never grants visibility (it only hides within an already-visible screen).

## 3. Overrides (grants) — `ols_app_access`

Everything finer-grained is a grant row. One table, generic shape so it never needs schema changes:

| Column | Meaning |
|---|---|
| `USERNAME` | the user (matched case-insensitively) |
| `RESOURCE_TYPE` | `SCREEN` \| `SERVER` \| `APP` \| `DB` \| `TABLE_CATEGORY` \| `TABLE` \| `SECTION` |
| `RESOURCE_SCOPE` | the screen/scope the resource lives in (see below) |
| `RESOURCE_KEY` | the specific resource id, or `*` for "all in scope". `APP` keys: `OLS_GROUP`/`OLS_CIB`/`OLS_RETAIL`/`POSEIDON`. `DB` keys: `group`/`cib_batch`/`cib_reporting`/`retail_batch`/`retail_reporting` |
| `ACCESS_LEVEL` | `READ` \| `WRITE` \| `DENY` |
| `APP_ENV` | `PROD` / `STG` / `DEV`, or `*` for all environments |
| `IS_ACTIVE` | `Y` active, `N` = revoked (keep the row for audit) |
| `GRANTED_BY`, `GRANTED_ON`, `COMMENTS` | audit trail |

**`RESOURCE_SCOPE` values:** `log_analytics`, `config_ops:group`, `config_ops:cib`,
`config_ops:retail`, `infra_health`, `service_console`, `oracle_command_center`
(and `oracle_command_center:<db>` for a per-DB `SECTION` deny).

### DDL + sample grants — runnable script

The complete `CREATE TABLE` + indexes + sample INSERTs live in
[`backend/sql/rbac_setup.sql`](backend/sql/rbac_setup.sql) — run it as the app schema owner. The DDL
is reproduced here for reference:

### Suggested DDL (Oracle)
```sql
CREATE TABLE ols_app_access (
  username       VARCHAR2(64)  NOT NULL,
  resource_type  VARCHAR2(20)  NOT NULL,   -- SCREEN | SERVER | APP | DB | TABLE_CATEGORY | TABLE | SECTION
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

**Full-access shortcut:** one row `SCREEN / '*' / '*' / READ` = see everything read-only; `… / WRITE`
= everything + every action. (Like ADMIN, but via a grant rather than `IS_ADMIN`.)

| Screen | Visible when… | Write | Resource control |
|---|---|---|---|
| **Home** | the user has ≥1 feature | — | RBAC-filtered: shows only the Infra / Service / Oracle sections the user can access; nothing → a "your tools are in the sidebar" note |
| **Log Analytics** | **always (ungated)** — every active user | (read-only screen) | **No RBAC** — all servers shown to everyone |
| **Config Ops** (group/cib/retail) | a config grant exists in that scope | per-**table** (`TABLE`/`TABLE_CATEGORY` = `WRITE`) → the content modal's add/edit/delete/duplicate | **Tables opt-in** — category grant + per-table overrides. A scope with no grant (e.g. RETAIL) is fully hidden |
| **Infra Health** | **always (ungated)** — every active user | — | **No RBAC** — all apps shown to everyone |
| **Service Console** | a `SCREEN` or `APP` grant | `SCREEN … WRITE` → start/stop buttons | **Apps opt-in** — an `APP / service_console` grant limits which apps' services show (`SCREEN` grant = all apps) |
| **Oracle Command Center** | a `DB` grant (or `SCREEN / oracle_command_center` = all DBs) | **per-DB** — kill/apply on a DB needs `DB … WRITE` for that DB | **DBs opt-in + per-DB level** (READ tab = view-only, WRITE tab = killable). **Sections**: `SECTION … DENY` hides a panel — scope `oracle_command_center` = every DB, `oracle_command_center:<db>` = that DB only. Section keys: space / top / topidx / idxhealth / locks / blocking / temp / sessions / sql_intelligence |

### Exclusion — "all EXCEPT these" (`DENY`)
Grant `*` (all) on a resource, then add a `DENY` row per key to carve out exceptions. `DENY` **wins**
over the `*` grant and also trims an explicit allow-list — but it **never reveals a screen on its own**
(you still need the `*`/allow grant to open the screen). Supported for `SERVER` (Log Analytics),
`APP` (Infra Health & Service Console) and `DB` (OCC tabs); Config Ops has its own subtractive `DENY`
at the `TABLE` / `TABLE_CATEGORY` level. The snapshot carries the exclusions as `denied_servers`,
`infra.denied_apps`, `service.denied_apps`, `oracle.denied_dbs`, honoured by every `*Allowed` gate.
_Example: `SERVER/log_analytics/*/READ` + `SERVER/log_analytics/eur17/DENY` = all servers except eur17._

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

> A **full, copy-paste cookbook covering every pattern** (full-access, log-analytics all/one/many,
> config category+table combinations, infra apps, service-console apps, OCC per-DB + per-section) is
> in [`backend/sql/access_examples.sql`](backend/sql/access_examples.sql). A few highlights:

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

-- VIEW-only grants for the "everyone" screens (now opt-in): reveal the screen, no actions
VALUES ('JDOE','SCREEN','infra_health','*','READ','PROD','ADMIN1');           -- see Infra Health
VALUES ('JDOE','SCREEN','service_console','*','READ','PROD','ADMIN1');        -- see Service Console (no start/stop)
VALUES ('JDOE','SCREEN','oracle_command_center','*','READ','PROD','ADMIN1');  -- see OCC (no kill)

-- Service Console: DBAUSER may start/stop services (WRITE also reveals the screen)
VALUES ('DBAUSER','SCREEN','service_console','*','WRITE','PROD','ADMIN1');

-- Infra Health: DBAUSER sees ONLY the OLS_GROUP app (keys OLS_GROUP/OLS_CIB/OLS_RETAIL/POSEIDON, '*' = all)
VALUES ('DBAUSER','APP','infra_health','OLS_GROUP','READ','PROD','ADMIN1');

-- Oracle Command Center: WRITE on GROUP, READ-only on CIB BATCH; the other 3 DB tabs stay hidden
--   (DB keys: group | cib_batch | cib_reporting | retail_batch | retail_reporting; '*' = all DBs)
VALUES ('DBAUSER','DB','oracle_command_center','group','WRITE','PROD','ADMIN1');
VALUES ('DBAUSER','DB','oracle_command_center','cib_batch','READ','PROD','ADMIN1');

-- Oracle Command Center: hide SQL Intelligence for JDOE
VALUES ('JDOE','SECTION','oracle_command_center','sql_intelligence','DENY','PROD','ADMIN1');

-- Exclusion ("all EXCEPT"): JDOE sees ALL OCC DB tabs (write) EXCEPT retail_batch
VALUES ('JDOE','DB','oracle_command_center','*','WRITE','PROD','ADMIN1');
VALUES ('JDOE','DB','oracle_command_center','retail_batch','DENY','PROD','ADMIN1');

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
| Grant / revoke for a user | INSERT / flip `IS_ACTIVE` — or use the **User Management** screen (§11) | **None** |

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
ADMIN / READ / SALT to exercise each role without a database. In dev the **ADMIN** role also stands in
for the ops-admin gate (`is_ops_admin`), so User Management is reachable.

## 11. User Management screen (ops-admin) — hand out access from the UI

A dedicated **Administration → User Management** screen lets an *ops-admin* grant/revoke any
`ols_app_access` row for any active OLS user, and manage the ops-admin list itself — no SQL needed.

**Super-exclusive gate — `ols_ops_access`.** A third, deliberately tiny table of *privileged
operators* (`username`, `is_active`, **`can_users`**, **`can_sql`**) is the ONLY thing that reveals
these features. **User Management** shows only when the row is active with **`can_users='Y'`**;
**everyone else — including full `IS_ADMIN` users — does not.** `can_users` and `can_sql` (S-Studio,
§12) are **independent** — an operator can have either alone (e.g. S-Studio without super-admin). It
is independent of the base role. The snapshot carries `is_ops_admin`; `RbacService.canView('user_management')` and `opsAdminGuard`
(NOT the normal `rbacGuard`) both read it. DDL + bootstrap seed: `backend/sql/ops_access_setup.sql`.
Bootstrap by SQL once (chicken-and-egg is intentional); after that the screen can add more ops-admins.

**What it does** (all `POST /api/access/admin/*`, every call re-checks the caller against
`ols_ops_access`):
- **Catalogue-driven form** (`/admin/catalogue`) — pickers for screens, config scopes/categories,
  servers, apps, DBs, sections, plus levels & env. Data-driven lists (servers, OCC DBs) populate
  live; config tables are free-text; a new screen/section shows up once it's in its normal registry
  (§3/§7). Includes the “all EXCEPT” DENY pattern.
- **Load a user** (`/admin/user`) — validated against `ols_users`. If absent or `LGCL_DEL_FLG≠'N'`
  → *“The &lt;uid&gt; user does not exist in OLS. Please submit the appropriate provisioning request
  before proceeding.”* (via `access_api.no_ols_user_msg`) and no editing.
- **Grant / revoke** (`/admin/grant`, `/admin/grant/delete`) — build several grants (“Add to list”)
  then **Apply** them together (batched), or revoke individually; grant = upsert, **revoke = hard
  DELETE** (no audit table, by design). Segmented READ/WRITE/DENY control (only valid levels enabled).
  **No duplicates** — staging and the upsert both key on `(type,scope,key,env)` (re-adding updates).
- **Copy profile** — “Copy access from another user”: **Fetch detail** validates the source against
  `ols_users` (+ loads their `ols_app_access` grants), **View access** opens a modal listing exactly
  what they hold, and only then does **Copy** enable — staging those grants (retargeted) into the
  pending list so one Apply clones A's access onto B (deduped on merge).
- **Manage ops-admins** — each row has **Disable/Enable** (edit = flip `is_active`, `/admin/ops`
  action `disable`/`enable`, keeps the row) and **Remove** (hard delete).
- **Confirmation on every write** — Apply, Revoke, Add/Disable/Enable/Remove all go through the shared
  `ConfirmService.ask()` dialog first; nothing mutates on a stray click.
- **Manage ops-admins** (`/admin/ops`) — list / add / remove. Add requires an active OLS user.
  **No self-lockout guard** — an ops-admin can remove their own UID (recover by SQL).

**Authority:** an ops-admin may grant *anything to anyone* (no level cap). `granted_by` is the caller
(derive from the SSO token at go-live — §9). The writes here (grant/revoke, ops add/remove) are the
**only** writes in the whole access system.

Code: data `backend/database.py` (`fetch_is_ops_admin`/`fetch_ops_admins`/`fetch_all_grants`/
`fetch_server_names` + `grant_upsert`/`grant_delete`/`ops_admin_upsert`/`ops_admin_delete`);
API `backend/access_api.py` (`build_catalogue` + the `/admin/*` routes); UI
`src/app/views/user_management/*` + `auth/ops-admin.guard.ts` + `UserManagementService`. Full grant
patterns (the SQL equivalents of every form action) remain in `backend/sql/access_examples.sql`.

## 12. S-Studio — the Config Ops SQL console

A raw SQL / PL-SQL worksheet inside Config Ops (a third in-page tab **Config | MISC | S-Studio** on
each scope screen). An operator can run any query, DML, anonymous block, or deploy a
package/procedure/function against ONE database.

**Exclusive gate — `ols_ops_access.can_sql`.** S-Studio is visible only to an operator whose
`can_sql='Y'`. This is **independent of User Management (`can_users`)** — you can grant S-Studio
**without** making the person a super-admin (and vice-versa). Assign it from the User Management
"Who can manage access" panel (the **S-Studio** toggle → `/admin/ops` `sql_on`/`sql_off`) or by SQL.
Snapshot flag `can_sql`; `RbacService.canSql()`; the tab is gated by `canSql()` and the execute
endpoint re-checks it server-side.
Because S-Studio lives *inside* a config scope screen, an operator reaches it only on the scopes they
can already see — i.e. `can_sql` **plus** a config grant in that scope. (This keeps scope visibility
strictly grant-driven — a scope with no grant, e.g. RETAIL, stays hidden even for an S-Studio operator.)

**DB dropdown** — the databases in the current config scope, from `db_configs` filtered by key prefix
(`group`→[group], `cib`→[cib_batch, cib_reporting], …). A new DB (e.g. `group_reporting`) appears
automatically — no code change. Same keys OCC passes.

**Execution** (`POST /api/sql_studio/execute` → `database.execute_sql`):
- SELECT → columns + rows (capped at `SQL_STUDIO_MAX_ROWS`, default 1000).
- DML/DDL/PL-SQL/deploy → a status line; **Oracle errors (ORA-xxxxx) are returned as text and shown in
  the panel** (not a generic popup).
- **Manual commit** — the connection has autocommit OFF and is closed after each run, so uncommitted
  DML rolls back; include `COMMIT;` in your script to persist (DDL auto-commits in Oracle regardless).
- **Every run asks for confirmation**, showing the target database.

**Security (mandatory).** S-Studio runs writes/DDL, so it MUST use a **privileged connection, SEPARATE
from the read-only OCC monitor** — wire `app.state.sql_db_configs` (`{scope_key: privileged_conn}`); if
left empty in prod it falls back to `db_configs` and logs a warning. The execute endpoint re-checks
`can_sql` from the token server-side (UI hiding is not the gate). No auto-commit; `SQL_STUDIO_MAX_ROWS`
caps result size. DDL to add the column: `ops_access_setup.sql` (`can_sql CHAR(1) DEFAULT 'N'`).

Code: `backend/sql_studio_api.py` (`/databases`, `/execute`, `can_sql` gate) + `database.execute_sql`
(+ `fetch_can_sql` / `ops_admin_set_sql`); UI `src/app/views/config_ops_console/sql_studio/*`, the
`S-Studio` tab in each `config_ols_*` screen, `canSql` in `config-scope.base.ts` and `rbac.service.ts`.
