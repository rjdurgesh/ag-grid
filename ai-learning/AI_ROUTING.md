# AI_ROUTING — How a turn flows: Coordinator → Agent → Tool → "server"

This doc answers two questions you asked directly:

1. **How does the Coordinator know which agent to send a query to?**
2. **How does that agent know which tool / "MCP-like server" to connect to?**

Everything here is real code in `backend/oshiva/`. Every step names the **file + function** so you can open
it and read along. At the end there's a full worked example and a one-glance reference table.

> **One honest clarification up front (important):** in the reference architecture you shared, each domain has
> its own **MCP server**. **We do not have separate MCP servers yet.** Today each "server" is an ordinary
> **Python module** that lives *inside the same FastAPI process* (`backend/oshiva/tools/<screen>.py`). The
> agent doesn't open a network connection to it — it calls a function. That module plays *exactly the role* an
> MCP server would (it owns a set of tools), which is why the mapping is clean and swapping to real MCP later
> is low-risk. Wherever this doc says **"server,"** read it as **"the per-screen tool module (today) → an MCP
> server (later)."** See [`AI_TOOL_CALLING.md`](AI_TOOL_CALLING.md) §1 "Is our registry MCP?" and
> [`AI_ARCHITECTURE.md`](AI_ARCHITECTURE.md).

---

## 0. The whole turn in one picture

