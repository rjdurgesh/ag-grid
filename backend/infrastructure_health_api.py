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

import shutil
from typing import Any

from env_loader import env_bool  # importing also loads backend/.env into os.environ

from fastapi import APIRouter, Request
from pydantic import BaseModel

from utils.logging import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/infra_health", tags=["infra_health"])

# Per-screen backend DUMMY switch (the backend analog of the UI's apiMocks) — set in .env.
# 1/true = canned dummy data (config catalogue + synthetic agent); 0/false = real DB proc +
# real agent HTTP call. Lets you develop this screen against real infra without touching the
# others (and vice-versa).
INFRA_HEALTH_USE_DUMMY = env_bool("INFRA_HEALTH_USE_DUMMY", True)


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
    """Server/share monitoring catalogue for the health screen — the DB boundary. Dummy mode
    returns canned rows (``infrastructure_health_dummy.config_dummy``); real mode runs the
    stored proc. Same ``{ status, data:[ rows ] }`` shape either way, so nothing downstream
    changes."""
    if INFRA_HEALTH_USE_DUMMY:
        return config_dummy(app_env)
    return retrieve_server_health_details_real(group_db_config, app_env)


def retrieve_server_health_details_real(group_db_config: Any, app_env: str | None) -> dict:
    """Real catalogue: open ``group_db_config`` and call the stored proc filtered by
    ``app_env``; it must return the same ``{ status, data:[ rows ] }`` shape. Wire this to your
    DB (mirrors ``log_analytics.dependencies.fetch_log_path``)."""
    raise RuntimeError("retrieve_server_health_details_real: wire the stored proc via group_db_config")


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
        if INFRA_HEALTH_USE_DUMMY:
            return synthetic_agent(host_name, agent_listen_port, host_platform, monitoring_config)
        return _agent_over_http(host_name, agent_listen_port, monitoring_config)
    except Exception as exc:  # final safety net (covers a dead agent AND httpx not installed)
        logger.warning("agent unreachable %s:%s — %s", host_name, agent_listen_port, exc)
        return {"HOST_NAME": host_name, "reachable": False, "error": str(exc)}


def _agent_over_http(host_name: str, agent_listen_port: int, monitoring_config: dict | None) -> dict:
    """Real agent call (used when INFRA_HEALTH_USE_DUMMY is off). The dynamic URL is built HERE
    (server-side) from host_name + agent_listen_port, so it NEVER reaches the browser. Returns
    the same shape ``synthetic_agent`` produces, stamped ``reachable=True``. Requires httpx
    (``pip install httpx``) — imported lazily so dummy mode needs no extra dependency; a
    missing httpx / slow / dead agent is caught by ``call_agent`` and rendered as unreachable."""
    import httpx  # lazy: only needed in real mode
    url = f"http://{host_name}.xmp.net.intra:{agent_listen_port}/system-metrics"
    resp = httpx.post(url, json=monitoring_config, timeout=8.0)
    resp.raise_for_status()
    data = resp.json()
    data["reachable"] = True
    return data


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


# ---------------------------------------------------------------------------
# Dummy-mode data lives in infrastructure_health_dummy (canned catalogue + synthetic agent).
# It imports the shared byte/GB helpers from THIS module, so this import sits at the bottom —
# after those helpers are defined — to keep the cycle safe. Used when INFRA_HEALTH_USE_DUMMY on.
from infrastructure_health_dummy import config_dummy, synthetic_agent  # noqa: E402
