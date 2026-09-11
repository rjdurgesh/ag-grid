"""Regression screen API (DEV/STG only) — orchestrates the regression cycle and writes the audit log.

Follows the data/API split: SQL is in ``database.py`` (run/log/activity/batch-monitor); OS-level ops
(git, sqlplus, file copy) are in ``regression_ops.py``; this module gates the caller, calls them, and
records the audit trail. Registered in ``app.py``. See RBAC_DESIGN.md / the Regression screen plan.

GATE: hard-blocked unless the BACKEND's ``app.state.app_env`` is DEV or STG (never PROD), plus the
caller is an active OLS user with CIB Config access (admin or a ``config_ops:cib`` grant).
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime
from typing import Any

from env_loader import env_bool

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import config_loader
import database
import regression_ops as ops
from utils.logging import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/regression", tags=["regression"])

REGRESSION_USE_DUMMY = env_bool("ACCESS_USE_DUMMY", True)
DEFAULT_DB = "cib_batch"
# Per-scope settings (git repo, work/log dirs, NAS feed path) come from config/regression.json via
# config_loader.regression_scope_config(body.scope); each endpoint resolves them for the caller's scope.
# A step in_progress longer than this is treated as possibly-stuck (crash between start + result):
# the lock stops blocking it and the UI offers a logged "Unlock" so the run isn't deadlocked forever.
STEP_STALE_SECS = config_loader.regression_defaults()["step_stale_minutes"] * 60


# ---- request models --------------------------------------------------------
# Every request carries `scope` (cib | retail | group) — set by each scope's frontend service — which
# selects that app's per-scope config + separate regression state. Inheriting Caller adds it everywhere.
class Caller(BaseModel):
    caller: str
    scope: str = "cib"


class MarkBody(Caller):
    run_id: int
    step_key: str
    status: str                    # in_progress | complete | error | forced
    forced: bool = False
    business_line: str | None = None
    details: str | None = None


class RefreshBody(Caller):
    run_id: int
    dbs: list[str] = []            # databases to refresh (all 5 selectable)


class CompleteBody(Caller):
    run_id: int
    status: str = "complete"


class UnlockBody(Caller):
    run_id: int
    step_key: str


class PullBody(Caller):
    branch: str


class StartBody(Caller):
    branch: str = ""               # the release/* branch this run applies
    release_date: str = ""         # YYYYMMDD folder — validated against the pulled branch


class ReleaseScriptsBody(Caller):
    release_date: str
    dbs: list[str] = []            # chg*.sql are resolved PER DB (each DB has its own Scripts folder)


class BatchDBScriptsBody(Caller):
    db: str = ""                   # RegressionTesting scripts for this DB (Reset / Trigger batches steps)


class RunSqlBody(Caller):
    run_id: int
    step_key: str                  # apply_db | reset | trigger
    scripts: list[str]
    dbs: list[str]
    business_line: str | None = None


class LogBody(Caller):
    log_file: str


class FileBody(Caller):
    path: str


class ManifestsBody(Caller):
    release_date: str = ""         # discover filecopy_manifest*.json under Scripts/<date> per script-root


class ReadManifestBody(Caller):
    path: str                      # repo-relative path of the chosen manifest to read


class CopyBody(Caller):
    run_id: int
    items: list[dict]              # the items to copy NOW (a subset the operator ticked)
    manifest: list[dict] = []      # the FULL manifest — so the step is Complete only when every item is done


class PreflightBody(Caller):
    items: list[dict]              # {source,destination} to readiness-check BEFORE copying (copies nothing)


class MonitorBody(Caller):
    db: str = DEFAULT_DB


class ActivityBody(Caller):
    run_id: int | None = None


# ---- gate ------------------------------------------------------------------
def _require_regression(request: Request, caller: str):
    """Return the app DB config after confirming DEV/STG + CIB Config access; else 403. None in dummy."""
    if REGRESSION_USE_DUMMY:
        return None
    if str(getattr(request.app.state, "app_env", "PROD")).upper() not in ("DEV", "STG"):
        raise HTTPException(status_code=403, detail="Regression is available only in DEV/STG.")
    cfg = getattr(request.app.state, "app_db_config", None)
    ident = database.fetch_user_identity(cfg, caller)
    if not ident or str(ident.get("lgcl_del_flg") or "").strip().upper() != "N":
        raise HTTPException(status_code=403, detail="Not an active OLS user.")
    is_admin = str(ident.get("is_admin") or "").strip().upper() in ("Y", "YES", "1", "TRUE")
    if not is_admin:
        grants = database.fetch_user_grants(cfg, caller, request.app.state.app_env)
        has_cib = any((g.get("resource_scope") or "").lower() == "config_ops:cib" for g in grants)
        if not has_cib:
            raise HTTPException(status_code=403, detail="CIB Config access required.")
    return cfg


def _db_config(request: Request, db_key: str):
    """Privileged connection for a DB (same source S-Studio uses)."""
    cfgs = getattr(request.app.state, "sql_db_configs", None) or getattr(request.app.state, "db_configs", {})
    if db_key not in cfgs:
        raise HTTPException(status_code=400, detail=f"Unknown database '{db_key}'")
    cfg = cfgs.get(db_key)
    if cfg is None:
        raise HTTPException(status_code=503, detail=f"Database '{db_key}' is not reachable")
    return cfg


def _require_step_free(cfg: Any, run_id: int, step_key: str) -> None:
    """Concurrency lock — reject if this step is already running (in_progress and not stale), so two
    operators can't trigger the same step at once. A stale (likely-stuck) step does NOT block."""
    if cfg is None:
        return
    st = database.regression_step_state(cfg, run_id, step_key)
    if st and st.get("status") == "in_progress" and (st.get("age_seconds") or 0) <= STEP_STALE_SECS:
        who = st.get("performed_by") or "another user"
        raise HTTPException(status_code=409,
                            detail=f"'{step_key}' is already running (started by {who}). Wait for it to finish, or unlock it if it looks stuck.")


