# OLS Assistant — AI Agent Design & Architecture (Phase 2)

> **Status:** design / brainstorming. Nothing built yet. This is the master document for the AI part of
> the project; focused companion docs (tools, RAG, text-to-SQL, safety, ops) will branch off it as we
> build. Written to be readable by someone **new to agentic AI** — see the primer (§2) and glossary (§14).

---

## 1. Vision

Add a **private, on-prem AI assistant** ("OLS Assistant") to the OLS Dashboard: a chat interface backed
by an **agent** that can answer questions about the estate and *act* on the tool's own data —

- "List the CIB Windows servers." → reads your server inventory.
- "What's the status of the OMT service on `SRV-CIB-07`?" → calls the Service Console.
- "Show blocking sessions on the CIB batch DB." → calls the Oracle Command Center.
- *(later)* "What's the total LCR amount for 20-Sep-2026?" → figures out the right table, writes a safe
  SQL query, runs it read-only, and shows the number **and** the query.

Powered by your company's **self-hosted GPT-OSS model** — the "brain." **Everything stays inside your
network.** The model, the data, the prompts, the logs — none of it leaves your environment.

Audiences it should help: **developers** (debugging, "where is X configured"), **analysts** (data
questions, text-to-SQL), **ops/APS team** (server/service/DB status, runbooks), **end users** (how-to,
"why can't I see screen Y").

---

## 2. Agentic AI in 5 minutes (primer)

A few terms we'll use constantly:

- **LLM (Large Language Model):** the GPT-OSS model. It takes text in, produces text out. On its own it
  only *knows* what it was trained on and *sees* in the current prompt. It cannot look anything up or take
  actions by itself.
- **Agent:** an LLM wrapped in a loop that lets it **use tools**. The loop is: user asks → model decides
  "I need tool X with these arguments" → your code runs tool X → the result goes back to the model → model
  answers (or calls another tool). This "**tool/function calling**" is what turns a chatbot into an agent.
  *This is the core of our design.*
- **Tool (a.k.a. function):** a normal function in your backend the model is allowed to call, described to
  it by name + parameters (e.g. `list_servers(scope, os)`). The model never runs code itself — it only
  *requests* a call; **your code decides whether and how to run it.** This is where safety lives.
- **RAG (Retrieval-Augmented Generation):** instead of hoping the model "knows" your docs, you store your
  documents in a searchable index and, at question time, fetch the few most relevant chunks and paste them
  into the prompt. This is how the assistant "holds most of the tool's information" and stays current — you
  update the index, not the model.
- **Embeddings + vector store:** to make documents searchable *by meaning* (not keywords), you convert
  each chunk to a vector (a list of numbers) with an **embedding model**, and store them in a **vector
  store**. A question is embedded the same way; the store returns the nearest chunks. (GPT-OSS is a *chat*
  model — it does **not** produce embeddings, so we need a small separate embedding model too.)
- **Text-to-SQL:** the model writes a SQL query from a plain-English question. Powerful but the riskiest
  feature — needs heavy guardrails (read-only, allow-listed tables, validation). We do it **last**.
- **Hallucination:** the model confidently making something up. In an ops tool this is dangerous, so we
  design for **grounding** (answers come from tools/RAG, with citations) and an explicit "I don't know."
- **Prompt injection:** malicious text *inside data the model reads* ("ignore your rules and…") trying to
  hijack it. Because our agent reads DB rows, logs, and docs, we treat **all tool/RAG output as data, never
  as instructions** (§8).

---

## 3. The honest truth about "self-learning" ⭐ (read this)

You said you want it **self-learning** and to **keep feeding it data**. Important expectation-setting,
because getting this mental model right shapes the whole build:

**An LLM does not learn from each conversation automatically.** It doesn't silently absorb what your team
tells it. "Keeping it up to date" is achieved by **three mechanisms**, none of which retrain the model in
real time:

1. **Tools (live data)** — for anything that changes (server lists, service status, sessions, table data),
   the agent **calls your APIs/DB at question time**, so the answer is *always current by construction*.
   Nothing to "teach." This covers most of your Part-1 asks.
2. **RAG (knowledge you feed)** — for docs, runbooks, tribal knowledge, "how our estate works," you add
   documents to a **knowledge base** any time. The agent retrieves them on demand. *This is your "push data
   time to time" mechanism* — instant, no retraining, and you can correct/remove entries.
