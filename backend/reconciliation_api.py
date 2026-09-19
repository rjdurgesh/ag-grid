"""Data Reconciliation API (DEV/STG only) — PHASE 1: trigger report extracts + monitor them.

Post-regression (and ad-hoc) validation: run business reports on a LIVE db and a Regression db, then
(Phase 2) compare the aggregate output. This module covers the TRIGGER + EXTRACT-MONITORING half:

  * ``/reports``           — the report catalogue for a scope (from ``ols_recon_report_config`` in the
                             scope's DB; NOTHING hardcoded).
  * ``/databases``         — the DBs offered in the LIVE / Regression dropdowns.
  * ``/regression-runs``   — recent regression runs to optionally link (→ CHG + release date).
  * ``/trigger``           — for each selected report × side (LIVE, REG) call the report's PL/SQL batch
                             (``trigger_proc``) passing ``db_source`` + business date; store each returned
                             unique ``job_run_no`` (the poll correlation key).
  * ``/status``            — poll each extract by ``job_run_no`` against the batch-monitor status column,
                             derive the per-report state (Extracting / Failed / No-data / Ready), isolated
                             per report (one failure never affects the others).
  * ``/activity``          — the Extract Log history.

Follows the regression pattern: DEV/STG + grant gate, ACCESS_USE_DUMMY dummy path, OIDC caller via
``resolve_caller``, DB errors surfaced via ``db_errors``. SQL lives in ``database.py``. Registered in ``app.py``.
Phase 2 adds the compare engine + results.
"""

from __future__ import annotations

import json
import time

from env_loader import env_bool

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import access_api           # grants_have_full_access (Model B — role is not authorization)
import config_loader
import database
import db_errors
import reconciliation_ops as ops
from auth_token import resolve_caller  # OIDC: caller from validated token / AUTH_DEV_USER (AUTH_SETUP.md)
from utils.logging import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/reconciliation", tags=["reconciliation"])

RECON_USE_DUMMY = env_bool("ACCESS_USE_DUMMY", True)
_SCOPES = ("group", "cib", "retail")


# ---- request models --------------------------------------------------------
class Caller(BaseModel):
    caller: str
    scope: str = "cib"


class TriggerBody(Caller):
    live_db: str
    regression_db: str
    business_date: str                       # YYYYMMDD
    reports: list[str] = []                  # report_codes selected (multi-select)
    regression_run_id: int | None = None     # optional link → carries CHG + release date


class RunBody(Caller):
    run_id: int


class ReportBody(Caller):
    run_id: int
    report_code: str


# ---- gate ------------------------------------------------------------------
def _require_reconciliation(request: Request, body: Caller):
    """Resolve the caller from the OIDC token (else AUTH_DEV_USER / body), then confirm DEV/STG + an
    active user with reconciliation access for this scope (ADMIN, a ``config_ops:<scope>`` grant, or a
    RECONCILIATION grant). 403 otherwise; None in dummy. Mirrors ``regression_api._require_regression``."""
    body.caller = resolve_caller(request, body.caller)
    caller = body.caller
    if RECON_USE_DUMMY:
        return None
    if str(getattr(request.app.state, "app_env", "PROD")).upper() not in ("DEV", "STG"):
        raise HTTPException(status_code=403, detail="Data Reconciliation is available only in DEV/STG.")
    scope = (body.scope or "").lower()
    if scope not in _SCOPES:
        raise HTTPException(status_code=400, detail=f"Unknown scope '{body.scope}'.")
    cfg = getattr(request.app.state, "app_db_config", None)
    ident = database.fetch_user_identity(cfg, caller)
    if not ident or str(ident.get("lgcl_del_flg") or "").strip().upper() != "N":
        raise HTTPException(status_code=403, detail="Not an active OLS user.")
    # Model B: role no longer grants — need a full-access wildcard OR a config/reconciliation grant.
    grants = database.fetch_user_grants(cfg, caller)
    want_cfg = f"config_ops:{scope}".lower()
    ok = access_api.grants_have_full_access(grants) or any(
        ((g.get("access_level") or "").strip().upper() != "DENY")
        and ((g.get("resource_scope") or "").lower() == want_cfg
             or ((g.get("resource_type") or "").upper() == "RECONCILIATION"
                 and (g.get("resource_scope") or "").lower() in (scope, want_cfg)))
        for g in grants
    )
    if not ok:
        raise HTTPException(status_code=403, detail=f"Reconciliation access to {scope.upper()} is required.")
    return cfg


