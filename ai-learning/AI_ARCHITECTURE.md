# OSHIVA — Target Architecture & Component Roadmap

Companion to `AI_AGENT_DESIGN.md`. This maps OSHIVA onto the **bank-grade production agent architecture**
you shared, shows what we've already built vs. what's ahead, and gives a **component-by-component build
order** so you can learn each piece as we add it.

> **TL;DR:** The reference architecture is excellent and we adopt it as our **North Star**. We already have
> ~half of it built (UI, Auth, API, Coordinator agent, Authorisation/RBAC, Observability-lite). The rest —
> Session Store, RAG, Cost Tracker, PII Redaction, Eval Suite, and *optionally* multi-agent + MCP servers —
> we add **phase by phase**, not all at once.

---

## 1. Target architecture (OSHIVA, adapted from the reference)

![OSHIVA AI architecture — a layered view: Client → Edge (rate-limit) → API, gated by Authentication and Authorization, into the Coordinator which routes to one specialist agent; the agent calls per-domain tools that reach the existing OLS backends; the brain is the self-hosted GPT-OSS; and cross-cutting services (session store, PII redaction, observability + cost, eval suite, RAG) support every turn. Box colour shows build status.](ai-architecture.svg)

*(Colourful diagram — `ai-architecture.svg`. The same structure is spelled out in ASCII below for plain-text viewers, with per-box build status.)*

```
                         ┌──────────────────────────────┐
                         │  User Interface — OSHIVA chat │   [BUILT 2.0]
                         │       (Angular widget)        │
                         └───────────────┬───────────────┘
                                         │  HTTPS
                                         ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  EDGE LAYER   (WAF · DDoS = bank infra) · Rate-limit · Gateway │  [◑ gateway yes; rate-limit ✔ built]
        └───────────────┬───────────────────────────────┬──────────────┘
                        │                                │
                        ▼                                ▼
             ┌────────────────────┐          ┌──────────────────────────┐
             │  API  /api/assistant│          │  AUTHENTICATION (OIDC)    │  [BUILT — SSO / auth_token]
             │        /*           │          │  bank identity provider   │
             └─────────┬──────────┘          └──────────────────────────┘
                       │
                       ▼
        ┌───────────────────────────────┐        ┌───────────────────────┐
        │      COORDINATOR AGENT         │◄──────►│  AUTHORISATION (RBAC)  │  [BUILT — runs as the user]
        │  (agent loop; single agent now)│        │  SCREEN/assistant grant│
        └───────────────┬───────────────┘        └───────────────────────┘
                        │  tool calls
      ┌─────────────────┼──────────────────┐        (future: specialist sub-agents
      ▼                 ▼                  ▼          Infra Agent · DB Agent · Config Agent)
 ┌──────────┐    ┌──────────────┐   ┌──────────────┐
 │ Infra    │    │  OCC / DB    │   │  Config /    │   ← TOOLS  [BUILT 2.0, mock data]
 │ tools    │    │  tools       │   │  Service     │      now: direct Python functions
 │ list_    │    │ blocking_    │   │  tools       │      later: MCP servers per domain
 │ servers… │    │ sessions…    │   │ (2.2+)       │
 └────┬─────┘    └──────┬───────┘   └──────┬───────┘
      ▼                 ▼                  ▼
   Infra Pulse      Oracle CC          Service Console / Config Ops   ← your EXISTING backends
   (real data when tools flip from mock → live)

        ┌──────────────────────────── LLM LAYER ────────────────────────────┐
        │  Self-hosted GPT-OSS (PRIVATE)   [client BUILT; set .env to switch] │
        │  Third-party LLM  → OMITTED for OSHIVA (confidentiality)            │
        └────────────────────────────────────────────────────────────────────┘

  ┌───────────────────────────── CROSS-CUTTING SERVICES ──────────────────────────────┐
  │ Observability [✔ audit+cost]   Cost Tracker [✔ built]   PII Redaction [✔ built]        │
  │ Session Store  [◑ client→DB, 2.1]     Retriever + Vector store (RAG) [✗ 2.1]        │
  │ Agent Evaluation Suite (golden Q&A / safety) [✔ built — oshiva/eval]                 │
  └────────────────────────────────────────────────────────────────────────────────────┘

  Legend:  BUILT = done · ◑ = partial · ✗ = planned (phase noted)
```

