# OLS Dashboard — Integration Guide

This guide is the single reference for wiring the OLS Dashboard to your real backend:
where to configure things, every API the app calls, and the exact request/response
shape each one expects. It is kept up to date as the app evolves.

> TL;DR to go live: edit **`src/environments/environment.ts`** — set `apiBaseUrl`, `appEnv`,
> and either `useMock: false` (all real) or flip individual screens in `apiMocks` (real one
> area at a time). Make sure each API returns the documented shape.

---

## 1. Central configuration — `src/environments/environment.ts`

All app/runtime config lives in this **one** file (not in `api-endpoints.ts`, which is now
URLs only and reads `apiBaseUrl` from here).

| Setting | Purpose | Change to |
|---|---|---|
| `apiBaseUrl` | Root of your backend. Every endpoint is built from it. | Your API host, e.g. `https://ols-api.mybank.net` |
| `useMock` | Global default: while `true`, the in-app mock answers any endpoint **not listed in `apiMocks`** with canned data. | `false` to hit the real backend for everything unlisted |
| `apiMocks` | **Per-screen** mock control — a map of API path-prefix → `mock?` (`true` = in-app mock, `false` = real backend). A request matches the **longest** prefix; unlisted paths fall back to `useMock`. Lets you develop/test one screen live while the rest stay mocked (or vice-versa). | e.g. `'/api/oracle_cc': false` (live), `'/api/config': true` (mock) — flip one entry, no code change |
| `appEnv` | Environment (`DEV` \| `STG` \| `LIVE`). Header pill + sent to env-aware APIs (Config `tables`, Infra `config`). **`LIVE` is sent to the backend as `PROD`** via `apiEnv()`. | The env this instance runs in |
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
2. **Backend per-screen `*_USE_DUMMY`** (in `backend/.env`) decides, *once a request reaches
   FastAPI*, whether that screen returns canned data or runs its real functions:
   `ORACLE_CC_USE_DUMMY`, `INFRA_HEALTH_USE_DUMMY` (add one per screen you split). The backend
   has **no** `apiMocks` — these env flags are its equivalent, screen by screen.

   So three dev stages per screen: `apiMocks:true` (pure UI, no backend) → `apiMocks:false` +
   `*_USE_DUMMY=1` (real backend, canned data, no DB/agent) → `apiMocks:false` + `*_USE_DUMMY=0`
   (fully live). Each screen with a real/dummy split keeps its dummy data in a sibling module
   (`oracle_cc_dummy.py`, `infrastructure_health_dummy.py`) imported at the bottom of its API
   file; flip its flag in `.env`, no code change.

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

Access is driven by the user's access level from your user table, fetched once after
login: **`POST /api/auth/roles` `{ username }`** → a single-entry **`{ ACCESS: ROLE }`**
map, e.g. `{ "ADMIN": "OMT-BOTH" }`. The **key** is the access level (`ADMIN` / `READ` /
`SALT`) which maps to the internal `is_admin` / `is_read` / `is_salt` flags that gate the
app; the **value** is the role label shown on the profile card as **`ACCESS | ROLE`**
("ADMIN | OMT-BOTH"). `username` goes in the body (not the URL). Parsing + the
access→flag mapping live in [`rbac.service.ts`](src/app/auth/rbac.service.ts) (`parseRoles`).

**Local testing** (while `USE_MOCK = true`): flip `DEV_ROLES` in
[`api-endpoints.ts`](src/app/shared/api-endpoints.ts) to preview each level — the mock
maps the flags to the `{ ACCESS: ROLE }` shape (`ADMIN`→`OMT-BOTH`, `READ`→`OMT-READ`,
`SALT`→`OMT-SALT`). Ignored once the real endpoint answers.

**Rules:**
| Flag | Sees | Can act |
|---|---|---|
| `is_admin` | every screen | everywhere |
| `is_read` | every screen | nothing (all action buttons hidden) |
| `is_salt` | only `SALT_SCREENS` (Home + Config Ops) | on those screens (salt wins over read there) |
| none | — | → redirected to the **No-Access** page |

**Technical-action privilege** (Oracle Command Center **kill-session** + Service Console
**start/stop**) is stricter than plain `canWrite`: it needs **ADMIN access AND a technical/both
role** — `canActTechnical()` = `is_admin && role ∈ {OMT-TECHNICAL, OMT-BOTH}` (matched on the
role value). So `ADMIN|OMT-TECHNICAL` and `ADMIN|OMT-BOTH` can act; **`ADMIN|OMT-FUNCTIONAL`
and every `READ:*` are view-only** (buttons hidden); no-access sees nothing (guard → No-Access).
Both screens still *view*-gate via `canView` (admin + read). Gated in the UI by the
[`*olsCanAct`](src/app/auth/can-act.directive.ts) directive (Service Console) and the
`canKill` computed (Oracle CC), with a defensive re-check before each action fires.

