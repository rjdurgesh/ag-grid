"""FastAPI entrypoint for the OLS Dashboard backend.

Mounts the Log Analytics API and enables CORS for the Angular dev server.

Run (from the ``backend/`` directory)::

    python -m venv .venv
    .venv\\Scripts\\activate            # Windows
    pip install -r requirements.txt
    uvicorn app:app --reload --port 8000
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from log_analytics.log_analytics_api import router as log_analytics_router
from utils.logging import configure_logging, get_logger

configure_logging()
logger = get_logger(__name__)

app = FastAPI(title="OLS Dashboard API", version="0.1.0")

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


@app.get("/health", tags=["meta"])
def health() -> dict:
    """Simple liveness probe."""
    return {"status": "ok"}


logger.info("OLS Dashboard API ready")
