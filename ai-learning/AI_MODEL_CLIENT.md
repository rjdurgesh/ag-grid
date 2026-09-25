# AI_MODEL_CLIENT — the brain behind one seam

**In one line:** the *model client* is the ONE place OSHIVA talks to a language model. Everything else (the
coordinator, the agent loop, the tools) is model-agnostic — swap the brain and nothing above it changes.

> **Where it lives:** `backend/oshiva/llm/client.py`. The only function the rest of the code calls is
> `complete(messages, tools, cfg)`.

---

## 1. The seam: one function, one return shape

The agent loop ([`AI_ROUTING.md`](AI_ROUTING.md)) never imports a model SDK. It calls:

```python
resp = llm_client.complete(messages, tools, cfg)
```

and gets back an `LlmResponse` that is **either** a final answer **or** a request to run tools:

```python
@dataclass
class LlmResponse:
    content: str | None = None            # the final text answer (when the model is done)
    tool_calls: list[dict] = []           # [{id, name, arguments}] (when the model wants a tool first)
    usage: dict = {}                      # {prompt_tokens, completion_tokens, total_tokens, estimated?}
```

This mirrors an OpenAI "chat choice". Because the *shape* is fixed, the loop is identical no matter which brain
produced it — that's the whole point of the seam.

`complete()` just picks the brain from config:

```python
def complete(messages, tools, cfg):
    if cfg.get("use_stub", True):
        resp = _complete_stub(messages, tools)
        if not resp.usage:
            resp.usage = _estimate_usage(messages, resp)   # so cost/observability still get numbers
        return resp
    return _complete_real(messages, tools, cfg)
```

---

## 2. Two brains behind it

### a) The stub (`_complete_stub`) — scaffold, no model needed

A deterministic planner that *mimics* a tool-using model with keyword rules, so the entire chat + tool pipeline
runs on a laptop with **no GPU and no endpoint**. It reads the current agent's tools and either emits a
`tool_call` (e.g. "servers with RAM over 70%" → `list_servers{min_ram_percent:70}`) or, when a tool result is
already present, summarises it into an answer.

It is **throwaway** and intentionally brittle — it only understands phrasings we coded. Its jobs are: (1) let us
build and test everything else before the model lands, and (2) make the eval suite deterministic
([`AI_EVALS.md`](AI_EVALS.md)). It is retired by setting `use_stub=false`; you may keep it as an offline
fallback. **Never add business logic here** — the real model handles language natively.

### b) The real brain (`_complete_real`) — self-hosted GPT-OSS

A single OpenAI-compatible HTTP call:

```python
POST {base_url}/v1/chat/completions
Authorization: Bearer <ASSISTANT_API_KEY>        # only if the endpoint needs one
{ "model": ..., "messages": [...], "tools": [...], "tool_choice": "auto", "temperature": 0.1 }
```

It sends the transcript + the agent's tool schemas, sets `tool_choice="auto"` so the model decides whether to
call a tool, and parses the reply back into the same `LlmResponse` (content, `tool_calls`, and the exact
`usage` block). `_endpoint()` accepts a base with or without `/v1`. An empty `base_url` raises a clear error
telling you to set `.env` or turn the stub back on.

---

## 3. Configuring & switching

All via config (`config/assistant.json`) or `.env` — see [`AI_AGENT_DESIGN.md`](AI_AGENT_DESIGN.md) §8 for the
go-live detail:

| Key | Meaning |
| --- | --- |
| `use_stub` (`ASSISTANT_USE_STUB`) | `true` = stub brain · `false` = real GPT-OSS |
| `base_url` (`ASSISTANT_BASE_URL`) | the OpenAI-compatible endpoint |
| `model` (`ASSISTANT_MODEL`) | the served model id (e.g. `gpt-oss-20b`) |
| `api_key` (`ASSISTANT_API_KEY`) | **secret → `.env` only**, never in JSON/code |
| `timeout` (`ASSISTANT_TIMEOUT`) | per-call timeout (s) |
| `temperature` | sampling temperature |

**To go live:** set `base_url`/`model`/`api_key` and flip `use_stub=false`. No other code changes.

> **The one real dependency on the endpoint:** it must support **native tool-calling** (accept `tools`, emit
> `tool_calls`). vLLM/TGI do; some servers accept `tools` but don't emit `tool_calls`. If yours doesn't, the
> loop still runs but the model won't call tools — that's the thing to verify on first connection.

---

## 4. Why the seam matters (the payoff)

- **Confidentiality:** only this file touches a model. We deliberately **omit any third-party LLM** and keep to
  the self-hosted GPT-OSS, so fed data never leaves the bank (see [`AI_AGENT_DESIGN.md`](AI_AGENT_DESIGN.md) §8).
- **Swap-ability:** stub → GPT-OSS → a future model is a config flip, not a rewrite.
- **Cost/observability for free:** because every model call returns `usage`, the runner sums it and the turn is
  costed and logged with no extra work in the tools ([`AI_OBSERVABILITY.md`](AI_OBSERVABILITY.md)).
- **Safety before the model:** tool results are redacted *before* they're put in `messages`, so the model (a
  shared resource) never sees secrets/PII ([`AI_PII_REDACTION.md`](AI_PII_REDACTION.md)).

---

## Further reading (free)

- **OpenAI — Chat Completions & Function calling** (platform.openai.com/docs) — the request/response and
  `tool_calls` shape `_complete_real` speaks.
- ⭐ **Anthropic — "Building effective agents"** (anthropic.com/engineering) — why a thin, model-agnostic loop
  beats a heavyweight framework.
- **Ollama / vLLM / TGI docs** — how open models are *served* behind an OpenAI-compatible endpoint (what
  `base_url` points at); good for understanding self-hosting.
- See also [`AI_ROUTING.md`](AI_ROUTING.md) (the loop that calls this) and
  [`AI_TOOL_CALLING.md`](AI_TOOL_CALLING.md) (how the tool schemas are written).
