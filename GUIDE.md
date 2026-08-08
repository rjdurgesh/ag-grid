# OLS Dashboard — Integration Guide

This guide is the single reference for wiring the OLS Dashboard to your real backend:
where to configure things, every API the app calls, and the exact request/response
shape each one expects. It is kept up to date as the app evolves.

> TL;DR to go live: edit **`src/environments/environment.ts`** — set `apiBaseUrl`, `appEnv`,
> and either `useMock: false` (all real) or add path prefixes to `liveApiPrefixes` (real one
> area at a time). Make sure each API returns the documented shape.

---

## 1. Central configuration — `src/environments/environment.ts`

All app/runtime config lives in this **one** file (not in `api-endpoints.ts`, which is now
URLs only and reads `apiBaseUrl` from here).

| Setting | Purpose | Change to |
|---|---|---|
| `apiBaseUrl` | Root of your backend. Every endpoint is built from it. | Your API host, e.g. `https://ols-api.mybank.net` |
| `useMock` | While `true`, the in-app mock answers endpoints with canned data. | `false` to hit the real backend for everything |
| `liveApiPrefixes` | While `useMock` is true, request paths starting with any of these go to the **real** backend (the rest stay mocked). Wire endpoints one area at a time. | e.g. `['/api/log/']` (Log Analytics is live), add `'/api/config/'` etc. as you go |
| `appEnv` | Environment (`DEV` \| `STG` \| `LIVE`). Header pill + sent to env-aware APIs (Config `tables`, Infra `config`). **`LIVE` is sent to the backend as `PROD`** via `apiEnv()`. | The env this instance runs in |
| `supportEmail` | Address the error-popup "Email" button reports to. | Your support inbox |
| `username` / `name` | Demo identity for the direct (non-SSO) login / dev mode (real SSO overrides it). | Your dev user |
| `isSsoEnabled` | `true` = OpenID Connect (`src/app/auth/sso.config.ts`); `false` = direct login form. | `true` once `SSO_CONFIG` is filled in |
| `devRoles` | Preview role flags while `GET /api/auth/roles` is mocked. | — |

**Wiring an endpoint to the real backend (no code change):** point `apiBaseUrl` at your host,
keep `useMock: true`, and add the path prefix to `liveApiPrefixes`. That area then hits the
real API (visible in DevTools → Network) while everything else stays on the mock. Log Analytics
(`/api/log/`) is already wired this way to the FastAPI backend in `backend/`.

`API` (in `api-endpoints.ts`) is one object holding every URL. To fully detach the mock, set
`useMock: false` (or remove `mockApiInterceptor` from [`app.config.ts`](src/app/app.config.ts)).

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

Access is driven by the user's role flags from your user table, fetched once after
login: `GET /api/auth/roles` → `{ is_admin, is_read, is_salt }` (any combination).

**Local testing** (while `USE_MOCK = true`): flip `DEV_ROLES` in
[`api-endpoints.ts`](src/app/shared/api-endpoints.ts) to preview each level — the
mock returns it. Ignored once the real endpoint answers.

**Rules:**
| Flag | Sees | Can act |
|---|---|---|
| `is_admin` | every screen | everywhere |
| `is_read` | every screen | nothing (all action buttons hidden) |
| `is_salt` | only `SALT_SCREENS` (Home + Config Ops) | on those screens (salt wins over read there) |
| none | — | → redirected to the **No-Access** page |

**Generic core** — [`src/app/auth/rbac.config.ts`](src/app/auth/rbac.config.ts) is the
one place that lists screens. To gate a new screen: add its `ScreenKey` (+ to
`ALL_SCREENS`, and `SALT_SCREENS` if salt should see it), a `SCREEN_ROUTES` entry, a
`screenForNavUrl()` mapping, then on the route add `data: { screen: '<key>' }` +
`canActivate: [rbacGuard]`. That's it — guard, nav filter and directives all read
from here.

**Enforcement pieces:**
- [`rbac.service.ts`](src/app/auth/rbac.service.ts) — `canView(screen)` / `canWrite(screen)` / `hasAnyAccess()`.
- [`rbac.guard.ts`](src/app/auth/rbac.guard.ts) — blocks routes; redirects to the first allowed screen or `/no-access`.
- Sidebar nav is filtered by `canView` in [`default-layout.component.ts`](src/app/layout/default-layout/default-layout.component.ts).
- [`*olsCanWrite="'<screen>'"`](src/app/auth/can-write.directive.ts) — hides action controls (used on Service Console Start/Stop).
- `<app-grid-data [readOnly]="…">` — hides Config Ops mutating controls (Add/Save/Delete/Edit/Duplicate/Roll/Upload); bound from `canWrite('config_ops_console')`.

