"""System metrics API — real memory usage of the machine this backend runs on.

The browser can't read the host's RAM, so this is done server-side. Two shapes:

  GET /api/system/memory          one-shot snapshot → MemoryStats
  GET /api/system/memory/stream   Server-Sent Events — one long-lived connection
                                  that pushes a snapshot every few seconds. The UI
                                  header consumes this so the network tab shows a
                                  SINGLE entry instead of a poll every N seconds.

`read_memory()` uses `psutil` when installed, else a stdlib fallback (Windows
`GlobalMemoryStatusEx` via ctypes, Linux `/proc/meminfo`) — so it works with no
extra dependency to install.
"""

from __future__ import annotations

import asyncio
import json
import os

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from utils.logging import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/system", tags=["system"])


@router.get("/version")
def version(request: Request) -> dict:
    """Backend version for the UI footer. Source: APP_VERSION in backend/.env (see app.py)."""
    return {"version": getattr(request.app.state, "app_version", "")}


@router.get("/database")
def database(request: Request) -> dict:
    """Names of the databases this backend is configured for — the UI footer joins them with ' | '.
    Source: the keys of ``app.state.db_configs`` (the single source of truth; see app.py). Returns
    `{ databases: string[] }`."""
    cfgs = getattr(request.app.state, "db_configs", {}) or {}
    return {"databases": list(cfgs.keys())}

# How often the SSE stream pushes a fresh snapshot (seconds).
STREAM_INTERVAL_SECONDS = 2

_GB = 1024 ** 3


def _mem_bytes() -> tuple[int, int]:
    """(total, available) physical memory in bytes, via the first method available."""
    # 1) psutil if it's installed — most accurate, cross-platform.
    try:
        import psutil  # type: ignore

        vm = psutil.virtual_memory()
        return int(vm.total), int(vm.available)
    except Exception:
        pass

    # 2) Windows — GlobalMemoryStatusEx (no dependency).
    if os.name == "nt":
        import ctypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        stat = MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
        return int(stat.ullTotalPhys), int(stat.ullAvailPhys)

    # 3) Linux — /proc/meminfo (values are in kB).
    try:
        info: dict[str, int] = {}
        with open("/proc/meminfo", encoding="ascii") as fh:
            for line in fh:
                key, _, rest = line.partition(":")
                info[key.strip()] = int(rest.strip().split()[0]) * 1024
        total = info.get("MemTotal", 0)
        available = info.get("MemAvailable", info.get("MemFree", 0))
        return total, available
    except OSError:
        return 0, 0


def read_memory() -> dict:
    """Real host memory, shaped exactly like the UI's ``MemoryStats``
    (``{ free, used, total, unit, percent }`` in GB)."""
    total, available = _mem_bytes()
    used = max(total - available, 0)
    percent = round(used / total * 100) if total else 0
    return {
        "free": round(available / _GB, 1),
        "used": round(used / _GB, 1),
        "total": round(total / _GB, 1),
        "unit": "GB",
        "percent": percent,
    }


@router.get("/memory")
def memory() -> dict:
    """One-shot memory snapshot."""
    return read_memory()


@router.get("/memory/stream")
async def memory_stream(request: Request) -> StreamingResponse:
    """Server-Sent Events: push a memory snapshot every ``STREAM_INTERVAL_SECONDS``
    over ONE persistent connection. Stops cleanly when the client disconnects."""

    async def event_gen():
        logger.info("memory stream: client connected")
        try:
            while True:
                if await request.is_disconnected():
                    break
                yield f"data: {json.dumps(read_memory())}\n\n"
                await asyncio.sleep(STREAM_INTERVAL_SECONDS)
        finally:
            logger.info("memory stream: client disconnected")

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # Disable proxy buffering so events flush immediately (e.g. nginx).
            "X-Accel-Buffering": "no",
        },
    )
