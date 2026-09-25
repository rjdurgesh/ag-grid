"""Coordinator — the entry point for a turn.

It decides WHICH agent handles the message (registry.route), announces that choice as a ``route`` event,
then delegates the actual work to that agent's tool loop (runner.run_agent_loop). Today there's one agent
(ops), so the coordinator always routes there; when specialists are added to ``registry.AGENTS`` the routing
starts fanning out with no change here or at the call site. This is the seam that lets us grow from one agent
to many (plug in / plug out).

Yields the same event stream as the agent loop, plus one extra at the start:
  {"type": "route", "agent": "ops", "title": "Ops agent"}
"""

from __future__ import annotations

from typing import Iterator

from . import registry as agent_registry
from .runner import run_agent_loop


def run(user_message: str, history: list[dict], caller: str, cfg: dict,
        scopes: set | None = None, ctx: dict | None = None) -> Iterator[dict]:
    agent = agent_registry.route(user_message)
    yield {"type": "route", "agent": agent.name, "title": agent.title}
    yield from run_agent_loop(agent, user_message, history, caller, cfg, scopes, ctx)