![Routing flow — a user message runs through api.py, the Coordinator's route() (our code) picks one agent, the agent is shown only its own tools, the model picks the tool + arguments, run_tool() dispatches to the per-screen module ("server"), the result is redacted and looped back, and the final answer is streamed to the UI.](routing-flow.svg)

*(Static diagram — `routing-flow.svg`. Text version below for plain viewers.)*

```
USER: "list CIB servers with RAM over 70%"
   │
   ▼
api.py (POST /api/assistant/chat)                     ← entry point; builds caller, scopes, ctx
   │
   ▼
coordinator.run(msg, history, caller, cfg, scopes, ctx)
   │   ── STEP 1 ── registry.route(msg)  ───────────►  picks ONE agent (keyword scoring)
   │                                                    → INFRA_AGENT ("Infra agent")
   │   emits  {"type":"route","agent":"infra","title":"Infra agent"}
   ▼
runner.run_agent_loop(agent, …)                       ← runs THAT agent to completion
   │   ── STEP 2 ── tools = agent.tool_schemas()  ──►  agent is shown ONLY its 4 tools
   │   ── STEP 3 ── llm_client.complete(messages, tools, cfg)
   │                    the BRAIN chooses a tool + args:  list_servers(scope=cib, min_ram_percent=70)
   │   ── STEP 4 ── (defence) is the tool in agent.tool_names?  → yes
   │   ── STEP 5 ── run_tool("list_servers", args, caller, use_mock, scopes, ctx)
   │                    tools/registry._DISPATCH → infra_pulse._list_servers(...)   ← the "server"
   │   ── STEP 6 ── redaction.redact(result)  → feed back to the brain
   │                    brain writes the final answer → streamed to the UI
   ▼
USER sees: a table of CIB servers with RAM ≥ 70%
```

Two separate decisions happen, by two different pieces of code:

| Decision | "Which **agent**?" | "Which **tool** (on which server)?" |
| --- | --- | --- |
| Made by | **our code** — `registry.route()` (cheap keyword scoring) | **the model/brain** — `llm/client.py` (GPT-OSS later; keyword stub now) |
| Constrained by | the agents registered in `AGENTS` | the agent's **own** `tool_names` (it can't see other agents' tools) |
| Runs the choice | `coordinator.run()` | `runner.run_agent_loop()` → `run_tool()` |

Keep that split in mind: **we route to an agent; the agent's brain picks the tool.**

---

## 1. STEP 1 — How the Coordinator picks the agent

**File:** [`backend/oshiva/agents/coordinator.py`](../backend/oshiva/agents/coordinator.py) → `run()`
**File:** [`backend/oshiva/agents/registry.py`](../backend/oshiva/agents/registry.py) → `route()` + the `AGENTS` registry

The coordinator is tiny on purpose — it's the "seam" that lets one agent grow into many:

```python
# coordinator.py
def run(user_message, history, caller, cfg, scopes=None, ctx=None):
    agent = agent_registry.route(user_message)          # ← STEP 1: pick the agent
    yield {"type": "route", "agent": agent.name, "title": agent.title}   # tell the UI
    yield from run_agent_loop(agent, user_message, history, caller, cfg, scopes, ctx)
```

### What an "agent" is

An agent is just a small data record (a persona + its allowed tools + routing hints). No magic:

```python
# registry.py
@dataclass(frozen=True)
class Agent:
    name: str                      # stable id, e.g. "infra"
    title: str                     # display name, e.g. "Infra agent"
    description: str               # what it's for
    system_prompt: str             # the persona/rules sent to the model
    tool_names: tuple[str, ...]    # THE TOOLS IT MAY CALL  ← the key line
    keywords: tuple[str, ...]      # routing hints (route() matches on these)
```

We register four specialists in one tuple. **Adding a new specialist = append one `Agent` here; nothing else
changes** ("plug in / plug out"):

```python
# registry.py
AGENTS = {a.name: a for a in (INFRA_AGENT, DATABASE_AGENT, CONFIG_OPS_AGENT, REGRESSION_AGENT)}
DEFAULT_AGENT = "infra"
```

Each agent declares its `keywords`. For example:

- `INFRA_AGENT.keywords` = `server, servers, host, service, ram, cpu, disk, drive, share, nas, windows, linux, …`
- `DATABASE_AGENT.keywords` = `blocking, session, lock, sql, oracle, db, sql_id, plan, index, mview, gather, kill, …`
- `CONFIG_OPS_AGENT.keywords` = `config, table, column, parameter, lma, lookup, roll, export, csv, …`
- `REGRESSION_AGENT.keywords` = `regression, downstream, extract, batch, release, chg, step, run`

### The routing function itself

```python
# registry.py
def route(message: str) -> Agent:
    text = (message or "").lower()
    best, best_score = None, 0
    for agent in AGENTS.values():
        # word-boundary match so "ram" doesn't fire inside "ols_param", or "up" inside "group"
        score = sum(1 for kw in agent.keywords if re.search(rf"\b{re.escape(kw)}\b", text))
        if score > best_score:
            best, best_score = agent, score
    return best or AGENTS[DEFAULT_AGENT]      # nobody matched → default (infra)
```

**How it decides, in words:** lower-case the message, and for each agent **count how many of its keywords
appear as whole words** — a normal `keyword` scores **1**, a `strong_keyword` scores **3**. The highest total
wins. Nobody matches → fall back to `DEFAULT_AGENT` (infra).

**Why the ×3 strong tier:** some words are *unambiguous* intent. "manifest", "filecopy" and "cleanup" only ever
mean the regression manifest tools, so they're `strong_keywords` on the regression agent. Without the weight,
*"generate a file-copy manifest to copy D:/rel/app.config to …"* tied 1–1 (regression's `manifest` vs config_ops'
`config` — matched **inside the path** `app.config`) and, on a tie, the earlier-registered config_ops agent won →
misroute. With the weight, `manifest` (3) clearly beats an accidental `config` (1). Reach for a strong keyword only
when a word is a near-certain signal for exactly one agent.

#### Worked scoring example

Message: **"list the blocking sessions on the cib batch db"**

| Agent | Keywords that hit (whole-word) | Score |
| --- | --- | --- |
| infra | *(none — "server/service/ram…" absent)* | 0 |
| **database** | `blocking`, `session`, `db`, `batch`? no→ *(batch is a database keyword too)* `blocking`, `session`, `db` | **3** ✅ |
| config_ops | *(none)* | 0 |
| regression | `batch` | 1 |

→ **database agent wins** (3 > 1 > 0). This is why we deliberately added OCC write-words like `gather`,
`kill`, `mview`, `batch` to the database agent's keywords — otherwise *"gather stats on the cib batch"* would
be stolen by the regression agent (which also owns `batch`). Tuning routing = tuning these keyword lists.

> **Why keyword scoring and not an LLM to route?** It's **instant and free** (no extra model call per turn),
> and with a handful of clearly-separated domains it's accurate. `route()`'s docstring notes the upgrade path:
> when domains get fuzzy, swap the body for an LLM-based router — **the call site (`coordinator.run`) doesn't
> change.** That's the whole point of keeping routing behind one function.

> **When the real GPT-OSS is on:** the *routing to an agent* still uses `route()` (our code). The model's job
> starts *inside* the chosen agent (Step 3). So routing quality doesn't depend on the model at all today.

---

## 2. STEP 2 — The agent is shown ONLY its own tools

**File:** [`backend/oshiva/agents/runner.py`](../backend/oshiva/agents/runner.py) → `run_agent_loop()`
**File:** [`backend/oshiva/agents/registry.py`](../backend/oshiva/agents/registry.py) → `Agent.tool_schemas()`

Before the brain is even asked anything, the runner narrows the tool menu to *this agent's* tools:

```python
# runner.py
def run_agent_loop(agent, user_message, history, caller, cfg, scopes=None, ctx=None):
    tools = agent.tool_schemas()          # ← only THIS agent's tools
    allowed = set(agent.tool_names)       # ← used again in Step 4 as a hard guard
    messages = [{"role": "system", "content": agent.system_prompt}]
    messages.extend(history or [])
    messages.append({"role": "user", "content": user_message})
    ...
```

`tool_schemas()` is just a filter of the **global** catalogue down to the agent's slice:

```python
# registry.py
def tool_schemas(self) -> list[dict]:
    allowed = set(self.tool_names)
    return [t for t in TOOL_SCHEMAS if t["function"]["name"] in allowed]
```

So the **database agent** literally never sees `list_servers` or `export_config` — its `tools` list contains
only `blocking_sessions, top_tables, top_indexes, unusable_indexes, list_sessions, mviews, sql_detail`.

**Why this matters (two reasons):**
1. **Better tool choice** — a smaller, on-topic menu makes the model pick correctly and keeps the prompt small.
2. **Safety by construction** — an agent *can't* call another domain's tool even if it wanted to.

---

## 3. STEP 3 — The brain chooses the tool + arguments

**File:** [`backend/oshiva/llm/client.py`](../backend/oshiva/llm/client.py) → `complete()`

This is the step that answers **"how does the agent know which tool to use?"** — it's the **model** (the
brain) that decides, given (a) the agent's system prompt and (b) the tool **schemas** (name + description +
parameters). The runner just calls:

```python
# runner.py
resp = llm_client.complete(messages, tools, cfg)
```

`complete()` has two implementations behind one shape (`LlmResponse`, which is *either* a final `content`
*or* a list of `tool_calls`):

- **`_complete_real`** — the real GPT-OSS. Sends the messages + tool schemas over an OpenAI-compatible
  `POST /v1/chat/completions` with `tool_choice="auto"`. GPT-OSS *reads the tool descriptions* and returns a
  `tool_call` like `{"name": "list_servers", "arguments": {"scope": "cib", "min_ram_percent": 70}}`. **This is
  genuine language understanding** — it works for phrasings we never hard-coded.
- **`_complete_stub`** — the throwaway scaffold we use until the endpoint is wired. It fakes the same decision
  with **keyword rules** (e.g. `if "server" in text → list_servers`, `_parse_threshold` pulls "70%"). It's
  brittle by design and will be retired (`use_stub=false`).

Either way the **output shape is identical**, so the loop below doesn't care which brain ran. The tool
descriptions in the schemas are what "teach" the model when to use each tool — that's why we write them
carefully (see [`AI_TOOL_CALLING.md`](AI_TOOL_CALLING.md)).

---

## 4 & 5. STEP 4/5 — Run the chosen tool (the "connect to the server" step)

**File:** [`backend/oshiva/agents/runner.py`](../backend/oshiva/agents/runner.py) (the loop)
**File:** [`backend/oshiva/tools/registry.py`](../backend/oshiva/tools/registry.py) → `run_tool()` + `_DISPATCH`

