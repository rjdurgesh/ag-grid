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

Use **two services** only if you specifically want to deploy/scale the UI and API
independently, or you'd rather your reverse proxy (IIS/nginx) serve the static files itself.
Both patterns are documented below.

| | Option A — 1 service (recommended) | Option B — 2 (proxy serves UI) |
|---|---|---|
| Windows services | 1 (FastAPI serves API + UI) | 1 FastAPI (API only); proxy serves static |
| Deep-link refresh | handled in FastAPI | handled by proxy SPA-fallback rule |
| CORS | none (same origin) | none (same origin via proxy) |
| Ops complexity | lowest | slightly higher (2 things to manage) |
| Independent UI/API deploy | no (deploy together) | yes |

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

## Checklist / gotchas

- [ ] Serve the **`browser`** sub-folder, not its parent (`dist/.../browser/index.html`).
- [ ] `<base href="/">` present in the deployed `index.html` (it is by default). If the app
      is hosted under a sub-path instead of the domain root, rebuild with
      `ng build --base-href /yoursubpath/`.
- [ ] **SPA fallback** exists (Option A: the FastAPI catch-all; Option B: the proxy rule) —
      this is what makes refreshing a nested URL work.
- [ ] `environment.ts`: `useMock: false`, `apiBaseUrl: ''` (same origin) before building.
- [ ] TLS terminates at the reverse proxy; the FastAPI service binds to `127.0.0.1` only.
- [ ] Redeploying the UI = rebuild, replace the `browser` folder, (Option A) restart the
      service or (Option B) just replace files.