---

## 1a. Where the code lives — the `oshiva` package

All bot code lives under **`backend/oshiva/`**, grouped by concern so each architecture box maps to a
subpackage (restructured 2026-09-23 — the HTTP contract `/api/assistant/*` and `oshiva/assistant.json` are
unchanged; only the code moved):

```
backend/oshiva/
  api.py                     ← the FastAPI router (/api/assistant/*); request entry point
  agents/
    coordinator.py           ← routes a turn to an agent, then runs it (the multi-agent seam)
    registry.py              ← Agent dataclass + AGENTS registry + route(); per-domain specialists:
                                infra · database · config_ops · regression (each carries only its own tools)
    runner.py                ← run_agent_loop(): the tool-calling loop for ONE agent (streams events)
  tools/                     ← ONE module per screen (add a screen = new file + 1 line in registry)
    base.py                  ← shared helpers (scope mapping, num, the standard denial)
    infra_pulse.py           ← list_servers (scope/os/RAM/CPU/disk/state) + service_status + list_services
                                (cross-server, read-only; writes → link to screen) + list_shares (NAS)
    oracle_command_center.py ← blocking_sessions · top_tables · top_indexes · unusable_indexes ·
                                list_sessions · sql_detail (plan/monitor → download); writes → link to screen
    config_ops_console.py    ← read (list/get/describe/query_table) + find_tables_with_column +
                                export_config (CSV download) + roll_config (confirm-gated WRITE)
    regression.py            ← regression_status (names the step it's on) /activity/batch_status/
                                downstream_extract (read-only) + generate_filecopy_manifest /
                                generate_cleanup_manifest (author a downloadable JSON; nothing copied/deleted)
    registry.py              ← thin aggregator: gathers each module's SCHEMAS/TOOLS + run_tool()
  auth/
    gate.py                  ← screen gate: "may you use OSHIVA at all?" (enabled + allow-list / RBAC)
    scope_access.py          ← tool authz: which business lines (group/cib/retail) the caller may query
  security/
    redaction.py             ← scrubs secrets + PII from every tool result (before model + audit)
  memory/
    sessions.py              ← server-side conversation history + shared scratchpad (per conversation_id)
  llm/
    client.py                ← the model client (STUB now; real GPT-OSS later, loop unchanged)
  observability/
    audit.py                 ← append-only audit log of every turn + feedback vote
```

Runtime data keeps its existing on-disk names: sessions in `backend/assistant_data/sessions/`, audit in
`backend/Logs/assistant/`. Frontend widget lives under **`src/app/oshiva/`**
(`OshivaService`, `OshivaWidgetComponent` `<app-oshiva-widget>`, `OshivaRobotComponent`).

---

## 2. Reference → OSHIVA mapping (what we have vs. what's ahead)