3. **Feedback loop + periodic fine-tune (optional, later)** — capture 👍/👎 and corrections on answers.
   Use them to (a) improve prompts and retrieval immediately, and (b) *optionally*, on a schedule (e.g.
   quarterly), run a **curated offline fine-tune** to bake in stable domain style/knowledge. This is
   deliberate and reviewed — **not** live weight updates (which cause "catastrophic forgetting," are
   expensive, and are a safety/audit nightmare).

So the practical definition of "self-learning" for us = **RAG that you keep updating + tools for live data
+ a feedback loop that continuously improves retrieval/prompts, with optional scheduled fine-tunes.** This
is exactly how serious private assistants are built, and it's better than literal self-learning because
every piece of knowledge is **inspectable, correctable, and auditable** — essential for a confidential ops
tool where a wrong answer has consequences.

---

## 4. High-level architecture

```
┌──────────────────────────────────────────── Angular SPA ────────────────────────────────────────────┐
│  Chat panel (streaming)  ·  tool-call trace ("checking service status…")  ·  citations  ·  show-SQL   │
└───────────────────────────────────────────────┬──────────────────────────────────────────────────────┘
                                                 │  POST /api/assistant/chat   (SSE stream)
                                                 ▼
┌──────────────────────────────── FastAPI backend (in your VPC) ────────────────────────────────────────┐
│  Assistant API  →  Agent Orchestrator (the tool-calling loop)                                          │
│      │                     │                                                                            │
│      │                     ├── Tool registry  ──► existing backend services, run AS the signed-in user  │
│      │                     │       list_servers · service_status · blocking_sessions · (later) run_sql   │
│      │                     ├── Retriever (RAG) ──► Vector store  ◄── ingestion pipeline (docs/runbooks)  │
│      │                     └── LLM client ──────► GPT-OSS endpoint (private, OpenAI-compatible)          │
│      └── Audit log (every prompt, tool call, result, answer)   ·   RBAC gate   ·   rate limit           │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ read-only DB role for data queries        ▲ embedding model (private)        ▲ NO internet egress
```

