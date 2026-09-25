"""Assistant audit trail.

Every turn (prompt, tool calls, final answer, latency) and every feedback vote is appended as one JSON
line to ``backend/Logs/assistant/audit-YYYYMMDD.jsonl``. This is the scaffold store; Phase 2.1+ moves it
to ``ols_ai_*`` DB tables. It is required for a confidential system — it's the incident-review and
abuse-detection record (see AI_AGENT_DESIGN.md §8). Never log secrets/tokens here.

The batch-log housekeeping already cleans this folder if you add it to ``config/housekeeping.json``
``log_dirs`` (e.g. "Logs/assistant").
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path

# oshiva/observability/audit.py → parents[2] == backend/  (log dir name stays "Logs/assistant")
_DIR = Path(__file__).resolve().parents[2] / "Logs" / "assistant"
_LOCK = threading.Lock()


def _write(record: dict) -> None:
    record["ts"] = datetime.now(timezone.utc).isoformat()
    try:
        _DIR.mkdir(parents=True, exist_ok=True)
        path = _DIR / f"audit-{datetime.now(timezone.utc):%Y%m%d}.jsonl"
        line = json.dumps(record, default=str, ensure_ascii=False)
        with _LOCK:
            with path.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
    except OSError:
        pass  # auditing must never break a chat response


def log_turn(*, conversation_id: str, caller: str, prompt: str, tool_calls: list[dict],
             answer: str, brain: str, elapsed_ms: int, error: str | None = None,
             agent: str = "", tokens: dict | None = None, cost: float | None = None,
             steps: int | None = None) -> None:
    """One chat turn. ``tokens`` = summed model usage ({prompt/completion/total_tokens, estimated?}); ``cost``
    = money cost of those tokens (0 for self-hosted); ``steps`` = tool-calling iterations; each entry in
    ``tool_calls`` may carry an ``ms`` wall-clock time. These power oshiva/observability/metrics.py."""
    _write({
        "kind": "turn", "conversation_id": conversation_id, "caller": caller,
        "prompt": prompt, "agent": agent, "tool_calls": tool_calls, "answer": answer,
        "brain": brain, "elapsed_ms": elapsed_ms, "error": error,
        "tokens": tokens or {}, "cost": cost if cost is not None else 0.0, "steps": steps,
    })


def log_feedback(*, conversation_id: str, message_id: str, caller: str, vote: str,
                 comment: str | None = None) -> None:
    _write({
        "kind": "feedback", "conversation_id": conversation_id, "message_id": message_id,
        "caller": caller, "vote": vote, "comment": comment,
    })
