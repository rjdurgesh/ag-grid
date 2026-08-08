"""Server catalogue (the DB-connection boundary) + the shared path-jail dependency.

Two clearly separate concerns:

1. `fetch_log_path` — the ONE place the catalogue is produced. It takes the GROUP db
   connection config and returns each server's ``base_log_path`` (a stand-in query
   for now; swap the body for the real DB call). Used ONLY by ``GET /servers``.

2. `resolve_jailed` — browsing. The UI already has the base path from ``/servers``,
   so it sends it back (in the POST body) when it wants to browse; the backend just
   confirms the requested ``path`` stays inside that ``base`` (no DB call). Everything
   below the base path is read live from disk (see utils/fs_browser.py).

Getting `request` / the DB config: FastAPI injects the `Request` object wherever you
declare a `request: Request` parameter — here, in the `group_db_config` dependency.
`request.app.state.db_configs` is populated at startup in app.py.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import HTTPException, Request

from utils import fs_browser


def group_db_config(request: Request) -> Any:
    """FastAPI dependency → the GROUP database connection config.

    `request` is injected automatically by FastAPI because it's declared as a
    parameter (this is *the* place `request` enters the module). The configs are
    set once at startup in app.py (`app.state.db_configs`).
    """
    return request.app.state.db_configs.get("group")


def fetch_log_path(group_db_config: Any, app_env: str | None = None) -> dict[str, list[dict]]:
    """The server catalogue for ``GET /log/servers`` — the DB-connection boundary.

    Stand-in for the real query. In the production project this is:

        conn = <open connection using group_db_config>
        return <call the stored proc, filtered by app_env>

    Replace the body below with that call — it must return this exact shape, keyed
    by ``{db_source}_{server_type}_{server_name}``, each value a list of rows (one
    per ``base_log_path``). The DB stores ONLY the base path; everything below it
    (subdirs, files, content) is read from disk by the browse endpoints. (The inline
    stand-in ignores ``group_db_config``; the real query uses it.)
    """
    return {
        "OLSCIB_WEB_A_1_eur17": [
            {"server_name": "eur17", "base_log_path": "C:/my/cib", "server_type": "WEB_A_1", "db_source": "OLSCIB"}
        ],
        "OLSGROUP_APP_1_eur12": [
            {"server_name": "eur12", "base_log_path": "C:/apps/data", "server_type": "APP_1", "db_source": "OLSGROUP"}
        ],
    }


def resolve_jailed(base: str, path: str) -> Path:
    """Resolve ``path`` and return it only if it sits inside ``base`` — the browse jail.

    ``base`` is the selected server's ``base_log_path`` (the UI already has it from
    ``/servers`` and sends it back in the request body); ``path`` is the folder/file
    to open. No DB call. Keeps a request from climbing above the configured base
    (``..``/escape → 400) while everything inside it is browsable.

    - Path escapes the base (.., other drive, symlink out) → 400
    - Path is inside the base but doesn't exist (e.g. deleted since the tree loaded)
      → 404 ("Path not found") — a clean error, never a hang.
    """
    resolved = fs_browser.resolve_within_bases([base], path)
    if resolved is None:
        raise HTTPException(status_code=400, detail="Path is outside the server's base log directory")
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    return resolved
