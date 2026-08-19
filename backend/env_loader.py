"""Minimal ``.env`` loader — zero external dependencies.

Reads ``backend/.env`` (next to this file) at import time and injects any keys that
aren't already set in the real environment, so an actual OS/env var always wins (same
precedence as python-dotenv). Lines that are blank, comments (``#``), or have no ``=``
are skipped; surrounding single/double quotes on a value are stripped.

Import it once, early, before anything reads its env vars::

    import env_loader  # noqa: F401  (loads .env)
    FOO = os.getenv("FOO", "default")
"""

from __future__ import annotations

import os
from pathlib import Path


def load_env(path: str | os.PathLike | None = None) -> None:
    p = Path(path) if path else Path(__file__).with_name(".env")
    if not p.is_file():
        return
    for raw in p.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key = key.strip()
        val = val.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = val


def env_bool(name: str, default: bool = True) -> bool:
    """Read a boolean env var. Truthy unless explicitly 0/false/no/off/empty."""
    v = os.getenv(name)
    if v is None:
        return default
    return v.strip().lower() not in ("0", "false", "no", "off", "")


def env_int(name: str, default: int) -> int:
    """Read an int env var, falling back to ``default`` on unset/invalid."""
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


# Load on import so a bare ``import env_loader`` is enough.
load_env()