def _mark_in_progress(cfg: Any, run_id: int, step_key: str, caller: str) -> None:
    """Durable in_progress marker (visible to other operators + the lock); cleared when the step
    writes its complete/error result."""
    if cfg is None:
        return
    database.regression_log_write(cfg, run_id, step_key, "start", "in_progress", caller, start_time=datetime.now())


# ---- run + steps -----------------------------------------------------------
@router.post("/run/current")
def run_current(request: Request, body: Caller) -> dict:
    cfg = _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success", "run": None, "steps": {}}
    return {"status": "success", **(database.regression_run_current(cfg, request.app.state.app_env) or {"run": None, "steps": {}})}


@router.post("/run/start")
def run_start(request: Request, body: StartBody) -> dict:
    """Open a run for a specific release: the pulled `branch` + a `release_date` (YYYYMMDD folder).
    The date is HARD-VALIDATED against the release folders actually present in the pulled branch, so a
    wrong/absent date is rejected with the list of what's available (no run is created)."""
    cfg = _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success", "run": {"run_id": 1, "app_env": "DEV", "status": "in_progress",
                                             "started_by": body.caller, "git_branch": body.branch,
                                             "release_date": body.release_date}, "steps": {}}
    scfg = config_loader.regression_scope_config(body.scope)
    available = ops.list_release_dates(scfg)
    if not body.release_date or body.release_date not in available:
        shown = ", ".join(available[:12]) if available else "(none found — pull the release branch first)"
        raise HTTPException(status_code=400,
                            detail=f"No release folder '{body.release_date or ''}' in the pulled branch. Available: {shown}")
    env = request.app.state.app_env
    rid = database.regression_run_start(cfg, env, body.caller, body.branch, body.release_date)
    return {"status": "success", **(database.regression_run_current(cfg, env) or {"run": {"run_id": rid}, "steps": {}})}


@router.post("/step/mark")
def step_mark(request: Request, body: MarkBody) -> dict:
    cfg = _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success"}
    now = datetime.now()
    database.regression_log_write(
        cfg, body.run_id, body.step_key,
        action=("forced" if body.forced else body.status), status=body.status,
        performed_by=body.caller, business_line=body.business_line,
        forced_by=(body.caller if body.forced else None), comments=body.details,
        start_time=now, end_time=now,
    )
    return {"status": "success", **(database.regression_run_current(cfg, request.app.state.app_env) or {})}


