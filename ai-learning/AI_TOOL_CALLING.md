# OSHIVA — How it understands questions & calls tools (learner's guide)

This answers the natural questions: *"Can I just feed all my APIs to OSHIVA? How does it know to filter by
RAM > 70%? How does it know 'CIB' means only CIB servers? People phrase things differently — will it cope?"*

Short version: **the model never touches your APIs directly.** It only ever chooses a **tool** (a described
function) and fills in its **arguments**. Understanding the question and turning it into `tool + arguments`
is exactly what the LLM is for — and it's why the *real* GPT-OSS is far more capable than today's stub.

---

## 1. The mental model: tools, not "the whole API"

An agent doesn't get "the entire API." It gets a **menu of tools**, each described in plain language with a
typed parameter schema. On every turn the model sees that menu and decides: *answer directly, or call a tool
(and with what arguments)?* This is the OpenAI-style "function calling" contract we already use
(`oshiva/tools/registry.py` → `TOOL_SCHEMAS`).

Example of what the model actually sees for one tool:

```jsonc
{ "name": "list_servers",
  "description": "List servers in the estate, optionally filtered by business scope and OS.",
  "parameters": { "type": "object", "properties": {
    "scope": { "type": "string", "enum": ["cib","retail","group"], "description": "Business line. Omit for all." },
    "os":    { "type": "string", "enum": ["windows","linux"],       "description": "OS. Omit for all." }
  }}}
```

So **"can we feed all our APIs so it can answer anything about them?"** — yes, and that's the plan: each
existing endpoint (Infra Pulse, OCC, Service Console, Config Ops…) becomes **one tool** with a good
description + parameters. The more well-described tools it has, the more it can answer. But:

- We expose them **deliberately, one at a time**, each read-only first and **run as the caller** (RBAC +
  scope checks still apply — see `AI_TOOL_AUTHZ.md`). We do *not* hand the model raw, unrestricted API access.
- A tool's **description and parameter names are the "teaching"** — the model relies on them to pick the
  right tool and fill arguments. Vague descriptions → wrong tool choices. Writing good tool specs is the
  main craft here.
- Too many tools at once (30+) makes selection noisier and prompts costlier, so we grow the menu as needed.

### Is our registry "MCP"?
Same *idea*, not the same thing. `oshiva/tools/registry.py` is an **in-process tool registry** — Python
functions + OpenAI-style JSON schemas, called directly inside the FastAPI process. **MCP (Model Context
Protocol)** is a **standard protocol + a separate tool server** that lets *any* client/agent discover and
call those tools over a wire protocol. Our `TOOL_SCHEMAS` are the same *shape* MCP would expose (that's why
it feels similar), but there's no protocol/server here. Adopt MCP later only when the tools must be reused
across multiple agents/apps/teams or deployed separately — for one self-hosted agent, the in-process
registry is simpler and correct, and migrating is low-risk (the descriptions barely change, only the
transport).

### "Turn an endpoint into a tool" — we don't touch the screen's endpoint
The existing endpoint your UI calls (e.g. `POST /api/infra_health`) stays **unchanged**. The tool runs in the
**same process**, so it calls the **same data-layer/service function the endpoint already calls** — directly,
in-process (no HTTP hop, no new route, no duplicated SQL). Endpoint and tool become two thin callers of one
shared function:

```
   Browser (screen) ─▶ POST /api/infra_health ─┐   both call the SAME function
   OSHIVA tool ──────▶ list_servers() ─────────┴─▶ retrieve_server_health_details() ─▶ database.py ─▶ DB
```

All the "endpoint → tool" work lives in `tools/registry.py` (add a tool fn + its schema, call the existing
function inside it). Fetch-then-filter is fine to start; push filters into the DB `WHERE` (catalogue fields)
and prefer a queryable metrics store over live per-server fan-out as the estate grows.

---

## 2. "List servers whose RAM > 70%" — how does it not dump everything?

Two things happen, and they're separate:

**(a) The model extracts intent → structured arguments.** The LLM reads the sentence and produces a tool
call like `list_servers({ min_ram_percent: 70 })`. It understood "more than 70%" → `min_ram_percent: 70`.
That's the model's job (a real LLM does this reliably; see §4).

**(b) The tool must actually support that filter.** This is a *design decision on our side*, and there are
two patterns:

| Pattern | How | When to use |
| --- | --- | --- |
| **Filter server-side (preferred)** | Give the tool a `min_ram_percent` parameter; the backend applies the filter (SQL `WHERE` / metrics threshold) and returns **only** matching rows. | Large data (thousands of servers), live metrics, anything where dumping everything is slow/expensive. |
| **Return rows, let the model reason** | Tool returns the list; the model filters/summarises in its answer. | Small result sets only (tens of rows). Simple to build, but wasteful/inaccurate at scale. |

For the estate we'll almost always choose **server-side filtering**: the tool takes the filter as a
parameter and the query does the work. So the flow is:

```
"list servers with RAM over 70%"
   → model: list_servers({ min_ram_percent: 70 })
   → tool:  SELECT ... WHERE ram_percent > 70   (only matches come back)
   → model: "3 servers are above 70% RAM: …"
```

The model decides *what* to ask for; the tool decides *how* to fetch it efficiently and safely.

**Wired to live Infra (2026-09-23):** `list_servers` now takes `scope`, `os`, `min_ram_percent`,
`min_cpu_percent` and is **backed by the real Infra layer** — it reuses `infrastructure_health_api`
in-process: `retrieve_server_health_details(...)` for the catalogue (scope/os filter, cheap) and
`call_agent(...)` per server for the live RAM/CPU a threshold needs (metrics fan-out, only when a threshold
is asked). **No new endpoint, no duplicated SQL.** In dev it serves the Infra *dummy* catalogue/metrics
(`INFRA_HEALTH_USE_DUMMY`); in prod the same code hits the real stored proc + agents — so realness is
governed by that one Infra flag, not the assistant's `use_mock_tools`. Verified live: "list all servers" (as
a caller with only group+retail) returned the group hosts and **hid the CIB host**, and "RAM over 40%"
fetched live metrics — a clean illustration that **the model asks, the backend decides**.

---

## 3. "CIB server" vs group/retail — how does it scope correctly?

Same mechanism: the model maps the word **"CIB"** to the argument `scope: "cib"`, so `list_servers` only
returns CIB rows. "retail" → `scope:"retail"`, "group" → `scope:"group"`, no scope word → all (that the
caller may see). The `enum` in the schema (`["cib","retail","group"]`) tells the model exactly which values
are valid, so it won't invent `scope:"corporate"`.

Two guardrails sit on top of the model's choice:
- **The enum constrains it** to the three real business lines.
- **Authorization still applies regardless of what the model asks** — if the caller has no CIB access,
  `scope_access` refuses `scope:"cib"` and OSHIVA replies with the professional denial. The model choosing
  "cib" can never *bypass* access; it only ever asks — the backend decides (`AI_TOOL_AUTHZ.md`).

So even if someone phrases it as "show me the corporate/investment-bank boxes", the model resolves that to
`scope:"cib"`, and access is checked before any data is returned.

---

## 4. "People ask the same thing many ways" — will it understand?

**Yes — that's the whole reason to use an LLM instead of hard-coded rules.** This is the single biggest
difference between what we have now and what we're building toward:

| | **Stub brain (today, `llm/client.py`)** | **Real GPT-OSS (the goal)** |
| --- | --- | --- |
| How it "understands" | Brittle **keyword matching** (`if "server" in text …`) | Genuine language understanding |
| "list CIB windows boxes" | works (has the keywords) | works |
| "which investment-bank hosts run Windows?" | **fails** (no keyword hit) | **works** (understands it means CIB + Windows) |
| "servers with RAM over 70%" | **works** — we taught the stub this exact `N% + ram/memory` pattern | works |
| "any hosts maxing out memory?" | **fails** (no number to grab) | works (→ `min_ram_percent`) |
| Typos, synonyms, follow-ups ("and the linux ones?") | fails | works (uses conversation memory too) |

The stub exists only so the **whole pipeline runs on a laptop with no model**. It is intentionally dumb.
Once the real endpoint is wired (`_complete_real` + `use_stub:false`), paraphrase, synonyms, multi-step
reasoning and parameter extraction come "for free" from the model — no code per phrasing.