When the brain returns a `tool_call`, the runner (a) re-checks the tool really belongs to this agent
(defence-in-depth), then (b) executes it:

```python
# runner.py  (inside the loop, for each tool call the brain asked for)
name = tc["name"]; args = tc.get("arguments") or {}
yield {"type": "tool", "name": name, "args": args}          # UI shows the tool "chip"
result = ({"error": f"Tool '{name}' is not available to the {agent.name} agent."}
          if name not in allowed                            # ← STEP 4: hard guard
          else run_tool(name, args, caller, use_mock, scopes, ctx))   # ← STEP 5: run it
result = redaction.redact(result)                           # ← STEP 6: scrub before the model sees it
messages.append({"role": "tool", "tool_call_id": tc["id"], "name": name,
                 "content": json.dumps(result, default=str)})
yield {"type": "tool_result", "name": name}
```

### This is where the "which server?" is answered

`run_tool` is the **switchboard**. It looks the tool name up in a dispatch table and calls the actual
function — that function lives in a **per-screen module**, which is our "server":

```python
# tools/registry.py
from . import config_ops_console, infra_pulse, oracle_command_center, regression

# The registered "servers". Append a module here to connect its tools — nothing else changes.
_MODULES = (infra_pulse, oracle_command_center, config_ops_console, regression)

TOOL_SCHEMAS = [schema for m in _MODULES for schema in m.SCHEMAS]          # every tool's schema
_DISPATCH    = {name: fn for m in _MODULES for name, fn in m.TOOLS.items()} # name → function

def run_tool(name, args, caller, use_mock=True, scopes=None, ctx=None):
    fn = _DISPATCH.get(name)                        # ← "which server owns this tool?"
    if fn is None:
        return {"error": f"Unknown tool '{name}'."}
    return fn(args or {}, caller, use_mock, scopes if scopes is not None else {"*"}, ctx)
```

So the chain for the "server" is:

```
tool name "list_servers"
   → _DISPATCH["list_servers"]                       (built from each module's TOOLS map)
   → infra_pulse._list_servers(args, caller, use_mock, scopes, ctx)   ← the actual code
        └─ which, in prod, calls your EXISTING backend (infrastructure_health_api / agents)
```

**`_MODULES` is literally "the list of connected servers."** Each module exposes two things the registry
harvests:
- `SCHEMAS` — the tool definitions (name/description/parameters) the brain reads.
- `TOOLS` — a `{name: function}` map the registry dispatches to.

Add a domain = write one `tools/<screen>.py` with its `SCHEMAS` + `TOOLS`, add it to `_MODULES`, and (if it's
a new domain) add an `Agent` in `registry.py`. That's the whole wiring. See
[`AI_ADD_A_CAPABILITY.md`](AI_ADD_A_CAPABILITY.md).

> **When we adopt real MCP:** `run_tool` (or a small MCP client) would look the tool up in a **remote** server
> instead of `_DISPATCH`, and `fn(...)` becomes a network call. The **schemas barely change** (MCP uses the
> same name/description/parameters shape), and the agent/coordinator code above is untouched. That's why the
> in-process registry is a safe first step, not throwaway work.

---

## 6. STEP 6 — Redact, feed back, answer (why the loop repeats)

Every tool result is **redacted** (`security/redaction.py`) *before* the model or the audit log sees it —
DB passwords, connection strings, and PII (name/email/username/GUID/account number) are masked at this single
chokepoint, so every tool present and future is covered (see [`AI_PII_REDACTION.md`](AI_PII_REDACTION.md)).

The redacted result is appended to `messages` and the loop **goes back to Step 3**: the brain now has the tool
output and either (a) asks for **another** tool (e.g. `find_tables_with_column` → then `query_table`) or
(b) writes the final answer, which is streamed to the UI as `token` events and captured as one `final` event
for the client + audit. A `max_steps` budget (default 6) stops runaway loops.

---

## 7. Full worked example (end to end)