@router.post("/step/unlock")
def step_unlock(request: Request, body: UnlockBody) -> dict:
    """Clear a stuck in_progress step (crash/drop between start and result) so the run isn't
    deadlocked. Logged as an 'unlock' with who did it; the step becomes re-runnable (status error)."""
    cfg = _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success"}
    now = datetime.now()
    database.regression_log_write(cfg, body.run_id, body.step_key, "unlock", "error", body.caller,
                                  comments=f"Stuck in-progress step cleared by {body.caller}.", start_time=now, end_time=now)
    return {"status": "success", **(database.regression_run_current(cfg, request.app.state.app_env) or {})}


@router.post("/refresh-databases")
def refresh_databases(request: Request, body: Caller) -> dict:
    """The databases refreshable for THIS scope in the current env (DEV/STG can have several — both
    batch + reporting). Scope-specific (cib screen → cib DBs) and env-specific (per-server config), so
    the Refresh-DB picker only ever shows this env's own databases. `{databases: [{key,label}]}`."""
    _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        env = str(getattr(request.app.state, "app_env", "DEV")).upper() or "DEV"
        # grouped BATCH / REPORTING, with a few instances each to exercise the dropdown
        canned = {
            "cib": {"BATCH": [f"OLS_CIB_BATCH_{env}", f"OLS_CIB_BATCH_{env}_02", f"OLS_CIB_BATCH_{env}_03"],
                    "REPORTING": [f"OLS_CIB_REPORTING_{env}", f"OLS_CIB_REPORTING_{env}_02"]},
            "retail": {"BATCH": [f"OLS_RET_BATCH_{env}", f"OLS_RET_BATCH_{env}_02"],
                       "REPORTING": [f"OLS_RET_REPORTING_{env}"]},
            "group": {"BATCH": [f"OLS_GROUP_{env}"]},
        }
        groups = canned.get(body.scope, canned["cib"])
        dbs = [{"key": n, "label": n, "category": cat} for cat, names in groups.items() for n in names]
        return {"status": "success", "databases": dbs}
    return {"status": "success", "databases": config_loader.regression_scope_config(body.scope)["refresh_databases"]}


@router.post("/refresh-db")
def refresh_db(request: Request, body: RefreshBody) -> dict:
    """Step 1 — call the (dummy) refresh API for the selected DB(s) and log it."""
    cfg = _require_regression(request, body.caller)
    _require_step_free(cfg, body.run_id, "refresh_db")
    _mark_in_progress(cfg, body.run_id, "refresh_db", body.caller)
    started = datetime.now()
    dbs = body.dbs or []
    refresh_url = config_loader.regression_scope_config(body.scope)["refresh_url"]
    detail = f"Refresh API: {refresh_url or '(dummy stub — not configured)'} — DB(s): {', '.join(dbs) or '(none)'}"
    result_status = "complete"       # dummy always succeeds; wire the scope's refresh_url later
    if not REGRESSION_USE_DUMMY:
        database.regression_log_write(cfg, body.run_id, "refresh_db", "refresh", result_status,
                                      body.caller, comments=detail, start_time=started, end_time=datetime.now())
    return {"status": "success",
            "result": {"status": result_status, "message": f"Refresh triggered for {len(dbs)} database(s) (dummy).", "details": detail}}


@router.post("/run/complete")
def run_complete(request: Request, body: CompleteBody) -> dict:
    """Close out a run once every step is complete/forced — log the completion + mark it finished."""
    cfg = _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success"}
    now = datetime.now()
    database.regression_log_write(cfg, body.run_id, "run", "complete", body.status, body.caller,
                                  comments="Regression run completed", start_time=now, end_time=now)
    database.regression_run_finish(cfg, body.run_id, body.status)
    return {"status": "success", **(database.regression_run_current(cfg, request.app.state.app_env) or {"run": None, "steps": {}})}


# ---- git -------------------------------------------------------------------
@router.post("/git/branches")
def git_branches(request: Request, body: Caller) -> dict:
    _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success", "branches": ["release/2026-09-10", "release/2026-08-15"]}
    try:
        return {"status": "success", "branches": ops.list_release_branches(config_loader.regression_scope_config(body.scope))}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/git/pull")
