"""Filesystem browsing utilities — the sandbox ("jail") plus directory/file reads.

SECURITY: every path a client sends is resolved with symlinks and ``..`` collapsed
(``os.path.realpath``) and must land INSIDE one of the server's configured base
paths. Anything else — a parent directory, another drive, a symlink pointing out,
an explicit ``..`` — is rejected. The client can never browse above its base.

This module is pure (no FastAPI imports) so it is trivially unit-testable.
"""

from __future__ import annotations

import os
import re
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
    # A bare drive letter ("D:") is drive-RELATIVE on Windows (the current dir on
    # D:), not the root — keep the slash so it unambiguously means the root ("D:/").
    if re.fullmatch(r"[A-Za-z]:", s):
        s += "/"
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

    # A bare drive letter ("D:") is drive-RELATIVE on Windows — realpath("D:")
    # returns the current dir on D:, not the root. Coerce it to the root ("D:/")
    # so a client that sent "D:" (e.g. after trailing-slash normalisation) still
    # resolves to the drive root.
    req = requested.replace("\\", "/")
    if re.fullmatch(r"[A-Za-z]:", req):
        req = req + "/"

    try:
        target_real = os.path.realpath(req)
    except OSError:
        return None
    target_n = _normcase(target_real)

    for base in bases:
        base_real = os.path.realpath(base)
        base_n = _normcase(base_real)
        # A drive root (e.g. "D:\\") already ends with the separator; other paths
        # don't. Normalise to exactly one trailing separator for the prefix test
        # so "D:\\" correctly contains "D:\\ALGO".
        base_prefix = base_n if base_n.endswith(os.sep) else base_n + os.sep
        if target_n == base_n or target_n.startswith(base_prefix):
            return Path(target_real)
    return None


def list_dir(resolved: Path, requested: str, limit: int = 0) -> dict:
    """Immediate children of ``resolved`` (one level only — lazy browsing).

    Entry ``path`` values are built from the client's ``requested`` path so they
    round-trip exactly with the UI's tree (which uses them for the next expand).
    Folders first, then files, alphabetical.

    When ``limit`` > 0 and the folder holds more than ``limit`` entries, only the
    first ``limit`` are returned and ``truncated`` is set — a per-folder cap that
    keeps a directory of thousands of files from hanging the UI. ``total`` is the
    real (uncapped) child count.
    """
    base = to_posix(requested)
    entries: list[dict] = []
    # os.scandir is used (not Path.iterdir + child.is_dir) so the folder/file type
    # comes from the directory entry itself — no separate stat() per child. That
    # keeps a folder with thousands of entries fast instead of hanging the UI.
    try:
        with os.scandir(resolved) as it:
            for de in it:
                try:
                    is_dir = de.is_dir()
                except OSError:
                    continue  # unreadable entry (permissions / broken link) → skip
                entries.append(
                    {
                        "name": de.name,
                        "type": "folder" if is_dir else "file",
                        "path": f"{base}/{de.name}",
                    }
                )
    except (PermissionError, OSError):
        entries = []

    entries.sort(key=lambda e: (e["type"] != "folder", e["name"].lower()))

    total = len(entries)
    truncated = limit > 0 and total > limit
    if truncated:
        entries = entries[:limit]
    return {"entries": entries, "total": total, "truncated": truncated}


# --- file preview reads --------------------------------------------------------

# Per-page window for the windowed (large-file) reader, and a hard ceiling so one
# window can never return an unbounded amount over the wire.
DEFAULT_WINDOW_BYTES = 1_000_000       # ~1 MB per page
MAX_WINDOW_BYTES = 8 * 1024 * 1024     # ceiling per window (headroom for the 5 MB option)


def read_file_all(resolved: Path, max_bytes: int) -> str:
    """Whole-file text — the small-file path (size <= threshold). Reads up to
    `max_bytes`; appends a truncation note if the file is larger. Binary → placeholder."""
    with resolved.open("rb") as fh:
        data = fh.read(max_bytes + 1)
    truncated = len(data) > max_bytes
    data = data[:max_bytes]
    if _looks_binary(data):
        return f"(binary file — preview not available: {resolved.name})"
    text = data.decode("utf-8", errors="replace")
    if truncated:
        text += f"\n\n… [truncated at {max_bytes:,} bytes]"
    return text


def read_file_window(
    resolved: Path,
    offset: int = 0,
    length: int = DEFAULT_WINDOW_BYTES,
    from_end: bool = False,
) -> dict:
    """Read a bounded, line-aligned byte window of a (possibly huge) file WITHOUT
    loading the whole thing — the large-file preview path.

    - ``from_end=True`` → the LAST ``length`` bytes (newest-first "tail").
    - otherwise         → ``length`` bytes starting at ``offset``.

    A partial first line (unless at the very start) and a partial last line (unless
    at EOF) are trimmed, so paging never splits a line across windows. Returns what
    the UI needs to page: ``{ content, start, end, total_size, bof, eof }`` where
    ``start``/``end`` are byte offsets into the file.
    """
    size = resolved.stat().st_size
    length = max(1, min(int(length or DEFAULT_WINDOW_BYTES), MAX_WINDOW_BYTES))
    if size == 0:
        return {"content": "", "start": 0, "end": 0, "total_size": 0, "bof": True, "eof": True}

    with resolved.open("rb") as fh:
        if from_end:
            start = max(0, size - length)
            fh.seek(start)
            data = fh.read()            # to EOF (<= length bytes)
        else:
            start = max(0, min(int(offset or 0), size))
            fh.seek(start)
            data = fh.read(length)
    end = start + len(data)

    if _looks_binary(data):
        return {
            "content": f"(binary file — preview not available: {resolved.name})",
            "start": start, "end": end, "total_size": size,
            "bof": start == 0, "eof": end >= size,
        }

    # Keep whole lines at the window edges.
    if start > 0:
        nl = data.find(b"\n")
        if nl != -1:
            start += nl + 1
            data = data[nl + 1:]
    if end < size:
        nl = data.rfind(b"\n")
        if nl != -1:
            data = data[: nl + 1]
            end = start + len(data)

    return {
        "content": data.decode("utf-8", errors="replace"),
        "start": start,
        "end": end,
        "total_size": size,
        "bof": start == 0,
        "eof": end >= size,
    }


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
