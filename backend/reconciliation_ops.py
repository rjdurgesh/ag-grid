"""Data Reconciliation — Phase 2 compute layer (source-agnostic compare engine + CSV loading).

Kept SEPARATE from ``database.py`` (SQL only) and ``reconciliation_api.py`` (orchestration): this holds
the pure comparison and the file reader. The engine takes two already-loaded datasets (each
``{columns, rows}`` — from a CSV file OR a DB table) and a report's config (key columns, measure columns,
tolerance) and returns a PASS/FAIL summary + the discrepancy grid (self-describing columns + rows).
"""

from __future__ import annotations

import csv
import io
from pathlib import Path
from typing import Any

# Cap the discrepancy rows we keep/return so a wildly-divergent report can't blow up the payload/CLOB.
MAX_DISCREPANCY_ROWS = 5000


def _split_cols(spec: str | None) -> list[str]:
    return [c.strip() for c in str(spec or "").split(",") if c.strip()]


def _num(v: Any) -> float | None:
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _delta(live_v: Any, reg_v: Any) -> Any:
    lv, rv = _num(live_v), _num(reg_v)
    if lv is None or rv is None:
        return None
    return round(lv - rv, 6)


def _within(live_v: Any, reg_v: Any, tol_type: str, tol_val: float) -> bool:
    """True when LIVE ≈ REG under the tolerance. Non-numeric values → exact string compare."""
    lv, rv = _num(live_v), _num(reg_v)
    if lv is None or rv is None:
        return str(live_v).strip() == str(reg_v).strip()
    t = (tol_type or "EXACT").upper()
    if t == "ABS":
        return abs(lv - rv) <= tol_val
    if t == "PCT":
        return abs(lv - rv) / abs(rv) * 100 <= tol_val if rv else lv == rv
    return lv == rv


def _index(ds: dict, key_cols: list[str], measure_cols: list[str]):
    """Index a dataset by its key-column tuple; return (index, measure→col-position). Matches columns
    by NAME (case-insensitive), so LIVE and REG may list columns in a different order."""
    cols = [str(c).strip().upper() for c in (ds.get("columns") or [])]
    kpos = [cols.index(k.upper()) for k in key_cols if k.upper() in cols]
    mpos = {m: cols.index(m.upper()) for m in measure_cols if m.upper() in cols}
    idx: dict[tuple, list] = {}
    for row in (ds.get("rows") or []):
        key = tuple("" if row[i] is None else str(row[i]).strip() for i in kpos)
        idx[key] = row
    return idx, mpos


def compare_datasets(live: dict, reg: dict, key_columns: str | list[str],
                     measure_columns: str | list[str], tolerance_type: str = "EXACT",
                     tolerance_value: float = 0) -> dict:
    """Full-outer compare of two aggregate datasets on the key columns. Returns:
    ``{status, matched, changed, missing, extra, compared, columns, rows}`` where columns/rows are the
    self-describing discrepancy grid: ``Type, <keys…>, <measure> (LIVE), <measure> (REG), <measure> Δ``.
      * changed  — key in both, at least one measure outside tolerance
      * missing  — key only in LIVE (missing in Regression)
      * extra    — key only in Regression
    PASS when there are zero discrepancies; otherwise FAIL."""
    keys = _split_cols(key_columns) if isinstance(key_columns, str) else list(key_columns or [])
    measures = _split_cols(measure_columns) if isinstance(measure_columns, str) else list(measure_columns or [])
    lidx, lm = _index(live, keys, measures)
    ridx, rm = _index(reg, keys, measures)

    columns = ["Type"] + keys
    for m in measures:
        columns += [f"{m} (LIVE)", f"{m} (REG)", f"{m} Δ"]

    rows: list[list] = []
    matched = changed = missing = extra = 0
    # preserve encounter order: LIVE keys first, then REG-only keys
    all_keys = list(dict.fromkeys(list(lidx.keys()) + list(ridx.keys())))
    for key in all_keys:
        lrow, rrow = lidx.get(key), ridx.get(key)
        if lrow is not None and rrow is not None:
            cells: list = []
            ok = True
            for m in measures:
                lv = lrow[lm[m]] if m in lm else None
                rv = rrow[rm[m]] if m in rm else None
                if not _within(lv, rv, tolerance_type, tolerance_value):
                    ok = False
                cells += [lv, rv, _delta(lv, rv)]
            if ok:
                matched += 1
            else:
                changed += 1
                if len(rows) < MAX_DISCREPANCY_ROWS:
                    rows.append(["Changed"] + list(key) + cells)
        elif lrow is not None:
            missing += 1
            if len(rows) < MAX_DISCREPANCY_ROWS:
                cells = []
                for m in measures:
                    cells += [lrow[lm[m]] if m in lm else None, None, None]
                rows.append(["Missing"] + list(key) + cells)
        else:
            extra += 1
            if len(rows) < MAX_DISCREPANCY_ROWS:
                cells = []
                for m in measures:
                    cells += [None, rrow[rm[m]] if m in rm else None, None]
                rows.append(["Extra"] + list(key) + cells)

    compared = matched + changed + missing + extra
    status = "PASS" if (changed + missing + extra) == 0 else "FAIL"
    return {"status": status, "matched": matched, "changed": changed, "missing": missing,
            "extra": extra, "compared": compared, "columns": columns, "rows": rows}


def read_csv_dataset(path: str) -> dict | None:
    """Read a report's CSV extract → ``{columns, rows}`` (header row = columns). Returns None when the
    file is absent or empty (→ the caller reports NO_DATA)."""
    p = Path(path)
    if not p.is_file():
        return None
    text = p.read_text(encoding="utf-8-sig", errors="replace")
    if not text.strip():
        return None
    reader = csv.reader(io.StringIO(text))
    all_rows = [r for r in reader if r != []]
    if not all_rows:
        return None
    return {"columns": all_rows[0], "rows": all_rows[1:]}


def extract_csv_path(base_dir: str, run_id: int, report_code: str, side: str) -> str:
    """The deterministic path the batch was told to write to (Phase 1): <base>/<run_id>/<report>_<SIDE>.csv."""
    return str(Path(base_dir) / str(run_id) / f"{report_code}_{side.upper()}.csv")