| Reference component | OSHIVA equivalent | Status | When |
| --- | --- | --- | --- |
| **User Interface (chat)** | OSHIVA Angular widget (launcher + drawer, streaming) | ✅ Built | 2.0 |
| **Edge Layer** (WAF, DDoS, Rate limit, Gateway) | `ui_server` proxy = gateway; **rate-limit built** (`auth/rate_limit.py`, per-caller turns/min → 429); WAF/DDoS = your bank's network infra | ✅ Rate-limit built | 2.2 |
| **Authentication** (bank identity provider) | OIDC / SSO (`auth_token.py`, `sso.config.ts`) — see `AI_AUTHENTICATION.md` | ✅ Built (design) | done |
| **API** | FastAPI `/api/assistant/*` | ✅ Built | 2.0 |
| **Coordinator Agent** | `oshiva/agents/coordinator.py` (routes a turn to an agent) | ✅ Built | 2.0 |
| **Specialist Agents** (Accounts/Transaction/Service) | `oshiva/agents/registry.py` — **4 per-domain agents: infra · database · config_ops · regression**; pluggable (add = append to `AGENTS`). Routing is keyword-based (one agent/turn, no extra model call) so more agents don't add latency; `strong_keywords` carry ×3 weight so an unambiguous intent beats an accidental one-word overlap | ✅ Built (4 agents) | grows |
| **MCP Servers** | `oshiva/tools/*` (per-screen modules, direct functions now) → MCP servers later | ◑ Direct tools | later |
| **Downstream operations** (balance, txn, KYC…) | Infra/Service/OCC/Config tools — Infra + Service Console + OCC (blocking, top tables/indexes, index health, sessions, sql_id investigation) + Config Ops all wired (dummy in dev, live in prod); reads open, writes refuse+link | ✅ wired | 2.0 |
| **Authorisation** | RBAC: `SCREEN/assistant` grant (screen gate) **+ per-tool scope checks** (tools run *as the user* — deny/filter by group/cib/retail; see `AI_TOOL_AUTHZ.md`) | ✅ Built | 2.0 |
| **PII Redaction** | Redact secrets + personal data before they reach the LLM/audit (`security/redaction.py`, central in `runner.py`; see AI_PII_REDACTION.md) | ✅ Built | done |
| **Observability** | Audit log per turn (route/agent, tool calls + per-tool ms, tokens, latency, cost); roll-up via `python -m oshiva.observability` | ✅ Built | 2.2 |
| **Cost Tracker** | Per-turn token usage (`LlmResponse.usage`, exact real / estimated stub) → cost via config prices (`metrics.cost_of`) | ✅ Built | 2.2 |
| **Session Store** | Conversation history + inter-agent shared state (file now → DB `ols_ai_*`) | ✅ Built (scaffold) | 2.1 |
| **Agent Evaluation Suite** | Golden-Q&A + safety eval harness (`oshiva/eval`, `python -m oshiva.eval`) | ✅ Built | 2.2 |
| **LLM Layer** (self-hosted + third-party) | **Self-hosted GPT-OSS only** — OpenAI-compatible client **implemented** (`llm/client._complete_real`); set `ASSISTANT_BASE_URL`/`_MODEL`/`_API_KEY` in `.env` + `ASSISTANT_USE_STUB=false` to switch on | ◑ code ready, config pending | on config |

**Bottom line:** the two architectures are the *same shape*. OSHIVA already covers the request path
(UI → Edge/Gateway → Auth → API → Coordinator agent → tools → LLM) plus Authorisation and basic
Observability. What's left is mostly the **cross-cutting governance layer** (Session Store, Cost, PII,
Eval) and the **optional scale-up** (multi-agent + MCP).

---

## 3. My recommendation (honest, as your AI lead)

**Adopt it as the North Star — but build it phased, and don't over-build.**

1. **Prioritise the cross-cutting/governance boxes over multi-agent.** For a confidential, bank-like tool,
   PII redaction, audit/observability, session store, cost tracking and evals matter *more* than having
   many agents. They're what make it safe and operable.
2. **Coordinator + pluggable agents (chosen).** We built a real **Coordinator**
   (`oshiva/agents/coordinator.py`) that routes each turn to an agent from a **registry**
   (`oshiva/agents/registry.py`) — **one agent today (Ops)**, and adding a specialist later (e.g. a
   **DB/SQL Agent**, **Infra Agent**, **Config Agent**) is just appending it to `AGENTS` (plug in / plug
   out), no call-site change. This keeps today simple (one agent, low latency/cost) while the multi-agent
   seam is already in place for when task-splitting is worth it.
3. **Adopt MCP servers when you want standardised, reusable tools.** MCP (Model Context Protocol) is the
   clean way to expose tools as independent, language-agnostic servers other agents/teams can reuse. Our
   `oshiva/tools/registry.py` is functionally the same thing today; migrating to MCP is a later, low-risk
   evolution.
