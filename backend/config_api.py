"""Config Ops — CSV Upload & Load API (see GUIDE.md §4, "Config Ops — CSV Upload & Load").

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
import re
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

# Upload settings come from config/config_ops.json (per server), falling back to CONFIG_UPLOAD_* .env
# vars, then defaults. CONFIG_USE_DUMMY reuses the shared ACCESS_USE_DUMMY flag (stays in .env).
import config_loader
_CFG = config_loader.config_ops_config()

CONFIG_USE_DUMMY = env_bool("ACCESS_USE_DUMMY", True)
ARCHIVE_DIR = _CFG["archive_dir"]
MAX_ROWS = _CFG["max_rows"]
MAX_MB = _CFG["max_mb"]
BATCH_SIZE = _CFG["batch_size"]
# System/audit columns the load sets itself — never expected in the file.
AUDIT_COLUMNS = {str(c).strip().upper() for c in _CFG["audit_columns"] if str(c).strip()}
# Safety cap for the eye-view content grid (the modal virtualises; this bounds one payload).
CONTENT_MAX_ROWS = 5000


class UploadBody(BaseModel):
    caller: str
    mode: str                       # append | replace
    delimiter: str = ","
    original_filename: str = "upload.csv"
    file_content: str               # the reviewed/edited CSV (header + valid rows)
    db_source: str = ""             # the table's physical DB (ols_cib_batch | ols_cib_reporting | …)
    is_cobdt: str = "N"             # 'Y' → the table is date-partitioned; apply the date-column rules


class RollBody(BaseModel):
    rolled_by: str
    table_name: str
    source_date: str                # YYYY-MM-DD
    target_dates: list[str]         # one or more YYYY-MM-DD
    tablespace: str | None = None
    db_source: str = ""             # the table's physical DB (ols_cib_batch | ols_cib_reporting | …)


# --- read + CRUD request bodies (each carries db_source → the table's physical DB) ---------------
class ColumnDetailBody(BaseModel):
    table_name: str
    db_source: str = ""
    caller: str = ""                # actor (from the SSO token at go-live) for the read gate


class ContentBody(BaseModel):
    table_name: str
    db_source: str = ""
    caller: str = ""
    is_cobdt: str = "N"             # 'Y' → filter by the resolved date column
    start_date: str | None = None
    end_date: str | None = None
    date_range: bool = False


class InsertBody(BaseModel):
    inserted_by: str
    db_source: str = ""
    columns: list[str]
    rows: list[list[Any]]           # value arrays in `columns` order


class UpdateBody(BaseModel):
    updated_by: str
    db_source: str = ""
    updates: list[dict[str, dict]]  # [{ "<rowid>": { COL: value } }] — changed columns only


class DeleteBody(BaseModel):
    deleted_by: str
    db_source: str = ""
    # `Any` (not `list[str]`) so a null/blank id isn't rejected by Pydantic with a cryptic
    # 422 — the handler validates each id via `_valid_rowid` and returns a clear 400 instead.
    rowids: list[Any]


class CellError(Exception):
    def __init__(self, column: str, reason: str):
        self.column = column
        self.reason = reason
        super().__init__(f"{column}: {reason}")


# ---- gate ------------------------------------------------------------------
def _require_config_access(request: Request, caller: str, scope: str, action: str = "write"):
    """Active OLS user with access to this config scope (admin or a ``config_ops:<scope>`` grant). Reads
    and writes use the same scope-visibility check today; ``action`` only tunes the 403 message."""
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
            raise HTTPException(status_code=403, detail=f"{action.capitalize()} access to {scope.upper()} config is required.")
    return cfg


def _require_config_write(request: Request, caller: str, scope: str):
    return _require_config_access(request, caller, scope, "write")


def _require_config_read(request: Request, caller: str, scope: str):
    return _require_config_access(request, caller, scope, "read")


_DB_SOURCE_RE = re.compile(r"^ols_[a-z0-9_]+$")


def _source_db(request: Request, db_source: str, scope: str):
    """Privileged connection for the table's PHYSICAL DB (``db_source`` = an app.py connection key like
    ``ols_cib_batch`` / ``ols_cib_reporting``), never the read-only monitor. A table's config lives in
    the scope's batch DB but the table itself can be in the batch OR reporting DB — ``db_source`` (from
    the catalogue row) routes the op to the right one. Guarded so a scope can only touch its own DBs."""
    key = (db_source or "").strip().lower()
    if not key or not _DB_SOURCE_RE.match(key):
        raise HTTPException(status_code=400, detail="A valid db_source is required (e.g. ols_cib_batch).")
    if not (key == f"ols_{scope.lower()}" or key.startswith(f"ols_{scope.lower()}_")):
        raise HTTPException(status_code=403, detail=f"db_source '{db_source}' does not belong to scope '{scope}'.")
    cfgs = getattr(request.app.state, "sql_db_configs", None) or getattr(request.app.state, "db_configs", {})
    cfg = cfgs.get(key)
    if cfg is None:
        raise HTTPException(status_code=503, detail=f"Config DB '{db_source}' is not reachable.")
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
                "targets": [{"date": d, "status": "success", "count": 0} for d in body.target_dates]}
    dbcfg = _source_db(request, body.db_source, scope)
    try:
        result = database.config_roll_dates(dbcfg, table=body.table_name, source_date=src,
                                            target_dates=targets, uid=body.rolled_by,
                                            tablespace=body.tablespace)
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

    dbcfg = _source_db(request, body.db_source, scope)
    started = datetime.now()
    columns = database.config_table_columns(dbcfg, table)
    if not columns:
        raise HTTPException(status_code=404, detail=f"Unknown table '{table}'.")
    # `is_cobdt` is the catalogue's declaration that this table is DATE/COB-managed — i.e. the upload's
    # date rules (required date column, one date per file, partition check) should apply. It is NOT the
    # same as "physically has a date column": a table can have a DATE column yet not be COB-managed, and
    # such a table must be uploaded like any other. `config_date_column` always returns a default
    # ('COB_DT'), so resolve/enforce the date column ONLY when the catalogue marks the table COB.
    is_cob = str(body.is_cobdt or "").strip().upper() == "Y"
    date_col = database.config_date_column(dbcfg, table) if is_cob else None
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

    # Detect-and-report: if the table is RANGE-partitioned on the date column and the partition for this
    # date doesn't exist yet (e.g. a future COB date), stop BEFORE loading with a clear message — no DDL.
    if date_col and cob_dt is not None:
        part = database.config_partition_status(dbcfg, table, date_col, cob_dt)
        if part.get("covered") is False:
            last = part.get("last_high")
            raise HTTPException(status_code=409, detail=(
                f"The partition for {date_col} = {cob_dt.date()} does not exist on {table}"
                + (f" (partitions cover up to {last})." if last else ".")
                + " Ask the DBA / OLS dev team to create the partition/subpartition, then retry."))

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
                  start_time=started, rows_in_file=len(data_rows), rows_rejected=len(rejects),
                  file_hash=hashlib.sha256(body.file_content.encode("utf-8")).hexdigest())
    try:
        result = database.config_load_table(
            dbcfg, table=table, columns=insert_cols, rows=cast_rows, mode=body.mode,
            date_col=date_col, cob_dt=cob_dt, system_defaults=system_defaults,
            lock_key=lock_key, locked_by=body.caller, batch_size=BATCH_SIZE)
    except Exception as exc:  # noqa: BLE001 — audit the failure, then surface it
        database.config_upload_audit_write(dbcfg, **common, archived_path="", end_time=datetime.now(),
                                           duration_secs=(datetime.now() - started).total_seconds(),
                                           rows_loaded=0, rows_deleted=0, status="failed", error_desc=str(exc))
        raise HTTPException(status_code=409 if "in progress" in str(exc) else 500, detail=str(exc))

    archived = _archive(body.file_content, body.original_filename, body.caller, token)
    load_id = database.config_upload_audit_write(
        dbcfg, **common, archived_path=archived, end_time=datetime.now(),
        duration_secs=(datetime.now() - started).total_seconds(),
        rows_loaded=result["rows_loaded"], rows_deleted=result["rows_deleted"], status="success", error_desc=None)
    return {"status": "success", "result": {
        "load_id": load_id, "mode": body.mode, "rows_loaded": result["rows_loaded"],
        "rows_deleted": result["rows_deleted"], "rows_rejected": len(rejects),
        "cob_dt": (cob_dt.isoformat() if cob_dt else None), "archived": archived}}


# ---- read: column detail (expand) + table content (eye) --------------------
@router.post("/{scope}/columnretrieve")
def config_columnretrieve(scope: str, request: Request, body: ColumnDetailBody) -> dict:
    """Down-arrow expand → the table's column definitions as `{cols, rows}` (rendered as-is)."""
    _require_config_read(request, body.caller, scope)
    if CONFIG_USE_DUMMY:
        return {"cols": ["COLUMN_NAME", "DATA_TYPE", "NULLABLE", "DATA_LENGTH", "DATA_PRECISION", "DATA_SCALE"], "rows": []}
    dbcfg = _source_db(request, body.db_source, scope)
    try:
        return database.config_column_detail(dbcfg, body.table_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/{scope}/retrieve")
def config_retrieve(scope: str, request: Request, body: ContentBody) -> dict:
    """Eye-click → self-describing content `{cols, cols_data_types, Table_data}` (each row carries a
    hidden rowid for update/delete). For a COB table the resolved date column is filtered by the chosen
    date(s)/range; a non-COB table returns the whole table (capped at CONTENT_MAX_ROWS)."""
    _require_config_read(request, body.caller, scope)
    if CONFIG_USE_DUMMY:
        return {"cols": [], "cols_data_types": [], "Table_data": []}
    dbcfg = _source_db(request, body.db_source, scope)
    is_cob = str(body.is_cobdt or "").strip().upper() == "Y"
    date_col = start = end = None
    if is_cob:
        date_col = database.config_date_column(dbcfg, body.table_name)
        try:
            if body.start_date:
                start = _parse_dt(body.start_date, False)
            if body.end_date:
                end = _parse_dt(body.end_date, False)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"Dates must be YYYY-MM-DD ({exc}).")
    try:
        return database.config_table_content(
            dbcfg, table=body.table_name, date_col=date_col, is_cob=is_cob,
            start_date=start, end_date=end, date_range=body.date_range, row_cap=CONTENT_MAX_ROWS)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))


