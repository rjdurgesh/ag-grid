# OLS Dashboard — Integration Guide

This guide is the single reference for wiring the OLS Dashboard to your real backend:
where to configure things, every API the app calls, and the exact request/response
shape each one expects. It is kept up to date as the app evolves.

> TL;DR to go live: **nothing to edit per env.** `environment.ts` auto-resolves DEV/STG/PROD from
> the browser hostname (`ENV_BY_HOST`) — deployed hosts use a same-origin API (`apiBaseUrl:''`, proxied
> by `ui_server.py`) with `useMock:false`; local dev uses `:8000` + the mock. Build once, deploy the
> same bundle everywhere. Just keep `ENV_BY_HOST` hostnames + `supportEmail`/`isSsoEnabled` current,
> and make sure each API returns the documented shape. Backend env = `APP_ENV` per server (DEPLOYMENT.md
> → "Environments").

---

## 1. Central configuration — `src/environments/environment.ts`

All app/runtime config lives in this **one** file (not in `api-endpoints.ts`, which is now
URLs only and reads `apiBaseUrl` from here).

**Runtime env resolution (one build → DEV/STG/PROD).** `apiBaseUrl`, `appEnv`, `useMock` and
`apiMocks` are now **derived from the browser hostname** at load time, not hardcoded — the SAME built
bundle runs in every environment with nothing to swap. Edit `ENV_BY_HOST` (top of `environment.ts`)
to map your hostnames → env: `abc.dev.com`→DEV, `abc.stg.com`→STG, `abc.group.com`→LIVE (unknown host →
LIVE). Deployed → `apiBaseUrl:''` (same-origin `/api/...`, proxied by `ui_server.py`) + `useMock:false`
+ `apiMocks:{}`; local (`localhost`) → `:8000` + `useMock:true` + the local `apiMocks`. See DEPLOYMENT.md
→ "Environments" for the backend (`APP_ENV`) side.

| Setting | Purpose | Notes |
|---|---|---|
| `ENV_BY_HOST` | hostname substring → `AppEnv` map that drives everything below. | The one thing to keep current |
| `apiBaseUrl` | Root of the backend; every endpoint is built from it. | Auto: `''` (same-origin) deployed, `http://localhost:8000` local |
| `useMock` / `apiMocks` | In-app mock (global + per-screen). | Auto: on locally, off (`{}`) when deployed |
| `appEnv` | Environment (`DEV` \| `STG` \| `LIVE`). Header pill + sent to env-aware APIs. **`LIVE` → `PROD`** via `apiEnv()`. | Auto: from the hostname |
| `supportEmail` | Address the error-popup "Email" button reports to. | Your support inbox |
| `infraHealthRefreshMinutes` / `serviceConsoleRefreshMinutes` | Default auto-refresh cadence (minutes) for the Infrastructure Health / Service Console screens. Must be one of each page's dropdown options (5 / 10 / 15 / 30). | Your preferred default (e.g. `5`) |
| `username` / `name` | Demo identity for the direct (non-SSO) login / dev mode (real SSO overrides it). | Your dev user |
| `isSsoEnabled` | `true` = OpenID Connect (`src/app/auth/sso.config.ts`); `false` = direct login form. | `true` once `SSO_CONFIG` is filled in |
| `devRoles` | Preview role flags while `GET /api/auth/roles` is mocked. | — |

**Wiring an endpoint to the real backend (no code change):** point `apiBaseUrl` at your host,
keep `useMock: true`, and set that screen's prefix to `false` in `apiMocks` (e.g.
`'/api/config': false`). That area then hits the real API (visible in DevTools → Network) while
everything else stays on the mock. The reverse works too — keep a screen on `true` to mock it
even when `useMock` is globally `false`. Log Analytics, Infra Health, Service Console and Oracle
Command Center are already `false` (live) against the FastAPI backend in `backend/`.

`API` (in `api-endpoints.ts`) is one object holding every URL. To fully detach the mock, set
`useMock: false` (or remove `mockApiInterceptor` from [`app.config.ts`](src/app/app.config.ts)).

**Two independent layers of "mock" — don't confuse them:**
1. **Frontend `apiMocks`** (above, in `environment.ts`) decides whether a request *even leaves
   Angular*. `true` → answered in-browser by `mock-data.ts`, backend never called.
2. **Backend per-screen `*_USE_DUMMY`** decides, *once a request reaches FastAPI*, whether that
   screen returns canned data or runs its real functions: `ACCESS_USE_DUMMY` (access/config/regression),
   `INFRA_HEALTH_USE_DUMMY` in `.env`; OCC's is `use_dummy` in `config/occ.json`. The backend has **no**
   `apiMocks` — these flags are its equivalent, screen by screen.

   So three dev stages per screen: `apiMocks:true` (pure UI, no backend) → `apiMocks:false` +
   `*_USE_DUMMY=1` (real backend, canned data, no DB/agent) → `apiMocks:false` + `*_USE_DUMMY=0`
   (fully live). Each screen with a real/dummy split keeps its dummy data in a sibling module
   (`oracle_cc_dummy.py`, `infrastructure_health_dummy.py`) imported at the bottom of its API file.

**Backend config split** (`config_loader.py`): screen-specific, non-secret settings live in
per-feature files **`backend/config/<feature>.json`** — `regression.json` (**per scope**: cib/retail/group
git repo, work/log dirs, NAS feed path + a `defaults` block), `occ.json` (Oracle Command Center thresholds
/ schema / SQL-Intelligence), `config_ops.json` (CSV upload archive dir, limits, batch size). Real files are
per-server + gitignored; commit only `<feature>.example.json`. **`.env`** keeps only GLOBAL (`APP_ENV`, CORS)
+ SECRETS (`REGRESSION_GIT_TOKEN[_<SCOPE>]`, `CYBERARK_*`, DB creds) + the dummy flags. Resolution per key is
**JSON → legacy env var → default**, so existing `.env`-only deployments keep working (non-breaking). Edit a
JSON → restart the backend (read at import).

---

## 2. Routing & clean URLs

- URLs are hash-less: `/home`, `/log_analytics`, `/config_ops_console/cib`,
  `/infra_pulse/infrastructure_health`, `/infra_pulse/service_console`.
- This requires `<base href="/">` in [`src/index.html`](src/index.html) and a web
  server that serves `index.html` for unknown paths (SPA fallback). `ng serve` does
  this in dev automatically.
- **Production**: configure your server to fall back to `index.html`
  (nginx: `try_files $uri $uri/ /index.html;`). If the app is served under a
  sub-path, set `<base href="/subpath/">` and provide `APP_BASE_HREF` accordingly.
- Route table: [`src/app/app.routes.ts`](src/app/app.routes.ts). Nav items:
  [`src/app/layout/default-layout/_nav.ts`](src/app/layout/default-layout/_nav.ts).
