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
from typing import Optional

from utils.fs_browser import to_posix


class Settings:
    """Backend settings, overridable via environment variables."""

    def __init__(self) -> None:
        # The jail ROOT — browsing can never escape above this. Default: D: drive.
        self.log_root: str = os.getenv("OLS_LOG_ROOT", "D:/")
        # Optional JSON catalogue file for the /servers response.
        self.servers_file: Optional[str] = os.getenv("OLS_SERVERS_FILE")


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
