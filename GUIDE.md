# OLS Dashboard — Integration Guide

This guide is the single reference for wiring the OLS Dashboard to your real backend:
where to configure things, every API the app calls, and the exact request/response
shape each one expects. It is kept up to date as the app evolves.

> TL;DR to go live: set `APP_ENV`, `API_BASE_URL`, and `USE_MOCK = false` in
> [`src/app/shared/api-endpoints.ts`](src/app/shared/api-endpoints.ts), point the
> endpoints at your services, and make sure each API returns the documented shape.

---

## 1. Central configuration — `src/app/shared/api-endpoints.ts`

Everything you need to change lives at the top of this one file.

| Setting | Purpose | Change to |
|---|---|---|
| `API_BASE_URL` | Root of your backend. Every endpoint is built from it. | Your API host, e.g. `https://ols-api.mybank.net` |
| `USE_MOCK` | While `true`, the in-app mock interceptor answers all endpoints with canned data. | `false` to hit the real backend |
| `APP_ENV` | Which environment this deployment is (`DEV` \| `STG` \| `PROD`). Sent to the Infra config API so it returns only that env's rows. | The env this instance runs in |
| `IS_SSO_ENABLED` | `true` = authenticate via OpenID Connect (`src/app/auth/sso.config.ts`); `false` = bypass SSO and use the direct login form. | `true` once `SSO_CONFIG` is filled in |

`API` is one object holding every URL as a function/string. Change a URL in one place
and it updates everywhere.

To fully detach the mock you can also remove `mockApiInterceptor` from
[`src/app/app.config.ts`](src/app/app.config.ts) `provideHttpClient(withInterceptors([...]))`.

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
| Method & path | Request | Response |
|---|---|---|
| `GET /api/log/servers` | – | `ServerInfo[]` |
| `GET /api/log/files?server=<id>` | – | `{ paths: string[] }` |
| `GET /api/log/file?server=<id>&path=<p>` | – | `{ content: string }` |
| `GET /api/log/file-properties?server=<id>&path=<p>` | – | `FileProperties` |

### Config Ops Console (`scope` = `cib` \| `group` \| `retail`)
| Method & path | Request | Response |
|---|---|---|
| `GET /api/config/{scope}/tables` | – | `ConfigTableRow[]` |
| `GET /api/config/{scope}/table/{table_name}` | – | `TableContent` `{ columns, rows }` |
| `POST /api/config/{scope}/roll` | `{ table_name, from, to }` | `{ message, rolledRows }` |
| `POST /api/config/{scope}/retrieve` | `{ table_name, start, end, range }` | `TableContent` |
| `POST /api/config/{scope}/rows` | `{ table_name, rows }` | `{ success, inserted }` |

### Infrastructure Pulse — see section 5 for the full flow
| Method & path | Request | Response |
|---|---|---|
| `GET /api/infra/config?env=<DEV\|STG\|PROD>` | – | `HealthServerConfigRow[]` |
| `POST /api/infra/agent/collect` | `{ hostname, host_platform, host_address, agent_listen_port, monitor_config }` | `AgentCollectResponse` |
| `POST /api/infra/agent/action` | `{ hostname, host_address, agent_listen_port, service, script, action }` | `AgentActionResponse` |
| `GET /api/infra/share?app=<app>&name=<share>` | – | `ShareSpaceResponse` `{ used, total, unit }` |

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