To go live: point `API.auth.roles` at your backend so it returns the flags from the
user table (`USE_MOCK = false`). Nothing else changes.

---

## 4. API catalog

All paths are relative to `API_BASE_URL`. Shapes are defined in
[`src/app/shared/models.ts`](src/app/shared/models.ts) and
[`src/app/shared/infra-models.ts`](src/app/shared/infra-models.ts).

### System / Home
| Method & path | Request | Response | Used by |
|---|---|---|---|
| `GET /api/system/memory` | – | `MemoryStats` `{ free, used, total, unit, percent }` | Header live memory |
| `GET /api/system/database` | – | `{ name: string }` | Footer DB name (centered) |
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
is expanded, the UI calls `GET /api/log/dir?base=<base_log_path>&path=<folder>`:

- `base` = the selected server's configured `base_log_path` — **constant**; it is
  the security **ceiling** (the request may not climb above it).
- `path` = the folder being opened — the base itself on first expand, then a deeper
  path each time you go down (e.g. `D:/Website` → `D:/Website/coreui` →
  `D:/Website/coreui/src`). The backend confirms `path` sits inside `base`, then
  reads that folder from disk and returns its immediate children. Works to any depth.

`file` / `file-properties` take the same `base` + the file's `path`.

**Per-folder cap (anti-hang):** `/dir` returns at most `OLS_DIR_LIMIT` entries (default
**500**) *per folder call*; when a folder holds more, `truncated: true` + the real `total`
come back and the tree shows a "showing N of M — filter to narrow" note. The cap is
per-folder, so going **deeper** is never limited — expanding a child triggers a fresh `/dir`
that returns up to 500 of that child's own entries.

**Left refresh button** re-seeds the **selected server's** tree from its base paths and
**resets the right preview to default** — it never re-hits `/servers` (only page open/refresh
does that) and never leaves the last-read file showing. Selecting a different server does the
same for that server.

| Method & path | Request | Response |
|---|---|---|
| `GET /api/log/servers?app_env=<DEV\|STG\|PROD>` | – | `LogServersResponse` (map key → **array** of rows, one per `base_log_path`); `app_env` scopes the DB query (`LIVE`→`PROD`). **The only DB-backed call.** |
| `GET /api/log/dir?base=<base_log_path>&path=<abs>` | – | `LogDirResponse` `{ entries: {name,type,path}[], total, truncated }` — immediate children of ONE folder, read from disk (jailed to `base`, **capped per folder** — `truncated`/`total` when the cap is hit) |
| `GET /api/log/file?base=<base_log_path>&path=<abs>` | – | `{ content: string }` (jailed to `base`) |
| `GET /api/log/file-properties?base=<base_log_path>&path=<abs>` | – | `FileProperties` (jailed to `base`) |

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
| `GET /api/config/{scope}/tables?app_env=<DEV\|STG\|PROD>` | – | `TabularData` `{ cols, rows }` — catalogue for that env (`LIVE`→`PROD`) |
| `POST /api/config/{scope}/columnretrieve` | `{ table_name }` | `TabularData` `{ cols, rows }` — **down-arrow expand** detail, rendered as-is |
| `POST /api/config/{scope}/retrieve` | `{ table_name, is_cobdt, start_date, end_date, date_range }` | `TableContentResponse` `{ cols, cols_data_types, Table_data }` |
| `POST /api/config/{scope}/roll` | `{ rolled_by, tablespace, table_name, from, to }` — `tablespace` = `OLS_RPT32` (group) / `OLS` (cib, retail) | `{ status, message }` — the UI shows `message` verbatim in the roll panel (falls back to a count line only if `message` is absent) |
| `POST /api/config/{scope}/table/{table}/rows` | `{ inserted_by, columns, rows: [[…]] }` | `{ inserted: N }` — INSERT |
| `POST /api/config/{scope}/table/{table}/update` | `{ updated_by, updates: [ { "<rowid>": { col: val } } ] }` | `{ updated: N }` — UPDATE |
| `POST /api/config/{scope}/table/{table}/delete` | `{ deleted_by, rowids: [ "<rowid>", … ] }` | `{ deleted: N }` — DELETE |

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

