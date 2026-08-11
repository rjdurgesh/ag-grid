"""Service Console API — start / stop / status of the services configured on each server.

Shares the SAME config catalogue as Infrastructure Health (`retrieve_server_health_details`
in ``infrastructure_health_api.py``): the browser fetches that once, filters to SERVER rows
that have services (and ``IS_ACTIVE == 'Y'``), and calls this proxy per server. There is ONE
browser-facing route::

    POST /api/service_console/service-manage
        body { host_name, agent_listen_port, host_platform, action?, service?, services? }

The backend forms the dynamic agent URL ``http://{host}.xmp.net.intra:{port}/service-manage``
and calls it — so the agent URL never reaches the browser's network tab. The single endpoint
handles both shapes the agent supports, chosen by whether ``action`` is present:

  * STATUS (no ``action``)            body { services: [names] }   → { HOST_NAME, <name>: { service, status }, ... }
  * ACTION (start / stop / status)    body { service, action }     → { action, message, service, success }

Always returns HTTP 200 with a ``reachable`` flag; a dead/slow agent becomes
``reachable: false`` so one bad server renders as a single "Unreachable" server, never a
whole-panel error.
"""

from __future__ import annotations

import random

from fastapi import APIRouter
from pydantic import BaseModel

from utils.logging import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/service_console", tags=["service_console"])


class ServiceManageRequest(BaseModel):
    host_name: str
    agent_listen_port: int
    host_platform: str | None = None
    # ACTION mode:
    service: str | None = None          # script path (Linux) or service name (Windows)
    action: str | None = None           # start | stop | status
    # STATUS mode:
    services: list[str] | None = None   # service names to report status for


@router.post("/service-manage")
def service_manage(req: ServiceManageRequest) -> dict:
    """One endpoint, two payloads: an ACTION (start/stop/status on one service) or a bulk
    STATUS check for a list of services. Both proxy to the server's agent."""
    return call_service_agent(req)


def call_service_agent(req: ServiceManageRequest) -> dict:
    """Talk to a server's agent ``/service-manage``. Dummy today; flip the ONE marked line
    to ``_service_agent_over_http`` to go live (that function is written out, commented, just
    below). Never raises to the caller — a dead agent returns ``{ reachable: false }`` so one
    bad server renders as a single "Unreachable" server, not a whole-panel error.
    """
    try:
        # ─── DUMMY ↔ REAL SWITCH — change these two lines to go live ─────────────
        # DUMMY (synthetic data, no agent needed) — ACTIVE:
        return _synthetic_service_agent(req)
        # PRODUCTION (call the real agent) — comment the line above, then uncomment the
        # next line AND the `_service_agent_over_http` function further down:
        # return _service_agent_over_http(req)
        # ────────────────────────────────────────────────────────────────────────
    except Exception as exc:  # final safety net (also covers the real HTTP path)
        logger.warning("service agent unreachable %s:%s — %s", req.host_name, req.agent_listen_port, exc)
        return {"HOST_NAME": req.host_name, "reachable": False, "error": str(exc)}


def _synthetic_service_agent(req: ServiceManageRequest) -> dict:
    """Stand-in agent reading. See ``_service_agent_over_http`` (commented, below) for the
    real call this replaces."""
    if req.action:
        # ACTION acknowledgement. The real agent actually runs the start/stop; the UI then
        # re-fetches status to show the settled state.
        verb = {"start": "Starting", "stop": "Stopping", "status": "Checking"}.get(req.action, req.action.title())
        return {
            "action": req.action,
            "service": req.service,
            "message": f"{verb} {req.service}...",
            "success": True,
            "reachable": True,
        }

    # STATUS — deterministic per (host, service) so values are stable across polls.
    out: dict = {"HOST_NAME": req.host_name, "reachable": True}
    for name in req.services or []:
        rnd = random.Random(f"{req.host_name}:{name}")
        out[name] = {"service": name, "status": "Running" if rnd.random() > 0.35 else "Stopped"}
    return out


# ─── PRODUCTION agent call — uncomment this whole function to talk to real agents ───
# Requires httpx:  pip install httpx   (and add `httpx` to backend/requirements.txt)
#
# def _service_agent_over_http(req: ServiceManageRequest) -> dict:
#     """Call the on-server agent's /service-manage. The dynamic URL is built HERE
#     (server-side) from host_name + agent_listen_port, so it never reaches the browser.
#     ACTION → { service, action }; STATUS → { services: [...] }. Same response shapes the
#     dummy returns; we just stamp reachable=True."""
#     import httpx
#     url = f"http://{req.host_name}.xmp.net.intra:{req.agent_listen_port}/service-manage"
#     service_config = (
#         {"service": req.service, "action": req.action}
#         if req.action
#         else {"services": req.services or []}
#     )
#     try:
#         resp = httpx.post(url, json=service_config, timeout=8.0)
#         resp.raise_for_status()
#         data = resp.json()
#         data["reachable"] = True
#         return data
#     except Exception as exc:
#         logger.warning("service agent unreachable at %s — %s", url, exc)
#         return {"HOST_NAME": req.host_name, "reachable": False, "error": str(exc)}
# ───────────────────────────────────────────────────────────────────────────────────