# ---- write: insert / update / delete (rowid-based CRUD) --------------------
def _cast_by_name(coldefs: list[dict], colname: str, cell: Any):
    """Cast one cell to its column's Oracle type, keyed by name. Raises HTTPException(400) on a bad cell."""
    col = next((c for c in coldefs if c["name"].upper() == str(colname).upper()), None)
    if not col:
        raise HTTPException(status_code=400, detail=f"Unknown column '{colname}'.")
    try:
        return _cast("" if cell is None else str(cell), col)
    except CellError as ce:
        raise HTTPException(status_code=400, detail=f"{ce.column}: {ce.reason}")


def _audit_defaults(coldefs: list[dict], actor: str, prefix: str) -> dict:
    """{col: value} for the audit columns of one action that actually exist on the table:
    prefix='INSERTED' → INSERTED_BY/DATE/ON; 'UPDATED' → UPDATED_BY/DATE/ON."""
    now = datetime.now()
    present = {c["name"].upper() for c in coldefs} & AUDIT_COLUMNS
    out: dict[str, Any] = {}
    if f"{prefix}_BY" in present:
        out[f"{prefix}_BY"] = actor
    if f"{prefix}_DATE" in present:
        out[f"{prefix}_DATE"] = now
    if f"{prefix}_ON" in present:
        out[f"{prefix}_ON"] = now
    return out


