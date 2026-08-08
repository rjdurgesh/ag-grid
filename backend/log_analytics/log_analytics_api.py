"""Log Analytics API — matches the Angular Log Analytics Hub contract exactly.

All routes are under ``/api/log``:

======================================  ==========================================
GET /servers?app_env=                   catalogue (from the DB) → { key: [rows...] }
GET /dir?base=&path=                     { "entries": [{name, type, path}], ... }
GET /file?base=&path=                    { "content": "<text>" }
GET /file-properties?base=&path=         FileProperties {name,type,size,...}
======================================  ==========================================

Only ``/servers`` touches the DB — it returns each server's ``base_log_path``. From
there the UI browses by sending that ``base`` back with the ``path`` it wants; the
tree loads one folder level at a time (``/dir`` on each expand) so browsing stays
responsive on huge directories. ``base`` + ``path`` are sandboxed by the
``jailed_path`` dependency (see dependencies.py) — the requested path must sit
inside the given base. No DB call on the browse path.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from config import settings
from utils import fs_browser
from utils.logging import get_logger

from .dependencies import fetch_log_path, group_db_config, jailed_path

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
