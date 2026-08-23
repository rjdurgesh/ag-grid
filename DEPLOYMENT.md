# OLS Dashboard — Windows Server Deployment Guide

Your setup: **Windows Server**, running the app as a **Windows service**, with a
**reverse proxy already configured** (TLS + routing). This app has two parts:

- **Angular UI** — after `ng build` it's just static files (`index.html`, hashed JS/CSS).
- **FastAPI API** — a Python process (uvicorn) that answers `/api/*`.

---

## TL;DR — my recommendation

**Run ONE Windows service: FastAPI serves BOTH the API and the built Angular UI.**

Why, for your case (internal ops dashboard, one service, reverse proxy in front):
- **One service** to install / monitor / restart (matches your plan).
- **One origin** → no CORS, and **deep-link refresh works automatically** (FastAPI returns `index.html` for any non-`/api` path).
- **Simplest reverse-proxy config** — forward *everything* to that single service.
- Serving static files from FastAPI is more than fast enough for an internal dashboard.

Use **two services** if you specifically want to deploy/scale the UI and API
independently. **Option C** below is the one you asked for: two dedicated Windows
services — **`OLS_UI_SERVICE`** (a lightweight static web server, no IIS, no Node needed
at runtime) and **`OLS_BACKEND_SERVICE`** (FastAPI). All patterns are documented below.

| | Option A — 1 service (recommended) | Option B — proxy serves UI | Option C — 2 services, no IIS |
|---|---|---|---|
| Windows services | 1 (FastAPI serves API + UI) | 1 FastAPI (API only) + existing proxy | 2 (`OLS_UI_SERVICE` + `OLS_BACKEND_SERVICE`) |
| Serves the UI | FastAPI | your reverse proxy | `OLS_UI_SERVICE` (Python/uvicorn) |
| Deep-link refresh | handled in FastAPI | proxy SPA-fallback rule | `OLS_UI_SERVICE` SPA fallback |
| CORS | none (same origin) | none (same origin via proxy) | none — UI service proxies `/api` |
| External tools | none | reverse proxy | **none** (Python + `httpx`) |
| Ops complexity | lowest | slightly higher | two services to manage |
| Independent UI/API deploy | no (deploy together) | yes | yes |

---

## Step 1 — Build the Angular app (both options)

On a machine with Node + the repo:

```bash
ng build
```

Output (Angular 22 application builder):

```
dist/ols-operations-command-center/browser/
```

Serve the **`browser`** sub-folder as the web root — that's where `index.html` lives.
`<base href="/">` is already set. Copy that `browser/` folder to the server (e.g.
`C:\ols\ui`).

Before building for production, set these in `src/environments/environment.ts`:

```ts
apiBaseUrl: '',        // same-origin → API calls go to relative /api/... (works behind the proxy)
useMock: false,        // hit the real FastAPI, not the in-app mock
```