def git_pull(request: Request, body: PullBody) -> dict:
    _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success", "scripts": ["reset/reset_batches.sql", "trigger/trigger_all.sql"],
                "release_dates": ["20260910", "20260815", "20260710"]}
    cfg = config_loader.regression_scope_config(body.scope)
    try:
        ops.git_pull_branch(cfg, body.branch)
        # release_dates → the run-start date hint + validation source (folders in THIS pulled branch)
        return {"status": "success", "scripts": ops.list_branch_scripts(cfg),
                "release_dates": ops.list_release_dates(cfg)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/release/dates")
def release_dates(request: Request, body: Caller) -> dict:
    """Release folders (YYYYMMDD) present in the pulled branch, newest first — refresh the date hint
    without re-pulling."""
    _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success", "release_dates": ["20260910", "20260815", "20260710"]}
    return {"status": "success", "release_dates": ops.list_release_dates(config_loader.regression_scope_config(body.scope))}


@router.post("/release/scripts")
def release_scripts(request: Request, body: ReleaseScriptsBody) -> dict:
    """chg*.sql for a release, resolved PER DB (cib_batch ← CIB/Batch/Scripts/<date>, cib_reporting ←
    CIB/Reporting/Scripts/<date>, retail/group ← their single root). Returns {db: [scripts]} so the
    Apply step runs each DB's scripts against that DB only (never cross-product)."""
    _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        canned = {
            "cib_batch": [f"CIB/Batch/Scripts/{body.release_date}/chg_batch_001.sql",
                          f"CIB/Batch/Scripts/{body.release_date}/chg_batch_002.sql"],
            "cib_reporting": [f"CIB/Reporting/Scripts/{body.release_date}/chg_rpt_001.sql"],
            "retail_batch": [f"RET/Scripts/{body.release_date}/chg_ret_001.sql"],
            "retail_reporting": [f"RET/Scripts/{body.release_date}/chg_ret_001.sql"],
            "group": [f"Scripts/{body.release_date}/chg_grp_001.sql"],
        }
        return {"status": "success", "scripts": {d: canned.get(d, []) for d in (body.dbs or ["cib_batch"])}}
    cfg = config_loader.regression_scope_config(body.scope)
    try:
        return {"status": "success", "scripts": {d: ops.list_release_scripts(cfg, body.release_date, d) for d in body.dbs}}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/git/scripts")
def git_scripts(request: Request, body: Caller) -> dict:
    _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success", "scripts": ["apply/CHG_20260828.sql", "reset/reset_batches.sql", "trigger/trigger_all.sql"]}
    return {"status": "success", "scripts": ops.list_branch_scripts(config_loader.regression_scope_config(body.scope))}


@router.post("/batch-db-scripts")
def batch_db_scripts(request: Request, body: BatchDBScriptsBody) -> dict:
    """.sql scripts from the selected DB's **RegressionTesting** folder — the Reset / Trigger batches steps
    pick from here (separate from Apply's Scripts/<release_date>/chg*.sql). `{scripts: string[]}`."""
    _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        db = body.db or "cib_batch"
        base = "CIB/Batch/RegressionTesting" if "batch" in db else "CIB/Reporting/RegressionTesting"
        return {"status": "success", "scripts": [f"{base}/reset_batches.sql", f"{base}/trigger_all.sql",
                                                 f"{base}/trigger_CB.sql", f"{base}/trigger_ALMT.sql"]}
    return {"status": "success", "scripts": ops.list_batch_db_scripts(config_loader.regression_scope_config(body.scope), body.db)}


@router.post("/git/tree")
def git_tree(request: Request, body: Caller) -> dict:
    """The whole pulled branch (files) + info, so the operator can browse it and verify referenced
    packages/procs exist with the latest code."""
    _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success", "workdir": "D:/ols/regression/work", "branch": "release/20260828",
                "files": ["apply/CHG_20260828.sql", "apply/CHG_20260828_MISC1.sql",
                          "db/package/lam/abc.pck", "db/package/lam/xyz.pck", "db/package/cb/cb_valuation.pck",
                          "db/procedure/lam/load_positions.prc", "reset/reset_batches.sql",
                          "trigger/trigger_all.sql", "trigger/trigger_CB.sql", "README.md"]}
    cfg = config_loader.regression_scope_config(body.scope)
    return {"status": "success", **ops.repo_info(cfg), "files": ops.list_repo_tree(cfg)}


@router.post("/git/file")
def git_file(request: Request, body: FileBody) -> dict:
    """Content of one file in the pulled branch (verification / review)."""
    _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success", "path": body.path,
                "content": f"-- {body.path}\nCREATE OR REPLACE PACKAGE BODY abc AS\n  PROCEDURE run IS BEGIN NULL; END;\nEND abc;\n/"}
    try:
        return {"status": "success", "path": body.path,
                "content": ops.read_repo_file(config_loader.regression_scope_config(body.scope), body.path)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=404, detail=str(exc))