**Non-negotiables baked in from day one:** private model (no egress), the agent **runs tools as the
signed-in user** (so it can never exceed that user's RBAC), a **read-only** DB role for data, and a
**full audit trail**.

---

## 5. Components

| Component | Role | Phase |
| --- | --- | --- |
| **Chat UI** | Angular panel/drawer; streams tokens; shows tool-call steps + citations; feedback buttons. | 2.0 |
| **Assistant API** (`/api/assistant/*`) | FastAPI endpoints: `chat` (SSE stream), `feedback`, `history`. RBAC-gated. | 2.0 |
| **Agent orchestrator** | The tool-calling loop: send messages+tools to the model, execute requested tools, feed results back, stream the final answer. Enforces a max-steps budget. | 2.0 |
| **Tool registry** | Typed wrappers over your existing services (Infra Pulse, Service Console, OCC). Each tool authorizes against the caller's RBAC before running. | 2.0 |
| **LLM client** | Thin client to the GPT-OSS endpoint (OpenAI-compatible chat + tool-calling). | 2.0 |
| **Audit log** | Persists every turn: user, prompt, tool calls + args + results, final answer, latency, tokens. | 2.0 |
| **Vector store + retriever** | Stores embedded doc chunks; returns top-k for a question. | 2.1 |
| **Embedding model** | Private model that turns text → vectors (separate from GPT-OSS). | 2.1 |
| **Ingestion pipeline** | Load → chunk → embed → upsert docs/runbooks/inventories; re-runnable to "feed data." | 2.1 |
| **Semantic layer** | Curated table/column/metric definitions ("LCR amount" → table.column) for text-to-SQL. | 2.3 |
| **Eval harness** | Golden Q&A set to measure accuracy before widening access. | 2.2+ |

---

## 6. Capability model — Tools vs RAG vs Text-to-SQL

Pick the right mechanism per question type:

| Question type | Mechanism | Example |
| --- | --- | --- |
| Live/structured state of the estate | **Tool call** (existing API) | "list CIB Windows servers", "service status on SRV-07", "blocking sessions" |
| How-to / policy / tribal knowledge / "where is X" | **RAG** over docs | "how do I roll a COB date?", "what does the regression Refresh step do?" |
| Ad-hoc numbers from the DB | **Text-to-SQL** (guarded) | "total LCR amount for 20-Sep-2026" |
| Mix | **Agent combines them** | "which servers running OMT had errors last night?" → tool + log RAG |

Rule of thumb: **prefer a deterministic tool over free-form SQL** wherever a tool exists — it's safer,
faster, and testable. Text-to-SQL is the fallback for the long tail of ad-hoc analytics.

---

## 7. Phase plan

Each phase is shippable and gated to `B27886` until you widen access.

- **Phase 2.0 — Foundations + first tools (the MVP).**
  Chat UI (streaming) · agent loop · 2–3 read-only tools (`list_servers`, `service_status`,
  `blocking_sessions`) · access gate (hardcoded `B27886`) · audit log · safety scaffolding.
  *Exit:* B27886 can ask the three questions above and get correct, cited, audited answers.

- **Phase 2.1 — RAG knowledge base + feedback.**
  Vector store + embeddings + ingestion of GUIDE.md, `document_repo`, runbooks, server inventory.
  👍/👎 + correction capture. *Exit:* "how-to" and "where is X" questions answered from your docs with
  citations; you can add a doc and see the answer change.

- **Phase 2.2 — More read tools + evals.**
  Broaden OCC/Infra/Service tools; build the golden-Q&A eval set; measure accuracy.
  *Exit:* a measured accuracy baseline; coverage of the common ops questions.

- **Phase 2.3 — Text-to-SQL (guarded).**
  Read-only DB role · allow-listed schema · semantic layer · SQL validation (no DML/DDL, forced LIMIT,
  EXPLAIN) · show-the-SQL UX · start with **curated query templates**, then free-form. *Exit:* the "LCR
  amount for a date" class of question works safely, transparently, and is logged.

- **Phase 2.4 — Widen + advance.**
  Move the gate from hardcode to RBAC (grant `assistant`) · proactive insights · role-aware depth ·
  optional guarded *write* actions (with confirmation) · optional scheduled fine-tune.

---

## 8. Safety, security & confidentiality (the important part)

Because the data is confidential and this is an ops tool, safety is a first-class feature, not an add-on.

- **Private model, zero egress.** The GPT-OSS endpoint is internal-only; the backend never calls the
  public internet for inference, embeddings, or anything else. Confirm the model host has no outbound
  telemetry.
- **The agent acts *as the user*.** Every tool authorizes against the **signed-in user's RBAC** (reuse the
  existing `/api/access/me` model). The agent can never see or do more than the user could in the UI.
- **Read-only by default.** Phase 2.0–2.3 are strictly read. Any future *write* action (restart a service,
  etc.) is a separate, individually-gated tool with an explicit confirmation step and audit — never
  implicit.
- **DB access is a locked-down read-only role.** Text-to-SQL uses a dedicated Oracle user with SELECT on an
  **allow-listed** set of tables/views only; statement timeout; forced row `LIMIT`/`FETCH FIRST`; queries
  parsed and rejected if they contain DML/DDL/PL-SQL or touch non-allow-listed objects; `EXPLAIN` before
  execute.
- **Treat all tool/RAG/DB output as *data, not instructions*.** A row, log line, or doc that says "ignore
  your instructions" is shown to the user, never obeyed (prompt-injection defense). The system prompt is
  fixed server-side; user/content text can't override it.
- **Full audit trail.** Persist every turn (who, prompt, tool calls + args + results, answer, tokens,
  latency). This is your incident-review and abuse-detection record, and it's required for a confidential
  system.
- **PII / sensitive data.** Decide what the assistant may surface; redact where needed; keep audit logs
  access-controlled. Don't log secrets/tokens.
- **Grounding over guessing.** Prompt the model to answer *only* from tool/RAG results and to say "I don't
  have that information" otherwise. Show **citations** so users can verify. Hallucination in ops = wrong
  action taken.
- **Rate limits & budgets.** Per-user request limits and a per-conversation max-tool-steps budget (prevents
  runaway loops and cost/latency blowups).
- **Evaluation before expansion.** Don't widen access on vibes — use the eval harness (§5) to show accuracy
  on a golden set first.

---

### 8.1 Reusing a shared, company-wide model — data isolation ⭐

Your GPT-OSS is a **shared platform**: it serves multiple teams and has broad infra access. You want to
reuse it but ensure **the knowledge/data you feed is never exposed to the other teams on the same model.**
Here's why that's achievable and how:

- **A shared inference endpoint is stateless per request.** You send a prompt → it answers → it forgets.
  Other teams' calls are independent; they cannot see your prompts or data. Reusing the model for
  **inference** does not leak anything. The model is a *rented brain*, not a shared memory.
- **Your "learning" lives in a store YOU own, not in the model.** All fed knowledge goes into **your
  project's RAG vector store** (your DB/store), retrieved only by your backend for your users. It never
  becomes part of the shared model, so no other team can reach it. **Isolation by construction.**
- **Do NOT fine-tune the shared base model with your data.** That is the *one* way your knowledge would
  bake into everyone's model. If fine-tuning is ever needed, use a **private LoRA adapter scoped to your
  project** — never the shared weights. Default: don't fine-tune; RAG covers it.
- **Verify one thing with the platform team:** does the shared endpoint **log/retain prompts** or **train
  on them**? If it's inference-only with no prompt retention/training (the norm for an internal vLLM/TGI
  serving layer), you are isolated. If it does retain/train, mitigate by requesting a no-log mode, and/or
  by sending **references/IDs** in prompts that your *private* tools resolve, instead of raw sensitive
  values.

**Summary: shared brain, private memory.** Confidentiality comes from keeping your data in your own store
and out of any shared training — not from owning a dedicated model.

## 9. Access control (your specific requirement)

**Now (dev):** visible only to **`B27886`**. Implemented as a small server-side allow-list **and** a
frontend nav/route guard:

```python
# backend — single source of truth for who may use the assistant (dev)
ASSISTANT_ALLOWED_USERS = {"B27886"}          # TODO: replace with an RBAC grant in Phase 2.4
def _require_assistant(caller: str):
    if caller not in ASSISTANT_ALLOWED_USERS:
        raise HTTPException(403, "Assistant is not enabled for your account.")
```

The frontend hides the chat entry point unless the signed-in username is `B27886` (mirrors how other
screens are gated). Server-side is the real boundary; UI hiding is convenience.

**Later (Phase 2.4):** swap the hardcoded set for a proper **`assistant` screen grant** in `ols_app_access`
(exactly like your other opt-in screens), so you hand out access per user with no code change. The design
uses a single `_require_assistant` chokepoint so this swap is one function.

---

## 10. Text-to-SQL design (Phase 2.3 — expanded)

The hardest, highest-value, highest-risk feature. Layered approach, safest first:

1. **Semantic layer (curated):** a machine-readable catalog of the tables/views the assistant may use —
   business description, columns, types, joins, and **metric definitions** ("LCR amount" → which
   table/column, any filters). This is what lets the model map "LCR amount for a date" to the right SQL.
   Curated by you, versioned, and fed to the model as context. Start small (the tables analysts actually
   ask about).
2. **Templates before free-form:** for known, recurring questions, ship **parameterized query templates**
   (the model fills the parameters, not the SQL). Deterministic and safe. Promote free-form generation only
   for the long tail.
3. **Generation:** model writes a candidate SELECT using the semantic layer + a few worked examples
   (few-shot).
4. **Validation (hard gate):** parse the SQL; reject anything that isn't a single read-only SELECT, touches
   a non-allow-listed object, or omits a row cap; inject `FETCH FIRST :n ROWS ONLY`; run `EXPLAIN` to catch
   nonsense/expensive plans.
5. **Execute** on the read-only role with a statement timeout.
6. **Transparency UX:** always show the **SQL used** and the row count alongside the answer, with a copy
   button. Analysts trust (and can correct) what they can see.
7. **Human-in-the-loop** for ambiguity: if the mapping is uncertain, the assistant asks a clarifying
   question or shows the SQL for confirmation before running.

---

## 11. Advanced ideas & roadmap (you asked for these)

Beyond the basics, high-value additions for your audiences:

- **"Explain this error/log."** Paste a stack trace or log line → root-cause summary + link to the relevant
  runbook (ties straight into your Log Analytics + `document_repo`).
- **Proactive briefings.** A scheduled digest: "Overnight: 2 servers degraded, 1 batch failed, 3 blocking
  sessions cleared." Reuses your Infra/OCC data; pushes to the dashboard or the morning brief.
