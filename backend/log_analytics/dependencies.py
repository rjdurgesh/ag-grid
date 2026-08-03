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
    """Configured base_log_path list for a server key (empty if unknown)."""
    return [row["base_log_path"] for row in SERVERS.get(server, [])]


def allowed_roots() -> list[str]:
    """Every directory browsing is confined to: the jail root plus each server's
    configured base path. With the default config this is just the jail root, so
    the whole `log_root` tree is browsable — generic, no per-path assumptions."""
    roots = [settings.log_root]
    for rows in SERVERS.values():
        roots.extend(row["base_log_path"] for row in rows)
    return roots


def jailed_path(path: str = Query(...)) -> Path:
    """FastAPI dependency shared by `/dir`, `/file` and `/file-properties`:
    resolve `path` and return it only if it lands inside an allowed root — else
    raise. Works for ANY path/server; the boundary is config, never hardcoded."""
    resolved = fs_browser.resolve_within_bases(allowed_roots(), path)
    if resolved is None:
        raise HTTPException(status_code=400, detail="Path is outside the allowed root directory")
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    return resolved
