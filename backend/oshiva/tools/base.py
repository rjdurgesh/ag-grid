"""Shared helpers for the per-screen tool modules.

Each screen's tools live in their own module (``infra_pulse.py``, ``oracle_command_center.py``,
``config_ops_console.py`` …) and expose two names — ``SCHEMAS`` (list of OpenAI tool schemas) and ``TOOLS``
(``{name: fn}``). ``registry.py`` aggregates them. The small, cross-cutting helpers they all share live here
so they aren't duplicated: scope mapping, number coercion, and the standard denial message.

A tool implementation has the signature ``fn(args, caller, use_mock, scopes, ctx) -> dict`` and must NEVER
raise to the loop — it returns a dict the model can read (data, ``{"error": ...}`` or ``{"denied": ...}``).
"""

from __future__ import annotations

import re as _re
import uuid as _uuid
from pathlib import Path as _Path


def export_dir() -> _Path:
    """Shared folder for downloadable exports (served by GET /api/assistant/export/<file>).
    backend/oshiva/tools/base.py → parents[2] = backend/."""
    return _Path(__file__).resolve().parents[2] / "assistant_data" / "exports"


def write_export(stem: str, content: str, ext: str = "txt") -> str:
    """Write ``content`` to a token-named export file and return its filename (for a download URL).
    Used for outputs too big for the chat (e.g. an explain plan). Only ``csv``/``txt`` are served."""
    d = export_dir()
    d.mkdir(parents=True, exist_ok=True)
    safe = _re.sub(r"[^A-Za-z0-9_]", "_", stem)[:40] or "export"
    fname = f"{safe}_{_uuid.uuid4().hex}.{ext if ext in ('csv', 'txt') else 'txt'}"
    (d / fname).write_text(content, encoding="utf-8")
    return fname


def num(v) -> float | None:
    """Coerce to float, or None if not numeric."""
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def scope_of_app_name(app_name: str) -> str:
    """Map an Infra/Config catalogue APP_NAME (e.g. 'OLS_CIB') to a business scope."""
    a = (app_name or "").upper()
    if "CIB" in a:
        return "cib"
    if "RETAIL" in a or "RET" in a:
        return "retail"
    if "GROUP" in a or "GRP" in a:
        return "group"
    return ""


def scope_of_server(name: str) -> str:
    """Business scope from a server host name (best-effort, for name-based tools)."""
    n = (name or "").upper()
    if "-CIB" in n or n.startswith("SRV-CIB"):
        return "cib"
    if "-RET" in n or n.startswith("SRV-RET"):
        return "retail"
    if "-GRP" in n or "-GROUP" in n:
        return "group"
    return ""


def scope_of_db(db: str) -> str:
    """Business scope from a database key like 'cib_batch'."""
    d = (db or "").lower()
    if d.startswith("cib"):
        return "cib"
    if d.startswith("retail") or d.startswith("ret"):
        return "retail"
    if d.startswith("group") or d.startswith("grp"):
        return "group"
    return ""


def deny(scope: str, scopes: set[str]) -> dict:
    """Standard, professional denial when the caller may not query ``scope``. Lists what they CAN query."""
    from ..auth import scope_access as authz
    if not scopes:
        return {"denied": True,
                "message": f"I can't access {scope.upper()} data with your current permissions. Your "
                           "account doesn't have access to any business line yet — please contact the OLS "
                           "team to request access."}
    return {"denied": True,
            "message": f"I can't access {scope.upper()} data with your current permissions. "
                       f"You can query {authz.describe(scopes)} data."}
