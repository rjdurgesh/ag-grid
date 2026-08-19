"""Infrastructure Health — DUMMY data (canned config catalogue + synthetic agent metrics).

Split out of ``infrastructure_health_api.py`` so the router file stays lean — same pattern as
``oracle_cc_dummy.py``. The shared byte/GB helpers live in the API module and are imported
here. ``infrastructure_health_api`` imports these functions at its bottom (once the shared
names exist) and calls them when ``INFRA_HEALTH_USE_DUMMY`` is on.
"""

from __future__ import annotations

import random

from infrastructure_health_api import _GB, _gb_str


def config_dummy(app_env: str | None = None) -> dict:
    """Canned server/share monitoring catalogue — the same ``{status, data:[rows]}`` shape the
    real stored proc returns. ``app_env`` is accepted for parity with the real query (the
    stand-in returns every row regardless)."""
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


def synthetic_agent(host_name: str, agent_listen_port: int, host_platform: str | None,
                    monitoring_config: dict | None) -> dict:
    """Stand-in agent reading — deterministic synthetic data (no agent runs on the dev box).
    Same shape the real ``_agent_over_http`` returns; ``reachable`` is always True here."""
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
