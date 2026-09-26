"""OSHIVA — the OLS Hybrid Intelligence Virtual Assistant (Phase 2 AI agent).

See AI_AGENT_DESIGN.md / AI_ARCHITECTURE.md. All bot code lives under this package, grouped by concern so
each box of the target architecture maps to a subpackage:

  api.py                     — the FastAPI router (/api/assistant/*); the request entry point.
  agents/                    — the coordinator + the pluggable specialist agents.
      coordinator.py           routes a turn to an agent, then runs it (the multi-agent seam).
      registry.py              the Agent dataclass + AGENTS registry + route().
      runner.py                the tool-calling loop that runs ONE agent and streams events.
  tools/                     — the tools an agent may call.
      registry.py              tool schemas + run_tool() (mock data in the scaffold; real services later).
  auth/                      — access control.
      gate.py                  screen-level gate: "may you use OSHIVA at all?" (enabled + allow-list/RBAC).
      scope_access.py          tool-level authz: which business lines (group/cib/retail) the caller may query.
  memory/                    — conversation state.
      sessions.py              server-side conversation history + shared scratchpad (per conversation_id).
  llm/                       — the model client.
      client.py                talks to the model (STUB now; real GPT-OSS endpoint later, loop unchanged).
  observability/             — operability.
      audit.py                 append-only audit log of every turn + feedback vote.

The public HTTP contract stays ``/api/assistant/*`` and the config file stays ``oshiva/assistant.json`` —
only the code was reorganised into this package.
"""