**User:** *"list CIB servers whose RAM is over 70%"*

| Step | Code | What happens |
| --- | --- | --- |
| entry | `api.py` `chat()` | builds `caller`, `scopes` (business lines allowed), `ctx` (db configs, app_env, api_base) |
| 1 | `coordinator.run` → `registry.route` | keywords `server`, `ram` hit **infra** (score 2) → **INFRA_AGENT**; emits `route` event |
| 2 | `runner.run_agent_loop` → `agent.tool_schemas()` | brain is shown only `list_servers, service_status, list_services, list_shares` |
| 3 | `llm/client.complete` | brain returns `tool_call list_servers {scope:"cib", min_ram_percent:70}` |
| 4 | `runner` guard | `list_servers` ∈ infra's `tool_names` → allowed |
| 5 | `tools/registry.run_tool` → `_DISPATCH["list_servers"]` → `infra_pulse._list_servers` | the tool checks the caller may see **cib** (scope authz), gathers servers, fans out for live RAM, filters ≥ 70% |
| 6 | `redaction.redact` → back to `complete` | result scrubbed; brain writes "Here are the CIB servers over 70% RAM: …" table |
| out | SSE `token`/`final` | UI streams the answer + shows a `list_servers` tool chip |

If the caller has **no CIB access**, Step 5's tool returns a **denial** dict (`scope_access.deny`) and the
brain relays it politely ("You don't have access to CIB…") — the routing/selection code above is unchanged.
That's [`AI_TOOL_AUTHZ.md`](AI_TOOL_AUTHZ.md).

---

## 8. Reference — the exact files & functions you asked for

| You want to see… | File | Function / symbol |
| --- | --- | --- |
| **Which agent for a query** (Q1) | `backend/oshiva/agents/registry.py` | **`route()`** + `AGENTS` + each `Agent.keywords` |
| The coordinator that calls it | `backend/oshiva/agents/coordinator.py` | **`run()`** |
| An agent's definition (persona + its tools) | `backend/oshiva/agents/registry.py` | `INFRA_AGENT` / `DATABASE_AGENT` / `CONFIG_OPS_AGENT` / `REGRESSION_AGENT` |
| **Which tools an agent may use** | `backend/oshiva/agents/registry.py` | `Agent.tool_names`, `Agent.tool_schemas()` |
| The agent loop (asks brain, runs tools) | `backend/oshiva/agents/runner.py` | **`run_agent_loop()`** |
| **The brain choosing the tool** (Q2, the decision) | `backend/oshiva/llm/client.py` | **`complete()`** → `_complete_real` / `_complete_stub` |
| **Which "server" owns a tool** (Q2, the dispatch) | `backend/oshiva/tools/registry.py` | **`run_tool()`**, `_DISPATCH`, `_MODULES` |
| A "server" (per-screen tool module) | `backend/oshiva/tools/infra_pulse.py` (etc.) | its `SCHEMAS` + `TOOLS` maps |
| Scrub before the model | `backend/oshiva/security/redaction.py` | `redact()` (wired in `runner.py`) |
| Who-are-you / what-may-you-see | `backend/oshiva/auth/gate.py`, `auth/scope_access.py` | `require_assistant`, `allowed_scopes` |

---

## Further reading (free)

- ⭐ **Anthropic — "Building effective agents"** (anthropic.com/engineering/building-effective-agents) — the
  "router / orchestrator + workers" pattern is exactly our coordinator + specialist agents.
- **OpenAI — Function calling** (platform.openai.com/docs/guides/function-calling) — the exact `tool_calls`
  shape `complete()` returns, and how `tool_choice="auto"` lets the model pick.
- **modelcontextprotocol.io** — read when we consider making the per-screen modules real MCP servers; note the
  tool **schema** shape is essentially what we already expose.
- See also our own [`AI_TOOL_CALLING.md`](AI_TOOL_CALLING.md) (§1 "Is our registry MCP?") and
  [`AI_ARCHITECTURE.md`](AI_ARCHITECTURE.md) (the box diagram + roadmap).