def _scope_db(request: Request, scope: str):
    """The scope's own DB connection config (holds ols_recon_report_config + the recon run/extract
    tables). Reuses the privileged pool used elsewhere; None → dummy/unwired."""
    key = f"{scope}_batch" if scope in ("cib", "retail") else scope
    cfgs = getattr(request.app.state, "sql_db_configs", None) or getattr(request.app.state, "db_configs", {})
    return cfgs.get(key) or cfgs.get(scope)


# ---- endpoints -------------------------------------------------------------
@router.post("/reports")
def reports(request: Request, body: Caller) -> dict:
    """Active reports for the scope's dropdown (from ols_recon_report_config in the scope DB)."""
    _require_reconciliation(request, body)
    if RECON_USE_DUMMY:
        return {"status": "success", "reports": _dummy_reports(body.scope)}
    try:
        return {"status": "success", "reports": database.fetch_recon_reports(_scope_db(request, body.scope))}
    except Exception:
        logger.exception("recon reports failed for %s", body.scope)
        raise db_errors.http_error()


@router.post("/databases")
def databases(request: Request, body: Caller) -> dict:
    """The DBs offered in the LIVE / Regression dropdowns for this scope."""
    _require_reconciliation(request, body)
    if RECON_USE_DUMMY:
        return {"status": "success", "databases": _dummy_databases(body.scope)}
    keys = list(getattr(request.app.state, "db_configs", {}) or {})
    scope = (body.scope or "").lower()
    picks = [k for k in keys if k == scope or k.startswith(scope + "_")] or keys
    return {"status": "success", "databases": [{"key": k, "label": k} for k in picks]}


@router.post("/regression-runs")
def regression_runs(request: Request, body: Caller) -> dict:
    """Recent regression runs to optionally link (→ carries CHG + release date). Empty for Group
    (no regression there) — the UI just shows no link options."""
    _require_reconciliation(request, body)
    if RECON_USE_DUMMY:
        return {"status": "success", "runs": _dummy_regression_runs(body.scope)}
    try:
        cfg = getattr(request.app.state, "app_db_config", None)
        return {"status": "success", "runs": database.fetch_recon_regression_runs(cfg, body.scope)}
    except Exception:
        logger.exception("recon regression-runs failed for %s", body.scope)
        raise db_errors.http_error()


@router.post("/trigger")
def trigger(request: Request, body: TriggerBody) -> dict:
    """Trigger the report batches: for each selected report × side (LIVE + REG), call its ``trigger_proc``
    with ``db_source`` + business date, capture the unique ``job_run_no``, and record the run + extracts.
    Returns immediately (the batches run async); the UI then polls ``/status``."""
    _require_reconciliation(request, body)
    if not body.reports:
        raise HTTPException(status_code=400, detail="Select at least one report to run.")
    if not (body.live_db and body.regression_db):
        raise HTTPException(status_code=400, detail="Select both a LIVE database and a Regression database.")
    if not (body.business_date or "").isdigit() or len(body.business_date) != 8:
        raise HTTPException(status_code=400, detail="Business date must be an 8-digit YYYYMMDD value.")
    if RECON_USE_DUMMY:
        return {"status": "success", **_dummy_trigger(body)}
    try:
        scfg = _scope_db(request, body.scope)
        cfg = getattr(request.app.state, "app_db_config", None)
        env = request.app.state.app_env
        run_id = database.recon_run_start(cfg, env, body.scope, body.live_db, body.regression_db,
                                          body.business_date, body.caller, body.regression_run_id)
        report_defs = {r["report_code"]: r for r in database.fetch_recon_reports(scfg)}
        extracts = []
        for code in body.reports:
            rdef = report_defs.get(code)
            if not rdef:
                continue
            for side, db_source in (("LIVE", body.live_db), ("REG", body.regression_db)):
                # Each side calls the report's PL/SQL batch on its DB; the proc returns a unique job_run_no.
                # ISOLATION: one report/side failing to submit is recorded as failed, never aborts the rest.
                try:
                    job_run_no = database.recon_call_trigger(
                        _db_for(request, db_source), rdef["trigger_proc"],
                        report_code=code, db_source=db_source, business_date=body.business_date)
                    st, msg = "queued", None
                except Exception as exc:  # noqa: BLE001
                    logger.exception("recon trigger submit failed %s/%s", code, side)
                    job_run_no, st, msg = None, "failed", db_errors.classify(exc)[1]
                eid = database.recon_extract_insert(cfg, run_id, code, side, db_source, job_run_no, st, msg)
                extracts.append({"extract_id": eid, "report_code": code, "side": side,
                                 "db_source": db_source, "job_run_no": job_run_no, "status": st, "message": msg})
        return {"status": "success", "run_id": run_id, "extracts": extracts}
    except HTTPException:
        raise
    except Exception:
        logger.exception("recon trigger failed for %s", body.scope)
        raise db_errors.http_error()


