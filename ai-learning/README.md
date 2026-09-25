# OSHIVA — AI / Agent learning folder

This folder holds every doc written to help you **learn the concepts** behind OSHIVA (our in-app AI
assistant), not just the code. You said you're new to this domain, so these are written from the ground up:
plain language first, jargon explained the moment it appears, and each idea tied back to *where it lives in
our own code* so it's concrete, not abstract.

> **How to use this folder:** read the docs in the order below. Keep **`GLOSSARY.md`** open in a second tab —
> whenever a term is unfamiliar, look it up there (it's an A–Z of every concept we use, in plain English).
> At the end of each doc and in this README there are **free, public "further reading"** links if you want
> to go deeper on a topic.

---

## Read in this order

| # | Doc | What you'll learn | Depth |
| --- | --- | --- | --- |
| 0 | **`GLOSSARY.md`** | Every term in one place (LLM, token, agent, tool, RAG, MCP, embedding…), plain-English, with "in OSHIVA:" notes. Skim once, then use as a lookup. | reference |
| 1 | **`AI_AGENT_DESIGN.md`** | The master primer: what OSHIVA is, why an LLM doesn't "learn per chat", how the shared GPT-OSS stays private, and the overall plan. **Start here.** | foundational |
| 2 | **`AI_ARCHITECTURE.md`** | The target (bank-grade) architecture, what's built vs. planned, the component-by-component roadmap, and §1a "where the code lives" (the `oshiva/` package). | architecture |
| 3 | **`AI_TOOL_CALLING.md`** | The heart of how an agent works: how a question becomes *the right tool + arguments* (filters like "RAM > 70%", scope like "CIB only", coping with different phrasings), why we expose APIs as **described tools** (and whether that's "MCP"), and tools-vs-RAG. | core mechanism |
| 4 | **`AI_ROUTING.md`** | How one turn actually flows: the **Coordinator** routes to an agent (keyword scoring in `route()`), the agent is shown **only its own tools**, the **model** picks the tool + arguments, and `run_tool()` dispatches to the per-screen module ("MCP-like server"). Full worked trace + exact file/function names. **Read this to see how the pieces connect.** | core mechanism |
| 5 | **`AI_CAPABILITIES.md`** | The answer to "do we have to handle every scenario?" — you enumerate **capabilities + policies**, not phrasings; the finite capability surface, graceful failure, and how coverage grows from real usage. | mindset |
| 6 | **`AI_TOOL_AUTHZ.md`** | How OSHIVA never shows data you couldn't see in the UI — per-business-line authorization ("tools run as the user"). | safety |
| 7 | **`AI_PII_REDACTION.md`** | How DB passwords, connection strings and personal data (name/email/username/GUID/account number) are scrubbed from tool results before they reach the shared model or the audit log. | safety |
| 8 | **`AI_EVALS.md`** | How we **prove** OSHIVA behaves: a deterministic golden-Q&A + guardrail suite (`python -m oshiva.eval`) that checks routing, tool choice, refusals, the confirm-gate, redaction and prompt-injection — the gate to run before flipping on the real model. | safety / quality |
| 9 | **`AI_OBSERVABILITY.md`** | How we **see** every turn: the per-turn audit record (route, tools, tokens, latency) and the **cost** derived from it (`python -m oshiva.observability`). | operations |
| 10 | **`AI_RATE_LIMIT.md`** | How we cap how often the bot can be called (per-caller turns/minute → HTTP 429) so a loop or abuse can't run up cost — the Edge box. | operations |
| 11 | **`AI_SESSION_STORE.md`** | How OSHIVA remembers across turns (server-side memory), and how a conversation expires. | component |
| 12 | **`AI_MODEL_CLIENT.md`** | The one seam to the brain (`llm/client.py`): the stub vs. the real GPT-OSS, the shared `LlmResponse`, and how you switch. | component |
| 13 | **`AI_AUTHENTICATION.md`** | How OSHIVA proves *who* is asking — OIDC/SSO token validation, identity-from-token-never-the-body, and dev/dummy mode. | safety |
| 14 | **`AI_ADD_A_CAPABILITY.md`** | The build recipe: exactly which files change to wire a new capability (data layer → tool → agent → stub), and what you get for free. | how-to |

New component docs get added here as we build each piece (RAG, cost tracking, evals, PII redaction…), one
focused doc at a time.

---

## Concept → where it lives in OSHIVA → which doc

A quick map so the theory always has a concrete home in our code (`backend/oshiva/`):

| Concept | In our code | Learn it in |
| --- | --- | --- |
| The model ("brain") | `llm/client.py` (stub now; real GPT-OSS later) | AI_MODEL_CLIENT |
| Tool / function calling | `tools/registry.py` (`TOOL_SCHEMAS` + `run_tool`) | AI_TOOL_CALLING |
| The agent loop | `agents/runner.py` (`run_agent_loop`) | **AI_ROUTING**, AI_TOOL_CALLING |
| Coordinator / routing (which agent) | `agents/coordinator.py` (`run`), `agents/registry.py` (`route`) | **AI_ROUTING** §1 |
| Tool dispatch (which "server") | `tools/registry.py` (`run_tool`, `_DISPATCH`, `_MODULES`) | **AI_ROUTING** §4–5 |
| Authentication (who are you) | `auth_token.py` (`resolve_caller`), OIDC/SSO | AI_AUTHENTICATION |
| Authorization (what may you see) | `auth/gate.py` (screen) + `auth/scope_access.py` (per-line) | AI_TOOL_AUTHZ |
| Memory / session state | `memory/sessions.py` | AI_SESSION_STORE |
| Observability / audit + cost | `observability/audit.py` + `metrics.py` (`python -m oshiva.observability`) | AI_OBSERVABILITY |
| Rate limiting (edge) | `auth/rate_limit.py` (enforced in `api.py`) | AI_RATE_LIMIT |
| Evaluation / guardrail suite | `eval/` (`python -m oshiva.eval`) | AI_EVALS |
| PII / secret redaction | `security/redaction.py` (wired in `agents/runner.py`) | AI_PII_REDACTION |
| RAG (knowledge) | *planned (Phase 2.1)* | AI_ARCHITECTURE §4–5, AI_TOOL_CALLING §5 |
| MCP | *optional later; today's registry is the in-process equivalent* | AI_TOOL_CALLING §1 |

---

## Further reading — all free & publicly available

Curated, beginner-friendly, and free. Where a URL might drift, I've named the author/org so you can search
for it. Start with the ⭐ ones.

### Big-picture: what an LLM actually is
- ⭐ **Andrej Karpathy — "Intro to Large Language Models"** (1-hour YouTube talk). The best plain-English
  starting point; no maths required. Also his "Deep Dive into LLMs like ChatGPT".
- **Jay Alammar — "The Illustrated Transformer"** and **"The Illustrated GPT-2"** (jalammar.github.io).
  Picture-led explanations of how the model works inside.
- **3Blue1Brown — "Neural networks / Large language models" series** (YouTube). Visual intuition for the
  underlying maths, only as deep as you want.

### Prompting & talking to models
- ⭐ **Prompt Engineering Guide** (promptingguide.ai) — free, open, covers prompts, system prompts, few-shot,
  chain-of-thought.
- **Anthropic docs — Prompt engineering** (docs.anthropic.com) and **OpenAI — Prompt engineering guide**
  (platform.openai.com/docs). Free to read even if you don't use those APIs.

### Agents & tool/function calling  (most relevant to OSHIVA)
- ⭐ **Anthropic — "Building effective agents"** (anthropic.com/engineering/building-effective-agents).
  Short, practical, and matches our "thin loop + tools, add complexity only when needed" philosophy.
- ⭐ **Hugging Face — Agents Course** (huggingface.co/learn/agents-course). Free, hands-on, from basics.
- **OpenAI — Function calling docs** (platform.openai.com/docs/guides/function-calling). This is the exact
  tool-schema format our `TOOL_SCHEMAS` use.

### RAG, embeddings & vector search (for the knowledge phase)
- ⭐ **Pinecone Learn** (pinecone.io/learn) — free articles on embeddings, vector databases, and RAG, written
  for beginners.
- **Jay Alammar — "The Illustrated Word2Vec"** — the clearest intuition for what an "embedding" is.
- **RAG paper — Lewis et al., 2020** (search "Retrieval-Augmented Generation arXiv"). The original idea, free
  on arXiv — skim the intro/figures.
- **Sentence-Transformers docs** (sbert.net) — practical embeddings for search.

### MCP (Model Context Protocol)
- **modelcontextprotocol.io** — the official intro + spec. Read this only when we consider MCP; today our
  in-process registry does the same job (see AI_TOOL_CALLING §1).

### Safety, prompt injection & evaluation
- ⭐ **Simon Willison's blog — "prompt injection" tag** (simonwillison.net). Accessible, ongoing, security-
  focused — directly relevant to our "instructions come only from the user, tool output is data" rule.
- **OWASP — Top 10 for LLM Applications** (genai.owasp.org / search "OWASP LLM Top 10"). The standard risk
  checklist for LLM apps.
- **OpenAI Evals** (github.com/openai/evals) and **Hugging Face Evaluate** — free/open, for the "how do we
  measure quality" phase.

### Running models yourself (self-hosted, like our GPT-OSS)
- **Ollama** (ollama.com) — the simplest way to *feel* a local LLM on your own machine; great for intuition
  about self-hosting, context windows, and temperature.
- **Hugging Face — model hub & "Open LLM" docs** (huggingface.co) — where open models live and how they're
  served.

### Going broad (optional, when you want a full course)
- **Chip Huyen's blog & "AI Engineering"** writing (huyenchip.com) — excellent on LLM *systems* (RAG,
  evaluation, production concerns).
- **Full Stack Deep Learning — LLM materials** (fullstackdeeplearning.com) — free course content.

---

## Watch — free YouTube videos (for your free time)

Ordered to match what we're building. All free on YouTube; I've given **channel — title/topic** so they're
easy to search even if a link changes. Start with the ⭐ five.

**Foundations — what an LLM is**
- ⭐ **Andrej Karpathy — "[1hr Talk] Intro to Large Language Models"** (~1 hr). The best plain-English start;
  no maths needed.
- **3Blue1Brown — "But what is a GPT?"** and **"Attention in transformers"** (Deep Learning ch. 5–6, ~20 min
  each). Beautiful visual intuition for how the model works inside.
- **IBM Technology — "What is a Large Language Model?"** and **"How LLMs work"** (~5–10 min). Quick and clear.

**Agents & tools — our core**
- ⭐ **IBM Technology — "What are AI Agents?"** (~10 min). Exactly the agent idea OSHIVA uses.
- ⭐ **IBM Technology — "Function Calling / Tool Calling in LLMs"** (~5–10 min). This is precisely our
  `TOOL_SCHEMAS` mechanism.
- **Sam Witteveen — "Function Calling" / "AI Agents"** (channel; short, practical, with code). Great once the
  IBM overviews click.
- *(deep, optional)* **freeCodeCamp — an "AI Agents" full course** (multi-hour, free). We don't use LangChain,
  but the concepts transfer.

**RAG & embeddings — the next phase**
- ⭐ **IBM Technology — "What is Retrieval-Augmented Generation (RAG)?"** (~7 min). The clearest short intro.
- **IBM Technology — "What are Vector Databases?"** and **"Word Embeddings"** (~5–8 min each).

**MCP**
- **IBM Technology — "What is MCP (Model Context Protocol)?"** (short). Watch when we consider MCP (recall our
  registry does the same job today).

**Safety — very relevant to us**
- ⭐ **Simon Willison — "Prompt injection" talk** (search his name + "prompt injection"; conference talks on
  YouTube). Directly explains our "tool output is data, never instructions" rule.
- **IBM Technology — "LLM security / prompt injection"** (short).

**Self-hosting intuition (like our GPT-OSS)**
- **"Ollama — getting started / run an LLM locally"** (many free tutorials). Best way to *feel* a local model,
  context window and temperature on your own machine.

**Optional deep dives (when curious)**
- **Andrej Karpathy — "Deep Dive into LLMs like ChatGPT"** (~3.5 hr) and **"Let's build GPT from scratch"**
  (code-along). Only if you want to go under the hood.

---

> If you hit a topic you want to go deeper on that isn't listed, tell me and I'll add a free reference (or
> video) for it here. As we build each new component I'll also drop a topic-specific "further reading" line in
> that component's doc.
