"""The agent loop — runs ONE agent to completion.

`run_agent_loop(agent, …)` is a generator of **events** (dicts). It sends the running transcript + the
agent's tool schemas to the model; if the model asks for a tool, it runs it (as the caller), feeds the
result back, and repeats until the model returns a final answer, which it streams as tokens. A hard
``max_steps`` budget stops runaway loops. Identical for the stub brain and the real GPT-OSS.

The coordinator (coordinator.py) decides WHICH agent to run; this module just runs whichever it's given.

Event types yielded:
  {"type": "tool",        "name", "args"}   a tool call is starting
  {"type": "tool_result", "name", "ms"}     that tool finished (with its wall-clock ms)
  {"type": "token",       "text"}           a chunk of the final answer
  {"type": "usage",       "usage", "steps"} token usage summed over the turn + step count (cost/observability)
  {"type": "final",       "content"}        the complete final answer (for the client + audit)
  {"type": "error",       "detail"}         something went wrong
"""

from __future__ import annotations

import json
import time
from typing import Iterator

from ..llm import client as llm_client
from ..observability import metrics
from ..security import redaction
from ..tools.registry import run_tool
from .registry import Agent


def run_agent_loop(agent: Agent, user_message: str, history: list[dict], caller: str,
                   cfg: dict, scopes: set | None = None, ctx: dict | None = None) -> Iterator[dict]:
    """Drive one user turn with a specific ``agent`` (its system prompt + its own tools). ``history`` is
    prior user/assistant messages (OpenAI-style, no system prompt). ``scopes`` = the business lines the
    caller may query (enforced per tool). ``ctx`` = per-request state threaded to tools (e.g. DB config)."""
    tools = agent.tool_schemas()
    allowed = set(agent.tool_names)
    messages: list[dict] = [{"role": "system", "content": agent.system_prompt}]
    messages.extend(history or [])
    messages.append({"role": "user", "content": user_message})

    max_steps = int(cfg.get("max_steps", 6))
    use_mock = bool(cfg.get("use_mock_tools", True))
    usage: dict = {}        # summed token usage across every model call in this turn (for cost/observability)
    steps = 0

    for _step in range(max_steps):
        steps += 1
        try:
            resp = llm_client.complete(messages, tools, cfg)
        except NotImplementedError as exc:
            yield {"type": "error", "detail": str(exc)}
            return
        except Exception as exc:  # noqa: BLE001
            yield {"type": "error", "detail": f"Model call failed: {exc}"}
            return
        usage = metrics.add_usage(usage, resp.usage)

        if resp.tool_calls:
            messages.append({"role": "assistant", "content": None, "tool_calls": [
                {"id": tc["id"], "type": "function",
                 "function": {"name": tc["name"], "arguments": json.dumps(tc.get("arguments") or {})}}
                for tc in resp.tool_calls]})
            for tc in resp.tool_calls:
                name = tc["name"]
                args = tc.get("arguments") or {}
                yield {"type": "tool", "name": name, "args": args}
                # Defence-in-depth: an agent may only run its own tools.
                t0 = time.perf_counter()
                result = ({"error": f"Tool '{name}' is not available to the {agent.name} agent."}
                          if name not in allowed else run_tool(name, args, caller, use_mock, scopes, ctx))
                ms = int((time.perf_counter() - t0) * 1000)
                # PII / secret redaction: scrub the result BEFORE the model (a shared LLM) ever sees it — and
                # therefore before it can end up in the streamed answer or the audit log. Central chokepoint,
                # so every tool (present + future) is covered. See oshiva/security/redaction.py.
                result = redaction.redact(result)
                messages.append({"role": "tool", "tool_call_id": tc["id"], "name": name,
                                 "content": json.dumps(result, default=str)})
                yield {"type": "tool_result", "name": name, "ms": ms}
            continue

        content = resp.content or ""
        for chunk in _chunks(content):
            yield {"type": "token", "text": chunk}
        yield {"type": "usage", "usage": usage, "steps": steps}
        yield {"type": "final", "content": content}
        return

    yield {"type": "usage", "usage": usage, "steps": steps}
    yield {"type": "error", "detail": "Reached the step limit without a final answer."}


def _chunks(text: str):
    """Yield the answer in small pieces so the UI streams it word-by-word (stub). A real streaming model
    yields its own token deltas; this just gives the scaffold the same feel."""
    words = text.split(" ")
    for i, w in enumerate(words):
        yield (w if i == 0 else " " + w)
