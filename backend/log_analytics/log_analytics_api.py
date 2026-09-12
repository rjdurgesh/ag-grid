"""Log Analytics API — matches the Angular Log Analytics Hub contract exactly.

All routes are under ``/api/log``:

======================================  ==========================================
GET  /servers?app_env=                  catalogue (from the DB) → { key: [rows...] }
POST /dir                               body {server_id?, base, path} → {entries,...}
POST /file                              body {server_id?, base, path, offset?, length?,
                                        from_end?} → small file: {mode:'full', content,
                                        total_size}; large file: {mode:'window', content,
                                        start, end, total_size, bof, eof}
GET  /file/download?base=&path=         streamed download (never buffered in RAM)
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
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from config import settings
from env_loader import env_bool  # importing also loads backend/.env into os.environ
from utils import fs_browser
from utils.logging import get_logger

from . import dummy
from .dependencies import fetch_log_path, group_db_config, resolve_jailed

logger = get_logger(__name__)

router = APIRouter(prefix="/api/log", tags=["log_analytics"])

# Per-screen backend DUMMY switch (the backend analog of the UI's apiMocks) — set in .env.
# 1/true = canned catalogue + in-memory folder tree (no real log servers needed); 0/false = real DB proc +
# real disk reads. Lets you demo/develop Log Analytics without touching the other screens (and vice-versa).
LOG_ANALYTICS_USE_DUMMY = env_bool("LOG_ANALYTICS_USE_DUMMY", True)


class BrowseRequest(BaseModel):
    """Body for the browse endpoints. ``base`` is the server's ``base_log_path``
    (the UI already has it from ``/servers``); ``path`` is the folder/file to open.
    ``server_id`` is optional context — which server the UI is browsing — logged for
    traceability, not used for the jail (``base`` is)."""

    base: str
    path: str
    server_id: str | None = None


class FileReadRequest(BrowseRequest):
    """Body for ``POST /file``. Adds the paging window for large files:

    - ``offset``   byte position to start reading (large-file window mode).
    - ``length``   max bytes for this window (server clamps to a safe ceiling).
    - ``from_end`` read the LAST ``length`` bytes instead (newest-first "tail").

    Small files (size <= threshold) ignore these and return the whole file.
    """

    offset: int = 0
    length: int | None = None
    from_end: bool = False


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
    logger.info("servers (app_env=%s, dummy=%s)", app_env, LOG_ANALYTICS_USE_DUMMY)
    if LOG_ANALYTICS_USE_DUMMY:
        return dummy.servers_dummy(app_env)
    return fetch_log_path(group_cfg, app_env)


@router.post("/dir")
def get_dir(req: BrowseRequest) -> dict:
    """Immediate children of one folder (one level — the load-on-expand call).
    Capped at `settings.dir_limit` per folder → `{ entries, total, truncated }`."""
    if LOG_ANALYTICS_USE_DUMMY:
        return dummy.dir_dummy(req.base, req.path)   # 404 for the intentionally-missing base path
    resolved = resolve_jailed(req.base, req.path)
    if not resolved.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")
    logger.info("dir  server=%s %s", req.server_id, resolved)
    return fs_browser.list_dir(resolved, requested=req.path, limit=settings.dir_limit)


@router.post("/file")
def get_file(req: FileReadRequest) -> dict:
    """File content for the preview.

    Small file (size <= ``OLS_FILE_WINDOW_THRESHOLD``) → the whole file
    (``mode:'full'``). Large file → a line-aligned byte WINDOW the UI pages
    through (``mode:'window'``), so a multi-GB file never loads whole anywhere.
    """
    if LOG_ANALYTICS_USE_DUMMY:
        return dummy.file_dummy(req.path)
    resolved = resolve_jailed(req.base, req.path)
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")
    size = resolved.stat().st_size

    if size <= settings.file_window_threshold:
        logger.info("read server=%s %s (full, %d bytes)", req.server_id, resolved, size)
        return {
            "mode": "full",
            "content": fs_browser.read_file_all(resolved, settings.file_window_threshold),
            "total_size": size,
        }

    window = fs_browser.read_file_window(
        resolved,
        offset=req.offset or 0,
        length=req.length or fs_browser.DEFAULT_WINDOW_BYTES,
        from_end=req.from_end,
    )
    logger.info(
        "read server=%s %s (window %d-%d of %d)",
        req.server_id, resolved, window["start"], window["end"], size,
    )
    return {"mode": "window", **window}


@router.get("/file/download")
def download_file(base: str = Query(...), path: str = Query(...)) -> StreamingResponse:
    """Stream a file to the browser as a download — chunked, so even a multi-GB
    file is never buffered in server memory. Jailed to ``base`` like every read."""
    if LOG_ANALYTICS_USE_DUMMY:
        body = dummy.file_dummy(path)["content"].encode("utf-8")
        name = (path or "download.log").replace("\\", "/").rstrip("/").rsplit("/", 1)[-1] or "download.log"
        return StreamingResponse(iter([body]), media_type="application/octet-stream",
                                 headers={"Content-Disposition": f'attachment; filename="{name}"',
                                          "Content-Length": str(len(body))})
    resolved = resolve_jailed(base, path)
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")

    def chunks():
        with resolved.open("rb") as fh:
            while True:
                chunk = fh.read(1024 * 1024)  # 1 MB at a time
                if not chunk:
                    break
                yield chunk

    logger.info("download %s", resolved)
    return StreamingResponse(
        chunks(),
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{resolved.name}"',
            "Content-Length": str(resolved.stat().st_size),
        },
    )


@router.post("/file-properties")
def get_file_properties(req: BrowseRequest) -> dict:
    """Metadata for the Properties dialog."""
    if LOG_ANALYTICS_USE_DUMMY:
        return dummy.file_properties_dummy(req.path)
    resolved = resolve_jailed(req.base, req.path)
    logger.info("stat server=%s %s", req.server_id, resolved)
    return fs_browser.file_properties(resolved)
