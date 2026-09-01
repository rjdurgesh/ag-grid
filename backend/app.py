"""FastAPI entrypoint for the OLS Dashboard backend.

Mounts the Log Analytics + System APIs and enables CORS for the Angular dev server.

Run (from the ``backend/`` directory)::

    python -m venv .venv
    .venv\\Scripts\\activate            # Windows
    pip install -r requirements.txt
    uvicorn app:app --reload --port 8000
"""

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import env_loader  # noqa: F401  — loads backend/.env into os.environ before we read APP_ENV etc.
import oracle_cc_api
from access_api import router as access_router
from infrastructure_health_api import router as infra_health_router
from log_analytics.log_analytics_api import router as log_analytics_router
from oracle_cc_api import router as oracle_cc_router
from regression_api import router as regression_router
from config_api import router as config_router
from docs_api import router as docs_router
from service_console_api import router as service_console_router
from sql_studio_api import router as sql_studio_router
from system_api import router as system_router
from utils.logging import configure_logging, get_logger

configure_logging()
logger = get_logger(__name__)

# Backend version — shown in the UI footer. Set APP_VERSION in backend/.env per release (falls back to
# a default if unset). It travels with the deploy the same way APP_ENV does.
APP_VERSION = os.getenv("APP_VERSION", "1.0.0").strip()

app = FastAPI(title="OLS Dashboard API", version=APP_VERSION)
app.state.app_version = APP_VERSION


def load_db_configs() -> dict[str, dict]:
    """Per-scope DB connection configs, read once at startup — the SINGLE source of truth for
    which databases the app can reach. Every screen keys off this: Log Analytics + Infra Health
    use ``"group"``; the Oracle Command Center builds its tabs from whichever scopes are present
    here (see ``oracle_cc_api.TARGET_CATALOG``). Add/remove a scope → it appears/disappears
    across the app. No screen hardcodes the connection list.

    Stand-in — swap the body for your real loader. Connect each scope INSIDE a try/except so a
    single unreachable database can't crash startup — a failed scope maps to None, which the OCC
    reads as "down" (grey tab) while every other DB works::

        cfgs = {}
        for scope in ("group", "cib_batch", "cib_reporting", "retail_batch", "retail_reporting"):
            try:
                cfgs[scope] = connect_db(scope.upper())   # your real connection object
            except Exception as exc:
                logger.warning("DB '%s' unavailable at startup: %s", scope, exc)
                cfgs[scope] = None                        # keeps the tab, shown grey/unreachable
        return cfgs

    Each value holds whatever your DB layer needs (dsn, user, password, pool, or a live
    connection). In dev it's an empty stub per scope (dummy endpoints don't open connections);
    a scope reads as "reachable" (green tab) only when its value is truthy.

    PER-ENVIRONMENT: this one function serves DEV / STG / PROD — read the target creds from THIS
    server's environment (``os.getenv``), keyed off ``APP_ENV`` and per-scope vars from its own
    ``.env`` (e.g. ``OLS_DB_GROUP_DSN`` / ``_USER`` / ``_PASSWORD``). Same code everywhere; only the
    ``.env`` differs per box, so nothing here is hardcoded to an environment. See DEPLOYMENT.md.
    """
    scopes = ("group", "cib_batch", "cib_reporting", "retail_batch", "retail_reporting")
    return {scope: {} for scope in scopes}


# Exposed on the app so any request can read it via ``request.app.state.db_configs``
# (see log_analytics/dependencies.py → ``group_db_config``). For real connection
# *pools* you'd open them in a lifespan handler and close them on shutdown; a plain
# config dict needs nothing more than this.
app.state.db_configs = load_db_configs()

# The Oracle Command Center routes read `request.app.state.db_configs.get(db)` directly and pass
# it to the `database.py` data layer, which opens the connection. Nothing else to wire here.

# RBAC reads the app's OWN database (ols_users + ols_app_access) — a DIFFERENT connection from the
# monitored Oracle CC databases above. Wire your app-DB config/connection here; in dev it's an empty
# stub because access runs in dummy mode (ACCESS_USE_DUMMY=1). See access_api.py / RBAC_DESIGN.md.
app.state.app_db_config = {}

# S-Studio (Config Ops SQL console) runs writes/DDL, so it needs PRIVILEGED connections — kept
# SEPARATE from the read-only OCC monitor `db_configs` above (never run DDL through the monitor).
# Wire {scope_key: privileged_connection} here (same keys as db_configs). Empty stub in dev; if left
# empty in prod, sql_studio_api falls back to db_configs and logs a warning. See RBAC_DESIGN.md §12.
app.state.sql_db_configs = {}

# Which environment this backend serves — PROD | STG | DEV. Set per deployment (env var or the
# server's own .env); the SAME code runs in all three. Drives DB selection in load_db_configs()
# (wire it to read this) and is handy for logging. Frontend detects its env from the hostname and
# sends its own app_env per request; they align because a given env's UI + backend deploy together.
APP_ENV = os.getenv("APP_ENV", "PROD").strip().upper()
app.state.app_env = APP_ENV

# CORS: in production the UI and API share ONE origin (ui_server.py proxies /api → this backend),
# so no CORS is needed there. It's only needed for LOCAL dev (ng serve on :4200 → backend :8000,
# cross-origin). Defaults cover localhost; override with OLS_ALLOWED_ORIGINS (comma-separated) if you
# ever expose the backend cross-origin (e.g. a UI host that calls it directly, without the proxy).
_DEFAULT_ORIGINS = "http://localhost:4200,http://127.0.0.1:4200"
ALLOWED_ORIGINS = [o.strip() for o in os.getenv("OLS_ALLOWED_ORIGINS", _DEFAULT_ORIGINS).split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(access_router)
app.include_router(log_analytics_router)
app.include_router(system_router)
app.include_router(infra_health_router)
app.include_router(service_console_router)
app.include_router(oracle_cc_router)
app.include_router(sql_studio_router)
app.include_router(regression_router)
app.include_router(config_router)
app.include_router(docs_router)


@app.get("/health", tags=["meta"])
def health() -> dict:
    """Simple liveness probe."""
    return {"status": "ok"}


logger.info("OLS Dashboard API ready - APP_ENV=%s", APP_ENV)
