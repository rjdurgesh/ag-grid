"""Infrastructure Health API — config (DB) + per-server agent fan-out + share utility.

Every browser-facing route is a **POST under `/api/infra_health`**, so the browser only
ever sees these clean URLs. The per-server agent URLs
(`http://{host}.xmp.net.intra:{port}/system-metrics`) are built and called **here,
server-side**, so they never appear in the browser's network tab.

  POST /api/infra_health          body { app_env, username }              → { status, data:[config rows] }
  POST /api/infra_health/metrics  body { host_name, agent_listen_port,
                                          host_platform, monitoring_config } → agent metrics (cpu/ram/disk)
  POST /api/infra_health/share    body { host_address, app_name }         → { used, total, unit }

`retrieve_server_health_details` is the DB-connection boundary (same pattern as
`log_analytics.dependencies.fetch_log_path`): it returns the config inline today; swap
its body for the real query. `call_agent` / `read_share_space` are stand-ins too — swap
for a real HTTP call to the agent and a real disk-usage read.
"""

from __future__ import annotations

import random
import shutil
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from utils.logging import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/infra_health", tags=["infra_health"])


# --- request bodies ----------------------------------------------------------

class ConfigRequest(BaseModel):
    app_env: str | None = None
    username: str | None = None   # reserved for future use (auditing); not used yet


class MetricsRequest(BaseModel):
    host_name: str
    agent_listen_port: int
    host_platform: str | None = None
    monitoring_config: dict | None = None


class ShareRequest(BaseModel):
    host_address: str
    app_name: str | None = None


# --- config: the DB-connection boundary (stand-in) ---------------------------

def retrieve_server_health_details(group_db_config: Any, app_env: str | None) -> dict:
    """Server/share monitoring catalogue for the health screen — the DB boundary.

    Stand-in: returns the data inline. In production, open ``group_db_config`` and call
    the stored proc filtered by ``app_env`` — it must return this same shape
    (``{ status, data:[ rows ] }``) and nothing downstream changes.
    """
    return {
        "status": "success",
        "data": [
            {
                "APP_ENV": "DEV", "RESOURCE_CATEGORY": "SERVER", "HOST_PLATFORM": "WINDOWS",
                "HOST_NAME": "eurv12", "HOST_ADDRESS": "eurv12.xmp.net.intra", "AGENT_LISTEN_PORT": 7002,
                "APP_NAME": "OLS_GROUP",
                "MONITORING_CONFIG": {"infra": ["ram", "cpu"], "disk": ["c", "d"],
                                       "services": [{"OLSFILELoader": None, "OLSUI-API-3": None}]},
                "IS_ACTIVE": "Y", "COMMENTS": "This is an OLS Dev 1 Server.",
                "LAST_UPDATED_BY": "OPS-10432", "LAST_UPDATED_ON": "2026-02-10 14:59:16",
            },
            {
                "APP_ENV": "DEV", "RESOURCE_CATEGORY": "SERVER", "HOST_PLATFORM": "WINDOWS",
                "HOST_NAME": "eurv13", "HOST_ADDRESS": "eurv13.xmp.net.intra", "AGENT_LISTEN_PORT": 7002,
                "APP_NAME": "OLS_CIB",
                "MONITORING_CONFIG": {"infra": ["ram", "cpu"], "disk": ["c", "d"], "services": []},
                "IS_ACTIVE": "Y", "COMMENTS": "This is an OLS CIB Dev 1 Server.",
                "LAST_UPDATED_BY": "OPS-10435", "LAST_UPDATED_ON": "2026-02-12 14:59:16",
            },
            {
                "APP_ENV": "DEV", "RESOURCE_CATEGORY": "SERVER", "HOST_PLATFORM": "LINUX",
                "HOST_NAME": "eurv22", "HOST_ADDRESS": "eurv22.xmp.net.intra", "AGENT_LISTEN_PORT": 7002,
                "APP_NAME": "OLS_GROUP",
                "MONITORING_CONFIG": {"infra": ["ram", "cpu"], "disk": ["apps", "data", "tmp"],
                                       "services": [{"apache": "/data/apache/scripts/apache.sh"}]},
                "IS_ACTIVE": "Y", "COMMENTS": "This is an OLS Linux Dev Server.",
                "LAST_UPDATED_BY": "OPS-10435", "LAST_UPDATED_ON": "2026-02-12 14:59:16",
            },
            {
                "APP_ENV": "DEV", "RESOURCE_CATEGORY": "SHARE_DRIVE", "HOST_PLATFORM": "SHARE_DRIVE",
                "HOST_NAME": "olsdev", "HOST_ADDRESS": "\\\\nas.dev.intra\\olsdev", "AGENT_LISTEN_PORT": 999999,
                "APP_NAME": "OLS_GROUP", "MONITORING_CONFIG": None,
                "IS_ACTIVE": "Y", "COMMENTS": "This is an OLS Share drive.",
                "LAST_UPDATED_BY": "OPS-10435", "LAST_UPDATED_ON": "2026-02-12 14:59:16",
            },
        ],
    }


