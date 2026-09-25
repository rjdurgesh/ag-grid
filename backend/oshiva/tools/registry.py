"""Tool registry — the aggregator over the per-screen tool modules.

Each screen's tools live in their OWN module (``infra_pulse``, ``oracle_command_center``,
``config_ops_console`` …), each exposing ``SCHEMAS`` (OpenAI tool schemas) and ``TOOLS`` (``{name: fn}``).
This file just gathers them and exposes the two things the agent layer needs: ``TOOL_SCHEMAS`` (the full
catalogue) and ``run_tool(...)``. **Adding a screen = one new module + one line in ``_MODULES``.**

SAFETY (design intent — see AI_AGENT_DESIGN.md §8 + AI_TOOL_AUTHZ.md + AI_PII_REDACTION.md):
  * Tools run **as the caller** — each re-checks the caller's scope before returning data.
  * Read-only in this phase.
  * Every tool result is PII/secret-redacted centrally in ``agents/runner.py`` before the model/audit see it.
"""

from __future__ import annotations

from typing import Any, Callable

from . import config_ops_console, infra_pulse, oracle_command_center, regression

# The registered screen modules. Append a new one here to add its tools — nothing else changes.
_MODULES = (infra_pulse, oracle_command_center, config_ops_console, regression)

TOOL_SCHEMAS: list[dict] = [schema for m in _MODULES for schema in m.SCHEMAS]
_DISPATCH: dict[str, Callable[..., dict]] = {name: fn for m in _MODULES for name, fn in m.TOOLS.items()}


def run_tool(name: str, args: dict, caller: str, use_mock: bool = True,
             scopes: set | None = None, ctx: dict | None = None) -> Any:
    """Execute a tool by name, enforcing the caller's ``scopes`` (business lines they may query). ``ctx``
    carries per-request state a tool may need (DB configs / app_env). Unknown tool, denial, or bad args →
    a dict the model can read and relay (never raises to the loop)."""
    fn = _DISPATCH.get(name)
    if fn is None:
        return {"error": f"Unknown tool '{name}'."}
    try:
        return fn(args or {}, caller, use_mock, scopes if scopes is not None else {"*"}, ctx)
    except NotImplementedError as exc:
        return {"error": str(exc)}
    except Exception as exc:  # noqa: BLE001 — surface as data, keep the loop alive
        return {"error": f"Tool '{name}' failed: {exc}"}
