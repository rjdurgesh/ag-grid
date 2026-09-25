"""Run the OSHIVA eval suite and print a report.

    python -m oshiva.eval                # all cases, deterministic stub + mock (CI gate)
    python -m oshiva.eval routing tool   # only those categories
    python -m oshiva.eval --real         # grade the real GPT-OSS (uses assistant_config; non-deterministic)
    python -m oshiva.eval -v             # show every check, not just failures

Exit code is 0 only if every selected case passes, so CI can gate on it.
"""

from __future__ import annotations

import sys

from .cases import CASES, CATEGORIES
from .harness import EVAL_CFG, run_suite


def _cfg(argv: list[str]) -> dict:
    if "--real" in argv:
        import config_loader
        cfg = dict(config_loader.assistant_config())
        cfg["use_stub"] = False           # grade the live model
        return cfg
    return EVAL_CFG


def main(argv: list[str]) -> int:
    verbose = "-v" in argv or "--verbose" in argv
    real_mode = "--real" in argv
    wanted = [a for a in argv if a in CATEGORIES]
    selected = [c for c in CASES if not wanted or c.category in wanted]
    if not selected:
        print("No cases selected.")
        return 1

    # real_only cases (e.g. free-form summaries, tool-data-obey) are only meaningful against the real model;
    # skip them in the deterministic stub run so they don't create false failures.
    skipped = [c for c in selected if c.real_only and not real_mode]
    cases = [c for c in selected if c not in skipped]

    results = run_suite(cases, _cfg(argv))

    by_cat: dict[str, list] = {}
    for r in results:
        by_cat.setdefault(r.case.category, []).append(r)

    print("\n=== OSHIVA eval report ===")
    print(f"brain: {'REAL gpt-oss' if '--real' in argv else 'stub'} | tools: mock/dummy | "
          f"{len(cases)} case(s)\n")

    total_pass = 0
    for cat in CATEGORIES:
        rs = by_cat.get(cat)
        if not rs:
            continue
        passed = sum(1 for r in rs if r.passed)
        total_pass += passed
        print(f"[{cat}]  {passed}/{len(rs)} passed")
        for r in rs:
            mark = "PASS" if r.passed else "FAIL"
            print(f"   {mark}  {r.case.id}: {r.case.message[:64]}")
            shown = r.checks if verbose else r.failures
            for label, ok, detail in shown:
                tick = "ok " if ok else "XX "
                print(f"         {tick}{label}" + (f"   [{detail}]" if detail else ""))
        print()

    if skipped:
        print(f"[skipped: {len(skipped)} real-only case(s) — run with --real to grade the live model]")
        for c in skipped:
            print(f"   -- {c.id}: {c.message[:64]}")
        print()

    total = len(results)
    print(f"TOTAL: {total_pass}/{total} passed"
          + (f"  ({total - total_pass} FAILED)" if total_pass != total else "  [ALL PASS]")
          + (f"  · {len(skipped)} skipped" if skipped else ""))
    return 0 if total_pass == total else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
