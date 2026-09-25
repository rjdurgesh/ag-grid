"""The eval harness — run a case through the real pipeline and grade it.

``run_case`` drives ``agents.coordinator.run`` (the same seam the /chat endpoint uses) and collects what
happened: which agent handled it, which tools were called with which args, and the final answer. A redaction
canary short-circuits to ``security.redaction.redact`` instead (no tool emits secrets in dummy mode).

``evaluate`` turns a case's expectations into concrete pass/fail checks. ``run_suite`` does both for a list.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

# Pin EVERY screen's data source to dummy BEFORE the tool modules import (they read these flags at import
# time). This makes the suite deterministic and guarantees it never touches a real server or database,
# regardless of APP_ENV / .env — an eval must control its own environment. Hard-set (not setdefault) so a
# PROD .env can't silently point the suite at live systems.
for _flag in ("INFRA_HEALTH_USE_DUMMY", "ACCESS_USE_DUMMY", "ORACLE_CC_USE_DUMMY",
              "LOG_ANALYTICS_USE_DUMMY", "SQLI_USE_DUMMY"):
    os.environ[_flag] = "1"

from ..agents import coordinator      # noqa: E402 — must follow the dummy-flag pin above
from ..llm import client as llm_client  # noqa: E402
from ..security import redaction      # noqa: E402
from .cases import EvalCase           # noqa: E402

# Deterministic config: stub brain + mock/dummy tools → the same inputs always produce the same route, tool
# calls and answer, so behavioural checks are reproducible (CI-gradeable). Pass a different cfg (e.g. the real
# assistant_config with use_stub=false) to grade the live model with the same cases.
EVAL_CFG: dict = {"use_stub": True, "use_mock_tools": True, "max_steps": 6}


@dataclass
class Outcome:
    agent: str = ""
    tools: list[dict] = field(default_factory=list)   # [{name, args}]
    answer: str = ""
    error: str | None = None


@dataclass
class Result:
    case: EvalCase
    passed: bool
    checks: list[tuple[str, bool, str]]               # (label, ok, detail)
    outcome: Outcome

    @property
    def failures(self) -> list[tuple[str, bool, str]]:
        return [c for c in self.checks if not c[1]]


def run_case(case: EvalCase, cfg: dict | None = None) -> Outcome:
    """Execute one case and capture the pipeline's observable behaviour."""
    cfg = cfg or EVAL_CFG

    # Redaction canary: exercise the scrubber directly (deterministic, no pipeline needed).
    if case.redact_input is not None:
        scrubbed = redaction.redact(case.redact_input)
        return Outcome(answer=json.dumps(scrubbed, default=str))

    # Injection probe: feed an exact transcript to the model. Tool messages are redacted first — exactly as
    # the runner does — so this tests the model's behaviour on redacted-but-still-poisoned tool DATA.
    if case.probe_messages is not None:
        msgs = []
        for m in case.probe_messages:
            if m.get("role") == "tool":
                try:
                    data = json.loads(m.get("content") or "{}")
                except (TypeError, ValueError):
                    data = m.get("content")
                m = {**m, "content": json.dumps(redaction.redact(data), default=str)}
            msgs.append(m)
        try:
            resp = llm_client.complete(msgs, [], cfg)
            return Outcome(answer=resp.content or "")
        except Exception as exc:  # noqa: BLE001
            return Outcome(error=f"probe failed: {exc}")

    out = Outcome()
    scopes = set(case.scopes)
    ctx: dict = {}   # empty → tools fall back to each screen's dummy data (deterministic)
    try:
        for ev in coordinator.run(case.message, [], case.caller, cfg, scopes, ctx):
            kind = ev.get("type")
            if kind == "route":
                out.agent = ev.get("agent", "")
            elif kind == "tool":
                out.tools.append({"name": ev.get("name"), "args": ev.get("args") or {}})
            elif kind == "final":
                out.answer = ev.get("content", "")
            elif kind == "error":
                out.error = ev.get("detail")
    except Exception as exc:  # noqa: BLE001 — a crash is a failed case, not a crashed suite
        out.error = f"pipeline raised: {exc}"
    return out


def evaluate(case: EvalCase, out: Outcome) -> Result:
    """Apply a case's expectations to its outcome → a Result with one check per expectation."""
    checks: list[tuple[str, bool, str]] = []

    def check(label: str, cond: bool, detail: str = "") -> None:
        checks.append((label, bool(cond), detail))

    if case.expect_agent:
        check(f"agent == {case.expect_agent}", out.agent == case.expect_agent, f"got {out.agent!r}")

    names = [t.get("name") for t in out.tools]
    if case.expect_tool:
        check(f"tool {case.expect_tool} called", case.expect_tool in names, f"tools={names}")
    if case.expect_no_tool:
        check("no tool called (read-only guard)", not names, f"tools={names}")

    if case.expect_args_contains:
        target = next((t for t in out.tools if t.get("name") == case.expect_tool), None)
        args = (target or {}).get("args", {}) or {}
        for key, want in case.expect_args_contains.items():
            check(f"arg {key} == {want!r}", args.get(key) == want, f"got {args.get(key)!r}")

    low = (out.answer or "").lower()
    for sub in case.answer_contains:
        check(f"answer contains {sub!r}", sub.lower() in low)
    for sub in case.answer_excludes:
        leaked = sub.lower() in low
        check(f"answer excludes {sub!r}", not leaked, "LEAK!" if leaked else "")

    # An unexpected pipeline error fails the case (unless the case is explicitly about errors).
    if out.error and case.category != "error":
        check("no pipeline error", False, out.error)

    passed = bool(checks) and all(ok for _, ok, _ in checks)
    return Result(case=case, passed=passed, checks=checks, outcome=out)


def run_suite(cases: list[EvalCase], cfg: dict | None = None) -> list[Result]:
    return [evaluate(c, run_case(c, cfg)) for c in cases]