# --- agent metrics (stand-in for the on-server agent) ------------------------

_GB = 1024 ** 3   # bytes in one gigabyte (1024³ = 1,073,741,824) — for byte↔GB conversions


def _gb_str(gb: float) -> str:
    return f"{gb:.2f} GB"


def call_agent(host_name: str, agent_listen_port: int, host_platform: str | None,
               monitoring_config: dict | None) -> dict:
    """Collect live metrics from one server's agent.

    Today this returns **synthetic** data (no agent runs on this dev box). To go live,
    flip the ONE marked line in the body from ``_synthetic_agent(...)`` to
    ``_agent_over_http(...)`` — the production function is written out (commented) right
    below. Nothing else in the app changes: same fields, same ``reachable`` flag.

    Whichever path runs, this always returns HTTP 200 with a ``reachable`` flag and never
    raises to the caller — so one dead/slow agent renders as a single red "unreachable"
    card, not a whole-panel error. The per-server agent URL is built server-side (inside
    ``_agent_over_http``), so it never reaches the browser's network tab.
    """
    try:
        # ─── DUMMY ↔ REAL SWITCH — change these two lines to go live ─────────────
        # DUMMY (synthetic data, no agent needed) — ACTIVE:
        return _synthetic_agent(host_name, agent_listen_port, host_platform, monitoring_config)
        # PRODUCTION (call the real on-server agent) — comment the line above, then
        # uncomment the next line AND the `_agent_over_http` function further down:
        # return _agent_over_http(host_name, agent_listen_port, monitoring_config)
        # ────────────────────────────────────────────────────────────────────────
    except Exception as exc:  # final safety net (also covers the real HTTP path)
        logger.warning("agent unreachable %s:%s — %s", host_name, agent_listen_port, exc)
        return {"HOST_NAME": host_name, "reachable": False, "error": str(exc)}


# ─── PRODUCTION agent call — uncomment this whole function to talk to real agents ───
# Requires httpx:  pip install httpx   (and add `httpx` to backend/requirements.txt)
#
# def _agent_over_http(host_name: str, agent_listen_port: int,
#                      monitoring_config: dict | None) -> dict:
#     """Call the on-server agent's /system-metrics endpoint and return its reading.
#
#     The dynamic URL is built HERE (server-side) from the config row's host_name +
#     agent_listen_port — so it NEVER reaches the browser. The agent is expected to
#     return the same shape `_synthetic_agent` produces (os, cpu_percent, load_avg,
#     ram{bytes,percent}, disk_storage{drive → {used, free, total, percent}}); we just
#     stamp `reachable=True`. A slow/dead agent fails fast on the timeout and comes back
#     as `reachable=False` instead of stalling the screen.
#     """
#     import httpx
#     url = f"http://{host_name}.xmp.net.intra:{agent_listen_port}/system-metrics"
#     try:
#         resp = httpx.post(url, json=monitoring_config, timeout=8.0)
#         resp.raise_for_status()
#         data = resp.json()
#         data["reachable"] = True
#         return data
#     except Exception as exc:
#         logger.warning("agent unreachable at %s — %s", url, exc)
#         return {"HOST_NAME": host_name, "reachable": False, "error": str(exc)}
# ───────────────────────────────────────────────────────────────────────────────────


