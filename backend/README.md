# OLS Dashboard — FastAPI backend

Python backend for the OLS Dashboard Angular UI. This first cut implements the
**Log Analytics** API so the UI browses your real local filesystem live.

```
backend/
  app.py                     # FastAPI app + CORS + router mount
  requirements.txt
  log_analytics/
    log_analytics_api.py     # the /api/log/* endpoints
    dependencies.py          # hardcoded server catalogue + path-jail dependency
  utils/
    fs_browser.py            # sandboxed directory listing / file read / properties
    logging.py               # logging setup
```

## Run

From the `backend/` directory:

```bash
python -m venv .venv
.venv\Scripts\activate           # Windows  (use: source .venv/bin/activate on *nix)
pip install -r requirements.txt
uvicorn app:app --reload --port 8000
```

- API root: `http://localhost:8000`
- Health: `http://localhost:8000/health`
- Interactive docs: `http://localhost:8000/docs`

## Endpoints (`/api/log`)

| Method & path | Purpose | Response |
|---|---|---|
| `GET /servers` | Server dropdown (hardcoded "DB connection") | `{ key: [ {server_name, base_log_path, server_type, db_source} ] }` |
| `GET /files?server=` | Seed the tree (**lazy** mode) | `{ "mode": "lazy", "roots": [ "D:/ALGO", … ] }` |
| `GET /dir?server=&path=` | Immediate children of one folder | `{ "entries": [ {name, type, path} ] }` |
| `GET /file?server=&path=` | File content (capped at 5 MB) | `{ "content": "…" }` |
| `GET /file-properties?server=&path=` | File metadata | `{ name, type, location, size, created, modified, accessed, lines, attributes }` |

## Configuration (nothing hardcoded)

All of it comes from `config.py`, read from env vars with safe defaults — nothing about
servers or paths is hardcoded in the request logic:

| Env var | Default | Purpose |
|---|---|---|
| `OLS_SERVERS_FILE` | `servers.json` (next to `config.py`) | JSON catalogue for `GET /servers` (the DB-connection stand-in). |
| `OLS_LOG_ROOT` | `D:/` | **Fallback** directory, used only when a server declares **no** `base_log_path`. |

**Servers catalogue** — each server's `base_log_path` values come from the catalogue (a real
DB later; `servers.json` for now). A request is confined to **that server's own base paths**,
whatever drive they're on (`C:/my/cib`, `D:/logs`, …). `OLS_LOG_ROOT` (D:/) is used **only** as
the fallback for a server that has no base path — so D:/ is never shown when the DB provides
paths. Delete `servers.json` (and leave `OLS_SERVERS_FILE` unset) to fall back to one generic
server rooted at `OLS_LOG_ROOT`. Later, swap `config.load_servers()` for a live DB query — the
endpoints don't change. See `servers.example.json` for the format.

Example (`servers.json`):

```json
{
  "OLSCIB_WEB_A_1_eur17": [
    { "server_name": "eur17", "base_log_path": "C:/my/cib", "server_type": "WEB_A_1", "db_source": "OLSCIB" }
  ]
}
```

## Security — the path jail

Every `path` is resolved with symlinks and `..` collapsed (`os.path.realpath`) and must land
**inside one of the requesting server's `base_log_path` values** (or the `OLS_LOG_ROOT` fallback
when it has none). A parent directory, another drive, a symlink pointing out, or a `..` segment
is rejected (HTTP 400). Bare drive letters (`D:`) are coerced to their root (`D:/`) so trailing-
slash normalisation on the client can't accidentally target the drive-current directory.

## Connecting the Angular UI

Already wired: `src/environments/environment.ts` has `apiBaseUrl: 'http://localhost:8000'`
and `liveApiPrefixes: ['/api/log/']`, so Log Analytics hits this backend while the rest of
the app stays on the mock. Just run this server and `ng serve`.
