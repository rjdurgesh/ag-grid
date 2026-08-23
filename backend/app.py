"""FastAPI entrypoint for the OLS Dashboard backend.

Mounts the Log Analytics + System APIs and enables CORS for the Angular dev server.

Run (from the ``backend/`` directory)::

    python -m venv .venv
    .venv\\Scripts\\activate            # Windows
    pip install -r requirements.txt
    uvicorn app:app --reload --port 8000
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import oracle_cc_api
from infrastructure_health_api import router as infra_health_router
from log_analytics.log_analytics_api import router as log_analytics_router
from oracle_cc_api import router as oracle_cc_router
from service_console_api import router as service_console_router
from system_api import router as system_router
from utils.logging import configure_logging, get_logger

configure_logging()
logger = get_logger(__name__)

app = FastAPI(title="OLS Dashboard API", version="0.1.0")


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

# The Angular dev server runs on :4200. Add your real front-end origins for prod.
ALLOWED_ORIGINS = [
    "http://localhost:4200",
    "http://127.0.0.1:4200",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(log_analytics_router)
app.include_router(system_router)
app.include_router(infra_health_router)
app.include_router(service_console_router)
app.include_router(oracle_cc_router)


@app.get("/health", tags=["meta"])
def health() -> dict:
    """Simple liveness probe."""
    return {"status": "ok"}


logger.info("OLS Dashboard API ready")