def _synthetic_agent(host_name: str, agent_listen_port: int, host_platform: str | None,
                     monitoring_config: dict | None) -> dict:
    """Stand-in agent reading — deterministic synthetic data. See `_agent_over_http`
    (above, commented out) for the real call this replaces."""
    cfg = monitoring_config or {}
    rnd = random.Random(host_name)  # deterministic per host so values are stable
    is_windows = (host_platform or "").upper().startswith("WIN")

    # RAM in bytes (like the real agent): fake 16 GB on Windows, 8 GB on Linux.
    total_ram = (16 if is_windows else 8) * _GB
    ram_percent = round(rnd.uniform(18, 72), 1)
    used_ram = int(total_ram * ram_percent / 100)
    ram = {"total": total_ram, "used": used_ram, "available": total_ram - used_ram,
           "free": total_ram - used_ram, "percent": ram_percent}

    # Disk per configured mount — values as "NN.NN GB" strings, keyed by drive.
    disk_storage: dict[str, dict] = {}
    for name in cfg.get("disk", []) or []:
        drive = f"{name.upper()}:/" if is_windows else (name if str(name).startswith("/") else f"/{name}")
        total_gb = round(rnd.uniform(80, 750), 2)
        pct = round(rnd.uniform(5, 92), 1)
        used_gb = round(total_gb * pct / 100, 2)
        disk_storage[drive] = {"drive": drive, "total": _gb_str(total_gb), "used": _gb_str(used_gb),
                                "free": _gb_str(round(total_gb - used_gb, 2)), "percent": pct}

    return {
        "AGENT_LISTEN_PORT": agent_listen_port,
        "HOST_NAME": host_name,
        "reachable": True,
        "os": "Windows" if is_windows else "Linux",
        "cpu_percent": round(rnd.uniform(0, 95), 1),
        "load_avg": [round(rnd.uniform(0, 2), 2) for _ in range(3)],
        "ram": ram,
        "disk_storage": disk_storage,
    }


def read_share_space(host_address: str) -> dict:
    """Free/total space of a share path — no agent (the agent only covers WINDOWS /
    LINUX servers).

    Reads the path DIRECTLY with ``shutil.disk_usage``, which works for a Windows UNC
    path (``\\\\server\\share``) and for a Linux mount point (mount the share and pass
    the mount path as ``host_address``). Returns GB. If the path is unreachable or access
    is denied it returns zeros with ``reachable: False`` (and logs a warning) instead of
    raising, so one bad share never breaks the screen.
    """
    try:
        usage = shutil.disk_usage(host_address)   # (total, used, free) in bytes
        return {
            "used": round(usage.used / _GB, 2),
            "total": round(usage.total / _GB, 2),
            "free": round(usage.free / _GB, 2),
            "unit": "GB",
            "reachable": True,
        }
    except OSError as exc:
        logger.warning("share space unavailable for %s: %s", host_address, exc)
        return {"used": 0.0, "total": 0.0, "free": 0.0, "unit": "GB", "reachable": False}


# --- routes ------------------------------------------------------------------

@router.post("")
def infra_health_config(req: ConfigRequest, request: Request) -> dict:
    """Config catalogue (DB). `app_env` + `username` come in the body (not the URL)."""
    group_db_config = request.app.state.db_configs.get("group")
    logger.info("infra_health config (app_env=%s, user=%s)", req.app_env, req.username)
    return retrieve_server_health_details(group_db_config, req.app_env)


@router.post("/metrics")
def infra_health_metrics(req: MetricsRequest) -> dict:
    """Per-server agent metrics. The dynamic agent URL is built + called server-side."""
    return call_agent(req.host_name, req.agent_listen_port, req.host_platform, req.monitoring_config)


@router.post("/share")
def infra_health_share(req: ShareRequest) -> dict:
    """Per-share free space (computed directly from the path — no agent)."""
    return read_share_space(req.host_address)