# Tokens that mean "no usable row id": an empty/whitespace value, or the string a
# frontend produces from a null/undefined id (String(null) / String(undefined)).
_MISSING_ROWID = {"", "none", "null", "undefined"}


def _valid_rowid(rid: Any) -> bool:
    """True if ``rid`` can identify a DB row (rowid-based CRUD). Rejects None and the
    blank/placeholder strings a client sends when the row carried no id."""
    return rid is not None and str(rid).strip().lower() not in _MISSING_ROWID


@router.post("/{scope}/table/{table}/rows")
def config_insert(scope: str, table: str, request: Request, body: InsertBody) -> dict:
    """INSERT rows — cells type-cast per the table schema, INSERTED_* audit stamped server-side. Reuses
    the atomic append path of ``config_load_table``."""
    _require_config_write(request, body.inserted_by, scope)
    if not body.columns or not body.rows:
        raise HTTPException(status_code=400, detail="Nothing to insert — provide at least one row of column values.")
    if all(all(c is None or str(c).strip() == "" for c in (row or [])) for row in body.rows):
        raise HTTPException(status_code=400, detail="Nothing to insert — every row is empty.")
    if CONFIG_USE_DUMMY:
        return {"inserted": len(body.rows)}
    dbcfg = _source_db(request, body.db_source, scope)
    coldefs = database.config_table_columns(dbcfg, table)
    if not coldefs:
        raise HTTPException(status_code=404, detail=f"Unknown table '{table}'.")
    cast_rows = []
    for rn, raw in enumerate(body.rows, start=1):
        try:
            cast_rows.append([_cast_by_name(coldefs, body.columns[i], raw[i] if i < len(raw) else "")
                              for i in range(len(body.columns))])
        except HTTPException as he:
            raise HTTPException(status_code=he.status_code, detail=f"Row {rn}: {he.detail}")
    try:
        result = database.config_load_table(
            dbcfg, table=table, columns=list(body.columns), rows=cast_rows, mode="append",
            system_defaults=_audit_defaults(coldefs, body.inserted_by, "INSERTED"), batch_size=BATCH_SIZE)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
    return {"inserted": result["rows_loaded"]}


