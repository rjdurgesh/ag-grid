# OSHIVA — Session Store & Coordinator/Agent (component notes)

Two building blocks landed together (see `AI_ARCHITECTURE.md`): the **Session Store** (server-side memory)
and the **Coordinator + pluggable agent registry**. This is a learner-oriented doc — what each is, why it
matters, how it works here, and how it grows.

---

## Part A — Session Store

### What & why
An LLM is **stateless** — it only knows what's in the current prompt. To hold a *conversation*, something
must remember the previous turns and feed them back. That's the **Session Store**: it keeps each
conversation's **message history** and a small **shared state** scratchpad, keyed by `conversation_id`.

Before this, the browser resent the whole transcript each turn (client-side memory — fragile, and the
server had to trust it). Now the **server owns the memory**: OSHIVA remembers across turns on its own, and
we don't trust client-supplied history. It's also where **inter-agent shared state** will live once we go
multi-agent.

### How it works here (`backend/oshiva/memory/sessions.py`)
- One record per conversation: `{ conversation_id, caller, messages[], state{}, created, updated }`.
- **Where the data lives (scaffold):** one JSON file per conversation on the **API server's disk** at
  `backend/assistant_data/sessions/<conversation_id>.json` (git-ignored). Not a browser cookie, not
  in-memory — it's a durable file, so it survives server restarts. The API is storage-agnostic, so
  **Phase-real swaps the file body for DB tables** (`ols_ai_conversation` / `ols_ai_message`) with no change
  to callers.
- **History is capped** (`MAX_MESSAGES = 40`) so a long chat can't grow without bound; the agent is fed the
  last ~12 turns.
- **Safety:** `conversation_id` is validated (`c_<hex>` only) to prevent path traversal; every read/write is
  lock-guarded; persistence is best-effort (a chat never fails because the store is unwritable).

### Lifecycle — when does a session expire?
- **New chat (reset):** the widget calls `POST /api/assistant/reset`, which **deletes that conversation's
  file immediately** — a clean expiry on reset.
- **Closing / reloading the window:** the `conversation_id` is held only in the widget's memory (not saved
  in the browser), so the next message starts a **new** conversation. The old file is left behind and then
  removed by the TTL sweep below.
- **Idle TTL:** `purge_expired()` deletes any session file idle longer than `session_ttl_hours` (default
  **72h**, configurable in `oshiva/assistant.json`). It runs as a **lazy sweep** — at most once an hour,
  triggered by normal use — so old conversations auto-expire without a separate scheduler.
- **Not tied to auth/session cookies:** "session" here means *a conversation thread*, not a login session.

### API (called by the chat endpoint)
```python
get_or_create(conversation_id, caller) -> Session
append_message(conversation_id, caller, role, content) -> Session
history(conversation_id, caller, limit=12) -> [{role, content}]   # for the model
set_state / get_state(conversation_id, caller, key[, value])      # shared scratchpad
clear(conversation_id)
```

### Where it plugs into the turn (`oshiva/api.py` → `chat`)
1. Resolve caller + access (RBAC gate).
2. `history = session_store.history(conv_id, caller)` — memory from the **server**, not the client.
3. `session_store.append_message(conv_id, caller, "user", message)` — record this turn.
4. Run the coordinator with `message` + `history`.
5. On completion, `append_message(..., "assistant", answer)` — so the next turn has it.
6. Audit the turn (now includes which agent handled it).

### Verified
Two turns on one `conversation_id` produced a session file with all four messages (user/assistant ×2),
same caller — server-side memory confirmed.

### Next (when the DB is wired)
Replace the file body with `ols_ai_conversation` + `ols_ai_message` tables; add TTL/retention (the log
housekeeping pattern) and, later, load older history on demand.

---

## Part B — Coordinator + pluggable agent registry

### What & why
Rather than one monolithic loop, OSHIVA now has a **Coordinator** that decides **which agent** handles a
turn, and an **agent registry** it routes to. Today there's **one agent (Ops)**; adding a specialist later
is "plug in / plug out" with no change to the call site — the seam for multi-agent is already there.

### The pieces
- `agents/registry.py` — the **registry**. Each `Agent` = `{ name, title, description, system_prompt,
  tool_names, keywords }` and exposes only its own slice of the tool catalogue. `AGENTS` holds them;
  `route(message)` scores each agent's `keywords` against the message and returns the best (falls back to
  the default). **Add a specialist** = define an `Agent` and append it to `AGENTS`. Nothing else changes.
- `agents/coordinator.py` — `run(message, history, caller, cfg)`: calls `route()`, emits a `route` event
  (`{type:"route", agent, title}`), then delegates to the chosen agent's loop.
- `agents/runner.py` — `run_agent_loop(agent, …)`: the tool-calling loop, scoped to **one agent** (its system
  prompt + only its tools; a tool outside the agent's set is refused — defence in depth).

### What you see
The chat shows a subtle **"Coordinator → Ops agent"** line above the tool trace, so the routing is visible.
The routed agent is also recorded in the audit log.

### Current agent
- **Ops agent** — servers, service status, blocking sessions (the 3 tools). Keywords: server, service,
  status, blocking, session, db…

### Growing to many agents (future, no rework)
1. Add e.g. a **DB/SQL Agent** (`agents/registry.py`) with its own prompt + SQL tools, append to `AGENTS`.
2. `route()` starts fanning out by keywords (later: escalate ambiguous cases to an LLM router — call site
   unchanged).
3. Agents share context via the Session Store's `state` scratchpad.

---

## Files

| File | Role |
| --- | --- |
| `backend/oshiva/memory/sessions.py` | Conversation history + shared state + TTL purge (file now → DB later) |
| `backend/oshiva/agents/registry.py` | Agent registry (`Agent`, `AGENTS`, `route()`) |
| `backend/oshiva/agents/coordinator.py` | Routes a turn to an agent, emits `route` event |
| `backend/oshiva/agents/runner.py` | `run_agent_loop(agent, …)` — the per-agent tool loop |
| `backend/oshiva/api.py` | Chat/reset endpoints wire session store + coordinator + audit |
| `src/app/oshiva/oshiva-widget.*` | Shows the "Coordinator → agent" route line; New chat expires the session |
