"""OSHIVA evaluation suite — golden Q&A + guardrail checks (Phase 2.2).

Why this exists: before we flip the brain from the stub to the real GPT-OSS (and before we widen access), we
want a repeatable way to prove OSHIVA still (a) routes to the right agent, (b) picks the right tool with the
right arguments, (c) REFUSES what it must (writes, cross-line data, unconfirmed rollovers), and (d) never
leaks secrets/PII. That's what an *evaluation suite* is: a fixed set of cases + automatic checks.

How it works: each case is run through the REAL pipeline (`agents.coordinator.run`) — the same seam the HTTP
endpoint uses — and we assert on the emitted route, tool calls, and final answer. In stub + mock mode the
brain and the tools are both DETERMINISTIC, so the whole suite is reproducible and can gate CI. Point it at
the real model (`use_stub=false`) with the same cases to grade the model's quality (then prefer the lenient
`answer_contains/excludes` checks over exact tool-arg matches, since a real model varies).

Layout:
  cases.py    — the golden dataset (``EvalCase`` records) grouped by category, incl. redaction canaries
  harness.py  — ``run_case()`` drives the pipeline; ``evaluate()`` applies a case's checks → ``Result``
  __main__.py — ``python -m oshiva.eval`` prints a report and exits non-zero if any case fails

See ai-learning/AI_EVALS.md for the beginner walkthrough.
"""
