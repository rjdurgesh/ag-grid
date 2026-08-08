"""Server catalogue (config-driven) + the shared path-jail dependency.

Nothing is hardcoded here: the catalogue comes from `config.load_servers()` (an
optional file or a generic default) and browsing is jailed to the configured root
(`settings.log_root`, default `D:/`) plus any base paths the catalogue declares.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException, Query

from config import load_servers, settings
from utils import fs_browser

# Loaded once at startup (stand-in for the DB-connection API). Restart to reload,
# or swap `load_servers()` for a live DB query.
SERVERS: dict[str, list[dict]] = load_servers()


def base_paths_for(server: str) -> list[str]:
    """The server's configured base_log_path list from the DB catalogue. Falls
    back to the default root (`settings.log_root`, D:/) ONLY when the DB returns
    none — so we browse the real base paths whenever they exist, D:/ otherwise."""
    bases = [row["base_log_path"] for row in SERVERS.get(server, []) if row.get("base_log_path")]
    return bases or [settings.log_root]


def jailed_path(server: str = Query(...), path: str = Query(...)) -> Path:
    """FastAPI dependency shared by `/dir`, `/file` and `/file-properties`:
    resolve `path` and return it only if it lands inside one of THIS server's base
    paths (or the D:/ default when the server declares none) — else raise. Generic:
    the boundary is whatever the DB catalogue returns, never hardcoded."""
    resolved = fs_browser.resolve_within_bases(base_paths_for(server), path)
    if resolved is None:
        raise HTTPException(status_code=400, detail="Path is outside the server's base log directories")
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    return resolved