@router.post("/status")
def status(request: Request, body: RunBody) -> dict:
    """Poll every extract by ``job_run_no``, derive the per-report state, then (Phase 2) auto-compare any
    report whose both sides are READY: load the two outputs (file/table), run the compare, store the
    result, and return PASS/FAIL + counts. Per-report isolation — one report's failure never affects others."""
    _require_reconciliation(request, body)
    if RECON_USE_DUMMY:
        return {"status": "success", **_dummy_status(body.run_id)}
    try:
        cfg = getattr(request.app.state, "app_db_config", None)
        scfg = _scope_db(request, body.scope)
        scope_cfg = config_loader.reconciliation_config(body.scope)
        extracts = database.recon_run_extracts(cfg, body.run_id)             # stored extracts (+ job_run_no)
        job_status: dict[str, dict] = {}
        for db_source in {e["db_source"] for e in extracts}:
            nos = [e["job_run_no"] for e in extracts if e["db_source"] == db_source and e.get("job_run_no")]
            if nos:
                try:
                    job_status.update(database.recon_poll_status(_db_for(request, db_source), nos))
                except Exception:
                    logger.exception("recon poll failed for db %s", db_source)
        for e in extracts:
            _resolve_extract_state(e, job_status, scope_cfg)
        reports = _derive_report_states(extracts)
        # Phase 2: compare each report whose extracts are both READY (auto). Isolated per report.
        report_defs = {r["report_code"]: r for r in database.fetch_recon_reports(scfg)}
        existing = database.recon_results_for_run(cfg, body.run_id)
        sides_by_report: dict[str, dict] = {}
        for e in extracts:
            sides_by_report.setdefault(e["report_code"], {})[e["side"]] = e
        for rep in reports:
            if rep["state"] != "ready":
                continue
            code = rep["report_code"]
            try:
                summ = existing.get(code) or _compute_and_store(
                    request, body, code, report_defs.get(code), scope_cfg, cfg, sides_by_report.get(code, {}))
                _apply_result(rep, summ)
            except Exception:
                logger.exception("recon compare failed for %s", code)
                rep["state"], rep["message"] = "compare_error", "Couldn't compare — retry, or contact OLS Dev."
        return {"status": "success", "run_id": body.run_id, "reports": reports}
    except Exception:
        logger.exception("recon status failed for run %s", body.run_id)
        raise db_errors.http_error()


