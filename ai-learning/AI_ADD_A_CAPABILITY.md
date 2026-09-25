# OSHIVA — How to wire a new capability (which files change)

When you want the bot to do something new ("add a filter", "wire a new screen action"), here is exactly where
the logic goes. Most capabilities touch **2–4 backend files and no frontend at all**.

## The layers (data flows top → bottom)

```
User → chat → Coordinator picks an AGENT → the agent's TOOL runs → (authz + redaction) → result → answer
                         │                        │
              agents/registry.py          tools/<screen>.py  →  database.py (SQL)  /  a screen's data fn
```

## The recipe (in order)

1. **Data layer — `backend/database.py`** *(only if new SQL is needed).*
   Add a **parameterized** function (bind values, validate identifiers). Reuse an existing screen function if
   one already returns what you need — don't duplicate SQL. *(Rule: all SQL lives here.)*

2. **Tool — `backend/oshiva/tools/<screen>.py`** *(the main file).* Add a function
   `def _my_tool(args, caller, use_mock, scopes, ctx) -> dict:` that:
   - checks access: `if not authz.scope_allowed(scopes, scope): return base.deny(scope, scopes)` (and a WRITE
     check for writes);
   - **dev vs prod**: return a small dummy sample when the screen's `*_USE_DUMMY` is on, else call the
     data-layer / screen function with `ctx["db_configs"]` etc.;
   - shapes a small result dict (cap rows ~5–50; for big output write a file via `base.write_export(...)` and
     return a `download_url` built from `ctx["api_base"]`).
   Then add its **schema** to `SCHEMAS` (name + description + typed params — the model reads these) and
   register it in `TOOLS`. *(New screen? new module + one line in `tools/registry.py` `_MODULES`.)*

3. **Agent — `backend/oshiva/agents/registry.py`.**
   Add the tool name to the right agent's `tool_names`, add routing `keywords`, and (for writes/policies)
   update that agent's `system_prompt` (e.g. "never do X; link to the screen").

4. **Stub brain — `backend/oshiva/llm/client.py`** *(dev only).*
   Add **agent-aware** routing (`if "my_tool" in have and <keywords>: return _call("my_tool", {...})`) and a
   short **summariser** for the result. The **real GPT-OSS does both of these itself** — this is only so the
   scaffold demos without a model.

5. **Frontend — usually nothing.** The widget renders whatever text/markdown/links the backend returns. Only
   touch `src/app/oshiva/oshiva-widget.component.ts` for a *new render behaviour* (we did this once, to make
   links clickable).

6. **Docs + memory.** Update `GUIDE.md` + the relevant `ai-learning/*.md`, and end the round with the
   modified-file list.

## Cross-cutting things you get "for free" (don't re-implement per tool)
- **Authorization** — call `base.deny` / `authz.scope_allowed`; the professional refusal is standard.
- **PII/secret redaction** — runs centrally in `agents/runner.py` on every tool result.
- **Audit + session memory + streaming** — already wired around every turn.
- **Downloads** — `base.write_export(stem, text_or_csv, ext)` + the `GET /api/assistant/export/<file>`
  endpoint (serves `.csv`/`.txt`). Use it for anything too big for chat.

## Two worked examples

- **A new read filter** (e.g. "disk over 40%"): just a **parameter** on an existing tool — add it to the
  tool's `SCHEMAS` params + apply it in the tool body (steps 2 only). No new files.
- **A new screen action** (e.g. OCC "top tables"): steps 1–4 — a `database.fetch_*` (or reuse), a tool in
  `tools/oracle_command_center.py`, add to the agent, add stub routing/summary.

## Rule of thumb
- **Reads** → expose freely (row-capped; big → download link).
- **Writes** → either a **confirm-gated** tool (preview → yes → execute) or **refuse + link to the screen**
  (only they, with access, act there).
- **Ambiguity** (e.g. OCC has 5 DBs) → the tool returns `{"needs_input": true, "message": "which …?"}` and
  the bot asks. Never guess a destructive or ambiguous target.
