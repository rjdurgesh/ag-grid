"""Runtime configuration — read from environment variables with safe defaults.

Nothing about servers or paths is hardcoded in the request logic; it all comes
from here (or an optional servers file), so the same code runs on any machine.

Env vars:
  OLS_LOG_ROOT      Jail root — the ONE directory browsing is confined to.
                    Default: "D:/". Nothing above it is ever served.
  OLS_SERVERS_FILE  Optional path to a JSON catalogue for GET /servers (the
                    DB-connection stand-in). If unset/missing, a single generic
                    server rooted at OLS_LOG_ROOT is served (zero-config).
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from utils.fs_browser import to_posix


def _int_env(name: str, default: int) -> int:
    """Read an int env var, falling back to `default` on unset/invalid."""
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


class Settings:
    """Backend settings, overridable via environment variables."""

    def __init__(self) -> None:
        # Default directory used ONLY when the catalogue returns no base path for a
        # server. Not a hard jail — each request is confined to its own server's
        # base paths (see dependencies.py). Override with OLS_LOG_ROOT.
        self.log_root: str = os.getenv("OLS_LOG_ROOT", "D:/")
        # JSON catalogue for the /servers response (the DB-connection stand-in).
        # Defaults to servers.json next to this file; override with OLS_SERVERS_FILE.
        self.servers_file: str = os.getenv(
            "OLS_SERVERS_FILE", str(Path(__file__).with_name("servers.json"))
        )
        # Max entries returned per folder by /dir (anti-hang cap). 0 = unlimited.
        # Override with OLS_DIR_LIMIT.
        self.dir_limit: int = _int_env("OLS_DIR_LIMIT", 500)


settings = Settings()


def load_servers() -> dict[str, list[dict]]:
    """The servers catalogue (stand-in for the DB-connection API).

    From `OLS_SERVERS_FILE` when it points at a valid JSON object, otherwise a
    generic single-server default rooted at the jail root — so the app browses the
    local filesystem with no configuration. Swap for a real DB query later without
    touching the endpoints.
    """
    path = settings.servers_file
    if path and os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            if isinstance(data, dict) and data:
                return data
        except (OSError, json.JSONDecodeError):
            pass  # fall through to the generic default

    root = to_posix(settings.log_root)
    return {
        "LOCAL_FS_localhost": [
            {
                "server_name": "localhost",
                "base_log_path": root,
                "server_type": "FS",
                "db_source": "LOCAL",
            }
        ]
    }