@router.post("/compare")
def compare(request: Request, body: ReportBody) -> dict:
    """Manually (re)run the comparison for one report — forces a fresh compute even if a result exists."""
    _require_reconciliation(request, body)
    if RECON_USE_DUMMY:
        return {"status": "success", **_dummy_compare(body.run_id, body.report_code)}
    try:
        cfg = getattr(request.app.state, "app_db_config", None)
        scfg = _scope_db(request, body.scope)
        scope_cfg = config_loader.reconciliation_config(body.scope)
        rdef = next((r for r in database.fetch_recon_reports(scfg) if r["report_code"] == body.report_code), None)
        extracts = [e for e in database.recon_run_extracts(cfg, body.run_id) if e["report_code"] == body.report_code]
        sides = {e["side"]: e for e in extracts}
        summ = _compute_and_store(request, body, body.report_code, rdef, scope_cfg, cfg, sides, force=True)
        if summ is None:
            raise HTTPException(status_code=409, detail="Extract output is not available for both sides yet.")
        return {"status": "success", "report_code": body.report_code, "result": summ}
    except HTTPException:
        raise
    except Exception:
        logger.exception("recon compare failed for %s", body.report_code)
        raise db_errors.http_error()


@router.post("/discrepancies")
def discrepancies(request: Request, body: ReportBody) -> dict:
    """The drill-down grid for one report's comparison: ``{columns, rows}`` (Type + keys + per-measure
    LIVE/REG/Δ). Read from the stored result."""
    _require_reconciliation(request, body)
    if RECON_USE_DUMMY:
        return {"status": "success", **_dummy_discrepancies(body.run_id, body.report_code)}
    try:
        cfg = getattr(request.app.state, "app_db_config", None)
        res = database.recon_result_get(cfg, body.run_id, body.report_code)
        if not res or not res.get("detail_json"):
            return {"status": "success", "columns": [], "rows": []}
        detail = json.loads(res["detail_json"])
        return {"status": "success", "columns": detail.get("columns", []), "rows": detail.get("rows", [])}
    except Exception:
        logger.exception("recon discrepancies failed for %s", body.report_code)
        raise db_errors.http_error()


# ---- compare helpers (real path) -------------------------------------------
def _load_side(request: Request, body: TriggerBody | ReportBody, rdef: dict, side: str,
               db_source: str, scope_cfg: dict) -> dict | None:
    """Load one side's extract output → {columns, rows}. FILE mode reads the CSV the batch wrote to the
    deterministic path; TABLE mode reads the shared staging table. None when the output isn't there."""
    mode = (rdef.get("output_mode") or "FILE").upper()
    if mode == "TABLE":
        return database.recon_load_dataset_table(_db_for(request, db_source), scope_cfg["staging_table"],
                                                 body.run_id, side, rdef["report_code"])
    path = ops.extract_csv_path(scope_cfg["extract_base_dir"], body.run_id, rdef["report_code"], side)
    return ops.read_csv_dataset(path)


def _compute_and_store(request: Request, body, code: str, rdef: dict | None, scope_cfg: dict,
                       cfg, sides: dict, force: bool = False) -> dict | None:
    """Load both sides, compare, store the result. Returns the summary (with columns/rows) or None when an
    output is missing (→ NO_DATA). ``sides`` = {'LIVE': extract, 'REG': extract} for the db_source per side."""
    if rdef is None:
        return None
    live_db = (sides.get("LIVE") or {}).get("db_source") or body.__dict__.get("live_db", "")
    reg_db = (sides.get("REG") or {}).get("db_source") or body.__dict__.get("regression_db", "")
    live = _load_side(request, body, rdef, "LIVE", live_db, scope_cfg)
    reg = _load_side(request, body, rdef, "REG", reg_db, scope_cfg)
    if live is None or reg is None:
        return None
    summ = ops.compare_datasets(live, reg, rdef.get("key_columns"), rdef.get("measure_columns"),
                                rdef.get("tolerance_type", "EXACT"), float(rdef.get("tolerance_value") or 0))
    detail = json.dumps({"columns": summ["columns"], "rows": summ["rows"]})
    database.recon_result_upsert(cfg, body.run_id, code, summ, detail, getattr(body, "caller", None))
    return summ


