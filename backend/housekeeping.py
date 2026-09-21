"""Automatic housekeeping of the batch-log directory.

Deletes files older than a configurable age from the logs directory, but ALWAYS keeps at least the
newest few files regardless of age — so a quiet period (no new logs written for a long time) can never
empty the folder.

Config (all in ``backend/.env``, overridable via ``config/housekeeping.json``):
  * ``LOG_HOUSEKEEP_ENABLED``       — turn the scheduled purge on/off (default on).
  * ``LOG_HOUSEKEEP_DIR``           — the directory to housekeep (default ``Logs/BatchLogs``; a relative
                                      path resolves against the backend dir).
  * ``LOG_HOUSEKEEP_MAX_DAYS``      — delete files older than this many days (default 30).
  * ``LOG_HOUSEKEEP_KEEP_MIN``      — always keep at least this many newest files (default 2).
  * ``LOG_HOUSEKEEP_INTERVAL_HOURS``— how often the background task runs (default 24).

The purge is idempotent (deleting an already-gone file is ignored), so it is safe even if it happens to
run in more than one worker process.
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

from utils.logging import get_logger

logger = get_logger(__name__)


def purge_old_logs(directory: str, max_age_days: int, keep_min: int, now: float | None = None) -> dict:
    """Delete files in ``directory`` older than ``max_age_days``, but never touch the newest ``keep_min``.

    Only regular files DIRECTLY inside ``directory`` are considered (sub-folders are left alone). The
    newest ``keep_min`` files (by modified time) are protected no matter how old they are — that is the
    safety floor that keeps the folder from ever being emptied during a quiet spell. Returns a summary
    dict (``deleted`` / ``kept_recent`` / ``kept_fresh`` / ``errors``) for logging; it never raises for a
    per-file failure (each is caught and reported).
    """
    now = time.time() if now is None else now
    result: dict = {
        "status": "ok", "dir": directory, "scanned": 0,
        "deleted": [], "kept_recent": [], "kept_fresh": 0, "errors": [],
    }

    base = Path(directory)
    if not base.is_dir():
        result["status"] = "skipped"
        result["reason"] = "directory does not exist"
        return result

    try:
        # Skip dotfiles (e.g. a .gitkeep placeholder) so they are neither deleted nor counted toward the
        # keep-min floor — the floor should always protect real log files.
        files = [f for f in base.iterdir() if f.is_file() and not f.name.startswith(".")]
    except OSError as exc:
        result["status"] = "error"
        result["reason"] = str(exc)
        return result

    result["scanned"] = len(files)
    keep_min = max(0, int(keep_min))
    max_age_days = max(0, int(max_age_days))
    cutoff = now - max_age_days * 86400

    # Newest first, so the first `keep_min` are the protected floor.
    files.sort(key=lambda p: _safe_mtime(p), reverse=True)
    protected = files[:keep_min]
    result["kept_recent"] = [p.name for p in protected]

    for f in files[keep_min:]:
        mtime = _safe_mtime(f)
        if mtime >= cutoff:
            result["kept_fresh"] += 1        # within the age window — keep
            continue
        try:
            f.unlink()
            result["deleted"].append(f.name)
        except FileNotFoundError:
            pass                              # already gone (idempotent) — fine
        except OSError as exc:
            result["errors"].append({"file": f.name, "error": str(exc)})

    return result


def _safe_mtime(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def run_housekeeping(cfg: dict) -> dict:
    """Run one purge from a config dict (see :func:`config_loader.housekeeping_config`) and log a summary."""
    summary = purge_old_logs(
        directory=cfg.get("log_dir", ""),
        max_age_days=int(cfg.get("max_age_days", 30)),
        keep_min=int(cfg.get("keep_min", 2)),
    )
    if summary["status"] == "skipped":
        logger.info("housekeeping: skipped — %s (%s)", summary.get("reason"), summary["dir"])
    elif summary["status"] == "error":
        logger.warning("housekeeping: could not read %s — %s", summary["dir"], summary.get("reason"))
    else:
        logger.info(
            "housekeeping: %s — scanned %d, deleted %d, kept %d newest + %d within age; %d error(s)",
            summary["dir"], summary["scanned"], len(summary["deleted"]),
            len(summary["kept_recent"]), summary["kept_fresh"], len(summary["errors"]),
        )
        if summary["deleted"]:
            logger.info("housekeeping: deleted %s", ", ".join(summary["deleted"]))
        for err in summary["errors"]:
            logger.warning("housekeeping: could not delete %s — %s", err["file"], err["error"])
    return summary


async def housekeeping_loop(cfg: dict) -> None:
    """Background task: run the purge once at startup, then every ``interval_hours``. Cancelled on
    shutdown by the FastAPI lifespan. The blocking file work runs in a thread so the event loop is free."""
    interval = max(1, int(cfg.get("interval_hours", 24))) * 3600
    logger.info("housekeeping: scheduler started (dir=%s, max_age_days=%s, keep_min=%s, every %sh)",
                cfg.get("log_dir"), cfg.get("max_age_days"), cfg.get("keep_min"), cfg.get("interval_hours"))
    while True:
        try:
            await asyncio.to_thread(run_housekeeping, cfg)
        except Exception:  # noqa: BLE001 — never let a bad run kill the loop
            logger.exception("housekeeping: run failed")
        await asyncio.sleep(interval)