- **API docs (Swagger):** FastAPI serves interactive Swagger UI at `{apiBaseUrl}/docs`
  (ReDoc at `/redoc`, raw schema at `/openapi.json`) — it lists the real backend routes
  and lets you exercise each GET/POST with "Try it out". A convenience route
  **`/swagger/docs`** ([`src/app/swagger_docs/`](src/app/swagger_docs)) redirects the current
  tab straight to it; the URL is derived from `environment.apiBaseUrl`, so it follows the
  configured backend. (Endpoints still answered by the Angular mock don't appear in Swagger until
  they're implemented as real FastAPI routes.)

---

## 3. Authentication

All auth code lives in [`src/app/auth/`](src/app/auth). The mode is chosen by
`IS_SSO_ENABLED` (section 1) — the `AuthService` facade
([`auth/auth.service.ts`](src/app/auth/auth.service.ts)) hides the difference from
the rest of the app. In both modes the bearer token is attached to every request
(`Authorization: Bearer <token>`) by `authInterceptor`, and `authGuard` sends
unauthenticated users to `/login`.

### Direct mode (`IS_SSO_ENABLED = false`, default)
- `POST {API_BASE_URL}/api/auth/login` with `{ username, password }` → `{ token, user }`
  (`user` = `{ username, displayName, role }`; see `LoginResponse` in
  [`shared/models.ts`](src/app/shared/models.ts)).
- The login page shows a username/password form. Mock accepts any non-empty creds.

### SSO mode (`IS_SSO_ENABLED = true`) — OpenID Connect
- Configure your provider in [`src/app/auth/sso.config.ts`](src/app/auth/sso.config.ts):
  `issuer`, `authorizeEndpoint`, `tokenEndpoint`, `endSessionEndpoint`, `clientId`,
  `redirectUri`, `postLogoutRedirectUri`, `scope`, `renewLeewaySeconds`. Most values
  are on your provider's `<issuer>/.well-known/openid-configuration`.
- **Flow:** standard Authorization Code + **PKCE** (no client secret in the SPA).
  The login page's "Continue with Single Sign-On" button redirects to the provider;
  the provider returns to `/auth/callback` ([`auth/sso-callback.component.ts`](src/app/auth/sso-callback.component.ts)),
  which exchanges the code for tokens and lands the user on their target page.
- **Timeout / re-auth:** before the access token expires the app **silently renews**
  it via the refresh token (on the same page — no redirect). If renewal fails the
  session is cleared and the user is sent back to `/login`. (Requesting the
  `offline_access` scope is what yields a refresh token.)
- **Logout:** clears the session and redirects through the provider's end-session
  endpoint back to `/login`, so the next sign-in re-authenticates.
- Register `redirectUri` (`<origin>/auth/callback`) and `postLogoutRedirectUri`
  (`<origin>/login`) with your provider. JWT signature validation is expected to be
  done server-side; the SPA obtains, stores and refreshes the token.

Key files: `auth/auth.service.ts` (facade), `auth/sso-auth.service.ts` (OIDC engine),
`auth/sso.config.ts` (provider config), `auth/auth.guard.ts`, `auth/auth.interceptor.ts`,
`auth/sso-callback.component.ts`.

### Login page & account menu
- The login page is a single **SSO Login** action (no credentials form). With SSO on
  it starts the OIDC flow; with SSO off a click establishes a local bypass session.
- The header **account menu** (`src/app/user_profile/`) shows the user's **UID, email,
  role and session age** ("signed in 7h 30m ago") with an initials avatar (no photos).
  It reads exactly the three claims OpenID returns — `sub` (UID) → `username`,
  `name` → `displayName`, `email`. Map extra claims in `sso-auth.service.ts`
  `storeTokens()` if needed. The login timestamp is captured at sign-in
  (`ols.login_at`).
- The login page shows a placeholder brand logo at `src/assets/ols.ico` (a copy of the
  favicon) beside the "OLS" wordmark — replace that file with your real logo.

---

## 3b. RBAC — roles & permissions

**Full handbook: [`RBAC_DESIGN.md`](RBAC_DESIGN.md)** (the model + a grant cookbook — this is a summary.)

Two gates: (1) the user is **active in `ols_users`** (`LGCL_DEL_FLG='N'` — read-only, never modified);
(2) **SSO**. Then one call, **`POST /api/access/me` `{ username, app_env }`** →  the resolved
**`AccessSnapshot`** (assembled server-side in [`access_api.py`](backend/access_api.py) from
`ols_users` + the grants table). [`rbac.service.ts`](src/app/auth/rbac.service.ts) caches it and
answers every gate.

**Everything is OPT-IN** — a user sees a screen ONLY if a grant touches it (there is **no default
read-all**). A valid login with **no grants** → the **No-Access page** ("No features assigned —
reach out to OLS Team"); `hasAnyAccess()` = active AND ≥1 granted screen. **Base role** from
`ols_users` flags (`IS_ADMIN` / `IS_READ` / `IS_SALT`):
| Role | Sees | Writes | Everything is |
|---|---|---|---|
| `ADMIN` | everything | everywhere (ignores grants) | granted |
| `READ` | only granted screens | only where granted | opt-in |
| `SALT` | Config Ops only (as granted) | only where granted | opt-in, config-only |
| none / no grants | → **No-Access** page (contact OLS Team) | | |

**Log Analytics + Infrastructure Health are UNGATED defaults** — every active user sees them (all
servers / all apps; no RBAC). Everything else is opt-in: Config Ops (config grant), Service Console
(`SCREEN service_console` / `APP`), OCC (`DB` grant). **Home** shows when the user has ≥1 feature and is
RBAC-filtered. **Two No-Access cases** on `/no-access` (message by `rbac.snapshot().active`): not an active
OLS user → "You don't have access to OLS (submit a provisioning request)"; active but nothing assigned →
"No features assigned yet" (rare now — everyone has the two defaults).

**Overrides = grants in `ols_app_access`** — one generic table
`(username, resource_type, resource_scope, resource_key, access_level, app_env)`. Types:
`SCREEN` (reveal/write an opt-in screen, e.g. Service Console / OCC), `APP` (Service Console per-app
— `service_console` scope), `DB` (OCC per-database + per-DB level),
`TABLE_CATEGORY` + `TABLE` (Config Ops opt-in read + per-table write, category matched on
`ols_master_table_config.table_category`), `SECTION … DENY` (hide a section, e.g. OCC SQL
Intelligence). `ACCESS_LEVEL` = `READ`/`WRITE`/`DENY`; per-table wins over category. **To grant, you
INSERT rows — no code change** (cookbook in [`backend/sql/access_examples.sql`](backend/sql/access_examples.sql), reference RBAC_DESIGN.md §6).

**Exclusion ("all EXCEPT")** — grant `*` then add a `DENY` row per key to carve out exceptions
(`SERVER`/`APP`/`DB`); `DENY` wins over `*` and trims explicit allow-lists, but never reveals a screen
alone. Snapshot carries `denied_servers` / `infra.denied_apps` / `service.denied_apps` / `oracle.denied_dbs`.

**Per-screen enforcement:** Log Analytics + Infra Health are ungated (all servers/apps shown to every
active user — `serverAllowed`/`infraAppAllowed` return true for active); Config Ops shows only granted
**sub-screens** (group/cib/retail via `configScopeVisible` — an ungranted scope like RETAIL is hidden)
and granted **tables** (`configTableAccess`), with the content modal's write buttons gated per-table
(`grid-data [canWriteRow]`); Service Console filters app panels (`serviceAppAllowed`) + start/stop =
`canWrite`; **OCC filters its DB tabs** and gates
kill/apply **per-DB** (`DB` grants → `dbAllowed` / `dbWritable` — READ tab view-only, WRITE tab
killable), and sections hide via `*olsIfSection`.

**Generic core** — [`rbac.config.ts`](src/app/auth/rbac.config.ts) lists screens. A new screen:
add its `ScreenKey` (+ `ALL_SCREENS`, + `SALT_SCREENS` if relevant), a `SCREEN_ROUTES` entry, a
`screenForNavUrl()` mapping, and `data: { screen: '<key>' }` + `canActivate: [rbacGuard]` on the
route. Everything else follows.

**Enforcement pieces:**
- [`rbac.service.ts`](src/app/auth/rbac.service.ts) — `canView` / `canWrite(screen)` / `configScopeVisible` / `configTableAccess` / `canWriteTable` / `serverAllowed` / `sectionAllowed` / `hasAnyAccess`.
- [`rbac.guard.ts`](src/app/auth/rbac.guard.ts) — blocks routes; redirects to first allowed or `/no-access`.
- Sidebar nav filtered by `canView` **+ per-scope** for Config Ops in [`default-layout.component.ts`](src/app/layout/default-layout/default-layout.component.ts).
- [`*olsCanWrite="'<screen>'"`](src/app/auth/can-write.directive.ts) — hides per-screen write controls (Service Console start/stop).
- [`*olsIfSection="{screen,key}"`](src/app/auth/if-section.directive.ts) — hides a section (OCC SQL Intelligence).
- `<app-grid-data [canWriteRow]="…">` — per-table write gate for the Config Ops content modal.
- **Admin diagnostic:** `POST /api/access/effective` `{ caller, username, app_env }` → resolved snapshot + raw grants ("why can't user X see table Y?").

**User Management screen** (Administration → User Management) lets an *ops-admin* grant/revoke access
from the UI (no SQL). Gated by a separate super-exclusive table **`ols_ops_access`** (`username`,
`is_active`) — a UID in it sees the screen, **everyone else (incl. `IS_ADMIN`) does not**; snapshot flag
`is_ops_admin`, route guard [`ops-admin.guard.ts`](src/app/auth/ops-admin.guard.ts). Catalogue-driven
form (`POST /api/access/admin/*`) grants any `ols_app_access` row to any active OLS user (target
validated against `ols_users`), revoke = **hard delete** (no audit), and it manages the ops-admin list
itself (no self-lockout guard). DDL/seed: [`backend/sql/ops_access_setup.sql`](backend/sql/ops_access_setup.sql).
Full detail: RBAC_DESIGN.md §11.

**S-Studio** (Config Ops → **Config | MISC | S-Studio** tab) is a raw SQL / PL-SQL console for running
queries, DML, anonymous blocks, and package/procedure deployments against one database. **Doubly
exclusive**: visible only to an ops-admin with **`ols_ops_access.can_sql='Y'`** (assigned per user from the
User Management **S-Studio** toggle; snapshot flag `can_sql`, `rbac.canSql()`). DB dropdown = the config
scope's databases from `db_configs` (prefix-filtered, so `cib` shows batch + reporting; auto-grows).
SELECT → results grid; DML/DDL/PL-SQL → status; **Oracle errors show in the panel**; **manual commit**
(include `COMMIT;`); **every run confirms the target DB**. Runs via [`sql_studio_api.py`](backend/sql_studio_api.py)
→ `database.execute_sql` on a **privileged** connection (`app.state.sql_db_configs`, separate from the
read-only OCC monitor). Full detail: RBAC_DESIGN.md §12.

**CSV Upload & Load** (Config Ops grid modal → 3-dot → **Upload Data**, gated by per-table write RBAC) loads a
CSV into the open table. Client: pick file → auto/override **delimiter** → RFC-4180 parse → **strict header
validation** (name + order; **trailing columns may be omitted → NULL**) → **editable, virtualized AG-Grid
preview** with per-cell validation (bad cells red; dates must be `YYYY-MM-DD`, fix inline or **Issues only** /
**Export**) → **Append** (insert only) or **Replace** (delete-then-insert; whole table, or the single COB date).
The server ([`config_api.py`](backend/config_api.py)) is the authority: validates against the real schema
(`ALL_TAB_COLUMNS`), resolves the **date column via the DB function `ols_util.get_date_column(:table)`**, type-casts
(explicit `TO_DATE`/native bind — never NLS), then `database.config_load_table` does the **atomic** load (per-table
lock, `DELETE` not `TRUNCATE`, batched `executemany`), **archives the CSV to NAS** (`<stem>_<user>_<token>.csv` +
SHA-256) and writes a maximal **`ols_upload_audit`** row. DDL: [`sql/upload_setup.sql`](backend/sql/upload_setup.sql);
config: `config/config_ops.json` (archive dir, limits, batch size). Config Ops is mock-backed today, so this is the first **real Config write
path** (frontend + mock verified; wire `sql_db_configs` to go live). Full design & internals: §4
**Config Ops — CSV Upload & Load (design & internals)** below.
Before a COB load the server runs a **partition detect-and-report** check (`database.config_partition_status`): if the
table is RANGE-partitioned on the date column and the date's partition doesn't exist yet (e.g. a future COB date),
it **stops before writing** with a clear 409 ("partition for <date> does not exist … ask the DBA/dev to create it")
— no auto-DDL. Any load/DB error (including this) opens the **rich error dialog** (full message + Copy + Email to
`environment.supportEmail`).
The same modal's **Roll Data** (COB tables) rolls one **source** date's rows into **one or more target dates**
(Target Start/End + a **Date Range** toggle → the expanded list; `POST …/roll` → `database.config_roll_dates`,
which calls the standard **`ols_util.roll_static_data`** proc once with the target dates as a `SYS.ODCIVARCHAR2LIST`
— the proc loops internally, per-date, and returns an OUT error list so one bad date is skipped not fatal) and
reports a **per-date result** (each target ✓ rolled / ✗ failed with the DB error; "N of M rolled, K failed").

**Regression** (Config Ops → **Regression** tab, **DEV/STG only** AND granted per scope via an
`ols_app_access` **`REGRESSION`** grant — `rbac.regressionVisible(scope)`; hidden otherwise, NOT tied to the
ops-admin table)
drives the pre-prod cycle as a gated, force-markable, fully-audited workflow: Refresh DB (multi-select all 5 DBs)
→ Apply DB changes (git-pull a `release/*` branch → run `CHG_*.sql` on the chosen DB(s) via **sqlplus**, log +
Download) → File copy (developer JSON manifest, `*` = recurse) → Reset → Trigger (run a branch `.sql` on one of
the 3 batch schedulers). Once every step is complete/forced, **Mark run complete** closes out the run (logs a
`run/complete` audit row, run status → Completed on screen, then Start new run). Apply DB also has
a collapsible **release-branch browser** (`git/tree` + `git/file`) to walk the pulled branch tree and read any
CHG/package/proc file on screen — verify a package exists / has the latest code before running (the browser is
empty until a branch is pulled, then reflects that exact branch). Every sqlplus run (Apply/Reset/Trigger) streams
**live** into a **collapsible, dockable sqlplus-style console** — output appears line-by-line as it executes
(`run-sql-stream`, Server-Sent Events; the dev mock animates the same), with collapse / expand / maximize /
Download. Each step shows its **last-run timestamp + run time**, badges **In progress** while running, blocks
Apply with a validation popup when no script/DB is picked, and prompts a confirm when re-running an already-complete
step. File copy shows a per-item log (files copied / failure detail) and writes a **durable per-item audit row**
(`copy_item`) as each item completes — so a crash / dropped connection mid-copy still records exactly what was
copied, and the step can be safely re-run (copies overwrite = idempotent). A `*` **folder item is all-or-nothing**:
if it fails partway (e.g. 450/500) the whole item is errored ("the WHOLE folder must be re-copied") and re-running
re-copies the entire folder — there is no file-level resume. Because the run + step statuses live in
Oracle (`run/current`), a **page refresh restores the run** rather than losing it: an in-progress run shows a
**resume gate** (started-by / when) with **Resume** (opens the workflow) or **Start fresh** (abandons the old run,
logged) — the steps stay hidden until resumed. A header **Refresh-state** button re-reads the backend after a drop.
**Concurrency:** each step action first writes a durable `in_progress` marker; the server rejects a second start of
the same step (409) while it runs, and every action records **who did it** (`performed_by`, shown per step + in the
log) — so multiple operators can share a run without stepping on each other. A step stuck `in_progress` past
`REGRESSION_STEP_STALE_MINUTES` (crash between start and result) is flagged **stale** and offers a logged **Unlock**
(→ error, re-runnable) so the run can't deadlock. Below it, two monitors: **Monitoring Batches** (a
`database.fetch_batch_monitor` query — returns the whole result set, capped only by `REGRESSION_BATCH_MAX_ROWS`
(default 100k); shown in an **AG-Grid with pagination + per-column filter + sort**, fixed to **OLS CIB Batch**
(no DB dropdown); icon **Refresh** + a live **"Last refreshed <ts> · N sec ago"** line) and
**Regression Activity** (the `ols_regression_log` audit — also an **AG-Grid** with pagination/filter/sort, icon
Refresh + the same live last-refreshed line). Backend
[`regression_api.py`](backend/regression_api.py) + `regression_ops.py` (git/sqlplus/copy) + `database.py`;
tables `sql/regression_setup.sql`; **per-scope config in `config/regression.json`** (each scope's git repo,
work/log dirs, NAS feed manifest — resolved via `config_loader.regression_scope_config(scope)`), git token in `.env`.
**Server prereqs: git + sqlplus.** The sqlplus password is fed over STDIN and **masked** in every log; it is
resolved server-side — from config, or at runtime from **CyberArk** ([`cyberark.py`](backend/cyberark.py), CCP
client-cert call by AppID; `CYBERARK_*` in `.env`) — so it is never typed in the UI or visible in the network tab.
**Frontend is per-scope** (so scopes can diverge — different steps later): each has its own component + service
under `views/config_ops_console/regression/` — `ols_cib_regression/` (`app-ols-cib-regression`, rendered by
config_ols_cib) and `ols_retail_regression/` (`app-ols-retail-regression`, rendered by config_ols_retail); group
to follow. Both are gated by `showRegression` = **DEV/STG AND a per-scope `REGRESSION` grant**. Each scope is a **separate application with separate regression
state** — the per-scope service sends `scope` on every `/api/regression/*` call and the dev mock keys its run/activity
store per scope (real backend is CIB-only today and ignores it; a retail backend would filter by scope). Retail's DB
defaults are `retail_batch`. The two monitor grids auto-load on open (no Refresh click), use **separate `gridOptions`**
(batches page size 50, activity 100 — never share one options object across grids), show a live "Last refreshed … ·
N sec ago" beside the refresh icon, and any toast auto-dismisses after 4s. Full detail: memory `regression-screen`.

**Local testing** (`USE_MOCK`/access mocked): flip `devRoles` in
[`environment.ts`](src/environments/environment.ts) to ADMIN/READ/SALT — the mock
(`mock-api.interceptor.ts` `mockAccessSnapshot`) serves a representative snapshot per role. In dev the
ADMIN role also stands in for the ops-admin gate, so User Management is reachable.

**To go live:** wire `app.state.app_db_config` (the app DB holding `ols_users` + `ols_app_access`),
set `ACCESS_USE_DUMMY=0`, ensure `/api/config/{scope}/tables` returns `TABLE_CATEGORY`, and
**re-check every write server-side from the SSO token** (RBAC_DESIGN.md §9 — UI hiding is not security).

---

## 4. API catalog

All paths are relative to `API_BASE_URL`. Shapes are defined in
[`src/app/shared/models.ts`](src/app/shared/models.ts) and
[`src/app/shared/infra-models.ts`](src/app/shared/infra-models.ts).

### System / Home
| Method & path | Request | Response | Used by |
|---|---|---|---|
| `GET /api/system/memory` | – | `MemoryStats` `{ free, used, total, unit, percent }` | One-shot snapshot (real host memory via `psutil`/stdlib) |
| `GET /api/system/memory/stream` | – | **SSE** stream of `MemoryStats` (one `data:` frame every ~2s) | Header live memory — consumed via `EventSource`, so it's ONE persistent connection (single network-tab entry), not a poll. Bypasses the mock → always the real backend. |
| `GET /api/system/database` | – | `{ name: string }` | Footer DB name (centered) |
| `GET /api/system/version` | – | `{ version: string }` | Sidebar-footer version chip (`API v…`); source = `APP_VERSION` in backend/.env. UI version is `environment.uiVersion`. |
| `GET /api/dashboard/stats` | – | `DashboardStat[]` | Home KPI cards |
| `GET /api/dashboard/activity` | – | `ActivityItem[]` | Home activity feed |
| `GET /api/dashboard/memory-trend` | – | `number[]` (last 12 % samples) | Home trend chart |

### Log Analytics
**Only `/servers` touches the DB** — it returns each server's `base_log_path`. A
server's value is an **array** (one row per configured `base_log_path`), so a server
can have **several base paths**; the tree shows **one root per base path**. From
there the UI browses the filesystem live, handing the backend the `base` it already
has plus the `path` it wants — no further DB calls.

**How browsing works (lazy, one folder per expand).** The tree seeds directly from
the base paths returned by `/servers` (no separate "list files" call). When a folder
is expanded, the UI **POSTs** to `/api/log/dir` with body `{ server_id, base, path }`
(body, not query string, so long paths never bloat the URL):

- `base` = the selected server's configured `base_log_path` — **constant**; it is
  the security **ceiling** (the request may not climb above it).
- `path` = the folder being opened — the base itself on first expand, then a deeper
  path each time you go down (e.g. `D:/Website` → `D:/Website/coreui` →
  `D:/Website/coreui/src`). The backend confirms `path` sits inside `base`, then
  reads that folder from disk and returns its immediate children. Works to any depth.
- `server_id` = which server is being browsed — **context only** (logged for
  traceability); the jail uses `base`, not this.

`file` / `file-properties` POST the same `{ server_id, base, path }`.

**Large-file preview (windowed).** `POST /file` picks its shape by file size
(`OLS_FILE_WINDOW_THRESHOLD`, default 400 MB):

- **small** (≤ threshold) → `{ mode:'full', content, total_size }` — the whole file;
  the UI paginates it by line as before.
- **large** (> threshold) → `{ mode:'window', content, start, end, total_size, bof,
  eof }` — a **line-aligned byte window** the UI pages through, so a multi-GB file
  never loads whole anywhere (no hang, no dropped connection). Request a window with
  `{ offset, length, from_end }`: `from_end:true` = the newest-first **tail**;
  otherwise `length` bytes from `offset`. Window size is user-selectable
  (**256 KB / 512 KB / 1 MB / 2 MB / 5 MB**; server clamps to an 8 MB ceiling).
  The pager counts in **reading order** like the line pager: **Page 1 = the first
  window shown** (the tail in newest-first / desc), First/Prev disabled there,
  Next reads further (older). It sends `offset = start − length` to read on and
  `offset = end` to go back (flipped for asc); `from_end` for page 1, `0` for last.
- **Download** is separate: `GET /api/log/file/download` **streams** the whole file
  to disk (1 MB chunks, never buffered in RAM) — works at any size.

**Per-folder cap (anti-hang):** `/dir` returns at most `OLS_DIR_LIMIT` entries (default
**500**) *per folder call*; when a folder holds more, `truncated: true` + the real `total`
come back and the tree shows a "showing N of M — filter to narrow" note. The cap is
per-folder, so going **deeper** is never limited — expanding a child triggers a fresh `/dir`
that returns up to 500 of that child's own entries.

**Left refresh button** re-fetches every **currently-expanded** folder (one `/dir` each)
and **merges the fresh listing in place** — so the tree stays **open** at the same depth
(new files/dirs appear, deleted ones drop, open sub-folders remain open) rather than
collapsing. It also **resets the right preview to default**. It never re-hits `/servers`
(only page open/refresh does that). Selecting a different server re-seeds that server's roots.
The tree panel scrolls **horizontally** so long/deep names are read in full (no ellipsis) —
important for same-name files that differ only by a date suffix.

| Method & path | Request | Response |
|---|---|---|
| `GET /api/log/servers?app_env=<DEV\|STG\|PROD>` | – | `LogServersResponse` (map key → **array** of rows, one per `base_log_path`); `app_env` scopes the DB query (`LIVE`→`PROD`). **The only DB-backed call.** |
| `POST /api/log/dir` | `{ server_id?, base, path }` | `LogDirResponse` `{ entries: {name,type,path}[], total, truncated }` — immediate children of ONE folder, read from disk (jailed to `base`, **capped per folder** — `truncated`/`total` when the cap is hit) |
| `POST /api/log/file` | `{ server_id?, base, path, offset?, length?, from_end? }` | small: `{ mode:'full', content, total_size }`; large: `{ mode:'window', content, start, end, total_size, bof, eof }` (line-aligned byte window; jailed to `base`) |
| `GET /api/log/file/download?base=&path=` | – | streamed file download (`Content-Disposition` attachment; never buffered in RAM; jailed to `base`) |
| `POST /api/log/file-properties` | `{ server_id?, base, path }` | `FileProperties` (jailed to `base`) |

> **Jail:** `path` must resolve to inside `base`. Escape (`..`, another drive, symlink out)
> → **400**; a path inside `base` that no longer exists (deleted since the tree loaded) →
> **404 "Path not found"** (clean error, never a hang).

### Config Ops Console (`scope` = `cib` \| `group` \| `retail`)
The catalogue and content are **fully dynamic** — the grid renders whatever columns
the API returns, so adding a column to the backing table needs no UI change. Only the
*semantic* catalogue columns are looked up by name (case-insensitive): **TABLE_NAME**
(row key + modal title), **IS_ACTIVE** (Y ⇒ openable), **IS_COBDT** (Y ⇒ date-partitioned).
**IS_COBDT / IS_ACTIVE render as coloured flag badges** — green for truthy, grey for
falsy — but showing the **raw value verbatim** (`Y`, `N`, `Yes`, `true`, …), never
relabelled. Truthy/falsy detection is case-insensitive across `Y|YES|TRUE|1` / `N|NO|FALSE|0`
(so `y`, `nO`, `False`, etc. all colour correctly). Same badge is used in the content modal's
CHAR(1) columns and the expand-detail's IS_* columns.

| Method & path | Request | Response |
|---|---|---|
| `POST /api/config/{scope}/tables` | `{ app_env, username }` | `TabularData` `{ cols, rows }` — catalogue for that env (`LIVE`→`PROD`). Body (not query) so `username` stays out of the URL/logs. **Returns a `DB_SOURCE` column per row** — no `db_source` in the request (see note below). |
| `POST /api/config/{scope}/columnretrieve` | `{ table_name, db_source }` | `TabularData` `{ cols, rows }` — **down-arrow expand** detail, rendered as-is |
| `POST /api/config/{scope}/retrieve` | `{ table_name, db_source, is_cobdt, start_date, end_date, date_range }` | `TableContentResponse` `{ cols, cols_data_types, Table_data }` |
| `POST /api/config/{scope}/roll` | `{ rolled_by, table_name, db_source, source_date, target_dates[], tablespace }` — `tablespace` = `OLS_RPT32` (group) / `OLS` (cib, retail) | `{ status, source_date, source_count, targets:[{date,status,count,error?}] }` — per-date result |
| `POST /api/config/{scope}/table/{table}/rows` | `{ inserted_by, db_source, columns, rows: [[…]] }` | `{ inserted: N }` — INSERT |
| `POST /api/config/{scope}/table/{table}/update` | `{ updated_by, db_source, updates: [ { "<rowid>": { col: val } } ] }` | `{ updated: N }` — UPDATE |
| `POST /api/config/{scope}/table/{table}/delete` | `{ deleted_by, db_source, rowids: [ "<rowid>", … ] }` | `{ deleted: N }` — DELETE |

**`db_source` routing (batch vs reporting).** Each scope has one or two physical DBs — `ols_group`, or
`ols_{cib,retail}_batch` + `ols_{cib,retail}_reporting` — matching the **app.py connection keys**. The
master catalogue table lives ONLY in the scope's **batch** DB but describes tables in BOTH, so it carries
a **`DB_SOURCE`** column naming each table's physical DB. `/tables` reads the catalogue (batch DB, so it
needs no `db_source`) and returns that column; **every per-table op** — `columnretrieve`, `retrieve`,
`roll`, insert / update / delete, and `…/upload` — then sends the row's `DB_SOURCE` back as `db_source`,
and the backend `config_api._source_db(request, db_source, scope)` opens the matching connection, routing
the read/write to the correct **batch or reporting** DB. The frontend resolves it via
`config-scope.base.ts` (`rowDbSource(row)` for ops that have the row; `dbSourceFor(tableName)` — a lookup
in the loaded catalogue — for insert/update/delete). **Real backend status:** `columnretrieve`, `retrieve`,
insert/update/delete, `upload` and `roll` are all **implemented** in `config_api.py` + `database.py`
(reads gated by `_require_config_read`, writes by `_require_config_write`; CRUD casts cells via `_cast`,
stamps INSERTED_*/UPDATED_* audit columns, and targets rows by **ROWID**; insert reuses
`config_load_table(mode='append')`). Only the **`/tables` catalogue** is still mock-served (its master-table
SQL is app-specific). Every real endpoint short-circuits to canned data when `ACCESS_USE_DUMMY=1`.