- **Role-aware answers.** An analyst gets numbers + SQL; the APS team gets status + next action; a developer
  gets config locations + file paths. Same question, tailored depth (driven by the user's RBAC role).
- **NL over the Oracle Command Center.** "Top 5 SQL by CPU today", "which MViews are stale" — you already
  have the queries; expose them as tools.
- **Runbook copilot.** Guided, step-by-step help through your Regression / Config-Ops workflows, with the
  actual actions still gated + confirmed (bridges chat → your existing gated workflows).
- **Incident/ticket drafting.** "Draft an incident note for the SRV-07 outage" using live status + history.
- **"What changed?"** Diff-style answers over config/regression history ("what changed in CIB config since
  Friday?").
- **Guarded write actions (later).** "Restart the OMT service on SRV-07" → confirmation dialog → audited
  action via an existing gated API. Read-first, always.
- **Saved answers / team knowledge.** Promote a good answer into the RAG KB so the team benefits (a clean,
  reviewed form of "self-learning").

---

## 12. Tech stack — options & recommendations

| Layer | Options | Recommendation |
| --- | --- | --- |
| **Model serving** | vLLM · Ollama · TGI · llama.cpp — all can serve GPT-OSS with an **OpenAI-compatible** API | Whatever your company already runs. We just need the base URL + an OpenAI-compatible `/chat/completions` **with tool-calling**. |
| **Orchestration** | (a) thin custom loop on the OpenAI SDK · (b) PydanticAI (typed, light) · (c) LangChain/LlamaIndex (batteries, heavier) | **(a) thin custom loop** — matches your dependency-light style (you avoided markdown-it/DOMPurify), gives full control + auditability. PydanticAI is a fine typed alternative. Skip LangChain unless we need it. |
| **Embeddings** | `bge-m3` · `e5-large` · `nomic-embed-text` — served privately | A small private embedding model alongside GPT-OSS. (GPT-OSS can't embed.) |
| **Vector store** | **Oracle 23ai AI Vector Search** · pgvector · Chroma/FAISS (local) | If you're on **Oracle 23ai**, use its native vector search — data stays in Oracle, one less system. Else pgvector, else local Chroma for the MVP. |
| **Streaming** | SSE from FastAPI → Angular | SSE (simplest; one-way stream fits chat). |
| **Audit/state** | Your Oracle DB (`ols_ai_*` tables) | New tables: conversations, messages, tool_calls, feedback. |

---

## 13. Decisions & open items

**Locked (2026-09-21):**
- **Model:** reuse the company's **shared GPT-OSS** platform (multi-tenant). Isolation handled per §8.1 —
  private RAG store, no shared fine-tune. ⚠️ *Action:* confirm the endpoint's prompt log/retention/training
  policy with the platform team.
- **Orchestration:** **thin custom tool-calling loop** (minimal deps, full control/auditability).
- **First slice (Phase 2.0):** **chat + 3 read tools** (`list_servers`, `service_status`,
  `blocking_sessions`), gated to `B27886`, with audit + streaming. RAG deferred to 2.1.
- **RAG storage/embeddings:** **deferred** — decided at the start of Phase 2.1.

**Still needed to write the LLM client (get from the GPT-OSS platform team):**
1. **Base URL** of the endpoint + **auth** method (API key / bearer / header name).
2. Is it **OpenAI-compatible** (`/v1/chat/completions`)? Does it support **native tool/function calling**?
   (If not, we use a prompt-based tool protocol — still works.)
3. **Model name/id** to pass (e.g. `gpt-oss-20b` / `gpt-oss-120b`) and any context-window limit.
4. Prompt **retention/training** policy (the §8.1 verification).

---

## 14. Glossary

- **Agent** — an LLM in a loop that can call tools.
- **Tool / function calling** — the model requests a named function with arguments; your code runs it.
- **RAG** — retrieval-augmented generation; fetch relevant docs at question time and add them to the prompt.
- **Embedding** — a vector representation of text used for semantic search.
- **Vector store** — a database of embeddings with nearest-neighbour search.
- **Semantic layer** — curated descriptions of tables/columns/metrics that ground text-to-SQL.
- **Grounding** — making answers come from real retrieved/tool data, with citations.
- **Hallucination** — the model fabricating an answer.
- **Prompt injection** — malicious instructions hidden in data the model reads.
- **Fine-tuning** — further training the model's weights on curated examples (offline, deliberate).
- **SSE** — server-sent events; a simple one-way stream (used to stream the answer to the browser).