def _apply_result(rep: dict, summ: dict | None) -> None:
    """Fold a comparison summary into a report row (state → pass/fail + counts + message)."""
    if summ is None:
        rep["state"], rep["message"] = "no_data", "Extract finished but no data was produced — please contact OLS Dev."
        return
    rep["state"] = "pass" if summ.get("status") == "PASS" else "fail"
    for k in ("matched", "changed", "missing", "extra", "compared"):
        rep[k] = summ.get(k, 0)
    rep["message"] = (f"{summ.get('matched', 0)} matched · {summ.get('changed', 0)} changed · "
                      f"{summ.get('missing', 0)} missing · {summ.get('extra', 0)} extra")


@router.post("/activity")
def activity(request: Request, body: Caller) -> dict:
    """Extract Log history for the scope (db, report, business date, status, who/when)."""
    _require_reconciliation(request, body)
    if RECON_USE_DUMMY:
        return {"status": "success", "rows": _dummy_activity(body.scope)}
    try:
        cfg = getattr(request.app.state, "app_db_config", None)
        return {"status": "success", "rows": database.recon_activity(cfg, body.scope)}
    except Exception:
        logger.exception("recon activity failed for %s", body.scope)
        raise db_errors.http_error()


# ---- state derivation (shared by real + dummy) -----------------------------
_STATE_RANK = {"failed": 4, "no_data": 3, "queued": 2, "running": 2, "done": 1}


def _db_for(request: Request, db_source: str):
    """Privileged connection to run a batch trigger / poll against a specific DB name (e.g. OLSCD1)."""
    cfgs = getattr(request.app.state, "sql_db_configs", None) or getattr(request.app.state, "db_configs", {})
    return cfgs.get(db_source)


def _resolve_extract_state(extract: dict, job_status: dict, scope_cfg: dict) -> None:
    """Update one extract's status from its job_run_no's raw batch status (mapped via status_map), then
    the READY vs NO_DATA output check when done. Mutates ``extract`` in place."""
    if extract.get("status") in ("failed", "no_data", "done"):
        return  # already settled at trigger time (e.g. submit failed) or by a prior poll
    raw = (job_status.get(extract.get("job_run_no")) or {}).get("status")
    side_state = _map_status(raw, scope_cfg.get("status_map", {}))
    if side_state == "failed":
        extract["status"], extract["message"] = "failed", "Extract batch failed — please take action."
    elif side_state == "done":
        # Phase 2 wires the real file/table output check here; Phase 1 marks done as ready.
        extract["status"] = "done"
    else:
        extract["status"] = "running"


def _map_status(raw: str | None, status_map: dict) -> str:
    up = str(raw or "").upper()
    for state, values in status_map.items():
        if up in [str(v).upper() for v in (values or [])]:
            return state
    return "running"  # unknown/absent → assume still going (don't falsely mark done)


def _derive_report_states(extracts: list[dict]) -> list[dict]:
    """Collapse each report's two sides into one report row with the precedence
    Failed > No-data > Extracting > Ready. Isolated per report."""
    by_report: dict[str, dict] = {}
    for e in extracts:
        by_report.setdefault(e["report_code"], {})[e["side"]] = e
    out = []
    for code, sides in by_report.items():
        live, reg = sides.get("LIVE"), sides.get("REG")
        states = [s.get("status", "queued") for s in (live, reg) if s]
        if "failed" in states:
            rep = "extract_failed"; msg = _side_msg(sides, "failed", "Extract failed — please take action")
        elif "no_data" in states:
            rep = "no_data"; msg = _side_msg(sides, "no_data", "Extract finished but no data was produced — please contact OLS Dev")
        elif any(s in ("queued", "running") for s in states) or len(states) < 2:
            rep = "extracting"; msg = "Extract still running…"
        else:
            rep = "ready"; msg = "Extracts ready — comparison will run (Phase 2)."
        out.append({
            "report_code": code, "state": rep, "message": msg,
            "live": _side_view(live), "reg": _side_view(reg),
        })
    return out


def _side_msg(sides: dict, want: str, base: str) -> str:
    bad = [s for s, e in sides.items() if e and e.get("status") == want]
    return f"{base} ({', '.join(bad)})." if bad else base + "."


def _side_view(e: dict | None) -> dict:
    if not e:
        return {"status": "queued", "job_run_no": None}
    return {"status": e.get("status", "queued"), "job_run_no": e.get("job_run_no"),
            "db_source": e.get("db_source"), "message": e.get("message")}


