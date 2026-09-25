"""Edge rate limiting for the assistant — protect the LLM endpoint from runaway cost / abuse.

A per-caller fixed-window counter: at most ``rate_limit_per_min`` chat turns per 60s per caller. It's the
cheap first line of defence in front of an expensive resource (every chat turn can fan out to several tool
calls and a model call). In-memory and per-process — fine for a single uvicorn worker or a dev box; a
multi-worker / multi-host deployment would back this with Redis (same interface).

Disabled when ``rate_limit_per_min`` <= 0. Enforced in oshiva/api.py before a turn runs; on trip the endpoint
returns HTTP 429 with a ``Retry-After`` header.
"""

from __future__ import annotations

import threading
import time

_WINDOW_S = 60.0
_hits: dict[str, list[float]] = {}
_LOCK = threading.Lock()


def _limit(cfg: dict) -> int:
    try:
        return int(cfg.get("rate_limit_per_min", 20))
    except (TypeError, ValueError):
        return 20


def check(caller: str, cfg: dict) -> tuple[bool, int]:
    """Record a hit for ``caller`` and say whether it's allowed. Returns ``(allowed, retry_after_seconds)``.
    ``retry_after`` is 0 when allowed. A limit <= 0 disables limiting (always allowed)."""
    limit = _limit(cfg)
    if limit <= 0:
        return True, 0
    now = time.time()
    cutoff = now - _WINDOW_S
    with _LOCK:
        q = _hits.setdefault(caller or "?", [])
        q[:] = [t for t in q if t >= cutoff]        # drop hits older than the window
        if len(q) >= limit:
            retry = int(_WINDOW_S - (now - q[0])) + 1
            return False, max(retry, 1)
        q.append(now)
        return True, 0


def reset(caller: str | None = None) -> None:
    """Clear counters (used by tests, or to lift a limit for one caller)."""
    with _LOCK:
        if caller is None:
            _hits.clear()
        else:
            _hits.pop(caller, None)
