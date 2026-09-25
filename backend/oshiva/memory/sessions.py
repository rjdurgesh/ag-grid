"""Session Store — server-side conversation memory + shared state for OSHIVA.

Keeps each conversation's **message history** and a small **shared state** scratchpad (readable/writable
by the coordinator and, later, by multiple agents) keyed by ``conversation_id``. This is why OSHIVA
remembers across turns without the browser having to resend the whole transcript, and it's where
inter-agent state will live once we go multi-agent.

Scaffold storage = one JSON file per conversation under ``backend/assistant_data/sessions/`` (git-ignored).
The public API is storage-agnostic, so Phase-real swaps the body for ``ols_ai_conversation`` /
``ols_ai_message`` DB tables with no change to callers. History is capped (``MAX_MESSAGES``) so a long chat
can't grow without bound.
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import config_loader

# oshiva/memory/sessions.py → parents[2] == backend/  (runtime dir name stays "assistant_data")
_DIR = Path(__file__).resolve().parents[2] / "assistant_data" / "sessions"
_LOCK = threading.RLock()
MAX_MESSAGES = 40          # keep the most recent N messages per conversation
_last_purge = 0.0          # lazy-sweep timestamp (purge at most once an hour)
_PURGE_EVERY_S = 3600


@dataclass
class Session:
    conversation_id: str
    caller: str
    messages: list[dict] = field(default_factory=list)   # [{role, content, ts}]
    state: dict = field(default_factory=dict)             # shared scratchpad (inter-agent)
    created: float = field(default_factory=time.time)
    updated: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {"conversation_id": self.conversation_id, "caller": self.caller,
                "messages": self.messages, "state": self.state,
                "created": self.created, "updated": self.updated}

    @staticmethod
    def from_dict(d: dict) -> "Session":
        return Session(conversation_id=d.get("conversation_id", ""), caller=d.get("caller", ""),
                       messages=list(d.get("messages", [])), state=dict(d.get("state", {})),
                       created=d.get("created", time.time()), updated=d.get("updated", time.time()))


def _safe_id(conversation_id: str) -> str:
    """Only allow our own generated ids (``c_<hex>``); reject anything path-ish (traversal defence)."""
    cid = (conversation_id or "").strip()
    return cid if cid and all(ch.isalnum() or ch in "_-" for ch in cid) else ""


def _path(conversation_id: str) -> Path | None:
    cid = _safe_id(conversation_id)
    return (_DIR / f"{cid}.json") if cid else None


def purge_expired(ttl_hours: int | None = None) -> int:
    """Delete session files idle longer than the TTL (by file mtime). Returns how many were removed.
    This is how a conversation 'expires' after the user stops using it / closes the window."""
    if ttl_hours is None:
        ttl_hours = int(config_loader.assistant_config().get("session_ttl_hours", 72))
    cutoff = time.time() - max(1, ttl_hours) * 3600
    removed = 0
    with _LOCK:
        if not _DIR.is_dir():
            return 0
        for f in _DIR.glob("*.json"):
            try:
                if f.stat().st_mtime < cutoff:
                    f.unlink()
                    removed += 1
            except OSError:
                pass
    return removed


def _maybe_purge() -> None:
    """Run purge_expired at most once an hour (lazy sweep — no separate scheduler needed)."""
    global _last_purge
    now = time.time()
    if now - _last_purge >= _PURGE_EVERY_S:
        _last_purge = now
        purge_expired()


def get_or_create(conversation_id: str, caller: str) -> Session:
    """Load the conversation, or start a fresh one bound to ``caller``."""
    with _LOCK:
        _maybe_purge()
        p = _path(conversation_id)
        if p is not None and p.is_file():
            try:
                return Session.from_dict(json.loads(p.read_text(encoding="utf-8")))
            except Exception:  # noqa: BLE001 — corrupt file → start fresh
                pass
        return Session(conversation_id=_safe_id(conversation_id) or "", caller=caller)


def _save(session: Session) -> None:
    p = _path(session.conversation_id)
    if p is None:
        return
    session.updated = time.time()
    if len(session.messages) > MAX_MESSAGES:
        session.messages = session.messages[-MAX_MESSAGES:]
    try:
        _DIR.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(session.to_dict(), ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass  # persistence best-effort; a chat must never fail because the store is unwritable


def append_message(conversation_id: str, caller: str, role: str, content: str) -> Session:
    """Append one message and persist. Returns the updated session."""
    with _LOCK:
        s = get_or_create(conversation_id, caller)
        if not s.caller:
            s.caller = caller
        s.messages.append({"role": role, "content": content, "ts": time.time()})
        _save(s)
        return s


def history(conversation_id: str, caller: str, limit: int = 12) -> list[dict]:
    """The recent user/assistant turns for the model (OpenAI-style, no system prompt, no timestamps)."""
    with _LOCK:
        s = get_or_create(conversation_id, caller)
        turns = [{"role": m["role"], "content": m["content"]}
                 for m in s.messages if m.get("role") in ("user", "assistant") and m.get("content")]
        return turns[-limit:]


def set_state(conversation_id: str, caller: str, key: str, value) -> None:
    """Write to the conversation's shared scratchpad (used by the coordinator / future agents)."""
    with _LOCK:
        s = get_or_create(conversation_id, caller)
        s.state[key] = value
        _save(s)


def get_state(conversation_id: str, caller: str, key: str, default=None):
    with _LOCK:
        return get_or_create(conversation_id, caller).state.get(key, default)


def clear(conversation_id: str) -> None:
    with _LOCK:
        p = _path(conversation_id)
        if p is not None and p.is_file():
            try:
                p.unlink()
            except OSError:
                pass
