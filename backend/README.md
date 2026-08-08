# OLS Dashboard — FastAPI backend

Python backend for the OLS Dashboard Angular UI. This first cut implements the
**Log Analytics** API so the UI browses your real local filesystem live.

```
backend/
  app.py                     # FastAPI app + CORS + router mount
  requirements.txt
  log_analytics/
    log_analytics_api.py     # the /api/log/* endpoints
    dependencies.py          # fetch_log_path (DB boundary) + path-jail dependency
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
| `GET /servers` | Server dropdown (from the DB — see `fetch_log_path`) | `{ key: [ {server_name, base_log_path, server_type, db_source} ] }` |
| `GET /files?server=` | Seed the tree (**lazy** mode) | `{ "mode": "lazy", "roots": [ "D:/ALGO", … ] }` |
| `GET /dir?server=&path=` | Immediate children of one folder | `{ "entries": [ {name, type, path} ] }` |
| `GET /file?server=&path=` | File content (capped at 5 MB) | `{ "content": "…" }` |
| `GET /file-properties?server=&path=` | File metadata | `{ name, type, location, size, created, modified, accessed, lines, attributes }` |

## The server catalogue (the DB boundary)

The catalogue — which servers exist and each one's `base_log_path` list — comes from the DB, not
from config. It's produced in **one** place, `log_analytics/dependencies.py → fetch_log_path()`,
which today returns the data inline as a stand-in for the query:

```python
def fetch_log_path(group_db_config, app_env: str | None = None) -> dict[str, list[dict]]:
    # real: conn = <open using group_db_config>; return <stored proc, filtered by app_env>
    return {
        "OLSCIB_WEB_A_1_eur17": [
            {"server_name": "eur17", "base_log_path": "C:/my/cib", "server_type": "WEB_A_1", "db_source": "OLSCIB"}
        ],
        "OLSGROUP_APP_1_eur12": [
            {"server_name": "eur12", "base_log_path": "C:/apps/data", "server_type": "APP_1", "db_source": "OLSGROUP"}
        ],
    }
```

Swap the body for the real DB connection + stored-proc call (filtered by `app_env`) — it must
return this same shape and **nothing else changes**. `GET /servers` returns it directly, and the
path jail reads each server's base paths from it via `base_paths_for()`.

**Where the DB connection config comes from.** FastAPI injects the `Request` object wherever you
declare a `request: Request` parameter (in a route *or* a dependency). Connection configs are
loaded once at startup in `app.py` (`app.state.db_configs = load_db_configs()`) and read per
request via `request.app.state.db_configs`. That single `request` declaration lives in the
`group_db_config` dependency; `/servers`, `/files` and the path jail all obtain the GROUP config
with `Depends(group_db_config)` — no repetition:

```python
def group_db_config(request: Request):            # request auto-injected by FastAPI
    return request.app.state.db_configs.get("group")

@router.get("/servers")
def get_servers(app_env: str | None = Query(None), group_cfg = Depends(group_db_config)):
    return fetch_log_path(group_cfg, app_env)
```

Replace `load_db_configs()` in `app.py` with your real loader (config file / env / secrets). For
connection *pools*, open them in a FastAPI lifespan handler and close on shutdown.

The only env-var tunable is operational, not data:

| Env var | Default | Purpose |
|---|---|---|
| `OLS_DIR_LIMIT` | `500` | Max entries `/dir` returns per folder (anti-hang cap). `0` = unlimited. |

## Security — the path jail

Every `path` is resolved with symlinks and `..` collapsed (`os.path.realpath`) and must land
**inside one of the requesting server's `base_log_path` values** (from `fetch_log_path`). An
unknown server (no base paths) is rejected with **404**; a parent directory, another drive, a
symlink pointing out, or a `..` segment is rejected with **400**. A path that is inside a base
path but no longer exists (e.g. deleted from disk after the tree loaded) returns **404 "Path not
found"** — a clean error, never a hang. Bare drive letters (`D:`) are coerced to their root
(`D:/`) so trailing-slash normalisation on the client can't accidentally target the drive-current
directory.

## Connecting the Angular UI

Already wired: `src/environments/environment.ts` has `apiBaseUrl: 'http://localhost:8000'`
and `liveApiPrefixes: ['/api/log/']`, so Log Analytics hits this backend while the rest of
the app stays on the mock. Just run this server and `ng serve`.