**Mutation payload shapes** (the backend keys rows by their DB `rowid`):
- **INSERT** — `rows` are value arrays in `columns` order; new drafts are entered at the
  **top of the first page** (so pagination never hides them). Save persists only the ticked drafts.
- **UPDATE** — `updates` is an array of `{ "<rowid>": { onlyChangedColumn: value } }` objects.
- **DELETE** — `rowids` is an array of the DB rowids. (A just-inserted row has no rowid until
  the grid is refreshed — refresh before editing/deleting a row you just added.)

**Errors** — INSERT/UPDATE/DELETE failures open the rich **error popup**: the FULL server
message (`error.details` from Oracle, or `error.message`), scrollable, with **Email / Copy /
OK / Close**. *Email* opens a pre-filled report to `SUPPORT_EMAIL` (`api-endpoints.ts`, single
source) — subject `"<UserID>: Issue with OLS Operations Dashboard - DD-Mon-YYYY"`. Success still
shows the simple "N rows …" notice. *(Dev: submit a cell value of `ERR` to trigger a mock ORA error.)*

**Down-arrow (expand) flow:** clicking a row's ▾ calls **`columnretrieve`** with that
row's `table_name` and renders the returned `{ cols, rows }` verbatim in a full-width
detail grid (plain text, no typing). This is separate from the eye modal.

**Eye (view content) flow, per row:** the **`retrieve`** call always sends
`{ table_name, is_cobdt, start_date, end_date, date_range }`:
- `is_cobdt` — the catalogue row's `Y`/`N` flag, passed straight through.
- `start_date` / `end_date` — the two dates currently selected on the modal's date bar
  (default **T-1** on both) **when is_cobdt = Y**; sent as **`null`** when is_cobdt = N.
- `date_range` — `false` = just those two days, `true` = the inclusive range. Defaults to
  `false`; on the modal's **Retrieve** button it follows the "Date Range" checkbox.

The response is **self-describing** — `cols`, `cols_data_types` (parallel cx_Oracle types,
e.g. `<cx_Oracle.DbType DB_TYPE_DATE>`), `Table_data` (row objects). The type drives
rendering: **DATE → date-only calendar**, **TIMESTAMP → date+time calendar**,
**CHAR(1) → Yes/No badge**, **CLOB/BLOB/JSON/XMLTYPE → the "…" value token**, else text.
The modal **Retrieve** button re-issues the *same* `retrieve` call with the chosen dates +
checkbox (COB tables only — the date bar shows only when is_cobdt = Y).

**CLOB/JSON/XML/BLOB values** open in a dedicated **value modal** (a standalone overlay, *not*
a nested CoreUI modal — nested CoreUI modals collapse each other, so closing it never closes the
data-grid modal underneath). Read-only rows show it as a pretty-printed viewer (JSON/XML indented,
Copy + Close). While a row is being **edited** (draft or inline-edit), the same cell shows a pencil
affordance (an "Enter data…" hint when empty) that opens the modal as a **textarea editor with
OK / Cancel** — these values are edited here, never inline in the grid cell. OK writes the text back
into the row (part of the INSERT for a draft, or the UPDATE diff for a saved row).

**`rowid` is hidden.** Each `Table_data` object carries a `rowid` (the DB row id) that is
**not** listed in `cols`, so it never becomes a visible column — the grid keeps it in the
row data and uses it as the identity for update/delete.

**Insert / Update / Delete** each hit their own endpoint (table name in the URL, rest in
the body) and stamp the acting user (`inserted_by` / `updated_by` / `deleted_by` = the
signed-in user). Update sends **only the changed columns** per row (keyed by `rowid`);
insert sends **values in column order**. Each call returns the affected-row **count**,
shown in a success popup ("2 rows deleted successfully"); on failure the API's error
message is shown.

