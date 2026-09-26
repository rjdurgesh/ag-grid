"""Infra Pulse tools — servers + their services, from the live Infra layer.

Reuses ``infrastructure_health_api`` (catalogue + agent metrics) and ``service_console_api`` (per-server
service status) IN-PROCESS — the same functions the Infra Pulse / Service Console screens call. No new
endpoint, no duplicated SQL. In dev those layers serve dummy data (``INFRA_HEALTH_USE_DUMMY``); in prod they
hit the real stored proc + agents. Authorization is applied per row/server via ``scope_access``.
"""

from __future__ import annotations

from . import base
from ..auth import scope_access as authz   # top-level so a missing/renamed authz module fails at startup
                                           # (the infrastructure_health_api / service_console_api imports stay
                                           # lazy on purpose — graceful on an infra-service outage)

# Health thresholds (any of RAM% / CPU% / disk% at/above these = that state). Simple + explicit; can move to
# config later. "critical" >= _CRIT, "warning" >= _WARN, else "healthy"; an unreachable agent = "unreachable".
_WARN_PCT = 75.0
_CRIT_PCT = 90.0


def _state_of(ram, cpu, disk_pcts: list) -> str:
    vals = [v for v in [ram, cpu, *(disk_pcts or [])] if isinstance(v, (int, float))]
    if not vals:
        return "unknown"
    worst = max(vals)
    return "critical" if worst >= _CRIT_PCT else "warning" if worst >= _WARN_PCT else "healthy"


def _drive_pct(disk_storage: dict, drive: str):
    """Percent used for a named drive/mount (e.g. 'D' → 'D:/', or '/data'), case-insensitive."""
    if not disk_storage:
        return None
    want = str(drive).strip().lower().strip(":/")
    for k, v in disk_storage.items():
        key = str(k).strip().lower().strip(":/")
        if key == want or key.startswith(want) or (want and want in key):
            return (v or {}).get("percent")
    return None