We make the real model *even* more reliable with three levers we control:
1. **Clear tool descriptions + parameter docs** (the model reads them to choose correctly).
2. **A good system prompt** (the agent's persona/rules — already in `agents/registry.py`).
3. **A few worked examples** in the prompt for tricky cases ("few-shot"), if needed.
4. Later, an **eval suite** (`AI_ARCHITECTURE.md` roadmap #5) of "question → expected tool call" pairs so we
   can *measure* that rephrasings still resolve correctly before widening access.

---

## 5. Where RAG fits (so it's not confused with this)

Tool-calling (this doc) is for **live/structured data** — "what's happening in the estate right now."
**RAG** (next phase) is for **knowledge** — runbooks, docs, past incidents: the model retrieves relevant
text and grounds its answer in it. Rule of thumb:

- *"Is SRV-CIB-07 up? which servers are over 70% RAM?"* → **tools** (live query).
- *"What's our procedure when the CIB batch is blocked? what does error OLS-4021 mean?"* → **RAG** (knowledge).

Both feed the same agent; they're just different sources.

### Do we have to wire *every* screen as a tool? — No.

A common confusion: "I have Log Analytics, Config Ops, Infra Pulse, OCC, User Management, Docs — must I wire
them all, and if so what's RAG for?" Two separate answers:

1. **You wire a screen as a tool only where a natural-language question over its *live data* adds value** —
   and you do it **incrementally**, one at a time, read-only first. A screen is not "converted"; you add a
   small tool that reuses that screen's existing data function. Skip the ones that don't earn it.
2. **RAG is not "wiring a screen"** — it's a *different source*. Tools answer "what is true right now"
   (live/structured). RAG answers "what do our documents say" (written knowledge). They don't overlap; the
   **Docs** screen's content is exactly what *feeds* RAG, rather than becoming a live tool.

A rough map for our screens (guidance, not a commitment):

| Screen | Becomes a tool? | Why |
| --- | --- | --- |
| **Infra Pulse** | ✅ done — `list_servers` + `service_status` (live) | live servers/metrics — high-value Q&A |
| **Config Ops Console** | ✅ done — `list_config_tables` / `get_config` / `describe_config_table` (**read-only**) | config is sensitive; writes stay in the UI (human-in-the-loop) |
| **Oracle Command Center** | ◑ `blocking_sessions` (mock; wire real next) → later sql intel, sessions | live DB state |
| **Log Analytics** | ◑ maybe (a `search_logs` tool) | live, but large/sensitive — design carefully |
| **Docs** | ❌ not a live tool → **this is RAG's input** | it's knowledge, not live state |
| **User Management** | ❌ generally no | admin/write + sensitive identities; don't expose to the bot |

Each screen's tools live in their own module under `oshiva/tools/` (e.g. `config_ops_console.py`), so the
Config screens CIB/RETAIL/GROUP are **one file with `scope` as a parameter**, not three files. Each domain
also gets its own **agent** (`infra` / `database` / `config_ops`) so the model only ever sees the tools it
needs. Config `get_config` **drops secret columns at the source** and caps rows, and all results pass through
central redaction (`AI_PII_REDACTION.md`).

So: **tools for a handful of high-value live screens (incrementally), RAG for the written knowledge, and
some screens stay out entirely.** You are never obliged to wire them all.

---

## 6. What this means for our build order

1. **Keep exposing endpoints as well-described tools**, one at a time, read-only, run-as-the-caller.
   *(Done: `list_servers` is wired to the live Infra layer. Next candidates: `service_status`, then OCC's
   blocking-sessions/sql-intel.)*
2. **Design each tool's parameters for server-side filtering** (scope, os, thresholds, date ranges…), so the
   model can ask precise questions and we never over-fetch.
3. **Wire the real GPT-OSS** to unlock robust understanding of arbitrary phrasings (the stub is a
   placeholder). Independent of tool-wiring — a real model over mock tools, or the stub over real tools, both
   work; you need both for production.
4. **Add an eval set** so we can prove "many phrasings → right tool + args" before trusting it more widely.

You're not going too far — these are exactly the questions that decide how we shape the tools. Getting the
tool descriptions and parameters right *is* most of the work of making an agent feel smart.

---

## Files referenced
| File | Role |
| --- | --- |
| `backend/oshiva/tools/registry.py` | The tool menu (schemas) + `run_tool` (where filters get applied) |
| `backend/oshiva/agents/registry.py` | Agent system prompt + which tools each agent may use |
| `backend/oshiva/llm/client.py` | Stub brain now (keyword) ↔ real GPT-OSS later (true understanding) |
| `backend/oshiva/auth/scope_access.py` | Enforces access on whatever scope the model asks for |
| `AI_TOOL_AUTHZ.md` | The per-business-line authorization layer |
| `AI_ARCHITECTURE.md` | Target architecture + component roadmap (RAG, evals, real tools) |