**Selection model (modal grid) — one operation at a time.** The modal never mixes an
INSERT and an UPDATE into a single ambiguous Save. Exactly one operation can be *pending*:
**Insert** (Add / Duplicate stage drafts), **Update** (Edit puts saved rows into inline-edit),
or **Delete** (immediate). Starting a different operation **resets the previous one** — Add or
Duplicate while editing reverts the edits; Edit while drafting discards the drafts; Delete
clears whatever was pending. *Add and Duplicate are both INSERT.*

- **Add / Duplicate** stage a new draft row that is **auto-ticked**. The bottom
  **Save selected N** inserts **only the ticked drafts** — untick a draft to leave it out; it
  stays as a draft. Add 3, untick 1 → Save selected 2 inserts 2.
- **Edit selected N** puts the selected saved rows into inline-edit and **keeps them selected**,
  so the bottom **Save selected N** updates them all in one UPDATE (each row also keeps its own
  per-row Save). While in update mode the "Edit selected" button hides.
- **Bulk buttons** — selecting existing (saved) rows shows **Edit selected N / Duplicate
  selected N / Delete selected N** (count = selected **saved** rows). Duplicate clones them into
  ticked drafts (switches to Insert); Delete removes them (after confirm).
- **Per-row buttons** (Edit / Duplicate / Delete on each row) act on **that row only** —
  never in bulk.
- **Save selected N** commits only the current pending operation for the **ticked** rows:
  the ticked drafts in Insert mode, or the ticked edited rows in Update mode.

### Config Ops — CSV Upload & Load (design & internals)

Design for the **Upload Data** feature in the Config Ops grid modal (3-dot → *Upload Data*). An
authorized user uploads a CSV into the currently-open table, reviews/edits/validates it on screen, then
loads it — safely, generically, fully audited. RBAC detail: RBAC_DESIGN.md. (The §3b summary above is the
short version; this is the full internals.)

#### 1. Goals & principles
- **Generic** across any config table (columns/types come from the catalogue, not hard-coded).
- **Safe**: every load is one **atomic transaction** — it fully succeeds or fully rolls back. No partial state.
- **Reviewable**: the user sees + edits the data on screen and fixes rejects **before** anything is written.
- **Authoritative server**: the client is UX; the server re-validates header, types, RBAC, and identifiers.
- **Traceable**: every successful load archives the file to NAS + writes a maximal audit row.

#### 2. Where it hooks in
- **Frontend**: `GridDataComponent.uploadData()` opens the upload dialog. The modal already holds the
  table's `cols`, `cols_data_types`, and the row's date flag — so header + type + COB decisions are
  available client-side. Reuses the existing `toCsv` export.
- **Gate**: same RBAC as editing — only users who can **write** that table (`canWriteTable`) see/use Upload.
  The server re-checks write permission.
- **Backend**: the Config Ops backend is **mock-only today**. This feature ships the **first real Config
  write path** (`config_api.py` + `database.py` functions), plus a mock for dev.

#### 3. Table / date metadata (the date-column function)
The customer's **existing DB function** `ols_util.get_date_column(<table_name>)` returns each config
table's **date column name** — `COB_DT` or `REPORTING_DT` (defaulting to `COB_DT` when it returns
nothing). This is the authority for the **exact date column name** to use in `DELETE WHERE <date_col> = :d`.
The server resolves it via `cursor.callfunc("ols_util.get_date_column", str, [table])` (in
`database.config_date_column`) — never trusts the client. The catalogue's existing `is_cobdt`-style flag /
start-end date UI is derived from the same source.

#### 4. Load modes
Both modes apply to **every** table type; only the DELETE scope differs.

| Mode | Non-date table | Date table (COB/reporting) |
|------|----------------|-----------------------------|
| **Append**  | `INSERT` only (no delete) | `INSERT` only for that date (no delete) |
| **Replace** | `DELETE FROM tgt;` then `INSERT` (full replace) | `DELETE FROM tgt WHERE <date_col> = :d;` then `INSERT` |

- **Date tables: exactly ONE distinct date per file, enforced** (client + server). >1 distinct date →
  block: *"This file has N dates (…). Upload one date per file."*
- **`DELETE`, never `TRUNCATE`** — TRUNCATE is DDL, auto-commits, can't roll back; a failed insert after
  TRUNCATE would leave the table empty with no undo. DELETE keeps the whole load atomic.

#### 5. Date & type handling
The #1 Oracle-load bug is relying on implicit `NLS_DATE_FORMAT` conversion (ambiguous, env-dependent).
We avoid it entirely:
- **Canonical input formats, enforced + shown in the dialog** (ISO 8601, **24-hour, no AM/PM, no tz**):
  - `DATE` → `YYYY-MM-DD` (time defaults to `00:00:00`); also accepts `YYYY-MM-DD HH24:MI:SS` when the DATE carries a time.
  - `TIMESTAMP` → `YYYY-MM-DD HH24:MI:SS`, optional fractional seconds `.ffffff` (≤6).
- **Date columns are known** from `cols_data_types` (the catalogue already returns Oracle types).
- **Client** validates each date cell (format + real-calendar check → `2026-02-30` rejected); 2-digit years
  rejected; users warned that Excel reformats dates (save ISO / as text).
- **Server converts explicitly** — parse each date string with the canonical format into a native
  `datetime` and **bind the datetime object** (python-oracledb → `DATE`/`TIMESTAMP`, no NLS). The
  `date_col = :d` value in the DELETE is likewise a bound date.
- **Numbers**: validate numeric (reject thousands separators / stray chars), bind native; **NULLs**: empty
  cell → `NULL` for nullable columns, **reject** for `NOT NULL`; strings trimmed; length checked.

#### 6. Header validation (strict, with trailing-column omission)
Expected header = the table's business columns from `retrieve` (audit columns like `inserted_by` are
system-set, **not** in the file). Validate **name + position** from the left — case-insensitive, trimmed.

**Trailing columns may be omitted** (SQL*Loader `TRAILING NULLCOLS`): the file's columns must be a valid
**left-prefix** of the table's columns (names match in order from column 1 — **no middle gaps, no
reordering**). Omitted **trailing** columns are auto-filled `NULL`, provided:
- each omitted column is **nullable or has a DB default** — an omitted `NOT NULL` (no default) column is a
  hard error: *"Your file omits required column(s): X, Y."*;
- for a **date table**, the **date column is never omittable** (needed for the single-date rule + Replace).

**Never silent**: the preview shows all table columns with omitted ones rendered as `(NULL — not in file)`,
and the confirm dialog states *"columns X, Y, Z will be set to NULL."* Middle gaps / extra / reordered
columns → Load stays disabled with a precise diff.

#### 7. Preview, validation & the reject flow
- **Editable, virtualized grid** (AG-Grid — virtualization handles 80–90k rows; only visible cells render).
  A **3-way view segment (All / Valid / Issues)** + pagination + column filters replace the old binary toggle.
- **Two-layer validation** (validation itself is cheap — ~1.8M cell checks at 90k×20 is sub-second):
  - **Client, primary**: per-cell type/format/NOT-NULL checks; bad cells **highlighted**; validated on edit
    (automatic — `onCellChanged` → `validateRow`, no separate validate click) and fully on Load.
  - **Server, authority**: re-validate header + type-cast + DB constraints; rejects are rare by then.
- **Reject flow**: fix a rejected row → re-validate → it promotes into the valid set; may **proceed with
  valid rows only**; may **export rejects** to CSV. **Atomic load**: only the valid set is inserted.

#### 8. Delimiter & parsing
- **Delimiter**: **Auto-detect** (sniff the header for the most consistent delimiter) with manual
  **override** (`, ; | : tab`).
- **RFC-4180 parser** — quoted fields, embedded delimiters/newlines, `""` escaping, BOM strip
  (hand-rolled in `shared/csv-util.ts`, dependency-free — not `split(',')`).

#### 9. Transfer & the load engine
- Because the grid is **editable**, what loads is the **edited** data — on Load the client **regenerates a
  CSV from the (edited) valid rows** and sends *that*. The server re-parses it (authority) and inserts. That
  same CSV is archived — a faithful record of exactly what entered the table.
- **No per-user temp tables** (dynamic `CREATE TABLE tmp_<t>_<user>` is an anti-pattern: DDL per upload,
  library-cache churn, orphan cleanup; and it doesn't prevent the real conflict on the shared target). A
  **single-request atomic load needs no staging** — the user already reviewed client-side.
- **Engine (one request, one session, one transaction)**:
  1. RBAC write re-check + **identifier whitelist** (table + columns must exist in the catalogue — never
     interpolate client identifiers).
  2. Resolve date column via `ols_util.get_date_column(:table)` → date column / mode scope.
  3. Take a **per-target-table application lock** (`SELECT … FOR UPDATE NOWAIT`, reuses the regression
     step-lock pattern) → reject a concurrent load with *"A load into TBL is in progress by X"*. (COB tables
     lock at `(table, date)`.)
  4. Re-parse CSV → re-validate header → type-cast/convert every cell (collect rejects).
  5. **Partition detect-and-report** (COB tables): `database.config_partition_status` — if the table is
     RANGE-partitioned on the date column and the date's partition doesn't exist yet, stop **before** any
     write with a **409** (*"partition for <date> does not exist … ask the DBA/dev to create it"*). No DDL.
  6. `DELETE` per mode (none for Append) → **batched `executemany` INSERT** (5–10k rows/batch).
  7. **COMMIT** (or ROLLBACK on any error).
  8. On success: **archive to NAS** + **write audit** + return counts. UI refreshes the modal grid.
- **Scale**: batched insert; define ceilings (`CONFIG_UPLOAD_MAX_ROWS` / `_MAX_MB`); beyond that, direct
  users to SQL*Loader/external tables.

#### 10. NAS archive
On success, copy the loaded CSV to `CONFIG_UPLOAD_ARCHIVE_DIR`, renamed
**`<original_stem>_<username>_<token>.csv`** (username for at-a-glance, token for uniqueness even if the same
user re-uploads the same filename). Store its SHA-256 in the audit row.

#### 11. Audit — `ols_upload_audit` (maximal)
`load_id (PK, identity)`, `load_dt` (DATE, default SYSDATE — activity date, query "today's/yesterday's" loads),
`app_env`, `scope`, `table_name`, `mode` (append/replace), `date_col`, `cob_dt` (the single business date
loaded), `original_filename`, `archived_path`, `file_hash` (SHA-256), `delimiter`, `uploaded_by`,
`start_time`, `end_time`, `duration_secs` (= end−start, seconds; convenience, derivable), `rows_in_file`,
`rows_loaded`, `rows_rejected`, `rows_deleted`, `status` (success/partial/failed), `error_desc` (CLOB). A
failed load also writes an audit row (`status='failed'`, `error_desc` set) before surfacing the error. The row is written by the
**`ols_upload_audit_write` DB procedure**, called as a **`PRAGMA AUTONOMOUS_TRANSACTION`** so the audit
persists even when the load's own transaction rolls back. `database.config_upload_audit_write` holds **no
column list** — it forwards whatever fields the caller passes as `p_<name>` params — so **the proc owns the
column list**: adding an audit column means changing only the proc (and `config_api.py` if the value comes
from the app; nothing if the column is DB-defaulted/computed), never the `database.py` plumbing.

#### 12. Security
- **RBAC**: server re-checks per-table write permission (`canWriteTable`). Upload hidden without it.
- **SQL-injection surface** (genericity is the risk): table + column identifiers **whitelisted** against the
  catalogue (`_is_ident` + `ALL_TAB_COLUMNS`); **all values bound as parameters**; never string-concatenate
  identifiers/values.
- **Privileged connection**: writes use `app.state.sql_db_configs` (privileged), never the read-only OCC
  monitor `db_configs`.
- **File**: `.csv` only, max size/rows enforced. CSV-injection: sanitize leading `= + - @` on any re-export.

#### 13. Code layout (data/API split)
- **Backend**: `database.py` holds **all** SQL — `config_table_columns`, `config_date_column`,
  `config_load_table` (lock/delete/executemany), `config_upload_audit_write`, `config_partition_status`,
  `config_roll_dates`. Thin `config_api.py` — `POST /api/config/{scope}/table/{table}/upload` and `…/roll`
  — validates + parses + orchestrates; router registered in `app.py`. DDL in `sql/upload_setup.sql`
  (`ols_upload_audit` + `ols_upload_lock` + the `ols_upload_audit_write` autonomous-transaction proc).
- **Frontend**: upload dialog (`components/grid-data/upload/`), `shared/csv-util.ts`, RBAC gate; reuses `toCsv`.
- **Mock**: `mock-api.interceptor.ts` handles the upload + roll endpoints for dev parity (`REJECTME` cell →
  reject demo; `DBERROR` → ORA-14400 demo; future date > mock max → partition 409 demo).
- **Config** (`config/config_ops.json`, via `config_loader.config_ops_config()`): `archive_dir`, `max_rows`,
  `max_mb`, `batch_size`, `audit_columns` (legacy `CONFIG_UPLOAD_*` env vars still work as fallback).

#### 14. Failure & concurrency
- Any error → ROLLBACK → target unchanged; audit row written `failed` with `error_desc`; the UI opens the
  **rich error dialog** (full message + Copy + Email to `environment.supportEmail`).
- Per-table (or per table+date) lock serializes concurrent loads; a stuck lock reuses the regression
  stale-threshold + unlock pattern.

#### 15. Roll Data (COB tables)
The same modal's **Roll Data** rolls one **source** date's rows into **one or more target dates** (Target
Start/End + a **Date Range** toggle → the expanded local-time list, excluding the source). `POST …/roll` →
`database.config_roll_dates`, which just hands the customer's standard **`ols_util.roll_static_data(table, fromdt,
todt_list, tablespace, uid, errmsg OUT)`** procedure its five inputs (table, from date, the **`SYS.ODCIVARCHAR2LIST`**
of 'YYYY-MM-DD' target dates, tablespace, uid) and lets the package do everything — **the proc loops over the dates
internally** (`ols_roll.rolltable` per date; audit stamping, tablespace/partition handling, and — per its loop
`COMMIT` — each target commits independently). No app-side COUNT queries. The proc returns a **same-length OUT
`errmsg` list** — slot *i* is `NULL` when date *i* rolled, or its Oracle error when that date was **skipped** — so one
bad date **doesn't abort the rest** (each iteration is its own `BEGIN…EXCEPTION…END`). from/to pass as strings (the
proc `TO_DATE`s them). The **per-date result** marks each target `success` (✓ rolled) or `failed` (the DB error) →
the roll panel shows a *"N of M rolled, K failed"* banner with each good date ✓ and, for each failed date, the
**first line** of the DB error + "…" as a **clickable link** → the full multi-line error opens in the rich error
dialog (Copy + Email; `errorReport.show`). The proc also returns per-date **row counts** (`p_rows OUT
SYS.ODCINUMBERLIST`) + the **source count** (`p_src_rows OUT NUMBER`) — counted inside the DB via the date column
it resolves, no app-side query — so each rolled date shows its row count and a **⚠** when it differs from the
source (catches a **0-row or doubled** roll that raised no DB error). `tablespace` + `uid` (roller) come from the
Roll Data dialog / `RollBody`.

#### 16. Open / future
Second date format via dropdown (if needed). Per-row server-side reject persistence. Progress streaming
(SSE, like the regression console) for very large loads. SQL*Loader path beyond the row ceiling.

### Documentation Center (`/docs`)

An in-app documentation portal that replaced the old hardcoded external "Docs" nav link. It has
**two screens** — **User Guide** (`/docs/user-guide`) and **Technical Guide** (`/docs/technical-guide`)
— and each holds **both** wiki links (open in a new tab) *and* local `.md` files (rendered in-app),
sub-grouped into *Guides* + *Wikis & Runbooks*. Full design: `DOCS_DESIGN.md`.

| Method & path | Request | Response |
| --- | --- | --- |
| POST `/api/docs/catalog` | `{ caller, app_env }` | `{ status, entries: DocEntry[] }` — already RBAC-filtered |
| POST `/api/docs/content` | `{ caller, id }` | `{ status, doc: { id, title, markdown, updated } }` |

`DocEntry = { id, title, description?, type:'wiki'|'markdown', audience:'user'|'technical', tags?, updated?, url? }`.
Markdown docs are addressed by an **opaque `id`** (never a filesystem path); wikis carry an external `url`.

- **Backend** (`docs_api.py`) is a thin file server: it auto-discovers every `.md` under a configured
  base dir — **hybrid discovery**. **Audience is set by the top-level subfolder**: a file under
  `<base_dir>/user/` shows in the User Guide, `<base_dir>/technical/` in the Technical Guide (anything
  else defaults to technical); an `overrides` entry (keyed by the path relative to `base_dir`) wins and
  can also set title/description/tags/order. Title falls back to the file's first `#` heading. It reuses
  the hardened `utils/fs_browser.py` (`resolve_within_bases`, `read_file_all`), whitelists `.md`, and
  re-checks RBAC on **both** endpoints. Config lives in **`backend/config/docs.json`** (`base_dir` /
  `wikis` / `overrides`) via `config_loader.docs_config()` (JSON → `DOCS_BASE_DIR` env → default).
  `base_dir` is a **backend** setting (the server reads the files off disk) — **not** `environment.ts`.
  Wiki links are config-only entries in `wikis[]` (external `url`, no file).