# --- list_servers ------------------------------------------------------------
def _list_servers(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    """List estate servers from the live Infra catalogue. scope/os filter the catalogue cheaply; RAM/CPU/disk
    thresholds and a health-state filter trigger a per-server metrics fan-out (``call_agent``). Per-row authz —
    a caller never sees a business line they can't access, even for an unscoped 'list all'."""
    scope = str(args.get("scope") or "").strip().lower()
    os_ = str(args.get("os") or "").strip().lower()
    min_ram = base.num(args.get("min_ram_percent"))
    min_cpu = base.num(args.get("min_cpu_percent"))
    min_disk = base.num(args.get("min_disk_percent"))
    drive = str(args.get("drive") or "").strip()
    state_want = str(args.get("state") or "").strip().lower()
    filters = {"scope": scope or None, "os": os_ or None, "min_ram_percent": min_ram,
               "min_cpu_percent": min_cpu, "min_disk_percent": min_disk,
               "drive": drive or None, "state": state_want or None}
    if scope and not authz.scope_allowed(scopes, scope):
        return base.deny(scope, scopes)

    ctx = ctx or {}
    try:  # lazy import keeps the package load cycle-free
        from infrastructure_health_api import call_agent, retrieve_server_health_details
    except Exception as exc:  # noqa: BLE001 — never fake data on an infra outage; say so honestly
        return {"error": f"Infra service is unavailable ({exc})."}

    catalogue = retrieve_server_health_details(ctx.get("group_db_config"), ctx.get("app_env")) or {}
    has_threshold = any(v is not None for v in (min_ram, min_cpu, min_disk))
    want_metrics = has_threshold or bool(state_want)
    out: list[dict] = []
    for r in catalogue.get("data", []) or []:
        if (r.get("RESOURCE_CATEGORY") or "").upper() != "SERVER":
            continue  # skip share drives etc.
        sc = base.scope_of_app_name(r.get("APP_NAME"))
        if not authz.scope_allowed(scopes, sc):       # per-row authz: never leak another line's servers
            continue
        if scope and sc != scope:
            continue
        osname = (r.get("HOST_PLATFORM") or "").lower()
        if os_ and osname != os_:
            continue
        entry = {"name": r.get("HOST_NAME"), "scope": sc, "os": osname, "app": r.get("APP_NAME"),
                 "status": "active" if (r.get("IS_ACTIVE") or "").upper() == "Y" else "inactive"}
        if want_metrics:  # thresholds / state need the live agent reading
            m = call_agent(r.get("HOST_NAME"), r.get("AGENT_LISTEN_PORT"),
                           r.get("HOST_PLATFORM"), r.get("MONITORING_CONFIG"))
            if not m.get("reachable"):
                entry.update(reachable=False, state="unreachable")
                if state_want and state_want != "unreachable":
                    continue
                if has_threshold:
                    continue        # can't evaluate a numeric threshold on an unreachable server
                out.append(entry)
                continue
            ram = (m.get("ram") or {}).get("percent")
            cpu = m.get("cpu_percent")
            disks = m.get("disk_storage") or {}
            disk_pcts = [(v or {}).get("percent") for v in disks.values()]
            entry.update(ram=ram, cpu=cpu, reachable=True, state=_state_of(ram, cpu, disk_pcts),
                         disks={str(k): (v or {}).get("percent") for k, v in disks.items()})
            if min_ram is not None and (ram is None or ram < min_ram):
                continue
            if min_cpu is not None and (cpu is None or cpu < min_cpu):
                continue
            if min_disk is not None:
                if drive:
                    dp = _drive_pct(disks, drive)
                    if dp is None or dp < min_disk:
                        continue
                    entry["drive"] = drive.upper()
                    entry["drive_percent"] = dp
                elif not any(isinstance(p, (int, float)) and p >= min_disk for p in disk_pcts):
                    continue
            if state_want and entry.get("state") != state_want:
                continue
        out.append(entry)
    return {"count": len(out), "servers": out, "filters": filters}


# --- service_status ----------------------------------------------------------
def _service_names(monitoring_config) -> list[str]:
    """Flatten a catalogue row's MONITORING_CONFIG.services (a list of {name: path} dicts) into names."""
    svcs = (monitoring_config or {}).get("services") if isinstance(monitoring_config, dict) else None
    names: list[str] = []
    for item in svcs or []:
        if isinstance(item, dict):
            names.extend(str(k) for k in item.keys())
        elif item:
            names.append(str(item))
    return names


def _service_status(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    """Status of the services configured on ONE server. Finds the server in the Infra catalogue (for its
    agent port + configured service list), authorizes by scope, then asks the Service Console agent."""
    server = str(args.get("server") or "").strip()
    if not server:
        return {"error": "A server name is required."}
    ctx = ctx or {}
    try:  # lazy imports → no package load cycle
        from infrastructure_health_api import retrieve_server_health_details
        from service_console_api import ServiceManageRequest, call_service_agent
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Service Console is unavailable ({exc})."}

    catalogue = retrieve_server_health_details(ctx.get("group_db_config"), ctx.get("app_env")) or {}
    row = next((r for r in catalogue.get("data", []) or []
                if str(r.get("HOST_NAME", "")).lower() == server.lower()
                and (r.get("RESOURCE_CATEGORY") or "").upper() == "SERVER"), None)
    if row is None:
        return {"server": server, "found": False, "message": f"No server named '{server}' is configured."}

    sc = base.scope_of_app_name(row.get("APP_NAME"))
    if not authz.scope_allowed(scopes, sc):
        return base.deny(sc, scopes)

    names = _service_names(row.get("MONITORING_CONFIG"))
    if not names:
        return {"server": server, "found": True, "services": [],
                "message": f"No services are configured for {server}."}

    result = call_service_agent(ServiceManageRequest(
        host_name=row.get("HOST_NAME"), agent_listen_port=row.get("AGENT_LISTEN_PORT"),
        host_platform=row.get("HOST_PLATFORM"), services=names))
    if not result.get("reachable", False):
        return {"server": server, "found": True, "reachable": False,
                "message": result.get("error") or "The server's agent is unreachable."}
    services = [{"service": n, "status": (result.get(n) or {}).get("status", "unknown")} for n in names]
    # Optional filters: one service name, and/or a status (running/stopped/unknown).
    svc_want = str(args.get("service") or "").strip().lower()
    if svc_want:
        services = [s for s in services if svc_want in s["service"].lower()]
    status_want = str(args.get("status") or "").strip().lower()
    if status_want:
        services = [s for s in services if _status_is(s["status"], status_want)]
    return {"server": server, "found": True, "reachable": True, "scope": sc, "services": services,
            "filters": {"service": svc_want or None, "status": status_want or None}}


def _status_is(actual: str, want: str) -> bool:
    a = str(actual or "").strip().lower()
    if want == "unknown":
        return a in ("", "unknown")
    return a == want


def _list_services(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    """Services ACROSS servers (a fan-out), filtered by scope/os and status (running/stopped/unknown). Use for
    'which services are stopped' or 'list unknown services in group'. Per-row authz by scope."""
    scope = str(args.get("scope") or "").strip().lower()
    os_ = str(args.get("os") or "").strip().lower()
    status_want = str(args.get("status") or "").strip().lower()
    if scope and not authz.scope_allowed(scopes, scope):
        return base.deny(scope, scopes)
    ctx = ctx or {}
    try:
        from infrastructure_health_api import retrieve_server_health_details
        from service_console_api import ServiceManageRequest, call_service_agent
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Service Console is unavailable ({exc})."}

    catalogue = retrieve_server_health_details(ctx.get("group_db_config"), ctx.get("app_env")) or {}
    out: list[dict] = []
    for r in catalogue.get("data", []) or []:
        if (r.get("RESOURCE_CATEGORY") or "").upper() != "SERVER":
            continue
        sc = base.scope_of_app_name(r.get("APP_NAME"))
        if not authz.scope_allowed(scopes, sc) or (scope and sc != scope):
            continue
        if os_ and (r.get("HOST_PLATFORM") or "").lower() != os_:
            continue
        names = _service_names(r.get("MONITORING_CONFIG"))
        if not names:
            continue
        result = call_service_agent(ServiceManageRequest(
            host_name=r.get("HOST_NAME"), agent_listen_port=r.get("AGENT_LISTEN_PORT"),
            host_platform=r.get("HOST_PLATFORM"), services=names))
        if not result.get("reachable", False):
            if not status_want or status_want == "unreachable":
                out.append({"server": r.get("HOST_NAME"), "scope": sc, "service": None, "status": "unreachable"})
            continue
        for n in names:
            st = (result.get(n) or {}).get("status", "unknown")
            if status_want and not _status_is(st, status_want):
                continue
            out.append({"server": r.get("HOST_NAME"), "scope": sc, "service": n, "status": st})
    return {"count": len(out), "services": out,
            "filters": {"scope": scope or None, "os": os_ or None, "status": status_want or None}}


def _list_shares(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    """List NAS / share-drive space utilization from the Infra catalogue (RESOURCE_CATEGORY = SHARE_DRIVE).
    Space is read per share (``read_share_space``); ``min_percent`` keeps only shares at/above that used %.
    Per-row authz by scope. In dev (INFRA_HEALTH_USE_DUMMY) space is synthetic so it's demoable."""
    import random

    scope = str(args.get("scope") or "").strip().lower()
    min_pct = base.num(args.get("min_percent"))
    if scope and not authz.scope_allowed(scopes, scope):
        return base.deny(scope, scopes)
    ctx = ctx or {}
    try:
        import infrastructure_health_api as infra
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Infra service is unavailable ({exc})."}

    catalogue = infra.retrieve_server_health_details(ctx.get("group_db_config"), ctx.get("app_env")) or {}
    out: list[dict] = []
    for r in catalogue.get("data", []) or []:
        if (r.get("RESOURCE_CATEGORY") or "").upper() != "SHARE_DRIVE":
            continue
        sc = base.scope_of_app_name(r.get("APP_NAME"))
        if not authz.scope_allowed(scopes, sc) or (scope and sc != scope):
            continue
        if getattr(infra, "INFRA_HEALTH_USE_DUMMY", False):        # synthetic, deterministic per share
            rnd = random.Random(str(r.get("HOST_NAME")))
            total = round(rnd.uniform(500, 2000), 2)
            pct = round(rnd.uniform(20, 95), 1)
            space = {"total": total, "used": round(total * pct / 100, 2),
                     "free": round(total * (100 - pct) / 100, 2), "unit": "GB", "reachable": True}
        else:
            space = infra.read_share_space(r.get("HOST_ADDRESS"))
        total = space.get("total") or 0
        pct = round((space.get("used", 0) / total) * 100, 1) if total else None
        entry = {"name": r.get("HOST_NAME"), "scope": sc, "address": r.get("HOST_ADDRESS"),
                 "used": space.get("used"), "total": space.get("total"), "free": space.get("free"),
                 "unit": space.get("unit", "GB"), "percent": pct, "reachable": space.get("reachable", False)}
        if min_pct is not None and (pct is None or pct < min_pct):
            continue
        out.append(entry)
    return {"count": len(out), "shares": out, "filters": {"scope": scope or None, "min_percent": min_pct}}


SCHEMAS: list[dict] = [
    {"type": "function", "function": {
        "name": "list_shares",
        "description": "List NAS / shared-drive space utilization, optionally by business scope, and optionally "
                       "only those above a used-% threshold. Use for 'NAS drive space for Group' or 'which "
                       "shares are over 80% full'.",
        "parameters": {"type": "object", "properties": {
            "scope": {"type": "string", "enum": ["cib", "retail", "group"],
                      "description": "Business line. Omit for all."},
            "min_percent": {"type": "number",
                            "description": "Only shares whose used percent is at or above this."},
        }},
    }},
    {"type": "function", "function": {
        "name": "list_servers",
        "description": "List servers in the estate, filtered by business scope, OS, live RAM/CPU/disk usage, "
                       "and/or health state. Use for 'list the CIB Windows servers', 'which servers have RAM "
                       "over 70%', 'whose D drive is over 40%', or 'which servers are in a critical state'.",
        "parameters": {"type": "object", "properties": {
            "scope": {"type": "string", "enum": ["cib", "retail", "group"],
                      "description": "Business line. Omit for all."},
            "os":    {"type": "string", "enum": ["windows", "linux"],
                      "description": "Operating system. Omit for all."},
            "min_ram_percent": {"type": "number",
                      "description": "Only servers whose RAM/memory usage percent is at or above this."},
            "min_cpu_percent": {"type": "number",
                      "description": "Only servers whose CPU usage percent is at or above this."},
            "min_disk_percent": {"type": "number",
                      "description": "Only servers where a disk's used percent is at or above this "
                                     "(pair with `drive` for a specific drive, e.g. D over 40%)."},
            "drive": {"type": "string",
                      "description": "A specific drive/mount to apply min_disk_percent to, e.g. 'D', 'C', '/data'."},
            "state": {"type": "string", "enum": ["healthy", "warning", "critical", "unreachable"],
                      "description": "Only servers in this health state (from RAM/CPU/disk vs thresholds)."},
        }},
    }},
    {"type": "function", "function": {
        "name": "service_status",
        "description": "Status of the services on ONE server, optionally a single service and/or a status "
                       "filter. Use for 'service status on eurv12', 'is OMT running on eurv12', or 'which "
                       "services are stopped on eurv12'.",
        "parameters": {"type": "object", "properties": {
            "server": {"type": "string", "description": "Server host name, e.g. eurv12."},
            "service": {"type": "string", "description": "Optional: a single service name to check."},
            "status": {"type": "string", "enum": ["running", "stopped", "unknown"],
                       "description": "Optional: only services in this status."},
        }, "required": ["server"]},
    }},
    {"type": "function", "function": {
        "name": "list_services",
        "description": "Services ACROSS servers, filtered by scope/OS and status. Use for 'which services are "
                       "stopped', 'list unknown services in group', or 'stopped services on windows'.",
        "parameters": {"type": "object", "properties": {
            "scope": {"type": "string", "enum": ["cib", "retail", "group"], "description": "Business line."},
            "os": {"type": "string", "enum": ["windows", "linux"], "description": "Operating system."},
            "status": {"type": "string", "enum": ["running", "stopped", "unknown", "unreachable"],
                       "description": "Only services in this status."},
        }},
    }},
]

TOOLS = {
    "list_servers": _list_servers,
    "service_status": _service_status,
    "list_services": _list_services,
    "list_shares": _list_shares,
}