# ===========================================================================
# Dummy (dev / backend-only). The frontend mock interceptor is the primary dev path; this mirrors it.
# ===========================================================================
_DUMMY_RUNS: dict[int, dict] = {}
_DUMMY_SEQ = [5000]
_DUMMY_JOB = [900000]
_DUMMY_RUN_SECS = 8.0


def _dummy_reports(scope: str) -> list[dict]:
    base = (scope or "cib").upper()
    def r(code, name, cat, sub, mode, keys):
        return {"report_code": f"{base}_{code}", "report_name": name, "category": cat, "sub_category": sub,
                "output_mode": mode, "key_columns": keys, "measure_columns": "AMOUNT"}
    return [
        r("ALMT_ACT_PNL", "P&L Aggregate", "ALMT", "Activity", "FILE", "LMA_CODE,CPT_CODE,AMOUNT_CODE"),
        r("ALMT_ACT_POS", "Positions", "ALMT", "Activity", "TABLE", "LMA_CODE,CPT_CODE"),
        r("ALMT_STD_BAL", "Balances", "ALMT", "StdBs", "FILE", "LMA_CODE"),
        r("ALMT_STD_FEES", "Fees Summary", "ALMT", "StdBs", "FILE", "CPT_CODE,AMOUNT_CODE"),
        r("CB_RISK", "Risk Exposure", "CB", "", "TABLE", "LMA_CODE,CPT_CODE,AMOUNT_CODE"),
        r("CB_LIQ", "Liquidity Summary", "CB", "", "FILE", "LMA_CODE,CPT_CODE"),
    ]


def _dummy_databases(scope: str) -> list[dict]:
    s = (scope or "cib").upper()[:1] or "C"
    return [{"key": f"OLS{s}D1", "label": f"OLS{s}D1 (DEV 1)"},
            {"key": f"OLS{s}D2", "label": f"OLS{s}D2 (DEV 2)"},
            {"key": f"OLS{s}R1", "label": f"OLS{s}R1 (Regression 1)"},
            {"key": f"OLS{s}R2", "label": f"OLS{s}R2 (Regression 2)"}]


def _dummy_regression_runs(scope: str) -> list[dict]:
    if (scope or "").lower() == "group":
        return []   # Group has no regression
    return [{"run_id": 42, "change_number": "CHG0123456", "release_date": "20260910", "label": "Run #42 · CHG0123456 · 2026-09-10"},
            {"run_id": 39, "change_number": "CHG0123001", "release_date": "20260828", "label": "Run #39 · CHG0123001 · 2026-08-28"}]


def _dummy_trigger(body: TriggerBody) -> dict:
    _DUMMY_SEQ[0] += 1
    run_id = _DUMMY_SEQ[0]
    extracts = []
    for code in body.reports:
        for side, db_source in (("LIVE", body.live_db), ("REG", body.regression_db)):
            _DUMMY_JOB[0] += 1
            extracts.append({"report_code": code, "side": side, "db_source": db_source,
                             "job_run_no": str(_DUMMY_JOB[0]), "status": "queued", "message": None})
    _DUMMY_RUNS[run_id] = {"submitted": time.time(), "reports": list(body.reports), "extracts": extracts}
    return {"run_id": run_id, "extracts": extracts}


def _dummy_status(run_id: int) -> dict:
    """Time-based progression so the UI shows queued→running→done, plus a deliberate FAILED and NO_DATA
    to exercise the state machine (…_RISK fails; the last report's REG side has no data)."""
    run = _DUMMY_RUNS.get(run_id)
    if not run:
        return {"run_id": run_id, "reports": []}
    elapsed = time.time() - run["submitted"]
    reports = run["reports"]
    last = reports[-1] if reports else None
    for e in run["extracts"]:
        if e["status"] in ("failed", "no_data", "done"):
            continue
        if elapsed < 3:
            e["status"] = "running"
        elif elapsed < _DUMMY_RUN_SECS:
            e["status"] = "running"
        else:
            if e["report_code"].endswith("_RISK"):
                e["status"], e["message"] = "failed", "Extract batch failed — please take action."
            elif last and e["report_code"] == last and e["side"] == "REG":
                e["status"], e["message"] = "no_data", "no rows produced"
            else:
                e["status"] = "done"
    reports = _derive_report_states(run["extracts"])
    # Phase 2 (dummy): auto-compare each READY report using the REAL engine on fabricated datasets.
    for rep in reports:
        if rep["state"] == "ready":
            _apply_result(rep, _dummy_ensure_result(run, rep["report_code"]))
    return {"run_id": run_id, "reports": reports}