# ---- run-sql (Apply / Reset / Trigger share this) --------------------------
@router.post("/run-sql")
def run_sql(request: Request, body: RunSqlBody) -> dict:
    cfg = _require_regression(request, body.caller)
    if not body.scripts or not body.dbs:
        raise HTTPException(status_code=400, detail="Pick at least one script and one database.")
    _require_step_free(cfg, body.run_id, body.step_key)
    _mark_in_progress(cfg, body.run_id, body.step_key, body.caller)
    if REGRESSION_USE_DUMMY:
        results = [{"script": s, "db": d, "status": "complete", "log_file": f"D:/ols/regression/logs/dummy/{s.split('/')[-1]}__{d}.log",
                    "tail": f"Connected to {d}.\n@{s}\nPL/SQL procedure successfully completed.\nSpool off."}
                   for s in body.scripts for d in body.dbs]
        return {"status": "success", "results": results, "step_status": "complete"}
    rcfg = config_loader.regression_scope_config(body.scope)
    results, any_error = [], False
    for s in body.scripts:
        for d in body.dbs:
            started = datetime.now()
            try:
                r = ops.run_sqlplus(rcfg, _db_config(request, d), d, s)
            except Exception as exc:  # noqa: BLE001
                r = {"status": "error", "script": s, "db": d, "log_file": "", "tail": str(exc)}
            any_error = any_error or r["status"] != "complete"
            database.regression_log_write(cfg, body.run_id, body.step_key, "run_sql", r["status"],
                                          body.caller, business_line=body.business_line,
                                          comments=f"{s} on {d} -> {r['status']} (log: {r.get('log_file','')})",
                                          start_time=started, end_time=datetime.now())
            results.append(r)
    step_status = "error" if any_error else "complete"
    database.regression_log_write(cfg, body.run_id, body.step_key, "run_sql_done", step_status,
                                  body.caller, business_line=body.business_line,
                                  comments=f"{len(body.scripts)} script(s) x {len(body.dbs)} db(s)")
    return {"status": "success", "results": results, "step_status": step_status}


