"""Print an OSHIVA usage/observability summary for a day.

    python -m oshiva.observability                # today (UTC)
    python -m oshiva.observability 20260925        # a specific day (YYYYMMDD)

Reads the append-only audit log (Logs/assistant/audit-YYYYMMDD.jsonl) and rolls it up: turns, errors, tokens,
cost, average latency, and per-caller / per-agent counts. Read-only.
"""

from __future__ import annotations

import sys

from .metrics import summarise_day


def main(argv: list[str]) -> int:
    day = next((a for a in argv if a.isdigit() and len(a) == 8), None)
    s = summarise_day(day)
    tok = s["tokens"]
    est = " (estimated - stub)" if s.get("estimated") else ""

    print(f"\n=== OSHIVA usage - {s['day']} ===")
    print(f"turns:     {s['turns']}   (errors: {s['errors']}, feedback votes: {s['feedback']})")
    print(f"tokens:    prompt {tok['prompt_tokens']} + completion {tok['completion_tokens']} "
          f"= {tok['total_tokens']}{est}")
    print(f"cost:      {s['cost']}")
    if s.get("avg_ms") is not None:
        print(f"latency:   avg {s['avg_ms']} ms/turn   (total {s['elapsed_ms_total']} ms)")
    if s["by_agent"]:
        print("by agent:  " + ", ".join(f"{k}={v}" for k, v in sorted(s["by_agent"].items())))
    if s["by_caller"]:
        top = sorted(s["by_caller"].items(), key=lambda kv: kv[1], reverse=True)[:10]
        print("top callers: " + ", ".join(f"{k}={v}" for k, v in top))
    if s["turns"] == 0:
        print("(no turns recorded for this day)")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
