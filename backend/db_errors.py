"""Map DB-layer failures to clean HTTP responses so the UI can show WHY a call failed —
**503** (system busy / no connection) or **504** (query timed out) — instead of a generic 500.

Kept OUT of ``database.py`` (the pure, FastAPI-free data layer): this module imports FastAPI and the
shared exception types (``database.DbBusyError`` / ``DbTimeoutError``) and classifies driver errors by
their Oracle code. Two ways to use it:

  * In an endpoint's ``except`` block::  ``raise db_errors.http_error()``  (picks up the current
    exception via ``sys.exc_info()`` — no need to bind ``as exc``).
  * Globally: ``db_errors.register_handlers(app)`` in ``app.py`` catches DB errors that propagate
    (connect failures, endpoints without their own try/except) and returns the right status + message.
"""

from __future__ import annotations

import sys

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

import database
from utils.logging import get_logger

logger = get_logger(__name__)

# call_timeout fires as DPI-1067 (wrapping ORA-03136/ORA-01013 "cancelled"); a query timeout → 504.
_TIMEOUT_TOKENS = ("DPI-1067", "ORA-03136", "ORA-01013", "CALL TIMEOUT")
# Connection / listener / pool-acquire failures → the DB is unreachable or too busy → 503.
_BUSY_TOKENS = ("ORA-24459", "DPI-1010", "ORA-12170", "ORA-12541", "ORA-12154", "ORA-12514",
                "ORA-12520", "ORA-00018", "ORA-00020", "TNS:")

_MSG_TIMEOUT = "The database query took too long and was cancelled. Try narrowing the request, then retry."
_MSG_BUSY = "The system is busy — no free database connection right now. Please retry in a moment."
_MSG_UNREACHABLE = "The database is not reachable right now. Please retry shortly."


def classify(exc: Exception) -> tuple[int, str]:
    """(status_code, user-facing detail) for a DB-ish exception. Non-DB errors → (500, generic)."""
    if isinstance(exc, database.DbTimeoutError):
        return 504, _MSG_TIMEOUT
    if isinstance(exc, database.DbBusyError):
        return 503, _MSG_BUSY
    up = str(exc).upper()
    if any(tok in up for tok in _TIMEOUT_TOKENS):
        return 504, _MSG_TIMEOUT
    if any(tok in up for tok in _BUSY_TOKENS):
        return 503, _MSG_UNREACHABLE
    return 500, "Internal server error"


def http_error(exc: Exception | None = None) -> HTTPException:
    """An ``HTTPException`` with the classified status + message. Call with no argument inside an
    ``except`` block — it reads the current exception from ``sys.exc_info()``."""
    if exc is None:
        exc = sys.exc_info()[1] or Exception("unknown error")
    status, detail = classify(exc)
    return HTTPException(status_code=status, detail=detail)


def http_error_verbose(exc: Exception | None = None) -> HTTPException:
    """Like :func:`http_error`, but for admin/debug endpoints that deliberately surface the raw driver
    text: friendly 503/504 for busy/timeout, otherwise 500 carrying the raw ``str(exc)`` (so an operator
    still sees the ORA-xxxxx detail)."""
    if exc is None:
        exc = sys.exc_info()[1] or Exception("unknown error")
    status, detail = classify(exc)
    if status == 500:
        detail = str(exc).strip() or detail
    return HTTPException(status_code=status, detail=detail)


def register_handlers(app) -> None:
    """Global safety net: classify DB errors that reach FastAPI unwrapped (e.g. a connect failure, or an
    endpoint without its own try/except) into 503/504, everything else stays 500."""
    @app.exception_handler(database.DbBusyError)
    async def _busy(request: Request, exc: database.DbBusyError):  # noqa: ANN202
        logger.warning("DB busy on %s: %s", request.url.path, exc)
        return JSONResponse(status_code=503, content={"detail": _MSG_BUSY})

    @app.exception_handler(database.DbTimeoutError)
    async def _timeout(request: Request, exc: database.DbTimeoutError):  # noqa: ANN202
        logger.warning("DB timeout on %s: %s", request.url.path, exc)
        return JSONResponse(status_code=504, content={"detail": _MSG_TIMEOUT})

    try:
        import oracledb  # lazy — not installed in pure dummy mode
    except Exception:
        return  # no driver → the two custom-exception handlers above are enough

    @app.exception_handler(oracledb.DatabaseError)
    async def _dberr(request: Request, exc: oracledb.DatabaseError):  # noqa: ANN202
        status, detail = classify(exc)
        if status == 500:
            logger.exception("Unclassified DB error on %s", request.url.path)
        else:
            logger.warning("DB error %s on %s: %s", status, request.url.path, exc)
        return JSONResponse(status_code=status, content={"detail": detail})