def _sse(event: str, data: dict) -> str:
    """One Server-Sent Event frame."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@router.post("/run-sql-stream")
def run_sql_stream(request: Request, body: RunSqlBody):
    """LIVE sqlplus: stream each script×db run's output line-by-line (SSE) so the console fills in
    real time. Same per-script + summary audit logging as /run-sql. Used by Apply/Reset/Trigger."""
    cfg = _require_regression(request, body.caller)
    if not body.scripts or not body.dbs:
        raise HTTPException(status_code=400, detail="Pick at least one script and one database.")
    _require_step_free(cfg, body.run_id, body.step_key)
    _mark_in_progress(cfg, body.run_id, body.step_key, body.caller)
    combos = [(s, d) for s in body.scripts for d in body.dbs]
    rcfg = config_loader.regression_scope_config(body.scope)

    def gen():
        any_error = False
        for s, d in combos:
            yield _sse("line", {"text": f"===== {s} · {d} ====="})
            started = datetime.now()
            status, log_file = "complete", ""
            if REGRESSION_USE_DUMMY:
                is_err = "ERR" in s.upper()
                for t in (f"Connected to {d}.", f"@{s}",
                          "ORA-00942: table or view does not exist" if is_err else "PL/SQL procedure successfully completed.",
                          "Spool off."):
                    yield _sse("line", {"text": t})
                    time.sleep(0.12)
                status = "error" if is_err else "complete"
            else:
                try:
                    for ev in ops.run_sqlplus_stream(rcfg, _db_config(request, d), d, s):
                        if ev.get("type") == "line":
                            yield _sse("line", {"text": ev["text"]})
                        else:
                            status, log_file = ev.get("status", "complete"), ev.get("log_file", "")
                except Exception as exc:  # noqa: BLE001
                    status = "error"
                    yield _sse("line", {"text": str(exc)})
                database.regression_log_write(cfg, body.run_id, body.step_key, "run_sql", status,
                                              body.caller, business_line=body.business_line,
                                              comments=f"{s} on {d} -> {status} (log: {log_file})",
                                              start_time=started, end_time=datetime.now())
            any_error = any_error or status != "complete"
            yield _sse("result", {"script": s, "db": d, "status": status, "log_file": log_file})
        step_status = "error" if any_error else "complete"
        if not REGRESSION_USE_DUMMY:
            database.regression_log_write(cfg, body.run_id, body.step_key, "run_sql_done", step_status,
                                          body.caller, business_line=body.business_line,
                                          comments=f"{len(body.scripts)} script(s) x {len(body.dbs)} db(s)")
        yield _sse("step", {"step_status": step_status})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/log/read")
def log_read(request: Request, body: LogBody) -> dict:
    _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success", "content": "Dummy log content.\nConnected.\nPL/SQL procedure successfully completed."}
    try:
        return {"status": "success", "content": ops.read_log(config_loader.regression_scope_config(body.scope), body.log_file)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=404, detail=str(exc))


# ---- file copy -------------------------------------------------------------
# Manifest lives IN the release repo at <Scripts-root>/<release_date>/filecopy_manifest*.json (NOT in
# config). File Copy is Complete only when EVERY manifest item is copied; a subset → Partial. Per-item
# state persists in the audit log (copy_item rows carry JSON), so ✓/⏳/✗ survive a reload.

def _stamp(r: dict, started: datetime, finished: datetime) -> dict:
    """Attach per-item timing (started / finished / duration seconds) to a copy result."""
    r["started"] = started.strftime("%Y-%m-%d %H:%M:%S")
    r["finished"] = finished.strftime("%Y-%m-%d %H:%M:%S")
    r["seconds"] = max(0, int((finished - started).total_seconds()))
    return r


def _dummy_copy_results(items: list[dict]) -> list[dict]:
    """Canned per-item copy results for the server-dummy path (folder → several files; 'fail'/'reports' → error)."""
    results = []
    now = datetime.now()
    for i in items:
        src = str(i.get("source", "")); dst = str(i.get("destination", ""))
        folder = src.rstrip("/\\").endswith("*")
        if folder and ("reports" in src.lower() or "partial" in src.lower()):
            r = {"source": src, "destination": dst, "ok": False, "kind": "folder", "count": 450, "folders": 3,
                 "error": "Folder copy FAILED after 450 file(s) — the WHOLE folder must be re-copied. "
                          "Failed on report_0451.dat: ERROR 112 (0x70): There is not enough space on the disk."}
        elif "missing" in src.lower() or "fail" in src.lower():
            r = {"source": src, "destination": dst, "ok": False, "count": 0, "folders": 0,
                 "error": "ERROR 5 (0x5): The system cannot find the path specified."}
        else:
            names = (["app.config", "log4j2.xml", "lib/core.jar"] if folder else [dst.split("\\")[-1]])
            files = [f"{dst}\\{n}" for n in names]
            r = {"source": src, "destination": dst, "ok": True, "count": len(files),
                 "folders": 3 if folder else 0, "kind": "folder" if folder else "file", "verified": True, "verify": "size", "files": files}
        results.append(_stamp(r, now, now))
    return results


def _copy_verify_mode(cfg) -> str:
    """Post-copy integrity mode from config (off | size | hash); anything unknown falls back to size."""
    m = str((cfg or {}).get("filecopy_verify") or "size").lower()
    return m if m in ("off", "size", "hash") else "size"


def _fmt_dur(secs: int) -> str:
    """Human-readable duration: '8s', '2m 30s', '1h 05m' — never a raw '600s' for a 10-minute copy."""
    secs = max(0, int(secs))
    if secs < 60:
        return f"{secs}s"
    m, s = divmod(secs, 60)
    if m < 60:
        return f"{m}m {s}s" if s else f"{m}m"
    h, m = divmod(m, 60)
    return f"{h}h {m:02d}m" if m else f"{h}h"


def _copy_summary(done: int, total: int, action_results: list[dict], fails: int) -> str:
    """Two-part human summary written to the 'copy' audit row: what THIS run did (so a single-file copy
    reads as its own operation) plus cumulative manifest progress. E.g.
    'Run: 1 copied · 1 file · 1s.  Manifest: 4/5 copied (1 remaining).'"""
    okc = sum(1 for r in action_results if r.get("ok"))
    tf = sum(int(r.get("count") or 0) for r in action_results)
    td = sum(int(r.get("folders") or 0) for r in action_results)
    ts = sum(int(r.get("seconds") or 0) for r in action_results)
    run = f"Run: {okc} copied" + (f", {fails} failed" if fails else "")
    run += f" · {tf} file(s)" + (f" · {td} folder(s)" if td else "") + f" · {_fmt_dur(ts)}"
    remaining = max(0, total - done)
    man = f"Manifest: {done}/{total} copied" + (f" ({remaining} remaining)" if remaining else "")
    return f"{run}.  {man}."


def _dummy_preflight(items: list[dict]) -> list[dict]:
    """Canned readiness results for the server-dummy path (a 'missing'/'fail' source → not found)."""
    out = []
    for i in items:
        src = str(i.get("source", "")); dst = str(i.get("destination", ""))
        bad = "missing" in src.lower() or "fail" in src.lower()
        out.append({"source": src, "destination": dst, "source_ok": not bad, "dest_ok": True, "space_ok": True,
                    "source_bytes": 0 if bad else 4096, "free_bytes": 5_000_000_000,
                    "ok": not bad, "note": "" if not bad else "source not found"})
    return out


def _copy_state(cfg, run_id: int) -> dict:
    """Per-item file-copy state (key 'src|dst' → latest {status,count,folders,error}) from the run's
    copy_item audit rows (each row's comments is JSON)."""
    state: dict = {}
    for row in database.regression_copy_items(cfg, run_id):
        try:
            d = json.loads(row.get("comments") or "{}")
        except Exception:  # noqa: BLE001
            continue
        src, dst = d.get("source"), d.get("destination")
        if src and dst:
            state[f"{src}|{dst}"] = {"source": src, "destination": dst, "status": row.get("status"),
                                     "count": d.get("count", 0), "folders": d.get("folders", 0), "error": d.get("error")}
    return state


def _finalize_copy(cfg, run_id: int, caller: str, action_results: list[dict], manifest: list[dict]) -> str:
    """Write the summary 'copy' row with the step status derived from the FULL manifest: complete only
    when every item is copied, error on any failure, else partial. Returns the step status."""
    state = _copy_state(cfg, run_id)
    keys = [f"{i.get('source')}|{i.get('destination')}" for i in manifest if i.get("source") and i.get("destination")]
    okc = sum(1 for r in action_results if r.get("ok"))
    fails = len(action_results) - okc
    if keys:
        done = sum(1 for k in keys if state.get(k, {}).get("status") == "complete")
        failed = any(state.get(k, {}).get("status") == "error" for k in keys)
        total = len(keys)
        status = "error" if failed else "complete" if done >= total else "partial" if done else "in_progress"
    else:
        done, total = okc, len(action_results)
        status = "complete" if fails == 0 else "error"
    summary = _copy_summary(done, total, action_results, fails)
    database.regression_log_write(cfg, run_id, "file_copy", "copy", status, caller,
                                  comments=json.dumps({"summary": summary, "items": action_results}))
    return status


@router.post("/file-copy/manifests")
def file_copy_manifests(request: Request, body: ManifestsBody) -> dict:
    """Discover filecopy_manifest*.json in the pulled branch under each Scripts root's <release_date>/
    folder → one entry per folder that has one (the UI shows a labelled dropdown per folder)."""
    _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        d = body.release_date or "20260921"
        return {"status": "success", "locations": [
            {"root": "CIB/Batch/Scripts", "label": "CIB/Batch/Scripts", "files": [f"CIB/Batch/Scripts/{d}/filecopy_manifest_{d}.json"]},
            {"root": "CIB/Reporting/Scripts", "label": "CIB/Reporting/Scripts", "files": [f"CIB/Reporting/Scripts/{d}/filecopy_manifest_{d}.json"]},
        ]}
    return {"status": "success", "locations": ops.list_filecopy_manifests(config_loader.regression_scope_config(body.scope), body.release_date)}


@router.post("/file-copy/manifest")
def file_copy_manifest(request: Request, body: ReadManifestBody) -> dict:
    """Read one chosen manifest (by repo-relative path) → its {source,destination} items."""
    _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success", "items": [
            {"source": "\\\\eur17\\d$\\release\\cib\\app.config", "destination": "\\\\eur34\\e$\\apps\\cib\\app.config"},
            {"source": "\\\\eur17\\d$\\release\\cib\\scripts\\*", "destination": "\\\\eur34\\e$\\apps\\cib\\scripts"},
        ]}
    try:
        return {"status": "success", "items": ops.read_manifest_file(config_loader.regression_scope_config(body.scope), body.path)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Could not read the manifest: {exc}")


@router.post("/file-copy/preflight")
def file_copy_preflight(request: Request, body: PreflightBody) -> dict:
    """READ-ONLY readiness check before a copy — per item: source exists, destination reachable/writable,
    enough free space. Copies + logs NOTHING; lets the operator catch problems before running the step."""
    _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success", "results": _dummy_preflight(body.items)}
    return {"status": "success", "results": ops.preflight_items(body.items)}


@router.post("/file-copy/run")
def file_copy_run(request: Request, body: CopyBody) -> dict:
    """Copy the selected items; log each incrementally (crash-safe) then a summary row whose status is
    Complete/Partial/Error vs the full manifest. (Mock/stream variants share this shape.)"""
    cfg = _require_regression(request, body.caller)
    if not body.items:
        raise HTTPException(status_code=400, detail="Select at least one item to copy.")
    _require_step_free(cfg, body.run_id, "file_copy")
    _mark_in_progress(cfg, body.run_id, "file_copy", body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success", "results": _dummy_copy_results(body.items), "step_status": "complete"}
    verify = _copy_verify_mode(cfg)
    results = []
    for item in body.items:
        started = datetime.now()
        r = ops.copy_items([item], verify=verify)[0]
        finished = datetime.now()
        _stamp(r, started, finished)
        database.regression_log_write(cfg, body.run_id, "file_copy", "copy_item",
                                      "complete" if r.get("ok") else "error", body.caller,
                                      comments=json.dumps(r), start_time=started, end_time=finished)
        results.append(r)
    step_status = _finalize_copy(cfg, body.run_id, body.caller, results, body.manifest)
    return {"status": "success", "results": results, "step_status": step_status}


@router.post("/file-copy/run-stream")
def file_copy_run_stream(request: Request, body: CopyBody):
    """LIVE file copy: stream one event per item as it finishes (SSE) so the UI shows a progress bar +
    per-file ✓/✗. Same incremental logging + manifest-based step status as /file-copy/run."""
    cfg = _require_regression(request, body.caller)
    if not body.items:
        raise HTTPException(status_code=400, detail="Select at least one item to copy.")
    _require_step_free(cfg, body.run_id, "file_copy")
    _mark_in_progress(cfg, body.run_id, "file_copy", body.caller)
    total = len(body.items)

    verify = _copy_verify_mode(cfg)

    def gen():
        results = []
        for idx, item in enumerate(body.items, start=1):
            if REGRESSION_USE_DUMMY:
                time.sleep(0.25)
                r = _dummy_copy_results([item])[0]
            else:
                started = datetime.now()
                r = ops.copy_items([item], verify=verify)[0]
                finished = datetime.now()
                _stamp(r, started, finished)
                database.regression_log_write(cfg, body.run_id, "file_copy", "copy_item",
                                              "complete" if r.get("ok") else "error", body.caller,
                                              comments=json.dumps(r), start_time=started, end_time=finished)
            results.append(r)
            yield _sse("item", {"result": r, "done": idx, "total": total})
        step_status = ("complete" if all(x.get("ok") for x in results) else "error") if REGRESSION_USE_DUMMY \
            else _finalize_copy(cfg, body.run_id, body.caller, results, body.manifest)
        yield _sse("step", {"step_status": step_status})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---- monitoring ------------------------------------------------------------
@router.post("/batch-monitor")
def batch_monitor(request: Request, body: MonitorBody) -> dict:
    _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success", "columns": ["BUSINESS_LINE", "BATCH", "STATUS_ID", "STARTED", "FINISHED"],
                "rows": [["CB", "CB_LOAD", 2, "2026-08-28 09:00", "2026-08-28 09:12"],
                         ["CB", "CB_VALUATION", 1, "2026-08-28 09:12", None],
                         ["ALMT", "ALMT_ETL", 2, "2026-08-28 08:40", "2026-08-28 09:05"],
                         ["FI", "FI_POST", 3, "2026-08-28 08:30", "2026-08-28 08:31"]]}
    try:
        return {"status": "success", **database.fetch_batch_monitor(_db_config(request, body.db))}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/activity")
def activity(request: Request, body: ActivityBody) -> dict:
    cfg = _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success", "rows": []}
    return {"status": "success", "rows": database.regression_activity(cfg, body.run_id)}