(`useMock` is baked in at build time — it's an Angular setting, not a service env var.)

---

## Option A (recommended) — one service, FastAPI serves API + UI

### A1. Add UI serving to `backend/app.py`

Paste this **after** all `app.include_router(...)` calls (the catch-all must be last so
API routes win):

```python
import os
from pathlib import Path
from fastapi import HTTPException
from fastapi.responses import FileResponse

# Point at the built Angular 'browser' folder. Override with OLS_UI_DIR on the server.
UI_DIR = Path(os.getenv(
    "OLS_UI_DIR",
    str(Path(__file__).resolve().parent.parent / "dist" / "ols-operations-command-center" / "browser"),
))

@app.get("/{spa_path:path}")
async def serve_ui(spa_path: str):
    # Never shadow the API.
    if spa_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found")
    candidate = UI_DIR / spa_path
    if spa_path and candidate.is_file():
        return FileResponse(candidate)          # real file: main-*.js, styles-*.css, assets/*, favicon…
    return FileResponse(UI_DIR / "index.html")  # any app route (deep link) → SPA shell
```

That single catch-all serves every real static file AND returns `index.html` for deep
links like `/infra_pulse/service_console` — which is exactly what fixes "refresh on a
nested URL shows nothing."

### A2. Run it as a Windows service (NSSM)

[NSSM](https://nssm.cc) is the simplest way to run uvicorn as a Windows service:

```bat
nssm install OLS-Dashboard "C:\ols\venv\Scripts\python.exe"
nssm set OLS-Dashboard AppParameters "-m uvicorn app:app --host 127.0.0.1 --port 8000"
nssm set OLS-Dashboard AppDirectory "C:\ols\backend"
nssm set OLS-Dashboard AppEnvironmentExtra "OLS_UI_DIR=C:\ols\ui" "ORACLE_CC_USE_DUMMY=0"
nssm set OLS-Dashboard Start SERVICE_AUTO_START
nssm start OLS-Dashboard
```

- Bind to `127.0.0.1` (localhost) — only the reverse proxy should reach it.
- `ORACLE_CC_USE_DUMMY=0` once the read-only Oracle monitoring connections are wired
  (leave `1` to keep the canned data).

### A3. Reverse proxy — forward everything to the one service

**nginx**
```nginx
location / {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

**IIS** (ARR + URL Rewrite) — one reverse-proxy rule to `http://127.0.0.1:8000/`.

Done — UI + API + deep links all work through one service.

---

## Option B — FastAPI = API only, reverse proxy serves the static UI

Use this if you prefer your proxy to serve the static files. Do **not** add the UI code
from A1; FastAPI only serves `/api/*`. Point the proxy's document root at `C:\ols\ui`
(the `browser` folder) and add a SPA fallback + `/api` proxy.

**nginx**
```nginx
root C:/ols/ui;                       # the built 'browser' folder
location /api/ { proxy_pass http://127.0.0.1:8000; }   # API → FastAPI service
location /     { try_files $uri /index.html; }         # SPA deep-link fallback
```

**IIS** — put this `web.config` in `C:\ols\ui`, and add an ARR rule that proxies `/api/*`
to `http://127.0.0.1:8000`:
```xml
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="OLS SPA" stopProcessing="true">
          <match url=".*" />
          <conditions logicalGrouping="MatchAll">
            <add input="{REQUEST_FILENAME}" matchType="IsFile" negate="true" />
            <add input="{REQUEST_FILENAME}" matchType="IsDirectory" negate="true" />
            <add input="{REQUEST_URI}" pattern="^/api/" negate="true" />
          </conditions>
          <action type="Rewrite" url="/index.html" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
```

FastAPI still runs as a Windows service (NSSM, same as A2 but without `OLS_UI_DIR`).

---

## Option C — two Windows services, no IIS, **no external tools**  ← the one you asked for

Constraint: **no external web server** (no Caddy / nginx / IIS). The UI service is a small
**Python/uvicorn app** — the *same stack you already run for the backend* — plus one Python
package, `httpx`. Two services, but a **single origin** so there's **no CORS**:

| Service | File | Runs | Listens on |
|---|---|---|---|
| **`OLS_BACKEND_SERVICE`** | `app.py` (existing) | FastAPI — **API only** | `127.0.0.1:8000` (localhost only) |
| **`OLS_UI_SERVICE`** | `ui_server.py` (in the repo) | serves the built UI + **proxies `/api/*`** to the backend | server host, e.g. `:8080` |

`ui_server.py` is a **separate app from `app.py`** — two processes, two ports. It only
*forwards* `/api/*` to the backend over HTTP; it never imports it. Because the browser talks
to one origin (`OLS_UI_SERVICE`), the backend stays on `127.0.0.1` and there's no CORS.

> Angular needs Node only for `ng build` (Step 1). At runtime it's static files served by
> `ui_server.py`. Install the one dependency into the existing venv: `pip install httpx`
> (it's already pinned in `backend/requirements.txt`).

### C1. `OLS_BACKEND_SERVICE` — FastAPI (API only)

Do **not** add the UI-serving code from A1. Bind to `127.0.0.1` — only `OLS_UI_SERVICE`
(same box) reaches it, and no `ALLOWED_ORIGINS` / CORS change is needed:

```bat
nssm install OLS_BACKEND_SERVICE "C:\ols\venv\Scripts\python.exe"
nssm set OLS_BACKEND_SERVICE AppParameters "-m uvicorn app:app --host 127.0.0.1 --port 8000"
nssm set OLS_BACKEND_SERVICE AppDirectory "C:\ols\backend"
nssm set OLS_BACKEND_SERVICE AppEnvironmentExtra "ORACLE_CC_USE_DUMMY=0"
nssm set OLS_BACKEND_SERVICE Start SERVICE_AUTO_START
nssm start OLS_BACKEND_SERVICE
```

### C2. `OLS_UI_SERVICE` — `ui_server.py` (serves UI + proxies `/api`)

The file already lives in the repo at [`backend/ui_server.py`](backend/ui_server.py) and
deploys with the backend folder (`C:\ols\backend`). It reads three env vars:

| Env var | Default | Meaning |
|---|---|---|
| `OLS_UI_DIR` | `C:\ols\ui` | the built Angular `browser` folder |
| `OLS_BACKEND_URL` | `http://127.0.0.1:8000` | the `OLS_BACKEND_SERVICE` origin |
| `OLS_PROXY_TIMEOUT` | `120` | upstream read timeout (Oracle can be slow) |

Install it as its own service (same `python.exe` and folder as the backend):

```bat
nssm install OLS_UI_SERVICE "C:\ols\venv\Scripts\python.exe"
nssm set OLS_UI_SERVICE AppParameters "-m uvicorn ui_server:app --host 0.0.0.0 --port 8080"
nssm set OLS_UI_SERVICE AppDirectory "C:\ols\backend"
nssm set OLS_UI_SERVICE AppEnvironmentExtra "OLS_UI_DIR=C:\ols\ui" "OLS_BACKEND_URL=http://127.0.0.1:8000"
nssm set OLS_UI_SERVICE Start SERVICE_AUTO_START
nssm start OLS_UI_SERVICE
```

Two things this file does:
- **`/api/*` → proxied** to `OLS_BACKEND_URL` (all methods, body, query, headers forwarded).
- **everything else → static file, or `index.html`** — the `{spa_path:path}` catch-all is
  what makes refreshing a nested URL (`/infra_pulse/service_console`) work.

### C3. Build settings for `environment.ts`

Single origin, so API calls are relative — same as Options A/B:

```ts
apiBaseUrl: '',    // relative → /api/... hits OLS_UI_SERVICE, which proxies to the backend
useMock: false,
```

Then `ng build` and copy `dist/ols-operations-command-center/browser/` to `C:\ols\ui`.

### TLS

There's no reverse proxy in this option, so terminate TLS wherever your org normally does
(a network load-balancer / corporate gateway), or run plain HTTP on the internal network.
If `OLS_UI_SERVICE` must terminate TLS itself, pass uvicorn `--ssl-keyfile` / `--ssl-certfile`
in its `AppParameters`.

> **Even simpler if two services isn't a hard requirement:** since `OLS_UI_SERVICE` is itself
> a Python/uvicorn process, **Option A** (one FastAPI service serves API *and* UI) removes the
> second service and the second port entirely. Use two services only if you want to
> deploy/restart the UI and API independently.

---

## Checklist / gotchas

- [ ] Serve the **`browser`** sub-folder, not its parent (`dist/.../browser/index.html`).
- [ ] `<base href="/">` present in the deployed `index.html` (it is by default). If the app
      is hosted under a sub-path instead of the domain root, rebuild with
      `ng build --base-href /yoursubpath/`.
- [ ] **SPA fallback** exists (Option A: the FastAPI catch-all; Option B: the proxy rule;
      Option C: the `{spa_path:path}` catch-all in `ui_server.py`) — this is what makes
      refreshing a nested URL work.
- [ ] **(Option C)** `pip install httpx` into the venv; `ui_server.py` proxies `/api/*` to
      `OLS_BACKEND_URL`, so it's a single origin — backend binds `127.0.0.1`, no CORS, and
      only the `OLS_UI_SERVICE` port is opened on the firewall.
- [ ] `environment.ts`: `useMock: false`, `apiBaseUrl: ''` (single origin — Options A/B **and**
      C) before building.
- [ ] TLS: Options A/B terminate at the reverse proxy (FastAPI binds `127.0.0.1`); Option C
      has no proxy — terminate TLS where your org normally does, use plain HTTP internally, or
      give uvicorn `--ssl-keyfile`/`--ssl-certfile`.
- [ ] Redeploying the UI = rebuild, replace the `browser` folder, then (Option A) restart the
      service, (Option B) just replace files, or (Option C) replace files in `C:\ols\ui` and
      restart `OLS_UI_SERVICE` (uvicorn caches `index.html` handles; a restart is cleanest).