**Generic core** — [`src/app/auth/rbac.config.ts`](src/app/auth/rbac.config.ts) is the
one place that lists screens. To gate a new screen: add its `ScreenKey` (+ to
`ALL_SCREENS`, and `SALT_SCREENS` if salt should see it), a `SCREEN_ROUTES` entry, a
`screenForNavUrl()` mapping, then on the route add `data: { screen: '<key>' }` +
`canActivate: [rbacGuard]`. That's it — guard, nav filter and directives all read
from here.

**Enforcement pieces:**
- [`rbac.service.ts`](src/app/auth/rbac.service.ts) — `canView(screen)` / `canWrite(screen)` / `canActTechnical()` / `hasAnyAccess()`.
- [`rbac.guard.ts`](src/app/auth/rbac.guard.ts) — blocks routes; redirects to the first allowed screen or `/no-access`.
- Sidebar nav is filtered by `canView` in [`default-layout.component.ts`](src/app/layout/default-layout/default-layout.component.ts).
- [`*olsCanAct`](src/app/auth/can-act.directive.ts) — hides technical-action controls (Service Console Start/Stop); Oracle CC kill uses the `canKill` computed. Both = `canActTechnical()`.
- [`*olsCanWrite="'<screen>'"`](src/app/auth/can-write.directive.ts) — hides action controls by plain `canWrite` (still used elsewhere).
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
| `GET /api/system/memory` | – | `MemoryStats` `{ free, used, total, unit, percent }` | One-shot snapshot (real host memory via `psutil`/stdlib) |
| `GET /api/system/memory/stream` | – | **SSE** stream of `MemoryStats` (one `data:` frame every ~2s) | Header live memory — consumed via `EventSource`, so it's ONE persistent connection (single network-tab entry), not a poll. Bypasses the mock → always the real backend. |
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
| `POST /api/config/{scope}/tables` | `{ app_env, username }` | `TabularData` `{ cols, rows }` — catalogue for that env (`LIVE`→`PROD`). Body (not query) so `username` stays out of the URL/logs. |
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
scroll for wide/extra columns is always on), and `[filterable]`/`filterPlaceholder` (a
client-side box that matches across every column and prunes drilldown trees to matching
branches — used on the Sessions list where a DBA may face 100+ rows). The **first column (row
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
| `POST /api/oracle_cc/{db}/sessions` | `{ status }` (`active`\|`inactive`\|`killed`\|`all`, default `active`) | Section 7 — session inventory filtered by state; each row carries `__actions` (`detail` always, `kill` unless already KILLED). Includes a **`running_for`** column (LAST_CALL_ET formatted; `—` for non-active) so long-running work is explicit instead of colour-coded. Row `__sev` = `crit` for KILLED only (long-running active is shown by the column, not an amber tint). `summary:{active,inactive,killed,total}` (full counts regardless of filter, for the tab badges). |
| `POST /api/oracle_cc/{db}/session-detail` | `{ sid, serial, sql_id?, panel? }` | Section 7 SID deep-dive: `{ status, session:{…facts}, panels:[…] }`. `panel` omitted → all panels (or the drawer's "Refresh all"); `panel:'ash'` → just that one (per-tab refresh, merged in place). Each panel is `kind:'text'` (plan / SQL Monitor), `kind:'table'` (dyn-table payload), `kind:'rollback'` (killed-session rollback monitor: `%`, undo blocks/records done vs pending, elapsed, est. remaining — from `V$SESSION_LONGOPS('Transaction Rollback')` + `V$TRANSACTION`), or `kind:'resource'` (Resource Profile). a panel is `available:false` only if its own query fails (built independently). Panels: rollback (KILLED only), plan, waits (V$SESSION_EVENT), binds (peeked binds), ash (ASH), **resource**, monitor (SQL Monitor), stats, locks, awr (DBA_HIST). The **plan** panel carries a generated `diagnosis` card (`{sev, findings[], hint}` — bottleneck line incl. its dominant resource, worst cardinality mis-estimate on a real access line + stale-stats root cause, cautious index hint), the **structured runtime plan** (`analysis.plan` with the same **Est. accuracy / Time % / Spent on** columns as SQL Intelligence Plan Analysis) + `analysis.stats`, and the raw `DISPLAY_CURSOR ALLSTATS LAST` text (collapsible). Same `V$SQL_PLAN_STATISTICS_ALL` engine. The **resource** panel (`resource:{pga_used/alloc/max_mb, temp_mb, activity, workareas}`) shows the CPU-vs-wait-class activity split (ASH, last 10 min), PGA (V$PROCESS), temp spill (V$TEMPSEG_USAGE) and active sort/hash work areas + spill passes (V$SQL_WORKAREA_ACTIVE). |
| `POST /api/oracle_cc/{db}/kill-session` | `{ sid, serial, immediate? }` | `{ status, success, message }`. **Admin-gated** in the UI (`RbacService.roles().is_admin`) + explicit danger-confirm before it fires. Used by Locks, Blocking, and Sessions (row + deep-dive drawer). |

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
  for your connector if it differs**. Tunables (owner schema, top-N, history days) are passed IN as
  params so the data layer has no import cycle with the config module. The shaping helpers
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