### Infrastructure Pulse — see section 5 for the full flow
| Method & path | Request | Response |
|---|---|---|
| `GET /api/infra/config?env=<DEV\|STG\|PROD>` | – | `HealthServerConfigRow[]` |
| `POST /api/infra/agent/collect` | `{ hostname, host_platform, host_address, agent_listen_port, monitor_config }` | `AgentCollectResponse` |
| `POST /api/infra/agent/action` | `{ hostname, host_address, agent_listen_port, service, script, action }` | `AgentActionResponse` |
| `GET /api/infra/share?app=<app>&name=<share>` | – | `ShareSpaceResponse` `{ used, total, unit }` |

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

// GET /api/auth/roles   (RBAC — see section 3b)   ← response
{ "is_admin": true, "is_read": false, "is_salt": false }

// POST /api/auth/logout   ← response
{ "success": true }
```

**System & Home**
```jsonc
// GET /api/system/memory     ← { free, used, total, unit, percent }
{ "free": 18.4, "used": 45.6, "total": 64, "unit": "GB", "percent": 71 }

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

// Expand C:/my/cib   ← GET /api/log/dir?base=C:/my/cib&path=C:/my/cib
{ "entries": [
    { "name": "app",       "type": "folder", "path": "C:/my/cib/app" },
    { "name": "BatchLogs", "type": "folder", "path": "C:/my/cib/BatchLogs" },
    { "name": "startup.log", "type": "file", "path": "C:/my/cib/startup.log" }
  ], "total": 3, "truncated": false }

// Go deeper — expand app   ← GET /api/log/dir?base=C:/my/cib&path=C:/my/cib/app
// Same `base`, deeper `path`. Backend confirms path ⊆ base, lists it from disk.
{ "entries": [ { "name": "application.log", "type": "file", "path": "C:/my/cib/app/application.log" } ],
  "total": 1, "truncated": false }

// GET /api/log/file?base=C:/my/cib&path=C:/my/cib/app/application.log   ← { content: string }
// Backend confirms `path` sits inside `base` (reject `..`) before reading — the jail.
// Escape → 400; a path inside base that no longer exists (deleted since the tree
// loaded) → 404 "Path not found" (clean error, never a hang). The UI clears the
// spinner and, for a file, shows "This file no longer exists…"; for a folder it
// marks the node errored (retryable). Refreshing the tree reconciles it with disk.
{ "content": "2026-07-21 20:10:00 INFO  Loader started\n..." }

// GET /api/log/file-properties?base=C:/my/cib&path=C:/my/cib/app/application.log   ← FileProperties
{ "name": "application.log", "type": "Log File", "location": "C:/my/cib/app",
  "size": 20480, "created": "2026-07-01T09:00:00Z", "modified": "2026-07-21T20:10:00Z",
  "accessed": "2026-07-21T20:11:00Z", "lines": 512, "attributes": "Read-only" }
```

**Config Ops Console** (`{scope}` = `cib` | `group` | `retail`)
```jsonc
// GET /api/config/{scope}/tables           ← TabularData { cols, rows }
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

// POST /api/config/{scope}/roll        → { rolled_by, tablespace, table_name, from, to }
//                                       ← { status, message }   (UI shows `message`)

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

**On each page load / refresh:**
1. **One config call** → `GET /api/infra/config?env=DEV` returns the rows of
   `health_Server_Details` for `APP_ENV`. (The four app sections share this single
   fetch via a cached observable.)
2. **One agent call per SERVER row** (fan-out) →
   `POST /api/infra/agent/collect` with that server's `monitor_config`. The agent
   returns live disk / infra / service readings.
3. **Share drives skip the agent** → `GET /api/infra/share` (computed directly).

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
| Home (Command Center) | `src/app/views/dashboard/*` — route `/home`; aggregates Infra Health + Service data via `InfraDataService` |
| Log Analytics | `src/app/views/log_analytics/*` |
| Config Ops Console | `src/app/views/config_ops_console/*` |
| Infrastructure Pulse | `src/app/views/infra_pulse/*` (`infra-data.service.ts` orchestrates config + agents) |

---

_Maintained automatically: this file is updated whenever configuration, endpoints,
data contracts, routing, or the Infra Pulse flow change._
