"""OLS_UI_SERVICE - serves the built Angular UI (with SPA deep-link fallback) AND proxies
/api/* to OLS_BACKEND_SERVICE, so the browser sees a single origin (NO CORS needed).

This is a SEPARATE app from ``app.py``:
  * ``app.py``        -> the FastAPI backend (the API).        Run as OLS_BACKEND_SERVICE.
  * ``ui_server.py``  -> serves the UI + forwards /api here.   Run as OLS_UI_SERVICE.

They are two processes on two ports; this file only *forwards* /api over HTTP - it never
imports the backend. See DEPLOYMENT.md "Option C".

Deps: fastapi + uvicorn (already installed) and httpx (``pip install httpx``).

Env:
  OLS_UI_DIR       - path to the built Angular 'browser' folder (default C:\\ols\\ui)
  OLS_BACKEND_URL  - origin of OLS_BACKEND_SERVICE      (default http://127.0.0.1:8000)
  OLS_PROXY_TIMEOUT- upstream read timeout in seconds   (default 120 - Oracle can be slow)
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, Response

UI_DIR = Path(os.getenv("OLS_UI_DIR", r"C:\ols\ui"))                     # built 'browser' folder
BACKEND_URL = os.getenv("OLS_BACKEND_URL", "http://127.0.0.1:8000")     # OLS_BACKEND_SERVICE
PROXY_TIMEOUT = float(os.getenv("OLS_PROXY_TIMEOUT", "120"))

# Hop-by-hop headers must not be forwarded. httpx already decodes the body, so the response
# side also drops content-encoding/length and lets Starlette recompute them.
_REQ_HOP = {"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
            "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length"}
_RESP_HOP = _REQ_HOP | {"content-encoding"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # One pooled client for the whole process - never one-per-request.
    app.state.client = httpx.AsyncClient(base_url=BACKEND_URL, timeout=PROXY_TIMEOUT)
    yield
    await app.state.client.aclose()


app = FastAPI(title="OLS UI", docs_url=None, redoc_url=None, lifespan=lifespan)


@app.api_route("/api/{path:path}",
               methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"])
async def proxy_api(path: str, request: Request) -> Response:
    """Forward every /api/* call to OLS_BACKEND_SERVICE, verbatim."""
    body = await request.body()
    fwd_headers = {k: v for k, v in request.headers.items() if k.lower() not in _REQ_HOP}
    upstream = await request.app.state.client.request(
        request.method,
        request.url.path,                 # includes the /api prefix; joined onto BACKEND_URL
        params=request.query_params,
        content=body,
        headers=fwd_headers,
    )
    out_headers = {k: v for k, v in upstream.headers.items() if k.lower() not in _RESP_HOP}
    return Response(content=upstream.content, status_code=upstream.status_code, headers=out_headers)


@app.get("/{spa_path:path}")
async def serve_ui(spa_path: str) -> FileResponse:
    """Serve a real static file if it exists, else the SPA shell (deep-link fallback)."""
    candidate = UI_DIR / spa_path
    if spa_path and candidate.is_file():
        return FileResponse(candidate)          # real file: main-*.js, styles-*.css, assets/*...
    return FileResponse(UI_DIR / "index.html")  # any app route (deep link) -> SPA shell
