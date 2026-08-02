"""Server catalogue (hardcoded for now) + the shared path-jail dependency.

The server list normally comes from the DB-connection API. It is hardcoded here
per the current requirement; the ``base_log_path`` values point at REAL local
directories so the UI browses the live filesystem. Swap {@link SERVERS} for a DB
lookup later without touching the endpoints.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException, Query

from utils import fs_browser

# --- Hardcoded "DB connection" result (the GET /servers response) ------------
# Keyed by {db_source}_{server_type}_{server_name}; value is a list of rows, one
# per configured base_log_path (a server may have several — each becomes a tree
# root). Real local dirs are used so directory browsing is live.
SERVERS: dict[str, list[dict]] = {
    "OLSCIB_WEB_A_1_eur17": [
        {
            "server_name": "eur17",
            "base_log_path": "D:/ALGO",
            "server_type": "WEB_A_1",
            "db_source": "OLSCIB",
        },
    ],
    "OLSGROUP_APP_1_eur12": [
        {
            "server_name": "eur12",
            "base_log_path": "D:/Material",
            "server_type": "APP_1",
            "db_source": "OLSGROUP",
        },
        {
            "server_name": "eur12",
            "base_log_path": "D:/Website",
            "server_type": "APP_1",
            "db_source": "OLSGROUP",
        },
    ],
}


def base_paths_for(server: str) -> list[str]:
    """Configured base_log_path list for a server key (empty if unknown)."""
    return [row["base_log_path"] for row in SERVERS.get(server, [])]


def jailed_path(server: str = Query(...), path: str = Query(...)) -> Path:
    """FastAPI dependency: validate ``(server, path)`` and return the resolved,
    in-jail absolute Path — or raise the appropriate HTTP error.

    Shared by ``/dir``, ``/file`` and ``/file-properties`` so the sandbox check
    lives in exactly one place.
    """
    bases = base_paths_for(server)
    if not bases:
        raise HTTPException(status_code=404, detail=f"Unknown server '{server}'")

    resolved = fs_browser.resolve_within_bases(bases, path)
    if resolved is None:
        raise HTTPException(
            status_code=400,
            detail="Path is outside the server's base log directories",
        )
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    return resolved
