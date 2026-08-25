"""S-Studio — the Config Ops SQL console.

A raw SQL / PL-SQL worksheet for **authorised operators only** (ops-admins in `ols_ops_access`
with `can_sql='Y'` — see RBAC_DESIGN.md §12). Two endpoints, both re-checked server-side:

* ``POST /api/sql_studio/databases`` `{ caller, scope }` → the databases in that config scope
  (from ``db_configs``, filtered by key prefix — future-proof).
* ``POST /api/sql_studio/execute``   `{ caller, db, sql }` → runs the statement/script and returns
  a UI-ready result (columns+rows for SELECT, a status line otherwise, or the ORA-xxxxx error text).

Follows the data/API split: all SQL execution lives in ``database.execute_sql``; this module only
gates the caller and picks the target connection.

SECURITY: the execution connection MUST be a **privileged** connection, kept SEPARATE from the OCC
read-only monitor. Wire ``app.state.sql_db_configs`` with those privileged creds; this module falls
back to the monitor ``db_configs`` only when that is not configured (and warns). Commits are manual
(``database.execute_sql`` does not auto-commit — include COMMIT in your script to persist).
"""

from __future__ import annotations

from env_loader import env_bool  # importing also loads backend/.env into os.environ

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import access_api           # reuse the OCC DB labels + the dummy ops-admin check
import database             # data layer — all SQL lives here
from utils.logging import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/sql_studio", tags=["sql_studio"])

# 1 = canned results (dev / no privileged DB wired), 0 = run against the real connection.
SQL_USE_DUMMY = env_bool("ACCESS_USE_DUMMY", True)


class DbQuery(BaseModel):
    caller: str
    scope: str


class ExecBody(BaseModel):
    caller: str
    db: str
    sql: str


def _dbs_for_scope(scope: str, db_keys: list[str]) -> list[str]:
    """Which db_configs keys belong to a config scope. Prefix match so a new DB added to a group
    (e.g. `group_reporting`) appears automatically. group→[group], cib→[cib_batch, cib_reporting]…"""
    s = (scope or "").strip().lower()
    if not s:
        return []
    return [k for k in db_keys if k == s or k.startswith(s + "_")]


def _require_sql_admin(request: Request, caller: str):
    """Confirm the caller may use S-Studio (`can_sql`), else 403. Returns the app DB config (None in dummy)."""
    if SQL_USE_DUMMY:
        if not access_api._dummy_is_ops_admin(caller):
            raise HTTPException(status_code=403, detail="S-Studio is restricted to authorised operators")
        return None
    cfg = getattr(request.app.state, "app_db_config", None)
    if not database.fetch_can_sql(cfg, caller):
        raise HTTPException(status_code=403, detail="S-Studio is restricted to authorised operators")
    return cfg


@router.post("/databases")
def sql_databases(request: Request, body: DbQuery) -> dict:
    """The databases available to run against for one config scope (ops-admin + can_sql only)."""
    _require_sql_admin(request, body.caller)
    db_keys = list(getattr(request.app.state, "db_configs", {}) or access_api.OCC_DB_LABELS)
    keys = _dbs_for_scope(body.scope, db_keys)
    return {"status": "success", "databases": [
        {"key": k, "label": access_api.OCC_DB_LABELS.get(k, k.replace("_", " ").title())} for k in keys]}


@router.post("/execute")
def sql_execute(request: Request, body: ExecBody) -> dict:
    """Run the operator's SQL against the chosen database and return the result."""
    _require_sql_admin(request, body.caller)
    if SQL_USE_DUMMY:
        return {"status": "success", "result": _dummy_execute(body.db, body.sql)}
    # Prefer the privileged S-Studio connections; fall back to the monitor configs with a warning.
    sql_cfgs = getattr(request.app.state, "sql_db_configs", None)
    db_cfgs = sql_cfgs if sql_cfgs else getattr(request.app.state, "db_configs", {})
    if not sql_cfgs:
        logger.warning("S-Studio using db_configs (no privileged sql_db_configs wired) — see RBAC_DESIGN.md")
    if body.db not in db_cfgs:
        raise HTTPException(status_code=400, detail=f"Unknown database '{body.db}'")
    db_config = db_cfgs.get(body.db)
    if db_config is None:
        raise HTTPException(status_code=503, detail=f"Database '{body.db}' is not reachable")
    try:
        result = database.execute_sql(db_config, body.sql)
    except Exception:
        logger.exception("S-Studio execute failed on %s", body.db)
        raise HTTPException(status_code=500, detail="Internal server error")
    return {"status": "success", "result": result}


# ---------------------------------------------------------------------------
# Dummy (dev / backend-only testing). The frontend mock interceptor is the primary dev path.
# ---------------------------------------------------------------------------

def _dummy_execute(db: str, sql: str) -> dict:
    text = (sql or "").strip().rstrip("/").strip()
    if not text:
        return {"kind": "error", "error": "No SQL to run."}
    if "ERR" in text.upper():                                   # dev hook: exercise the error panel
        return {"kind": "error", "error": "ORA-00942: table or view does not exist"}
    if database._looks_like_plsql(text):
        return {"kind": "exec", "message": database._plsql_message(text), "rows_affected": None, "statements": 1}
    stmts = database._split_sql_statements(text)
    last: dict | None = None
    for s in stmts:
        if s.lstrip().upper().startswith("SELECT"):
            last = {"kind": "select", "columns": ["ID", "NAME", "STATUS", "CREATED"],
                    "rows": [[1, "ALPHA", "ACTIVE", "2026-08-25 09:14:02"],
                             [2, "BRAVO", "ACTIVE", "2026-08-24 21:03:55"],
                             [3, "CHARLIE", "DISABLED", "2026-08-20 11:47:10"]],
                    "row_count": 3, "truncated": False, "statement": s}
        else:
            last = {"kind": "exec", "message": database._exec_message(s, 1), "rows_affected": 1, "statement": s}
    if last is None:
        return {"kind": "exec", "message": "Nothing to run.", "statements": 0}
    last["statements"] = len(stmts)
    return last