- **RBAC (grant-based):** both screens are **opt-in `SCREEN` grants** — a user with **no docs grant sees
  no Docs at all** (the whole sidebar group is hidden). **User Guide** = `SCREEN / docs`, **Technical
  Guide** = `SCREEN / docs_technical`; **ADMIN / full-access (`SCREEN / * / *`) sees both**. Assign either
  or both per user (they appear in the User Management screen picker). `RbacService.canView('docs' |
  'docs_technical')` gates the nav children and the `rbacGuard` on each route; `/docs`
  lands on the first guide the user can see. The catalogue + content endpoints re-filter by grant
  server-side (UI hiding is never the boundary).
- **Rendering** is client-side in `DocsRenderService` — a dependency-free, **safe-by-construction**
  Markdown→HTML renderer (escapes all source text, emits only a fixed tag whitelist, validates URL
  schemes → raw HTML in a `.md` renders as text, never markup). Supports headings (+ auto TOC & slug
  anchors), lists, tables, fenced code (with copy button), blockquotes, links, images. Swapping in
  `markdown-it` + `DOMPurify` later is a single-file change (keep `render()`'s signature).
- **Nav/route:** sidebar "Docs" group with two children — User Guide + Technical Guide (`_nav.ts`).
  The parent `/docs` lazy-loads `views/docs/route.ts`, whose two child routes carry `rbacGuard` +
  `data.screen` (`docs` / `docs_technical`). Screen keys are in `rbac.config.ts`. **Each guide is its own
  screen component** — `views/docs/user_guide/` (`UserGuideComponent`) and `views/docs/technical_guide/`
  (`TechnicalGuideComponent`) — so they stay separate and can evolve independently; both render the
  shared `DocsBrowserComponent` (the catalogue + reader engine) with `audience="user" | "technical"`.
  No tabs — you switch guides from the sidebar. `/docs` redirects (via `docsLandingGuard`) to the first
  guide the user can see. The open document is **URL state** — `…/technical-guide?doc=<id>` — so the
  browser Back button returns to the guide's catalogue (not the previous page) and doc links are
  shareable/bookmarkable. Cards show the source **filename** (e.g. `RBAC_DESIGN.md`) under the title.
- **Dev mock vs real files:** by default the interceptor answers `/api/docs/*` in-browser with a sample
  catalogue (scenarios `docs_user_only` / `docs_technical_only` / `defaults_only` exercise the grants;
  ADMIN sees both). To serve **real `.md` files** from `base_dir` in local dev, run the backend and set
  `'/api/docs': false` in `environment.ts` `apiMocks` — the app then calls the live `/api/docs/*`.

### Infrastructure Pulse — see section 5 for the full flow

**Infrastructure Health** (new contract — every call POST under `/api/infra_health`, so the
browser never sees the per-server agent URLs):
| Method & path | Request | Response |
|---|---|---|
| `POST /api/infra_health` | `{ app_env, username }` | `{ status, data: ServerHealthRow[] }` — config catalogue (DB). Body, not query, so nothing sensitive is in the URL. |
| `POST /api/infra_health/metrics` | `{ host_name, agent_listen_port, host_platform, monitoring_config }` | agent `/system-metrics` reading `{ reachable, cpu_percent, ram{bytes,percent}, disk_storage{drive→{used,total,percent}}, os, load_avg }`. Backend builds `http://{host}:{port}/system-metrics` and calls it — **URL never reaches the browser**. One call per server. **Always HTTP 200**: a dead/500/timed-out agent returns `{ reachable: false }` (never an error status), so one bad server = one red card, not a whole-panel failure. |
| `POST /api/infra_health/share` | `{ host_address, app_name }` | `ShareSpaceResponse` `{ used, total, unit, reachable }` — computed directly (no agent). `reachable: false` when the path can't be read → the card shows a red "Share path unreachable" state instead of a misleading `0.00/0.00 GB`. |

**Service Console** (new contract — reuses the `POST /api/infra_health` catalogue for the
server list, then one agent proxy for status + actions):
| Method & path | Request | Response |
|---|---|---|
| `POST /api/service_console/service-manage` (bulk status) | `{ host_name, agent_listen_port, host_platform, services: [names] }` | `{ HOST_NAME, <name>: { service, status }, …, reachable }`. Backend forms `http://{host}:{port}/service-manage` and calls it — **URL never reaches the browser**. `reachable: false` → the server shows a red "Unreachable" state. |
| `POST /api/service_console/service-manage` (action) | `{ host_name, agent_listen_port, host_platform, service, action }` (`action` = start\|stop\|status; `service` = script path, or the name for a script-less Windows service) | `{ action, message, service, success }`. The UI shows the message as a toast, then re-fetches status. |

**Oracle Command Center** (`backend/oracle_cc_api.py`, prefix `/api/oracle_cc`; set `false` in
`apiMocks` so it always hits the real FastAPI, never the mock). Every tabular
section returns the **same self-describing payload** so the UI never hardcodes columns:
`{ status, columns:[{key,label,type,warn?,crit?}], rows:[{…}], summary? }`. Add a column to a
query + its `columns` entry and it renders automatically (via the reusable `app-dyn-table`).
Row meta keys: `__sev` (`ok`/`warn`/`crit` — **hover-only** cue: warn/crit rows stay white at
rest and reveal an amber/red tint on hover; `ok`/none use the default blue hover — the state
chip carries the meaning at rest), `__children` (drilldown tree), `<key>__sev` (chip colour),
`__actions` (row action whitelist, e.g. `["kill"]`), plus raw `sid`/`serial` for the kill call.

`app-dyn-table` inputs: `[model]` (the payload), `[actions]`/`(action)` (row buttons),
`[maxRows]` (cap → past N rows a vertical scrollbar kicks in with a sticky header; horizontal
scroll for wide/extra columns is always on), `[filterable]`/`filterPlaceholder` (a
client-side box that matches across every column and prunes drilldown trees to matching
branches — used on the Sessions list where a DBA may face 100+ rows), and `[columnFilters]`
(a toggleable **per-column filter row** pinned under the header: a text box per column plus a
**dropdown of the distinct values for `chip` columns** — e.g. pick `status = ACTIVE`. All
column filters AND together, and with the global box; chip columns match exactly, others by
substring. On the Sessions Detail table for precise filtering at 100–200+ sessions). The **first column (row
identifier) and the action column are both frozen** (CSS `position:sticky; left:0` / `right:0`,
like Excel freeze panes / ag-grid pinned columns): they stay pinned to their edges while the
middle columns scroll horizontally — so you never lose which row you're on, and the
Kill/Deep-dive buttons stay reachable no matter how many columns the payload adds.

The OCC ribbon shows a **live instance indicator**: `{instance} instance` with a status dot —
green = reachable (a section query returned), red = can't contact the DB (all sections
errored), amber = connecting. It's derived client-side from the section load/error signals
(`instanceStatus()`), no extra endpoint. When the active DB is unreachable (all sections error)
a red "database unreachable" banner appears above the sections; the other tabs are unaffected.
(The Diagnostics-Pack concept was removed entirely — there is no pack gating anywhere now.)

Each **tab** also carries a status dot: **green = reachable, grey = down**, from `reachable` on
`/targets` (dummy → always true; real → the scope has a truthy connection in `db_configs`). A
down DB still gets a tab (grey) and its sections show read errors — the app never goes down.

