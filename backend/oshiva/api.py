"""Assistant API — the FastAPI router for the OLS Assistant (Phase 2.0).

Endpoints (all POST; caller in the body, resolved to the real identity when OIDC is on):
  * /api/assistant/available  → {enabled}  — drives the frontend's "show the chat?" gate (no 403).
  * /api/assistant/chat       → SSE stream — the agent loop's events (tool steps + answer tokens).
  * /api/assistant/feedback   → {status}   — 👍/👎 on an answer (audited).

Access (Phase 2.0): a hardcoded/config allow-list (``allowed_users``, default just ``B27886``). Enforced
server-side in ``oshiva.auth.gate.require_assistant`` — the single chokepoint that Phase 2.4 swaps for an
RBAC grant. The per-tool business-line authorization lives in ``oshiva.auth.scope_access``.
"""

from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

import config_loader
from auth_token import resolve_caller
from utils.logging import get_logger

from .agents import coordinator
from .auth import gate
from .auth import rate_limit
from .auth import scope_access as authz
from .llm import client as llm_client
from .memory import sessions as session_store
from .observability import audit, metrics

# Where export_config writes CSVs (served by GET /api/assistant/export/<file>). backend/oshiva/api.py →
# parents[1] = backend/.
_EXPORT_DIR = Path(__file__).resolve().parents[1] / "assistant_data" / "exports"

logger = get_logger(__name__)
router = APIRouter(prefix="/api/assistant", tags=["assistant"])

# Config for the chat pipeline (coordinator / llm describe). The access gate keeps its own copy in
# oshiva.auth.gate — see that module for the enabled/allowed_users access model.
_CFG = config_loader.assistant_config()


# ---- bodies ----------------------------------------------------------------
class AvailableBody(BaseModel):
    caller: str = ""


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatBody(BaseModel):
    caller: str = ""
    message: str
    conversation_id: str | None = None
    history: list[ChatMessage] = []


class FeedbackBody(BaseModel):
    caller: str = ""
    conversation_id: str
    message_id: str
    vote: str                       # "up" | "down"
    comment: str | None = None


class ResetBody(BaseModel):
    caller: str = ""
    conversation_id: str


# ---- endpoints -------------------------------------------------------------
@router.post("/available")
def available(request: Request, body: AvailableBody) -> dict:
    """Whether the caller may use the assistant — the frontend shows the launcher only when true.
    Never 403s (it's a visibility check)."""
    caller = resolve_caller(request, body.caller)
    return {"enabled": gate.is_allowed(request, caller)}


@router.post("/chat")
def chat(request: Request, body: ChatBody):
    """Run one turn and stream events as SSE (`text/event-stream`)."""
    caller = resolve_caller(request, body.caller)
    gate.require_assistant(request, caller)
    # Edge rate-limit: cap chat turns per caller per minute (a turn can fan out to many tool + model calls).
    allowed, retry_after = rate_limit.check(caller, _CFG)
    if not allowed:
        raise HTTPException(status_code=429, detail="Too many requests — please slow down.",
                            headers={"Retry-After": str(retry_after)})
    message = (body.message or "").strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message is required.")

    conv_id = body.conversation_id or f"c_{uuid.uuid4().hex[:12]}"
    msg_id = f"m_{uuid.uuid4().hex[:12]}"
    # Server-side memory: history comes from the Session Store (not trusted from the client), then we
    # record this user turn so the next request has it.
    history = session_store.history(conv_id, caller, limit=12)
    session_store.append_message(conv_id, caller, "user", message)
    scopes = authz.allowed_scopes(request, caller)   # business lines this caller may query (per-tool gate)
    # Per-request state tools may need (Infra group DB, Config Ops DBs, RBAC app DB, env). Threaded to run_tool.
    _state = request.app.state
    _db_configs = getattr(_state, "db_configs", None) or {}
    ctx = {
        "group_db_config": _db_configs.get("group"),
        "app_env": getattr(_state, "app_env", None),
        "db_configs": _db_configs,
        "sql_db_configs": getattr(_state, "sql_db_configs", None) or {},   # privileged config DBs
        "app_db_config": getattr(_state, "app_db_config", None),            # RBAC grants DB
        "api_base": str(request.base_url).rstrip("/"),                      # for tools that return a download URL
    }

    def stream():
        start = time.perf_counter()
        tool_log: list[dict] = []
        agent_name = ""
        answer = ""
        error = None
        usage: dict = {}
        steps = 0
        yield _sse({"type": "start", "conversation_id": conv_id, "message_id": msg_id})
        try:
            for ev in coordinator.run(message, history, caller, _CFG, scopes, ctx):
                if ev["type"] == "route":
                    agent_name = ev.get("agent", "")
                elif ev["type"] == "tool":
                    tool_log.append({"name": ev["name"], "args": ev.get("args")})
                elif ev["type"] == "tool_result":
                    if tool_log:                       # attach the tool's wall-clock time to its log entry
                        tool_log[-1]["ms"] = ev.get("ms")
                elif ev["type"] == "usage":
                    usage = ev.get("usage") or {}
                    steps = ev.get("steps") or 0
                elif ev["type"] == "final":
                    answer = ev.get("content", "")
                elif ev["type"] == "error":
                    error = ev.get("detail")
                yield _sse(ev)
        except Exception as exc:  # noqa: BLE001
            error = f"Assistant failed: {exc}"
            logger.exception("assistant chat failed")
            yield _sse({"type": "error", "detail": error})
        finally:
            if answer:
                session_store.append_message(conv_id, caller, "assistant", answer)
            elapsed = int((time.perf_counter() - start) * 1000)
            audit.log_turn(conversation_id=conv_id, caller=caller, prompt=message,
                           tool_calls=tool_log, answer=answer, brain=llm_client.describe(_CFG),
                           elapsed_ms=elapsed, error=error, agent=agent_name,
                           tokens=usage, cost=metrics.cost_of(usage, _CFG), steps=steps)
            yield _sse({"type": "done", "conversation_id": conv_id, "message_id": msg_id})

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.post("/feedback")
def feedback(request: Request, body: FeedbackBody) -> dict:
    caller = resolve_caller(request, body.caller)
    gate.require_assistant(request, caller)
    vote = body.vote if body.vote in ("up", "down") else "up"
    audit.log_feedback(conversation_id=body.conversation_id, message_id=body.message_id,
                       caller=caller, vote=vote, comment=body.comment)
    return {"status": "success"}


@router.post("/reset")
def reset(request: Request, body: ResetBody) -> dict:
    """Expire a conversation's server-side memory (called when the user starts a New chat)."""
    caller = resolve_caller(request, body.caller)
    gate.require_assistant(request, caller)
    session_store.clear(body.conversation_id)
    return {"status": "success"}


@router.get("/export/{name}")
def export_download(name: str):
    """Serve a CSV/TXT that a tool wrote (e.g. a config export, or an explain plan too big for chat). Access
    is by the **unguessable token filename** (a capability URL), so a browser `<a>` download works without a
    bearer. The name is strictly validated (no traversal); only files inside the exports dir are served."""
    m = re.fullmatch(r"[A-Za-z0-9_]+\.(csv|txt)", name)
    if not m:
        raise HTTPException(status_code=404, detail="Not found.")
    path = (_EXPORT_DIR / name).resolve()
    if _EXPORT_DIR.resolve() not in path.parents or not path.is_file():
        raise HTTPException(status_code=404, detail="Not found.")
    media = "text/csv" if m.group(1) == "csv" else "text/plain"
    return FileResponse(path, media_type=media, filename=name)


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, default=str)}\n\n"
