"""Filesystem browsing utilities — the sandbox ("jail") plus directory/file reads.

SECURITY: every path a client sends is resolved with symlinks and ``..`` collapsed
(``os.path.realpath``) and must land INSIDE one of the server's configured base
paths. Anything else — a parent directory, another drive, a symlink pointing out,
an explicit ``..`` — is rejected. The client can never browse above its base.

This module is pure (no FastAPI imports) so it is trivially unit-testable.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Cap how much of a file we read for content/preview and line-count so a huge or
# rogue file can never exhaust memory.
MAX_READ_BYTES = 5_000_000

# Extension → human-readable label, mirroring the labels the Angular mock used so
# the Properties dialog looks identical against the real backend.
_TYPE_LABELS = {
    "log": "Log File",
    "txt": "Text Document",
    "json": "JSON Source File",
    "xml": "XML Document",
    "yml": "YAML Config File",
    "yaml": "YAML Config File",
    "html": "HTML Document",
    "htm": "HTML Document",
    "csv": "Comma Separated Values",
    "tsv": "Tab Separated Values",
    "xlsx": "Excel Worksheet",
    "xls": "Excel Worksheet",
    "zip": "Compressed Archive",
    "gz": "Compressed Archive",
    "tar": "Compressed Archive",
    "7z": "Compressed Archive",
    "rar": "Compressed Archive",
    "bat": "Windows Batch File",
    "cmd": "Windows Command Script",
    "sh": "Shell Script",
    "ps1": "PowerShell Script",
    "sql": "SQL Script",
    "md": "Markdown Document",
    "pdf": "PDF Document",
    "conf": "Config File",
    "ini": "Config File",
    "properties": "Config File",
}


def to_posix(path) -> str:
    """Forward-slash form, trailing slash stripped — matches how the UI stores paths."""
    s = str(path).replace("\\", "/")
    while len(s) > 1 and s.endswith("/"):
        s = s[:-1]
    return s


def _normcase(p: str) -> str:
    """Case- and separator-normalised path for safe prefix comparison."""
    return os.path.normcase(os.path.normpath(p))


def resolve_within_bases(bases: list[str], requested: str) -> Optional[Path]:
    """Resolve ``requested`` and return it ONLY if it sits inside one of ``bases``.

    Returns ``None`` when the path escapes the jail (parent dir, other drive,
    symlink pointing out, or an explicit ``..`` segment).
    """
    if not requested:
        return None

    # Reject explicit traversal tokens up front (defence-in-depth; realpath also
    # collapses them, but this makes intent-to-escape an outright refusal).
    if ".." in requested.replace("\\", "/").split("/"):
        return None

    try:
        target_real = os.path.realpath(requested)
    except OSError:
        return None
    target_n = _normcase(target_real)

    for base in bases:
        base_real = os.path.realpath(base)
        base_n = _normcase(base_real)
        if target_n == base_n or target_n.startswith(base_n + os.sep):
            return Path(target_real)
    return None


def list_dir(resolved: Path, requested: str) -> list[dict]:
    """Immediate children of ``resolved`` (one level only — lazy browsing).

    Entry ``path`` values are built from the client's ``requested`` path so they
    round-trip exactly with the UI's tree (which uses them for the next expand).
    Folders first, then files, alphabetical.
    """
    base = to_posix(requested)
    entries: list[dict] = []
    for child in _safe_iterdir(resolved):
        try:
            is_dir = child.is_dir()
        except OSError:
            continue  # unreadable entry (permissions / broken link) → skip
        entries.append(
            {
                "name": child.name,
                "type": "folder" if is_dir else "file",
                "path": f"{base}/{child.name}",
            }
        )
    entries.sort(key=lambda e: (e["type"] != "folder", e["name"].lower()))
    return entries


def read_file_text(resolved: Path) -> str:
    """File content as text (capped). Binary files return a placeholder."""
    data, truncated = _read_capped(resolved)
    if _looks_binary(data):
        return f"(binary file — preview not available: {resolved.name})"
    text = data.decode("utf-8", errors="replace")
    if truncated:
        text += f"\n\n… [truncated at {MAX_READ_BYTES:,} bytes]"
    return text


def file_properties(resolved: Path) -> dict:
    """Metadata for the Properties dialog (name/type/size/timestamps/lines)."""
    st = resolved.stat()
    ext = resolved.suffix.lower().lstrip(".")

    lines = 0
    if resolved.is_file():
        data, _ = _read_capped(resolved)
        if not _looks_binary(data):
            lines = data.count(b"\n") + (1 if data and not data.endswith(b"\n") else 0)

    return {
        "name": resolved.name,
        "type": _TYPE_LABELS.get(ext, (ext.upper() + " File") if ext else "File"),
        "location": to_posix(resolved.parent),
        "size": st.st_size,
        "created": _iso(st.st_ctime),
        "modified": _iso(st.st_mtime),
        "accessed": _iso(st.st_atime),
        "lines": lines,
        "attributes": "Read & Write" if os.access(resolved, os.W_OK) else "Read-only",
    }


# --- internals ---------------------------------------------------------------


def _safe_iterdir(path: Path) -> list[Path]:
    try:
        return list(path.iterdir())
    except (PermissionError, OSError):
        return []


def _read_capped(resolved: Path) -> tuple[bytes, bool]:
    """Read at most MAX_READ_BYTES; second value is True if the file was larger."""
    with resolved.open("rb") as fh:
        data = fh.read(MAX_READ_BYTES + 1)
    truncated = len(data) > MAX_READ_BYTES
    return data[:MAX_READ_BYTES], truncated


def _looks_binary(data: bytes) -> bool:
    return b"\x00" in data[:4096]


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