def _dummy_datasets(code: str) -> tuple[dict, dict]:
    """Two fabricated aggregate datasets (the user's sample shape). Reports ending in ACT_PNL are made to
    FAIL (one changed AMOUNT, one row missing in REG, one extra in REG); every other report is identical (PASS)."""
    cols = ["LMA_CODE", "CPT_CODE", "AMOUNT_CODE", "AMOUNT"]
    live = [["IXL12", "CTE23", "AMC45", 5000], ["IXL12", "CTE23", "AMC44", 3000],
            ["IXL12", "CTE23", "AMC42", 2000], ["IXL14", "CTE24", "AMC45", 70000],
            ["IXL15", "CTE28", "AMC45", 8000], ["IXL17", "CTE23", "AMC45", 30000]]
    reg = [r[:] for r in live]
    if code.endswith("ACT_PNL"):
        reg[0][3] = 4800                                  # changed: 5000 → 4800
        reg = [r for r in reg if r[0] != "IXL17"]         # missing in REG
        reg.append(["IXL19", "CTE23", "AMC45", 1500])     # extra in REG
    return {"columns": cols, "rows": live}, {"columns": cols, "rows": reg}


def _dummy_ensure_result(run: dict, code: str) -> dict:
    """Compute (once, cached) the dummy comparison for a report via the real engine, and remember the
    discrepancy grid for the drill-down."""
    cache = run.setdefault("results", {})
    if code not in cache:
        live, reg = _dummy_datasets(code)
        cache[code] = ops.compare_datasets(live, reg, "LMA_CODE,CPT_CODE,AMOUNT_CODE", "AMOUNT", "EXACT", 0)
    return cache[code]


def _dummy_compare(run_id: int, code: str) -> dict:
    run = _DUMMY_RUNS.get(run_id) or {}
    summ = _dummy_ensure_result(run, code) if run else ops.compare_datasets(*_dummy_datasets(code), "LMA_CODE,CPT_CODE,AMOUNT_CODE", "AMOUNT")
    return {"report_code": code, "result": summ}


def _dummy_discrepancies(run_id: int, code: str) -> dict:
    run = _DUMMY_RUNS.get(run_id) or {}
    summ = _dummy_ensure_result(run, code) if run else ops.compare_datasets(*_dummy_datasets(code), "LMA_CODE,CPT_CODE,AMOUNT_CODE", "AMOUNT")
    return {"columns": summ["columns"], "rows": summ["rows"]}


def _dummy_activity(scope: str) -> list[dict]:
    base = (scope or "cib").upper()
    return [
        {"report_code": f"{base}_ALMT_ACT_PNL", "side": "LIVE", "db_source": f"OLS{base[:1]}D1", "business_date": "20260912",
         "job_run_no": "900101", "status": "done", "triggered_by": "OPS-10432", "triggered_on": "2026-09-12 19:40:11"},
        {"report_code": f"{base}_ALMT_ACT_PNL", "side": "REG", "db_source": f"OLS{base[:1]}R1", "business_date": "20260912",
         "job_run_no": "900102", "status": "done", "triggered_by": "OPS-10432", "triggered_on": "2026-09-12 19:40:11"},
        {"report_code": f"{base}_CB_RISK", "side": "LIVE", "db_source": f"OLS{base[:1]}D1", "business_date": "20260912",
         "job_run_no": "900109", "status": "failed", "triggered_by": "OPS-10432", "triggered_on": "2026-09-12 19:40:11"},
    ]
