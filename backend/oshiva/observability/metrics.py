"""Cost + usage metrics for OSHIVA turns.

Tokens come from the model (`LlmResponse.usage`) — exact for the real GPT-OSS, estimated for the stub. This
module (a) sums usage across the tool-calling steps of one turn, (b) turns tokens into a money cost using the
per-1k prices in config, and (c) rolls up a day's audit log into a summary you can eyeball.

Self-hosted GPT-OSS has no per-token bill, so the default prices are 0 — but you still get token counts and
latency (the numbers that actually tell you if a prompt is too big or a turn too slow). Set real prices in
config to model a chargeback or a third-party comparison.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

_AUDIT_DIR = Path(__file__).resolve().parents[2] / "Logs" / "assistant"

_KEYS = ("prompt_tokens", "completion_tokens", "total_tokens")


def add_usage(a: dict | None, b: dict | None) -> dict:
    """Sum two usage dicts (across the steps of one turn). Keeps an ``estimated`` flag if either side was."""
    a, b = a or {}, b or {}
    out = {k: int(a.get(k, 0) or 0) + int(b.get(k, 0) or 0) for k in _KEYS}
    if a.get("estimated") or b.get("estimated"):
        out["estimated"] = True
    return out


def _f(cfg: dict, key: str, default: float = 0.0) -> float:
    try:
        return float(cfg.get(key, default))
    except (TypeError, ValueError):
        return default


def cost_of(usage: dict | None, cfg: dict) -> float:
    """Money cost of one turn's tokens, from ``cost_per_1k_input`` / ``cost_per_1k_output`` in config.
    Returns 0.0 when prices are unset (the self-hosted default)."""
    usage = usage or {}
    pin = _f(cfg, "cost_per_1k_input")
    pout = _f(cfg, "cost_per_1k_output")
    if pin == 0.0 and pout == 0.0:
        return 0.0
    prompt = int(usage.get("prompt_tokens", 0) or 0)
    completion = int(usage.get("completion_tokens", 0) or 0)
    return round(prompt / 1000.0 * pin + completion / 1000.0 * pout, 6)


def summarise_day(day: str | None = None) -> dict:
    """Roll up one day's audit JSONL into totals: turns, errors, tokens, cost, latency, and per-caller counts.
    ``day`` is YYYYMMDD (default: today, UTC). Read-only — for a quick operational glance or the CLI report."""
    day = day or f"{datetime.now(timezone.utc):%Y%m%d}"
    path = _AUDIT_DIR / f"audit-{day}.jsonl"
    summary = {"day": day, "turns": 0, "errors": 0, "feedback": 0,
               "tokens": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
               "cost": 0.0, "elapsed_ms_total": 0, "by_caller": {}, "by_agent": {}, "estimated": False}
    if not path.is_file():
        return summary
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if rec.get("kind") == "feedback":
            summary["feedback"] += 1
            continue
        if rec.get("kind") != "turn":
            continue
        summary["turns"] += 1
        if rec.get("error"):
            summary["errors"] += 1
        tok = rec.get("tokens") or {}
        for k in _KEYS:
            summary["tokens"][k] += int(tok.get(k, 0) or 0)
        if tok.get("estimated"):
            summary["estimated"] = True
        summary["cost"] = round(summary["cost"] + float(rec.get("cost", 0.0) or 0.0), 6)
        summary["elapsed_ms_total"] += int(rec.get("elapsed_ms", 0) or 0)
        caller = rec.get("caller") or "?"
        summary["by_caller"][caller] = summary["by_caller"].get(caller, 0) + 1
        agent = rec.get("agent") or "?"
        summary["by_agent"][agent] = summary["by_agent"].get(agent, 0) + 1
    if summary["turns"]:
        summary["avg_ms"] = round(summary["elapsed_ms_total"] / summary["turns"], 1)
    return summary
