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

## Configured servers (hardcoded)

Edit `log_analytics/dependencies.py` → `SERVERS`. Current mapping:

- `OLSCIB_WEB_A_1_eur17` → `D:/ALGO`
- `OLSGROUP_APP_1_eur12` → `D:/Material`, `D:/Website`

## Security — the path jail

Every `path` is resolved with symlinks and `..` collapsed (`os.path.realpath`) and
must land **inside** one of the server's `base_log_path` values. Requests to a
parent directory, another drive, a symlink pointing out, or containing `..` are
rejected (HTTP 400). The UI can never browse above its configured roots.

## Connecting the Angular UI

In `src/app/shared/api-endpoints.ts` set:

```ts
export const API_BASE_URL = 'http://localhost:8000';
export const USE_MOCK = false;
```

Then restart `ng serve`. The Log Analytics Hub will hit this backend and browse
`D:/ALGO`, `D:/Material`, `D:/Website` in real time. (The other pages still call
their `/api/...` endpoints — implement those here next as needed.)
