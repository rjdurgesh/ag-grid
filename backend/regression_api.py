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


class CopyBody(Caller):
    run_id: int
    items: list[dict]


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
def run_start(request: Request, body: Caller) -> dict:
    cfg = _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success", "run": {"run_id": 1, "app_env": "DEV", "status": "in_progress", "started_by": body.caller}, "steps": {}}
    env = request.app.state.app_env
    rid = database.regression_run_start(cfg, env, body.caller)
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
        return {"status": "success", "branches": ["release/20260828", "release/20260815"]}
    try:
        return {"status": "success", "branches": ops.list_release_branches(config_loader.regression_scope_config(body.scope))}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/git/pull")
def git_pull(request: Request, body: PullBody) -> dict:
    _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success", "scripts": ["apply/CHG_20260828.sql", "apply/CHG_20260828_MISC1.sql", "reset/reset_batches.sql", "trigger/trigger_all.sql"]}
    cfg = config_loader.regression_scope_config(body.scope)
    try:
        ops.git_pull_branch(cfg, body.branch)
        return {"status": "success", "scripts": ops.list_branch_scripts(cfg)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@router.post("/git/scripts")
def git_scripts(request: Request, body: Caller) -> dict:
    _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success", "scripts": ["apply/CHG_20260828.sql", "reset/reset_batches.sql", "trigger/trigger_all.sql"]}
    return {"status": "success", "scripts": ops.list_branch_scripts(config_loader.regression_scope_config(body.scope))}


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
@router.post("/file-copy/manifest")
def file_copy_manifest(request: Request, body: Caller) -> dict:
    _require_regression(request, body.caller)
    if REGRESSION_USE_DUMMY:
        return {"status": "success", "items": [
            {"source": "\\\\eur17\\d$\\release\\cib\\app.config", "destination": "\\\\eur34\\e$\\apps\\cib\\app.config"},
            {"source": "\\\\eur17\\d$\\release\\cib\\scripts\\*", "destination": "\\\\eur34\\e$\\apps\\cib\\scripts"},
        ]}
    manifest = config_loader.regression_scope_config(body.scope)["filecopy_manifest"]
    if not manifest:
        raise HTTPException(status_code=400, detail="No file-copy manifest configured for this scope (config/regression.json).")
    try:
        return {"status": "success", "items": ops.read_manifest(manifest)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Could not read the file-copy manifest: {exc}")


def _copy_details(results: list[dict]) -> str:
    """Human-readable CLOB body: per-item OK/FAIL with the files copied (or the failure reason)."""
    lines: list[str] = []
    for r in results:
        if r.get("ok"):
            lines.append(f"OK   {r.get('source')} -> {r.get('destination')}  ({r.get('count', 0)} file(s))")
            lines.extend(f"       {f}" for f in (r.get("files") or []))
        else:
            lines.append(f"FAIL {r.get('source')} -> {r.get('destination')}: {r.get('error', '')}")
    return "\n".join(lines)


@router.post("/file-copy/run")
def file_copy_run(request: Request, body: CopyBody) -> dict:
    cfg = _require_regression(request, body.caller)
    if not body.items:
        raise HTTPException(status_code=400, detail="Select at least one item to copy.")
    _require_step_free(cfg, body.run_id, "file_copy")
    _mark_in_progress(cfg, body.run_id, "file_copy", body.caller)
    if REGRESSION_USE_DUMMY:
        results = []
        for i in body.items:
            src = str(i.get("source", "")); dst = str(i.get("destination", ""))
            folder = src.rstrip("/\\").endswith("*")
            if folder and ("reports" in src.lower() or "partial" in src.lower()):
                results.append({"source": src, "destination": dst, "ok": False, "kind": "folder", "count": 450,
                                "error": f"Folder copy FAILED after 450 file(s) — the WHOLE folder must be re-copied "
                                         f"(re-run the step). Failed on {dst}\\report_0451.dat: ERROR 112 (0x70): There is not enough space on the disk."})
                continue
            if "missing" in src.lower() or "fail" in src.lower():
                results.append({"source": src, "destination": dst, "ok": False,
                                "error": "ERROR 5 (0x5): The system cannot find the path specified."})
                continue
            names = (["app.config", "bootstrap.properties", "log4j2.xml", "scripts\\run.bat", "lib\\core.jar"]
                     if folder else [dst.split("\\")[-1]])
            files = [f"{dst}\\{n}" for n in names] if folder else [dst]
            results.append({"source": src, "destination": dst, "ok": True, "count": len(files),
                            "kind": "folder" if folder else "file", "files": files})
        return {"status": "success", "results": results}
    # Copy + LOG each item incrementally, so if the server crashes / the connection drops mid-copy the
    # audit table still records exactly which items completed (and which files) — the operator can see
    # what was done and safely re-run the step (copies overwrite, so it's idempotent).
    results = []
    for item in body.items:
        started = datetime.now()
        r = ops.copy_items([item])[0]
        database.regression_log_write(cfg, body.run_id, "file_copy", "copy_item",
                                      "complete" if r.get("ok") else "error", body.caller,
                                      comments=_copy_details([r]), start_time=started, end_time=datetime.now())
        results.append(r)
    ok = all(r.get("ok") for r in results)
    fails = sum(1 for r in results if not r.get("ok"))
    copied = sum((r.get("count") or 0) for r in results if r.get("ok"))
    summary = f"{copied} file(s) across {len(results) - fails} item(s)" + (f"; {fails} item(s) FAILED" if fails else "")
    database.regression_log_write(cfg, body.run_id, "file_copy", "copy", "complete" if ok else "error",
                                  body.caller, comments=f"{summary}\n{_copy_details(results)}")
    return {"status": "success", "results": results}


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
