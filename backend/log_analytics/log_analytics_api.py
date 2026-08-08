"""Log Analytics API — matches the Angular Log Analytics Hub contract exactly.

All routes are under ``/api/log``:

======================================  ==========================================
GET /servers                            catalogue (from the DB) → { key: [rows...] }
GET /files?server=                      { "mode": "lazy", "roots": [paths] }
GET /dir?server=&path=                  { "entries": [{name, type, path}] }
GET /file?server=&path=                 { "content": "<text>" }
GET /file-properties?server=&path=      FileProperties {name,type,size,...}
======================================  ==========================================

The tree is served in **lazy** mode: only root folders come back from ``/files``;
the UI fetches each folder's children on first expand via ``/dir``. That keeps
browsing responsive on huge real directories. Every ``path`` is sandboxed by the
``jailed_path`` dependency (see dependencies.py) — confined to the requesting
server's base paths, whatever the DB returns.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from config import settings
from utils import fs_browser
from utils.logging import get_logger

from .dependencies import base_paths_for, fetch_log_path, group_db_config, jailed_path

logger = get_logger(__name__)

router = APIRouter(prefix="/api/log", tags=["log_analytics"])


@router.get("/servers")
def get_servers(
    app_env: str | None = Query(None),
    group_cfg: Any = Depends(group_db_config),
) -> dict:
    """The server catalogue the dropdown reads — from the DB (see fetch_log_path).

    `group_cfg` is the GROUP db connection config, injected via the
    `group_db_config` dependency (which reads it off the request's app.state).
    `app_env` (DEV/STG/PROD, sent by the UI) scopes the query by environment.
    """
    logger.info("servers (app_env=%s)", app_env)
    return fetch_log_path(group_cfg, app_env)


@router.get("/files")
def get_files(
    server: str = Query(...),
    group_cfg: Any = Depends(group_db_config),
) -> dict:
    """Seed the tree in LAZY mode: root folders only — the server's base paths
    from the catalogue. The UI loads each folder's children on demand via
    ``/dir``. Empty roots when the server key is unknown."""
    return {"mode": "lazy", "roots": [fs_browser.to_posix(b) for b in base_paths_for(server, group_cfg)]}


@router.get("/dir")
def get_dir(path: str = Query(...), resolved: Path = Depends(jailed_path)) -> dict:
    """Immediate children of one folder (one level — the load-on-expand call).
    Capped at `settings.dir_limit` per folder → `{ entries, total, truncated }`."""
    if not resolved.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")
    logger.info("dir  %s", resolved)
    return fs_browser.list_dir(resolved, requested=path, limit=settings.dir_limit)


@router.get("/file")
def get_file(resolved: Path = Depends(jailed_path)) -> dict:
    """Full text content of a single file (capped; binary → placeholder)."""
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")
    logger.info("read %s", resolved)
    return {"content": fs_browser.read_file_text(resolved)}


@router.get("/file-properties")
def get_file_properties(resolved: Path = Depends(jailed_path)) -> dict:
    """Metadata for the Properties dialog."""
    logger.info("stat %s", resolved)
    return fs_browser.file_properties(resolved)