@router.post("/{scope}/table/{table}/update")
def config_update(scope: str, table: str, request: Request, body: UpdateBody) -> dict:
    """UPDATE rows by rowid. The whole `updates` payload is handed to the PL/SQL procedure as a JSON
    CLOB (see `database.config_update_rows` / `CONFIG_UPDATE_PROC`); the proc applies the changes by
    ROWID and stamps UPDATED_BY/UPDATED_DATE itself — so no per-cell casting or audit stamping here."""
    _require_config_write(request, body.updated_by, scope)
    if not body.updates:
        raise HTTPException(status_code=400, detail="Nothing to update — no rows were changed.")
    for upd in body.updates:
        if not upd:
            continue
        rid, changes = next(iter(upd.items()))
        if not _valid_rowid(rid):
            raise HTTPException(status_code=400, detail="Row id missing — cannot identify the row to update.")
        if not changes:
            raise HTTPException(status_code=400, detail="No changed columns to update for the selected row.")
    if CONFIG_USE_DUMMY:
        return {"updated": len(body.updates)}
    dbcfg = _source_db(request, body.db_source, scope)
    try:
        updated = database.config_update_rows(dbcfg, table=table, updates=body.updates,
                                              updated_by=body.updated_by)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
    return {"updated": updated}


@router.post("/{scope}/table/{table}/delete")
def config_delete(scope: str, table: str, request: Request, body: DeleteBody) -> dict:
    """DELETE rows by rowid (atomic; DELETE not TRUNCATE)."""
    _require_config_write(request, body.deleted_by, scope)
    if not body.rowids:
        raise HTTPException(status_code=400, detail="No rows selected to delete.")
    if any(not _valid_rowid(r) for r in body.rowids):
        raise HTTPException(status_code=400, detail="Row id missing — cannot identify the row(s) to delete.")
    if CONFIG_USE_DUMMY:
        return {"deleted": len(body.rowids)}
    dbcfg = _source_db(request, body.db_source, scope)
    try:
        deleted = database.config_delete_rows(dbcfg, table=table, rowids=body.rowids)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
    return {"deleted": deleted}