| Method & path | Request | Response |
|---|---|---|
| `GET /api/oracle_cc/targets` | — | `{ status, data: OracleTarget[] }` — the DB tabs to render. **One tab per catalogued DB**; each carries `reachable` (green dot = up, grey = down) computed from `app.state.db_configs` (real: scope has a truthy connection; dummy: always true). A down DB still gets a (grey) tab. `TARGET_META` (in `oracle_cc_api.py`) adds display metadata per scope, from which `TARGET_CATALOG` is built. Each target: `{ key, label, sub?, instance, connection, reachable }` where `key == connection ==` the db_configs scope. |
| `GET /api/oracle_cc/overview` | — | `{ status, data: OracleOverview[] }` — compact per-DB snapshot (storage %, blocking, active sessions, top segment) powering the **Home 'Oracle Databases' strip**; one call for the whole strip. |
| `POST /api/oracle_cc/{db}/space` | `{}` | Section 1 — per-tablespace space. Gauge `summary` (**Total/Used/Free Alloc (GB)**) is **physical-allocation** based: `total=Σ physical_alloc`, `used=Σ used`, `free=total−used`, `used% = used/physical`. Per-row columns also carry the autoextend view: **Alloc max (GB)** (`Σ DECODE(autoextensible,'NO',bytes,maxbytes)`) and **Total Free (GB)** (`alloc_max − used`). |
| `POST /api/oracle_cc/{db}/top_segments` | `{}` | Section 2 — top-10 tables by **data-segment** bytes; partition→subpartition as `__children`. |
| `POST /api/oracle_cc/{db}/top_indexes` | `{}` | Section 3 — top-5 indexes by allocated bytes (+ partitions). |
| `POST /api/oracle_cc/{db}/index_health` | `{}` | Section 4 — UNUSABLE / INVISIBLE / STALE-STATS indexes (state chip). |
| `POST /api/oracle_cc/{db}/locks` | `{}` | Section 5 — TX/TM enqueue locks, `state` BLOCKING/WAITING/HELD; each row killable. `summary:{blocking,waiting,total}`. |
| `POST /api/oracle_cc/{db}/blocking` | `{}` | Section 6 — **flat blocker↔victim pairs** (one row per blocking relationship): blocker SID/user/name/machine, object held + type, **blocker SQL_ID + SQL text**, victim SID/user/name, wait event + time, victim SQL_ID + SQL text. Both SQL_IDs are clickable → SQL Intelligence; SQL text uses the `clob` popup. (Blocker SQL_ID is often `—` — a blocker idle "in transaction" has no current statement.) Kill targets the **blocker** (frees the victim). `summary:{chains=distinct blockers, waiters=row count}`. |
| `POST /api/oracle_cc/{db}/temp-usage` | `{}` | Section 6b — **sessions holding TEMP/sort space** (`V$TEMPSEG_USAGE` + `V$SESSION`/`V$PROCESS`/`DBA_TABLESPACES`), one row per session+tablespace, **largest MB first** — the ones to kill when temp fills. Columns: SID,Serial#, status, user, OS user, **first name/surname**, machine, program, SQL_ID (→ SQL Intelligence), temp TS, **Temp (MB)** (row tint warn ≥ `ORACLE_CC_TEMP_WARN_MB`=1024 / crit ≥ `ORACLE_CC_TEMP_CRIT_MB`=5120), running-for, segments. Each row killable (`__actions:['kill']`). `summary:{sessions,total_mb}`. **`ols_users` is OPTIONAL** — `database.fetch_temp_usage` checks `ALL_OBJECTS` for `OLS_USERS` (table/view/synonym) and, if it isn't visible to the monitoring user, drops it from the join and returns NULL first/surname (a missing table can never break the query). Placed just before Sessions Detail. |
| `POST /api/oracle_cc/{db}/sessions` | `{ status }` (`active`\|`inactive`\|`killed`\|`all`, default `active`) | Section 7 — session inventory filtered by state; each row carries `__actions` (`detail` always, `kill` unless already KILLED). Includes a **`running_for`** column (LAST_CALL_ET formatted; `—` for non-active) so long-running work is explicit instead of colour-coded. Row `__sev` = `crit` for KILLED only (long-running active is shown by the column, not an amber tint). `summary:{active,inactive,killed,total}` (full counts regardless of filter, for the tab badges). |
| `POST /api/oracle_cc/{db}/session-detail` | `{ sid, serial, sql_id?, panel? }` | Section 7 SID deep-dive: `{ status, session:{…facts}, panels:[…] }`. **Vanished session** (closed before drill-in → no `v$session` row) returns `{ status:'success', available:false, reason:'gone', session, panels:[] }` (HTTP 200); the drawer shows a friendly **"Session no longer active"** message instead of the generic load error (which is reserved for real failures). `panel` omitted → all panels (or the drawer's "Refresh all"); `panel:'ash'` → just that one (per-tab refresh, merged in place). Each panel is `kind:'text'` (plan / SQL Monitor), `kind:'table'` (dyn-table payload), `kind:'rollback'` (killed-session rollback monitor — **all real, nothing fabricated**: `%`, undo **blocks** done/total/left from `V$SESSION_LONGOPS('Transaction Rollback')`, undo **records remaining** (`used_urec`) + `is_active` from `V$TRANSACTION` (joined via `s.taddr`), and REAL `elapsed` / `est_remaining` from the longops `elapsed_seconds` / `time_remaining`; transaction gone → 100% complete. `database.fetch_session_rollback` returns the dict; `_panel_rollback` shapes it), or `kind:'resource'` (Resource Profile). a panel is `available:false` only if its own query fails (built independently). Panels: rollback (KILLED only), plan, waits (V$SESSION_EVENT), binds (peeked binds), ash (ASH), **resource**, monitor, stats, locks, awr (DBA_HIST). The **monitor** panel (`database.fetch_session_monitor`) is the session's most-recent monitored execution, **precisely targeted** by `session_id + session_serial# + sql_id + sql_exec_id + sql_exec_start` (not "whatever it runs now") — an `overview` strip (status, SQL_ID, plan hash, elapsed, CPU, buffer gets, disk reads, started, last refresh from `V$SQL_MONITOR`) above the full `REPORT_SQL_MONITOR` **TEXT** report at `report_level='ALL'`. TEXT (not the `ACTIVE` HTML report) because ACTIVE needs Oracle's external CDN + can't embed under the app CSP. The **plan** panel carries a generated `diagnosis` card (`{sev, findings[], hint}` — bottleneck line incl. its dominant resource, worst cardinality mis-estimate on a real access line + stale-stats root cause, cautious index hint), the **structured runtime plan** (`analysis.plan` with the same **Est. accuracy / Time % / Spent on** columns as SQL Intelligence Plan Analysis) + `analysis.stats`, and the raw `DISPLAY_CURSOR ALLSTATS LAST` text (collapsible). Same `V$SQL_PLAN_STATISTICS_ALL` engine. The **resource** panel (`resource:{pga_used/alloc/max_mb, temp_mb, activity, workareas}`) shows the CPU-vs-wait-class activity split (ASH, last 10 min), PGA (V$PROCESS), temp spill (V$TEMPSEG_USAGE) and active sort/hash work areas + spill passes (V$SQL_WORKAREA_ACTIVE). |
| `POST /api/oracle_cc/{db}/kill-session` | `{ sid, serial, immediate? }` | `{ status, success, message, gone? }`. **Admin-gated** in the UI (`RbacService.roles().is_admin`) + explicit danger-confirm before it fires. Used by Locks, Blocking, and Sessions (row + deep-dive drawer). **Already-gone session** (vanished before the kill landed) returns `success:true, gone:true` (a no-op, NOT an error) → the UI shows a gentle "had already ended — nothing to kill" toast instead of the error popup. The real path must catch **ORA-00030 / ORA-00020** and return this shape (see the stub template in `oracle_cc_api.py`). |

**Section 8 — SQL Intelligence** (investigate a `sql_id` after the session is gone; every historical query is capped to `SQLI_HISTORY_DAYS` = **5 days** of AWR/ASH). Entry points: a `sql_id` search box, the finder (for when you only know "the slow report yesterday"), **and clicking any `SQL_ID` in Sessions / Critical Locks / Blocking** — those cells are links (via the shared DynTable's `[linkColumns]="['sql_id']"` + `(cellClick)` → `onSqlCell`, which expands the section, investigates, and scrolls to it).

| Endpoint | Body | Purpose |
|---|---|---|
| `POST /api/oracle_cc/{db}/sql_finder` | `{ q?, order? }` (`order`: `elapsed`\|`execs`\|`reads`\|`last`) | Top SQL over the window (DBA_HIST_SQLSTAT). Rows carry `__actions:['open']`; `flip` chip = MULTI when >1 plan (instability candidate). |
| `POST /api/oracle_cc/{db}/sql/{sql_id}/overview` | `{}` | `{ identity, verdict:{sev,headline,detail}, best_phv, current_phv, kpis[] }`. Verdict is computed by `_sqli_analyse` (best vs current plan; regression when current ≥2× the best). |
| `POST …/sql/{sql_id}/plan_timeline` | `{}` | ⭐ Plan-instability chart: `points[]` (per-snapshot plan_hash + elapsed/exec), `plans[]`, `flip:{label,from_phv,to_phv}`. The UI draws a static SVG (reduced-motion safe). |
| `POST …/sql/{sql_id}/plans` | `{}` | DynTable of distinct plans (BEST / CURRENT ⚠ / BASELINE status chip); `summary:{best_phv,current_phv,flip}` drives the diff selectors. |
| `POST …/sql/{sql_id}/plan_text` | `{ plan_hash_value }` | One plan's `DBMS_XPLAN.DISPLAY_AWR` text (falls back to `DISPLAY_CURSOR`). Called twice for the side-by-side diff. |
| `POST …/sql/{sql_id}/plan_analysis` | `{}` | **Bottleneck finder** — the runtime plan from `V$SQL_PLAN_STATISTICS_ALL` (live cursor): `{has_actual, note, summary, diagnosis, plan, stats}`. `plan` rows carry an **Est. accuracy** chip (A-Rows vs E-Rows×Starts), a **Time %** self-time bar (🔥 = bottleneck; falls back to ASH sample share when rowsource stats are absent), and a **Spent on** chip — the line's dominant resource (CPU vs a wait class) from ASH `sql_plan_line_id`, so you see *which* operation burned the CPU/I/O. `stats` correlates each table's `last_analyzed`/age/STALE with **stats-rows vs actual A-Rows**. `diagnosis:{sev,findings[],hint}` is the plain-language summary. A-Rows need rowsource stats — `has_actual:false` + `note` when absent. Live-cache only (empty when aged out → use Plan Timeline). |
| `POST …/sql/{sql_id}/sql_monitor` | `{}` | Real-time **SQL Monitor** — `{monitored, overview?, report?, note?}` from `GV$SQL_MONITOR` + `DBMS_SQL_MONITOR.REPORT_SQL_MONITOR`. **Live/recent only** (in-memory; parallel or ≥5s runs); `monitored:false` + `note` when the SQL isn't currently monitored (past/aged-out → use Plan Analysis / Plan Timeline). |
| `POST …/sql/{sql_id}/perf` | `{}` | Per-snapshot metric table (elapsed/cpu/gets/reads/rows per exec, by plan). |
| `POST …/sql/{sql_id}/ash` | `{}` | ASH breakdown — top waits (event/wait_class/samples/% ) from DBA_HIST_ACTIVE_SESS_HISTORY. |
| `POST …/sql/{sql_id}/binds` | `{}` | Captured binds per plan (DBA_HIST_SQLBIND) — bind-peeking / skew evidence. |
| `POST …/sql/{sql_id}/fix` | `{}` | **Read-only recommendation, shown to everyone**: `recommended:{plan_hash_value,rationale}`, `exists:{baseline,profile,detail}`, `scripts[]` (copy-ready DBMS_SPM baseline + DBMS_SQLTUNE advisor SQL), `advisor:{note,findings[]}`, `allow_apply` (mirrors `SQLI_ALLOW_APPLY`), `warning`. |
| `POST …/sql/{sql_id}/apply_fix` | `{ sql_id, plan_hash_value, method? }` | **WRITE.** Admin-gated in the UI (`canApplyFix` = `RbacService.canActTechnical()`) + confirm; server returns **403 when `SQLI_ALLOW_APPLY=0`**. `*_real` is a deliberate stub — must run on a **separate privileged, audited** connection (like kill-session), never the read-only monitor. |

Notes for the real wiring:
- **Two-layer split (data ↔ API).** **All SQL lives in `backend/database.py`** (the data layer):
  `connect(db_config)` opens the connection, and one **self-contained `fetch_*` per section** runs
  the query (or the few queries a section needs, on ONE connection, feeding results forward) and
  returns **raw rows** as dicts keyed by lowercased column name — no shaping. `oracle_cc_api.py` is
  the **API layer**: **each route is a single function** — `t = _target(db)` → dummy-check →
  `database.fetch_*(request.app.state.db_configs.get(db), …)` → **massage** into the
  `{status, columns, rows, summary}` contract (via `_space_payload`, `_lock_row`, `_blk_row`,
  `_sess_row`, `_stats_cell`, `_panel_*`, `_sqli_*_payload`), wrapped in `try/except → HTTP 500`.
  There is **no separate `*_real` layer** — the route does the whole job. No SQL in the API layer;
  no shaping in the data layer.
- **Connection resolution**: routes read `request.app.state.db_configs.get(db)` directly (the dict
  app.py builds in `load_db_configs()`), and hand it to the data layer. `database.connect()` accepts
  a live connection (passthrough), a `{user,password,dsn}` dict, or a DSN string — **swap its body
  for your connector if it differs**. `connect()` also installs a **LOB output-type handler** on
  every connection so `CLOB`/`NCLOB` come back as `str` and `BLOB` as `bytes` — so
  `DBMS_XPLAN.DISPLAY_CURSOR`, `REPORT_SQL_MONITOR`, `sql_fulltext`, CLOB config columns and
  `LISTAGG` overflow are read directly (no LOB locators to `.read()`, and no "LOB variable no longer
  valid" after the cursor closes). If you replace `connect()`, keep that handler. Tunables (owner
  schema, top-N, history days) are passed IN as params so the data layer has no import cycle with the
  config module. The shaping helpers
  (`_lock_row`, `_blk_row`, `_sqli_*_payload`, …) are the only things shared between a route and its
  `*_dummy` — so both paths return the identical shape.
- **Dummy ↔ real switch**: every section also has a `*_dummy` (canned data) in `oracle_cc_dummy.py`;
  both return the identical shape. Flip `ORACLE_CC_USE_DUMMY=0` once connections exist. To go live:
  (1) `connect_db` puts live connections/configs in `app.state.db_configs`; (2) set the app schema
  via `ORACLE_CC_SCHEMA` (default `OLS`); (3) `ORACLE_CC_USE_DUMMY=0`; (4) `pip install oracledb`.
  The SQL is standard V$/DBA_* but **verify view/column names against your Oracle version**.
  (`kill_session_real` / `sqli_apply_fix_real` stay stubs on purpose — writes need a **separate
  privileged, audited** connection, never the monitor.)
- **Session deep-dive shape** (`database.py`, Section 7): each panel is its own self-contained query
  — `fetch_session_base` (facts) + `fetch_session_plan / _waits / _binds / _ash / _monitor / _stats /
  _locks / _awr / _rollback` — matching the "one query = one function" rule used everywhere else.
  `fetch_session_detail` is a **thin orchestrator**: it opens **one** connection and hands that live
  connection to each `fetch_session_*` (`connect()` passes a live connection straight through, so none
  of them re-connect or close it), wrapping each call in its own try/except so one bad query degrades
  only that panel (`errors[key]` → `available:false`). `panel` limits the work to facts + that one
  panel for **per-tab refresh** (the rollback tab's `rollback` maps to the `rollback_pct` fetch). Each
  `fetch_session_*` is also callable on its own with a plain `db_config` (it self-connects and closes).
- **Locks query** (`database._SQL_LOCKS`) returns the extended set — SID/serial, user, **first
  name**, **surname**, machine, **object type**, lock type, **lock mode**, **session state**
  (BLOCKING/WAITING/HELD), held time, SQL id, and **SQL text**. All are shown as columns (firstname/
  surname are `NULL` placeholders → render `—` until you wire a name lookup). Fixes applied vs the
  first draft: `l.lmode` (not `l.mode`, reserved), `v$session` (not `v_session`), and `sql_text` via
  a scalar subquery (a plain `v$sql` join multiplies rows per child cursor).
- **CLOB columns** (`DynColType 'clob'`): a long-text column (e.g. `sql_text`) renders a ~10-word
  preview (width-capped with an ellipsis so it can't push under the sticky Actions column) + a
  clickable `…` that opens a **full-text popup** (with a Copy button) — handled inside
  `DynTableComponent` (`clobOpen` signal + `.dt-clob-modal`). The popup is **portaled to `<body>`**
  on open (`openClob` moves the nodes) so no ancestor stacking context (the section row's z-index)
  can trap it and let a later section paint over it while scrolling; Ivy removes the nodes cleanly
  on close. Used for `sql_text` in **Critical Locks**, **Blocking** (blocker + victim), and the
  **SQL Intelligence finder**.
- **Bind values with the SQL.** Oracle stores placeholders (`:1`, `:2`) in `v$sql.sql_text`, never
  a value-substituted SQL; the actual values live in `v$sql_bind_capture`. So for Locks + Blocking
  the data layer aggregates the captured binds (`LISTAGG … ON OVERFLOW TRUNCATE`) and the API
  appends them under the query (`_append_binds`) — the popup shows the statement **plus** a
  `-- Bind variables (captured):` block. (SQL Intelligence has its own **Binds** tab.) It's the
  honest view — captured values, not a reconstructed inline substitution (which can be incomplete).
- **Tunables live in `backend/.env`** (loaded by `env_loader.py`, no external dep; real env vars
  win; `.env` is gitignored, `.env.example` is the committed template): `ORACLE_CC_USE_DUMMY`,
  `ORACLE_CC_WARN_PCT` / `ORACLE_CC_CRIT_PCT` (gauge thresholds), `ORACLE_CC_TOP_CHILD_LIMIT`
  (drill-down top-N). SQL Intelligence adds `SQLI_USE_DUMMY` (defaults to the OCC switch),
  `SQLI_HISTORY_DAYS` (AWR/ASH window, default **5**), and `SQLI_ALLOW_APPLY` (default `1` — show the
  admin-only in-app "Apply fix" button; set `0` to make SQL Intelligence recommend-only). The
  Plan-Analysis flags tune with `SQLI_MISESTIMATE_MIN_ROWS` (default 1000 — ignore tiny-volume
  lines), `SQLI_MISESTIMATE_WARN` / `SQLI_MISESTIMATE_CRIT` (E/A-Rows ratio for amber/red, default
  10× / 100×), and `SQLI_STATS_STALE_DAYS` (default 7 — flag stats older than this). The code
  literals are just fallbacks.
- **Target catalog is built dynamically**: `TARGET_META` (in `oracle_cc_api.py`) holds only the
  per-scope *display* bits (label/sub/instance); `TARGET_CATALOG` is derived from it
  with `key == connection ==` the scope. So the only hardcoded remainder is display metadata.
- **Monitoring account**: connect with a dedicated **read-only** user (`SELECT_CATALOG_ROLE`),
  never OLS/SYS. `OracleTarget.connection` is the **scope key into `app.state.db_configs`** — so
  `_run()` uses the connection `set_db_configs()` registered for `target.connection`. Enabling a
  DB is therefore just: load its scope in `load_db_configs()` (app.py) and add its display row to
  `TARGET_META`.
- **kill-session privilege**: `ALTER SYSTEM KILL SESSION` needs `ALTER SYSTEM`, which the
  read-only monitor deliberately lacks — run kills through a **separate, privileged (audited)**
  connection, never by widening the monitor grant. (sid/serial are Pydantic ints → injection-safe.)
- **Reachability**: each target carries a `reachable` flag (green/grey tab dot) from
  `db_configs`; a down DB stays a grey tab with erroring sections — the app never goes down.
- RBAC: registered as the `oracle_command_center` screen (admin + read can view; not a SALT
  screen). The route is behind `rbacGuard` like every other screen, so roles are loaded before
  it renders (needed for the admin-only kill gating), and the nav item is filtered consistently.

### 4a. Concrete JSON — what each endpoint expects & returns

Every request/response body below is exactly what the mock returns today, so your
real backend can match it field-for-field. (Infra bodies are in section 5.)

**Auth**
```jsonc
// POST /api/auth/login
// → request
{ "username": "OPS-10432", "password": "••••••" }
// ← response
{ "token": "<jwt>",
  "user": { "username": "OPS-10432", "displayName": "Alex Morgan",
            "email": "alex.morgan@ols.local", "role": "Ops Admin" } }

// POST /api/auth/roles   (RBAC — see section 3b)
// → request
{ "username": "OPS-10432" }
// ← response  (single entry { ACCESS: ROLE }; key drives gating, value is the profile label)
{ "ADMIN": "OMT-BOTH" }

// POST /api/auth/logout   ← response
{ "success": true }
```

**System & Home**
```jsonc
// GET /api/system/memory     ← { free, used, total, unit, percent }  (real host RAM)
{ "free": 18.4, "used": 45.6, "total": 64, "unit": "GB", "percent": 71 }

// GET /api/system/memory/stream   ← Server-Sent Events (text/event-stream)
// One long-lived connection; the header consumes it via EventSource so the network
// tab shows a SINGLE entry. Each frame is the same MemoryStats shape:
//   data: {"free":18.4,"used":45.6,"total":64,"unit":"GB","percent":71}\n\n   (every ~2s)

// GET /api/system/database   ← { name }
{ "name": "OLSDB_DEV01" }

// GET /api/dashboard/stats   ← DashboardStat[]
[ { "key": "servers", "label": "Servers", "value": "24",
    "delta": 2, "icon": "cilStorage", "color": "primary" } ]

// GET /api/dashboard/activity  ← ActivityItem[]  (level: info|success|warning|danger)
[ { "time": "2026-07-21T20:10:00Z", "title": "Replication lag",
    "detail": "GRP entity hierarchy synced within SLA", "level": "info" } ]

// GET /api/dashboard/memory-trend  ← number[]  (last 12 percent samples)
[ 62, 64, 61, 68, 70, 66, 71, 69, 72, 70, 68, 71 ]
```

**Log Analytics**

Servers come from a config table (`Server_name, base_log_path, is_base_server,
is_active, server_type, db_source, app_env`). The API returns the active rows for
the current environment as a **map** keyed by `{db_source}_{server_type}_{server_name}`.
A key's value is an **array** — one row per configured `base_log_path`, so one
server can have several. `toLogServers()` (in `log_analytics.service.ts`) flattens
each key to a dropdown option carrying all its `basePaths`, and the file tree shows
**one root per base path** (full path label) with that base's files under it.

```jsonc
// GET /api/log/servers   ← LogServersResponse (map key → array of rows, one per base path)
{
  "OLSGROUP_APP_1_eur12": [
    { "server_name": "eur12", "base_log_path": "C:/apps/data", "server_type": "APP_1", "db_source": "OLSGROUP" }
  ],
  "OLSCIB_WEB_A_1_eur17": [
    { "server_name": "eur17", "base_log_path": "C:/my/cib", "server_type": "WEB_A_1", "db_source": "OLSCIB" },
    { "server_name": "eur17", "base_log_path": "D:/game",   "server_type": "WEB_A_1", "db_source": "OLSCIB" },
    { "server_name": "eur17", "base_log_path": "E:/my",     "server_type": "WEB_A_1", "db_source": "OLSCIB" },
    { "server_name": "eur17", "base_log_path": "F:/cib",    "server_type": "WEB_A_1", "db_source": "OLSCIB" }
  ]
}

// There is NO /files call — the UI seeds the tree straight from the base paths
// above. Browsing reads the filesystem live: `base` is the server's base_log_path
// (constant, the ceiling); `path` is the folder to open (deeper each expand).

// Expand C:/my/cib   ← POST /api/log/dir  body {server_id, base, path}
//   { "server_id": "OLSCIB_WEB_A_1_eur17", "base": "C:/my/cib", "path": "C:/my/cib" }
{ "entries": [
    { "name": "app",       "type": "folder", "path": "C:/my/cib/app" },
    { "name": "BatchLogs", "type": "folder", "path": "C:/my/cib/BatchLogs" },
    { "name": "startup.log", "type": "file", "path": "C:/my/cib/startup.log" }
  ], "total": 3, "truncated": false }

// Go deeper — expand app   ← POST /api/log/dir  body { …, "path": "C:/my/cib/app" }
// Same `base`, deeper `path`. Backend confirms path ⊆ base, lists it from disk.
{ "entries": [ { "name": "application.log", "type": "file", "path": "C:/my/cib/app/application.log" } ],
  "total": 1, "truncated": false }

// Small file → POST /api/log/file  body {server_id, base, path}
{ "mode": "full", "content": "2026-07-21 20:10:00 INFO  Loader started\n...", "total_size": 20480 }

// Large file (> OLS_FILE_WINDOW_THRESHOLD) → windowed. First read asks for the tail:
//   POST /api/log/file  body { …, "length": 1048576, "from_end": true }
{ "mode": "window", "content": "…last ~1 MB, line-aligned…",
  "start": 2146435072, "end": 2147483648, "total_size": 2147483648, "bof": false, "eof": true }
// Page toward the start:  body { …, "offset": start - length, "length": 1048576 }
// Page toward the end:    body { …, "offset": end,            "length": 1048576 }

// Backend confirms `path` sits inside `base` (reject `..`) before reading — the jail.
// Escape → 400; a path inside base that no longer exists (deleted since the tree
// loaded) → 404 "Path not found" (clean error, never a hang). The UI clears the
// spinner and, for a file, shows "This file no longer exists…"; for a folder it
// marks the node errored (retryable). Refreshing the tree reconciles it with disk.

// Whole-file download (any size) → GET /api/log/file/download?base=…&path=…  (streamed)

// POST /api/log/file-properties  body {server_id, base, path}   ← FileProperties
{ "name": "application.log", "type": "Log File", "location": "C:/my/cib/app",
  "size": 20480, "created": "2026-07-01T09:00:00Z", "modified": "2026-07-21T20:10:00Z",
  "accessed": "2026-07-21T20:11:00Z", "lines": 512, "attributes": "Read-only" }
```

**Config Ops Console** (`{scope}` = `cib` | `group` | `retail`)
```jsonc
// POST /api/config/{scope}/tables   body { app_env, username }  ← TabularData { cols, rows }
// Columns come straight from the API — the grid renders whatever arrives.
{ "cols": ["APP_ENV", "TABLE_NAME", "IS_COBDT", "IS_ACTIVE"],
  "rows": [
    ["DEV", "EMPLOYEE", "N", "Y"],
    ["DEV", "ORDER",    "Y", "Y"],
    ["DEV", "BILL",     "N", "N"]
  ] }

// POST /api/config/{scope}/retrieve    → { table_name, start?, end?, range? }
//   Dates are OPTIONAL — sent only when IS_COBDT = Y (range:false = the two
//   dates only). A non-COB table (e.g. BILL, IS_COBDT = N) passes just
//   { table_name }.
//   ← TableContentResponse — self-describing (column types included).
{ "cols": ["import_name", "pct", "pct_a", "cob_dt", "ecb"],
  "cols_data_types": ["<cx_Oracle.DbType DB_TYPE_VARCHAR>", "<cx_Oracle.DbType DB_TYPE_NUMBER>",
                      "<cx_Oracle.DbType DB_TYPE_CHAR>", "<cx_Oracle.DbType DB_TYPE_DATE>",
                      "<cx_Oracle.DbType DB_TYPE_CLOB>"],
  "Table_data": [
    { "import_name": "ABC", "pct": 1, "pct_a": "Y", "cob_dt": "2026-07-23", "ecb": "abc…", "rowid": "AAAR12000001" }
  ] }
// `cols_data_types` maps to rendering: DATE→date-only calendar, TIMESTAMP→date+time,
// CLOB/BLOB/JSON/XMLTYPE→"…" token, else text. `rowid` rides in each row but is NOT
// in `cols`, so it stays hidden; the grid uses it for update/delete.

// POST /api/config/{scope}/roll        → { rolled_by, table_name, db_source, source_date, target_dates[], tablespace }
//                                       ← { status, source_date, source_count, targets:[{date,status,count,error?}] }
// db_source = the table's physical DB (ols_cib_batch | ols_cib_reporting | …) from the catalogue row;
// the backend routes every per-table op to that DB (scope still gates RBAC). The master/catalogue table
// lives only in the scope's BATCH db but a table can be in batch OR reporting — db_source is the router.

// --- Insert / Update / Delete (table name in the URL) --------------------------
// POST /api/config/{scope}/table/EMPLOYEE/rows   (INSERT)
{ "inserted_by": "OPS-10432",
  "columns": ["ID", "CODE", "COB_DT"],
  "rows": [ [101, "EMP-0101", "2026-07-31"], [102, "EMP-0102", "2026-07-31"] ] }
//                                       ← { inserted: 2 }

// POST /api/config/{scope}/table/EMPLOYEE/update   (UPDATE — changed columns only)
{ "updated_by": "OPS-10432",
  "updates": [
    { "rowid": "AAAR12000001", "values": { "CODE": "EMP-9999" } },
    { "rowid": "AAAR12000002", "values": { "ENABLED": "N" } }
  ] }
//                                       ← { updated: 2 }

// POST /api/config/{scope}/table/EMPLOYEE/delete   (DELETE)
{ "deleted_by": "OPS-10432", "rowids": ["AAAR12000001", "AAAR12000002"] }
//                                       ← { deleted: 2 }
// All three return the affected count (popup); errors return { message } shown verbatim.
```

**Infrastructure Pulse** — request/response bodies (`HealthServerConfigRow`,
`monitor_config` CLOB, `AgentCollectResponse`, `AgentActionResponse`,
`ShareSpaceResponse`) are documented with JSON in **section 5** below.

---

## 5. Infrastructure Pulse — how the data flows

Both pages (Infrastructure Health + Service Console) are driven by your
`health_Server_Details` table plus the on-server agents. **No hardcoded servers.**

**Infrastructure Health — on each page load / refresh (new `/api/infra_health` contract):**
1. **One config call** → `POST /api/infra_health` `{app_env, username}` returns
   `{status, data:[ServerHealthRow]}` for `APP_ENV` (the four app sections share this
   one fetch via a cached observable).
2. **One metrics call per SERVER** (fan-out) → `POST /api/infra_health/metrics` with the
   server's identity + `monitoring_config`. The **backend** forms
   `http://{host}.xmp.net.intra:{port}/system-metrics`, POSTs the config to the agent, and
   returns cpu/ram/disk — the dynamic agent URL never appears in the browser network tab.
3. **Share drives skip the agent** → `POST /api/infra_health/share` (backend computes the
   path's free space directly).

**Resilience — one dead server never breaks the screen.** Each server/share is fetched and
error-handled independently (`collectHealth` in `infra-data.service.ts`): if the agent is down /
returns 500 / times out — or the share path is unreachable — that card alone renders in a red
**"Unreachable"** state ("Server not responding" / "Share path unreachable", plus a small
"reach out to the OLS Team on <supportEmail>" line pulled from `environment.supportEmail`), while
every other card renders normally. Two layers make this true: the **backend** always answers 200 with
`{ reachable: false }` (never an error status), and the **frontend** wraps each call in
`catchError` **and** a 15 s `timeout` — so even a network/proxy *stall* (which never errors and
would otherwise hold the whole `forkJoin` open) degrades to a single unreachable card. A share
that can't be read shows red instead of a misleading green `0.00/0.00 GB`.

**Card ordering.** Both **By Application** (`assembleHealth`) and **By Status** (`statusTargets`)
sort cards **Windows → Linux → Share**, then by name — so the sequence is identical in both views.

**Performance at scale.** `HealthCardComponent` is `ChangeDetectionStrategy.OnPush`, so a page of
N cards only re-renders the one card whose `target` input actually changed — not all N on every
global tick (the header's live memory SSE ticks every ~2 s). Verified smooth at 35 servers; the
backend fan-out for 35 servers completes in well under a second.

Backend: `backend/infrastructure_health_api.py` (routes + real functions) with the canned data
split into **`backend/infrastructure_health_dummy.py`** (`config_dummy` + `synthetic_agent`),
same pattern as `oracle_cc_dummy.py`. The **`INFRA_HEALTH_USE_DUMMY`** flag (`backend/.env`)
switches both the config catalogue and the agent between dummy and real: dummy →
`config_dummy` / `synthetic_agent`; real → `retrieve_server_health_details_real` (wire the DB
proc — currently raises) / **`_agent_over_http`** (builds
`http://{host}.xmp.net.intra:{port}/system-metrics`, POSTs with an 8 s timeout, lazy `import
httpx`). `call_agent` wraps the reading in try/except → `{ reachable: false }`, so a dead agent
(or missing httpx) is a single red card, never a panel error. Going fully live = set
`INFRA_HEALTH_USE_DUMMY=0` + `pip install httpx` + wire the DB proc. Units: RAM is **bytes**
(→ GB), disk values are **"NN.NN GB" strings** (parsed), bars use the agent-supplied `percent`.

**Service Console** (new contract — `backend/service_console_api.py`): reuses the **same
`POST /api/infra_health` catalogue** (one shared, cached fetch), filtered to `SERVER` rows
that are `IS_ACTIVE = 'Y'` **and** have services. Then per server:
1. **Bulk status** → `POST /api/service_console/service-manage` `{host_name, agent_listen_port,
   host_platform, services:[names]}` → status per service. Resilient like Infra Health: a
   dead/slow agent (or timeout) → that server renders red **"Unreachable"**, others are fine.
2. **Start/Stop** (behind a confirm dialog) → same endpoint with `{service, action}` → the
   agent runs it and returns `{success, message}`; the UI shows a toast, then **re-fetches**
   the server's status so the badges settle. `service` is the script path, or the service
   **name** when there's no script (e.g. Windows services the agent manages by name).

The backend forms the dynamic `…/service-manage` agent URL server-side; the browser only sees
`/api/service_console/service-manage`. Single endpoint, two payloads (branches on `action`);
dummy today with a commented `_service_agent_over_http` for going live (same switch pattern as
Infra Health). Wired via `apiMocks: { '/api/service_console': false }`.

Servers are ordered **Windows → Linux → Share** in both By-Application and By-Status (matching
Infra Health). Each server bar has an **ⓘ info** button (host, environment, platform, service
count, and the config **comments**). Both the **app panel** (OLS GROUP…) and each **server
sub-panel** carry an Infra-Health-style coloured left rail: **green** when all services run,
**amber** when a service is unaccessible/unreachable, **red** when any is stopped. **Partial status is per-service**: a service missing from
the agent's status response renders **"Unknown"** on its own row — the other services and the
server are unaffected; only a truly unreachable *agent* turns the whole server red.

### `HealthServerConfigRow` (matches your table columns 1:1)
```
app_env            'DEV' | 'STG' | 'PROD'
resource_category  'SERVER' | 'share_drive'
host_platform      'LINUX' | 'WINDOW' | 'share_drive'
hostname           string          (used as the UI id for the server/share)
host_address       string          (IP/FQDN for a server; UNC path for a share)
agent_listen_port  number
app_name           'OLS_GROUP' | 'OLS_CIB' | 'OLS_RETAIL' | 'POSEIDON'
monitor_config     string | null   (CLOB JSON; null for shares)
is_active          'Y' | 'N'        (only 'Y' rows are shown)
comments           string           (shown in the health card's ⓘ info dialog)
```

### `monitor_config` CLOB (JSON)
```json
{ "disk": ["c","d"], "infra": ["ram","cpu"], "services": [{"OLS File Loader": null}] }
```
- `disk`: disk/mount names to monitor (`c`,`d` on Windows → `C:\`,`D:\`; `apps`,`data`,`/`,`var` on Linux → `/apps`, `/data`, `/`, `/var`).
- `infra`: subset of `["ram","cpu"]`.
- `services`: array of single-key objects `{ "<service name>": "<action script or null>" }`.
- Parsed by `parseMonitorConfig()` in `infra-models.ts` (fails safe to empty on bad JSON).

### `AgentCollectResponse` (what each agent returns)
```
hostname   string
reachable  boolean
cpu?       number                       // percent, when 'cpu' requested
ram?       { used: number, total: number }   // GB, when 'ram' requested
disks      { name, used, total, unit }[]     // GB
services   { name, state, lastHeartbeat }[]  // state: Running|Stopped|Starting|Stopping|Faulted|Unknown
```
`AgentActionResponse` = `{ service, state, lastHeartbeat }`.

### Behaviours you get for free
- **Health page** uses `disk` + `infra`; each server/share is a card, coloured by its
  worst metric (warn ≥ 75 %, crit ≥ 90 % — tune in `HEALTH_THRESHOLDS`,
  `infra-models.ts`). The ⓘ icon shows the row's `comments`, host, environment.
- **Service Console** uses `services`; a server with **no configured services is
  hidden** there (it still appears on Health). Anything not `Running` is red; the
  `Unknown` state shows as grey "Unaccessible". Start/Stop call the agent action
  endpoint (with a confirm dialog).

### Calling each agent directly (per host:port)
The mock routes all agent calls through one endpoint. In production, if you call each
agent at its own address instead of a gateway, change the URL built in
`collectHealth` / `collectServices` in
[`src/app/views/infra_pulse/infra-data.service.ts`](src/app/views/infra_pulse/infra-data.service.ts)
to e.g. `` `http://${row.host_address}:${row.agent_listen_port}/collect` `` — the
payload builder (`agentPayload`) already carries `host_address` and
`agent_listen_port`. (Browser CORS/security may mean you proxy these through your
backend rather than calling agents straight from the browser.)

---

## 6. Swapping mock → real (checklist)

1. In `api-endpoints.ts`: set `API_BASE_URL`, `APP_ENV`, `USE_MOCK = false`.
2. Ensure each endpoint in section 4/5 returns the documented shape (or adjust the
   mapping in the matching service/component).
3. Auth: confirm the login response matches `LoginResponse`; the token is sent as a
   bearer header.
4. Infra agents: decide gateway vs direct-to-agent calls (section 5) and set the URL.
5. Production web server: add the SPA `index.html` fallback (section 2).
6. Optionally delete `mock-data.ts` and remove `mockApiInterceptor` from
   `app.config.ts` once fully cut over.

---

## 7. File map

| Area | Files |
|---|---|
| Central config & URLs | `src/app/shared/api-endpoints.ts` |
| Data contracts | `src/app/shared/models.ts`, `src/app/shared/infra-models.ts` |
| Mock backend (delete when live) | `src/app/shared/mock-data.ts`, `src/app/shared/mock-api.interceptor.ts` |
| HTTP client | `src/app/shared/api-data.service.ts` |
| Auth / SSO | `src/app/auth/*` (`auth.service.ts` facade, `sso-auth.service.ts`, `sso.config.ts`, `auth.guard.ts`, `auth.interceptor.ts`, `sso-callback.component.ts`) |
| Account menu | `src/app/user_profile/*` (initials avatar + name/email/UID/role + sign out) |
| Routing / nav | `src/app/app.routes.ts`, `src/app/app.config.ts`, `src/app/layout/default-layout/_nav.ts` |
| Home (Command Center) | `src/app/views/home/*` (`HomeComponent`) — route `/home`; aggregates Infra Health + Service data via `InfraDataService` |
| Log Analytics | `src/app/views/log_analytics/*` |
| Config Ops Console | `src/app/views/config_ops_console/*` |
| Infrastructure Pulse | `src/app/views/infra_pulse/*` (`infra-data.service.ts` orchestrates config + agents) |
| Oracle Command Center | `src/app/views/oracle_command_center/*` (`oracle-cc.service.ts`), `backend/oracle_cc_api.py`, contracts `src/app/shared/oracle-models.ts`, reusable table `src/app/components/dyn-table/*`. Home tiles deep-link with `?db=<key>` → the component lands on that tab. |
| Error pages | `src/app/views/pages/error-page/*` (reusable `<app-error-page>` — brand top-center, then code/title), used by `page404/*` + `page500/*`. Full-bleed, theme-aware, always offers **Back to Home** + Go-back / Try-again. Unknown URLs (`**`) render the 404 page at the typed URL. Other error types are already handled: 401→login (authGuard), 403/no-role→No-Access (rbacGuard), and API 4xx/5xx surface per-screen (inline "couldn't load" states + the ErrorReportService popup with the backend message). Add a new full-page code by pointing a route at `<app-error-page code="…" …>`. |

---

_Maintained automatically: this file is updated whenever configuration, endpoints,
data contracts, routing, or the Infra Pulse flow change._