4. **Keep OSHIVA self-hosted-only.** The reference routes non-sensitive traffic to a third-party LLM to
   save cost. Given your confidentiality mandate, I'd **omit the third-party LLM** unless a clearly
   non-sensitive use appears — one less egress path to worry about.

This phased approach is *ideal* for your "learn in parallel" goal: each box below is one focused component
you can study as we build it.

---

## 4. Component-by-component build order

**Already built (Phase 2.0):** UI · API · Coordinator agent (single) · Authorisation/RBAC · Tools (mock) ·
Observability-lite (audit log) · Access gate (private-beta pin + RBAC).

Suggested next components (each is a self-contained learning unit):

| # | Component | What you'll learn | Effort |
| --- | --- | --- | --- |
| 1 | **Session Store** (DB-backed conversation history + shared state; `ols_ai_*` tables) | how agents remember across turns; server-side state | S–M |
| 2 | **RAG** (Retriever + Vector store + ingestion) | embeddings, semantic search, grounding, "feed it data" | M |
| 3 | **Cost Tracker + Observability upgrade** (tokens, latency, traces) | measuring/operating an LLM system | ✅ done — `AI_OBSERVABILITY.md` |
| 4 | **Edge rate-limiting** on `/api/assistant/*` | protecting an LLM endpoint from abuse/runaway cost | ✅ done — `AI_RATE_LIMIT.md` |
| 5 | **Agent Evaluation Suite** (golden Q&A, safety checks) | proving quality before widening access | ✅ done — `AI_EVALS.md` (`python -m oshiva.eval`) |
| 6 | **PII Redaction** (before the LLM; esp. for DB data) | data protection in an AI pipeline | ✅ done — `AI_PII_REDACTION.md` |
| 7 | **Real tools** (flip mock → live Infra/OCC/Service) | wiring an agent to real systems safely — *`list_servers` + `service_status` live via Infra/Service Console; Config Ops read tools wired; blocking sessions next* | M |
| 8 | **Text-to-SQL** (guarded, read-only, semantic layer) | NL→SQL with guardrails | L |
| 9 | *(scale-up)* **MCP servers** + **specialist sub-agents** (multi-agent) | multi-agent orchestration, MCP | L |
|   | **Wire real GPT-OSS** (any time the endpoint details land) | swapping the stub brain for the model | S |

We'll build one at a time, verify it, and I'll document each in its own short `.md` so you have a growing,
readable reference.

> **New:** for *how OSHIVA turns a question into the right tool + arguments* (e.g. "servers with RAM > 70%",
> "CIB only", coping with different phrasings, and why we expose APIs as described **tools** rather than
> feeding it the whole API), see **`AI_TOOL_CALLING.md`**.

---

## 5. What each cross-cutting component *is* (quick learner's glossary)

- **Edge Layer** — the front door. WAF/DDoS/rate-limits protect the API before any agent logic runs. For
  us: your reverse proxy is the gateway; we add rate-limiting; WAF/DDoS are your bank's network layer.
- **Authentication vs Authorisation** — *authentication* = "who are you?" (OIDC/SSO, the bank IdP);
  *authorisation* = "what may you do?" (our RBAC grants). Two different boxes on purpose.
- **Coordinator Agent** — the brain that plans: decides which tool/sub-agent to call, in what order, and
  composes the final answer.
- **MCP Server** — a standard wrapper that exposes a set of tools over a protocol, so any agent can use
  them without custom glue. Think "USB for tools."
- **Session Store** — where a conversation's history and any shared state live between turns (and, in
  multi-agent setups, between agents).
- **Observability** — logs/traces/metrics for every prompt, tool call, latency and token count, so you can
  see and debug what the agent did.
- **Cost Tracker** — counts tokens/compute per call so you can watch spend and set budgets.
- **PII Redaction** — strips or masks personal/sensitive data before it's sent to the model.
- **Agent Evaluation Suite** — a test set of questions with expected answers + safety checks, run to
  measure the agent's quality/safety before you trust or widen it.
- **LLM Layer** — the model(s). Self-hosted for sensitive data (ours); some architectures add a third-party
  model for cheap, non-sensitive traffic (we omit it).
