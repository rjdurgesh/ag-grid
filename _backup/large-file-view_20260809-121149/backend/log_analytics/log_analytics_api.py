"""Log Analytics API — matches the Angular Log Analytics Hub contract exactly.

All routes are under ``/api/log``:

======================================  ==========================================
GET  /servers?app_env=                  catalogue (from the DB) → { key: [rows...] }
POST /dir                               body {server_id?, base, path} → {entries,...}
POST /file                              body {server_id?, base, path} → {content}
POST /file-properties                   body {server_id?, base, path} → FileProperties
======================================  ==========================================

Only ``/servers`` touches the DB — it returns each server's ``base_log_path``. From
there the UI browses by POSTing that ``base`` back with the ``path`` it wants (in the
body, so long paths never bloat the URL); the tree loads one folder level at a time
(``/dir`` on each expand) so browsing stays responsive on huge directories.
``base`` + ``path`` are sandboxed by ``resolve_jailed`` (see dependencies.py) — the
requested path must sit inside the given base. No DB call on the browse path.
``server_id`` is optional context (which server is being browsed) — logged only.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from config import settings
from utils import fs_browser
from utils.logging import get_logger

from .dependencies import fetch_log_path, group_db_config, resolve_jailed

logger = get_logger(__name__)

router = APIRouter(prefix="/api/log", tags=["log_analytics"])


class BrowseRequest(BaseModel):
    """Body for the browse endpoints. ``base`` is the server's ``base_log_path``
    (the UI already has it from ``/servers``); ``path`` is the folder/file to open.
    ``server_id`` is optional context — which server the UI is browsing — logged for
    traceability, not used for the jail (``base`` is)."""

    base: str
    path: str
    server_id: str | None = None


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


@router.post("/dir")
def get_dir(req: BrowseRequest) -> dict:
    """Immediate children of one folder (one level — the load-on-expand call).
    Capped at `settings.dir_limit` per folder → `{ entries, total, truncated }`."""
    resolved = resolve_jailed(req.base, req.path)
    if not resolved.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")
    logger.info("dir  server=%s %s", req.server_id, resolved)
    return fs_browser.list_dir(resolved, requested=req.path, limit=settings.dir_limit)


@router.post("/file")
def get_file(req: BrowseRequest) -> dict:
    """Full text content of a single file (capped; binary → placeholder)."""
    resolved = resolve_jailed(req.base, req.path)
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")
    logger.info("read server=%s %s", req.server_id, resolved)
    return {"content": fs_browser.read_file_text(resolved)}


@router.post("/file-properties")
def get_file_properties(req: BrowseRequest) -> dict:
    """Metadata for the Properties dialog."""
    resolved = resolve_jailed(req.base, req.path)
    logger.info("stat server=%s %s", req.server_id, resolved)
    return fs_browser.file_properties(resolved)
