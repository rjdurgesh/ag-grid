"""Server catalogue (the DB-connection boundary) + the shared path-jail dependency.

`fetch_log_path` is the ONE place the catalogue is produced. It takes the GROUP db
connection config and returns the catalogue; right now it returns the data inline
(a stand-in for the query), so swap its body for the real DB call and nothing else
changes. Both `GET /servers` (the dropdown) and the per-server path jail read from
it, so the jail's boundary is always exactly what the DB returns — never hardcoded.

Getting `request` / the DB config: FastAPI injects the `Request` object wherever you
declare a `request: Request` parameter — in a route *or* in a dependency. We declare
it once, in the `group_db_config` dependency below, and every consumer pulls the
config with `Depends(group_db_config)`. `request.app.state.db_configs` is populated
at startup in app.py.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import Depends, HTTPException, Query, Request

from utils import fs_browser


def group_db_config(request: Request) -> Any:
    """FastAPI dependency → the GROUP database connection config.

    `request` is injected automatically by FastAPI simply because it's declared as
    a parameter here (this is *the* place `request` enters the module). The configs
    are set once at startup in app.py (`app.state.db_configs`). If you also need the
    raw request elsewhere (headers, `request.query_params`, …), declare
    `request: Request` on that route/dependency the same way.
    """
    return request.app.state.db_configs.get("group")


def fetch_log_path(group_db_config: Any, app_env: str | None = None) -> dict[str, list[dict]]:
    """The server catalogue for ``GET /log/servers`` — the DB-connection boundary.

    Stand-in for the real query. In the production project this is:

        conn = <open connection using group_db_config>
        return <call the stored proc, filtered by app_env>

    i.e. use the GROUP db config to open the connection and call the proc. Replace
    the body below with that call — it must return this exact shape, keyed by
    ``{db_source}_{server_type}_{server_name}``, each value a list of rows (one per
    ``base_log_path``). Everything downstream (the dropdown + the path jail) keeps
    working unchanged. (``group_db_config`` is unused by the inline stand-in; the
    real query uses it.)
    """
    return {
        "OLSCIB_WEB_A_1_eur17": [
            {"server_name": "eur17", "base_log_path": "C:/my/cib", "server_type": "WEB_A_1", "db_source": "OLSCIB"}
        ],
        "OLSGROUP_APP_1_eur12": [
            {"server_name": "eur12", "base_log_path": "C:/apps/data", "server_type": "APP_1", "db_source": "OLSGROUP"}
        ],
    }


def base_paths_for(server: str, group_db_config: Any, app_env: str | None = None) -> list[str]:
    """The server's configured ``base_log_path`` list (its jail roots) — from the
    same catalogue ``/servers`` returns. Empty when the server key is unknown."""
    rows = fetch_log_path(group_db_config, app_env).get(server, [])
    return [row["base_log_path"] for row in rows if row.get("base_log_path")]


def jailed_path(
    server: str = Query(...),
    path: str = Query(...),
    group_cfg: Any = Depends(group_db_config),
) -> Path:
    """FastAPI dependency shared by ``/dir``, ``/file`` and ``/file-properties``:
    resolve ``path`` and return it only if it lands inside one of THIS server's
    base paths — else raise. The boundary is whatever the catalogue returns. The
    DB config arrives via ``Depends(group_db_config)`` (which pulls it off the
    request), so the jail reads the same source ``/servers`` does.

    - Unknown server (no base paths)         → 404
    - Path escapes the base paths (.., other drive, symlink out) → 400
    - Path is inside a base but doesn't exist (e.g. deleted since the tree loaded)
      → 404 ("Path not found") — a clean error, never a hang.
    """
    bases = base_paths_for(server, group_cfg)
    if not bases:
        raise HTTPException(status_code=404, detail=f"Unknown server '{server}'")
    resolved = fs_browser.resolve_within_bases(bases, path)
    if resolved is None:
        raise HTTPException(status_code=400, detail="Path is outside the server's base log directories")
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    return resolved
