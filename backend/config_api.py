"""Config Ops — CSV Upload & Load API (see UPLOAD_DESIGN.md).

The FIRST real Config-write path (the rest of Config Ops is mocked today). Validates the uploaded CSV
against the table's real schema (data dictionary), type-casts every cell, then loads it **atomically**
via ``database.config_load_table`` (Append = insert only; Replace = delete-then-insert, whole table or
by the single COB date). Archives the file to NAS and writes a maximal ``ols_upload_audit`` row.

Data/API split: ALL SQL lives in ``database.py``; this module parses, validates, casts, orchestrates,
does file I/O, and gates the caller. Register in ``app.py``.
"""

from __future__ import annotations

import csv
import hashlib
import io
import os
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from uuid import uuid4

from env_loader import env_bool

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import database
from utils.logging import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/config", tags=["config-upload"])

CONFIG_USE_DUMMY = env_bool("ACCESS_USE_DUMMY", True)
ARCHIVE_DIR = os.getenv("CONFIG_UPLOAD_ARCHIVE_DIR", "")
MAX_ROWS = int(os.getenv("CONFIG_UPLOAD_MAX_ROWS", "200000") or "200000")
MAX_MB = int(os.getenv("CONFIG_UPLOAD_MAX_MB", "50") or "50")
BATCH_SIZE = int(os.getenv("CONFIG_UPLOAD_BATCH_SIZE", "5000") or "5000")
# System/audit columns the load sets itself — never expected in the file.
AUDIT_COLUMNS = {c.strip().upper() for c in os.getenv(
    "CONFIG_UPLOAD_AUDIT_COLUMNS", "INSERTED_BY,INSERTED_DATE,INSERTED_ON,UPDATED_BY,UPDATED_DATE,UPDATED_ON").split(",") if c.strip()}


class UploadBody(BaseModel):
    caller: str
    mode: str                       # append | replace
    delimiter: str = ","
    original_filename: str = "upload.csv"
    file_content: str               # the reviewed/edited CSV (header + valid rows)


class RollBody(BaseModel):
    rolled_by: str
    table_name: str
    source_date: str                # YYYY-MM-DD
    target_dates: list[str]         # one or more YYYY-MM-DD
    tablespace: str | None = None


class CellError(Exception):
    def __init__(self, column: str, reason: str):
        self.column = column
        self.reason = reason
        super().__init__(f"{column}: {reason}")


# ---- gate ------------------------------------------------------------------
def _require_config_write(request: Request, caller: str, scope: str):
    """Active OLS user with write access to this config scope (admin or config_ops:<scope> grant)."""
    if CONFIG_USE_DUMMY:
        return None
    cfg = getattr(request.app.state, "app_db_config", None)
    ident = database.fetch_user_identity(cfg, caller)
    if not ident or str(ident.get("lgcl_del_flg") or "").strip().upper() != "N":
        raise HTTPException(status_code=403, detail="Not an active OLS user.")
    is_admin = str(ident.get("is_admin") or "").strip().upper() in ("Y", "YES", "1", "TRUE")
    if not is_admin:
        grants = database.fetch_user_grants(cfg, caller, getattr(request.app.state, "app_env", "PROD"))
        want = f"config_ops:{scope}".lower()
        if not any((g.get("resource_scope") or "").lower() == want for g in grants):
            raise HTTPException(status_code=403, detail=f"Write access to {scope.upper()} config is required.")
    return cfg


def _scope_db(request: Request, scope: str):
    """Privileged connection for a config scope (never the read-only monitor db_configs)."""
    cfgs = getattr(request.app.state, "sql_db_configs", None) or getattr(request.app.state, "db_configs", {})
    cfg = cfgs.get(scope)
    if cfg is None:
        raise HTTPException(status_code=503, detail=f"Config DB for scope '{scope}' is not reachable.")
    return cfg


# ---- parsing + casting -----------------------------------------------------
def _parse_csv(text: str, delimiter: str) -> tuple[list[str], list[list[str]]]:
    """RFC-4180 parse via the stdlib csv module. Returns (header, data_rows)."""
    if text and text[0] == "﻿":       # strip BOM
        text = text[1:]
    delim = {"\\t": "\t", "tab": "\t"}.get(delimiter, delimiter) or ","
    reader = csv.reader(io.StringIO(text), delimiter=delim)
    rows = [r for r in reader if r != []]
    if not rows:
        raise HTTPException(status_code=400, detail="The file is empty.")
    return rows[0], rows[1:]


