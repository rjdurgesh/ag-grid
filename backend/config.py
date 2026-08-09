"""Runtime configuration — the few operational knobs, from env vars with defaults.

Nothing about servers or paths lives here. The server catalogue and each server's
base log paths come straight from the DB (see `log_analytics.dependencies.
fetch_log_path`); browsing is jailed to those paths. This file holds only tunables
that are *operational*, not data.

Env vars:
  OLS_DIR_LIMIT              Max entries `/dir` returns per folder (anti-hang cap on
                            huge directories). Default 500. Set 0 for unlimited.
  OLS_FILE_WINDOW_THRESHOLD Byte size at/under which `/file` returns the WHOLE file
                            (small-file path, client paginates by line); above it the
                            file is served in line-aligned byte WINDOWS the UI pages
                            through. Default 400 MB. Lower it (e.g. 26214400 = 25 MB)
                            if whole-loading near the threshold feels heavy — windowed
                            mode is safe at any size.
"""

from __future__ import annotations

import os


def _int_env(name: str, default: int) -> int:
    """Read an int env var, falling back to `default` on unset/invalid."""
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


class Settings:
    """Backend tunables, overridable via environment variables."""

    def __init__(self) -> None:
        # Max entries returned per folder by /dir (anti-hang cap). 0 = unlimited.
        self.dir_limit: int = _int_env("OLS_DIR_LIMIT", 500)
        # /file serves the whole file at/under this size; larger files are windowed.
        self.file_window_threshold: int = _int_env("OLS_FILE_WINDOW_THRESHOLD", 400 * 1024 * 1024)


settings = Settings()