def _parse_dt(s: str, is_ts: bool) -> datetime:
    fmts = (("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d") if is_ts
            else ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"))
    for fmt in fmts:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    raise ValueError("expected YYYY-MM-DD" + (" HH24:MI:SS" if is_ts else ""))


def _cast(value: str, col: dict):
    """Type-cast one cell per the column's Oracle type. '' → NULL. Raises CellError on bad value."""
    v = (value or "").strip()
    if v == "":
        return None
    t = str(col["type"]).upper()
    try:
        if t == "DATE":
            return _parse_dt(v, False)
        if t.startswith("TIMESTAMP"):
            return _parse_dt(v, True)
        if t in ("NUMBER", "FLOAT", "INTEGER", "BINARY_FLOAT", "BINARY_DOUBLE"):
            try:
                return Decimal(v)
            except InvalidOperation:
                raise ValueError("not a number")
        return v            # VARCHAR2/CHAR/CLOB/etc.
    except ValueError as exc:
        raise CellError(col["name"], str(exc)) from exc


def _validate_header(file_header: list[str], loadable: list[dict]) -> list[dict]:
    """Strict left-prefix match (name + position, case-insensitive). Trailing columns may be omitted
    (auto-NULL) if nullable. Returns the omitted columns. Raises HTTPException on mismatch."""
    fh = [h.strip().upper() for h in file_header]
    lc = [c["name"].upper() for c in loadable]
    if len(fh) > len(lc):
        raise HTTPException(status_code=400, detail=f"File has {len(fh)} columns but the table has {len(lc)}.")
    for i, name in enumerate(fh):
        if name != lc[i]:
            raise HTTPException(status_code=400,
                                detail=f"Column {i + 1}: expected '{lc[i]}', got '{name}'. Columns must match name and order.")
    omitted = loadable[len(fh):]
    required = [c["name"] for c in omitted if not c["nullable"]]
    if required:
        raise HTTPException(status_code=400, detail=f"File omits required (NOT NULL) column(s): {', '.join(required)}.")
    return omitted


def _archive(content: str, original_filename: str, caller: str, token: str) -> str:
    """Copy the loaded CSV to the NAS archive dir as <stem>_<user>_<token>.csv. Returns the path
    (or '' if no archive dir configured)."""
    if not ARCHIVE_DIR:
        return ""
    stem = Path(original_filename).stem or "upload"
    safe_user = "".join(ch for ch in caller if ch.isalnum() or ch in "-_") or "user"
    Path(ARCHIVE_DIR).mkdir(parents=True, exist_ok=True)
    dest = Path(ARCHIVE_DIR) / f"{stem}_{safe_user}_{token}.csv"
    dest.write_text(content, encoding="utf-8")
    return str(dest)


# ---- roll data (COB tables) ------------------------------------------------
@router.post("/{scope}/roll")
def config_roll(scope: str, request: Request, body: RollBody) -> dict:
    """Roll a COB table's data from one source date to one or more target dates. Copies (replace) the
    source rows into each target date. Returns per-date counts."""
    _require_config_write(request, body.rolled_by, scope)
    try:
        src = _parse_dt(body.source_date, False)
        seen, targets = set(), []
        for d in body.target_dates:
            dt = _parse_dt(d, False)
            if dt != src and dt not in seen:
                seen.add(dt); targets.append(dt)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Dates must be YYYY-MM-DD ({exc}).")
    if not targets:
        raise HTTPException(status_code=400, detail="Provide at least one target date different from the source.")
    if CONFIG_USE_DUMMY:
        return {"status": "success", "source_date": body.source_date, "source_count": 0,
                "targets": [{"date": d, "count": 0} for d in body.target_dates]}
    dbcfg = _scope_db(request, scope)
    date_col = database.config_date_column(dbcfg, body.table_name)
    if not date_col:
        raise HTTPException(status_code=400, detail=f"'{body.table_name}' is not a date-partitioned table.")
    try:
        result = database.config_roll_dates(dbcfg, table=body.table_name, date_col=date_col,
                                            source_date=src, target_dates=targets, roller=body.rolled_by,
                                            audit_cols=AUDIT_COLUMNS)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
    return {"status": "success", **result}


# ---- upload & load ---------------------------------------------------------
@router.post("/{scope}/table/{table}/upload")
def config_upload(scope: str, table: str, request: Request, body: UploadBody) -> dict:
    _require_config_write(request, body.caller, scope)
    if body.mode not in ("append", "replace"):
        raise HTTPException(status_code=400, detail="mode must be 'append' or 'replace'.")
    if len(body.file_content.encode("utf-8")) > MAX_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"File exceeds the {MAX_MB} MB limit.")

    if CONFIG_USE_DUMMY:
        header, data_rows = _parse_csv(body.file_content, body.delimiter)
        return {"status": "success", "result": {
            "load_id": 0, "mode": body.mode, "rows_loaded": len(data_rows), "rows_deleted": 0,
            "rows_rejected": 0, "cob_dt": None, "archived": "(dummy)"}}

    dbcfg = _scope_db(request, scope)
    started = datetime.now()
    columns = database.config_table_columns(dbcfg, table)
    if not columns:
        raise HTTPException(status_code=404, detail=f"Unknown table '{table}'.")
    date_col = database.config_date_column(dbcfg, table)
    loadable = [c for c in columns if c["name"].upper() not in AUDIT_COLUMNS]

    header, data_rows = _parse_csv(body.file_content, body.delimiter)
    if len(data_rows) > MAX_ROWS:
        raise HTTPException(status_code=413, detail=f"File has {len(data_rows)} rows (limit {MAX_ROWS}).")
    omitted = _validate_header(header, loadable)
    if date_col and date_col.upper() in {c["name"].upper() for c in omitted}:
        raise HTTPException(status_code=400, detail=f"The date column '{date_col}' is required and cannot be omitted.")

    provided = loadable[:len(header)]
    cast_rows, rejects = [], []
    for rn, raw in enumerate(data_rows, start=1):
        try:
            vals = [_cast(raw[i] if i < len(raw) else "", provided[i]) for i in range(len(provided))]
            vals += [None] * len(omitted)
            cast_rows.append(vals)
        except CellError as ce:
            rejects.append({"row": rn, "column": ce.column, "reason": ce.reason})
    if rejects:
        return {"status": "rejected", "rejects": rejects[:1000], "rows_rejected": len(rejects)}

    cob_dt = None
    if date_col:
        di = [c["name"].upper() for c in loadable].index(date_col.upper())
        dates = {r[di] for r in cast_rows}
        if len(dates) > 1:
            raise HTTPException(status_code=400,
                                detail=f"The file has {len(dates)} distinct {date_col} values. Upload one date per file.")
        cob_dt = next(iter(dates)) if dates else None

    now = datetime.now()
    present_audit = {c["name"].upper() for c in columns} & AUDIT_COLUMNS
    system_defaults: dict[str, Any] = {}
    if "INSERTED_BY" in present_audit:
        system_defaults["INSERTED_BY"] = body.caller
    if "INSERTED_DATE" in present_audit:
        system_defaults["INSERTED_DATE"] = now
    if "INSERTED_ON" in present_audit:
        system_defaults["INSERTED_ON"] = now

    insert_cols = [c["name"] for c in loadable]
    lock_key = f"{scope}|{table.upper()}" + (f"|{cob_dt.isoformat()}" if cob_dt else "")
    token = uuid4().hex[:8]
    common = dict(app_env=getattr(request.app.state, "app_env", None), scope=scope, table_name=table,
                  load_mode=body.mode, date_col=date_col, cob_dt=(cob_dt.isoformat() if cob_dt else None),
                  original_filename=body.original_filename, delimiter=body.delimiter, uploaded_by=body.caller,
                  uploaded_on=started, rows_in_file=len(data_rows), rows_rejected=len(rejects),
                  file_hash=hashlib.sha256(body.file_content.encode("utf-8")).hexdigest())
    try:
        result = database.config_load_table(
            dbcfg, table=table, columns=insert_cols, rows=cast_rows, mode=body.mode,
            date_col=date_col, cob_dt=cob_dt, system_defaults=system_defaults,
            lock_key=lock_key, locked_by=body.caller, batch_size=BATCH_SIZE)
    except Exception as exc:  # noqa: BLE001 — audit the failure, then surface it
        database.config_upload_audit_write(dbcfg, **common, archived_path="", finished_on=datetime.now(),
                                           duration_secs=(datetime.now() - started).total_seconds(),
                                           rows_loaded=0, rows_deleted=0, status="failed", error_detail=str(exc))
        raise HTTPException(status_code=409 if "in progress" in str(exc) else 500, detail=str(exc))

    archived = _archive(body.file_content, body.original_filename, body.caller, token)
    load_id = database.config_upload_audit_write(
        dbcfg, **common, archived_path=archived, finished_on=datetime.now(),
        duration_secs=(datetime.now() - started).total_seconds(),
        rows_loaded=result["rows_loaded"], rows_deleted=result["rows_deleted"], status="success", error_detail=None)
    return {"status": "success", "result": {
        "load_id": load_id, "mode": body.mode, "rows_loaded": result["rows_loaded"],
        "rows_deleted": result["rows_deleted"], "rows_rejected": len(rejects),
        "cob_dt": (cob_dt.isoformat() if cob_dt else None), "archived": archived}}
