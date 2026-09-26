# AI_OBSERVABILITY — seeing (and costing) every turn

**In one line:** *observability* means you can look at what OSHIVA actually did — every turn's route, tools,
tokens, latency and cost — after the fact. If you can't see it, you can't operate it, debug it, or bill it.

This covers two adjacent architecture boxes: **Observability** (the record) and **Cost Tracker** (money/tokens
derived from that record). They're built together because cost is just one more number on each logged turn.

> **Where it lives:** `backend/oshiva/observability/` — `audit.py` (writes one JSON line per turn),
> `metrics.py` (token maths, cost, day roll-up), `__main__.py` (a report). Tokens are captured in
> `llm/client.py` and summed in `agents/runner.py`. View it with `python -m oshiva.observability`.

---

## 1. What gets recorded, and when

Every chat turn already flows through one place — the `/api/assistant/chat` endpoint — so that's where the
record is written, in the `finally` of the stream (so it's written even if the turn errors). One turn = **one
JSON line** appended to `backend/Logs/assistant/audit-YYYYMMDD.jsonl`:

```json
{
  "kind": "turn", "ts": "2026-09-25T08:53:21Z",
  "conversation_id": "c_ab12…", "caller": "B27886", "agent": "infra",
  "prompt": "list the group servers",
  "tool_calls": [ {"name": "list_servers", "args": {"scope": "group"}, "ms": 12} ],
  "answer": "Here are the group servers …",
  "brain": "stub", "steps": 2,
  "tokens": {"prompt_tokens": 487, "completion_tokens": 49, "total_tokens": 536, "estimated": true},
  "cost": 0.0, "elapsed_ms": 42, "error": null
}
```

Key fields added in this phase: **`tokens`**, **`cost`**, **`steps`**, and a per-tool **`ms`**. Note the
record is written **after** redaction (see [`AI_PII_REDACTION.md`](AI_PII_REDACTION.md)), so secrets/PII never
land in the log — an audit log is only safe if it's clean.

---

## 2. Where the numbers come from

**Tokens.** The model tells us. `LlmResponse` now carries a `usage` dict:

- **Real GPT-OSS** returns an exact `usage` block (`prompt_tokens` / `completion_tokens` / `total_tokens`) on
  every `/v1/chat/completions` call — `llm/client._complete_real` reads it straight through.
- **Stub** has no real count, so `llm/client._estimate_usage` approximates (~4 chars/token) and flags the
  result `"estimated": true`, so a report never pretends an estimate is exact.

**Summing across a turn.** One question can take several model calls (plan → tool → plan again → answer). The
agent loop (`agents/runner.py`) sums each call's usage with `metrics.add_usage(...)` and emits a single
`usage` event at the end, plus a `steps` count. It also times each tool with `perf_counter` and attaches `ms`.

**Latency.** The endpoint wraps the whole turn in `perf_counter` → `elapsed_ms`.

**Cost.** `metrics.cost_of(usage, cfg)` turns tokens into money using two config prices:

```
cost = prompt_tokens/1000 * cost_per_1k_input  +  completion_tokens/1000 * cost_per_1k_output
```

Self-hosted GPT-OSS has **no per-token bill**, so both prices default to **0** — you still get token counts and
latency (the numbers that actually tell you a prompt is too big or a turn too slow). Set real prices in
`oshiva/assistant.json` only if you want to model a chargeback or compare against a hosted API.

---

## 3. Looking at it

```bash
python -m oshiva.observability            # today (UTC)
python -m oshiva.observability 20260925   # a specific day (YYYYMMDD)
```

It rolls up the day's audit file into: turns, errors, feedback votes, total tokens (flagged if estimated),
cost, average latency, and per-agent / top-caller counts:

```
=== OSHIVA usage - 20260925 ===
turns:     1   (errors: 0, feedback votes: 0)
tokens:    prompt 487 + completion 49 = 536 (estimated - stub)
cost:      0.0
latency:   avg 42.0 ms/turn   (total 42 ms)
by agent:  infra=1
top callers: B27886=1
```

`metrics.summarise_day()` is the function behind it, if you want the numbers in code (e.g. a future admin
endpoint or dashboard). Output is ASCII-only so it's safe to redirect/pipe on any console.

---

## 4. Why this matters (the operator's view)

- **Debugging:** "why was that answer wrong?" → the line shows the route, the exact tool args, and the tool's
  own timing. You can replay the decision.
- **Cost/capacity:** token totals per day/caller tell you if prompts are bloating or one user is hammering the
  bot (which the rate-limiter then caps — see [`AI_RATE_LIMIT.md`](AI_RATE_LIMIT.md)).
- **Safety/audit:** for a confidential system you must be able to show *who asked what and what the bot did*.
  This is that record — and the eval suite ([`AI_EVALS.md`](AI_EVALS.md)) proves the guardrails hold; together
  they're "prove it's safe" + "show what happened."

**Limits / next:** the store is a per-day JSONL file on the API server (Phase 2.1 moves it to `ols_ai_*` DB
tables; the housekeeping job can already purge the folder). It's per-process, so a multi-worker deployment
aggregates per file/host. A live dashboard endpoint is a small future add on top of `summarise_day()`.

---

## Further reading (free)

- **OpenAI — the `usage` object** (platform.openai.com/docs) — the exact token block our real client reads.
- **Google SRE Book — "Monitoring Distributed Systems"** (sre.google/books) — the classic on the four signals
  (latency, traffic, errors, saturation); our per-turn record captures the first three.
- **OpenTelemetry — "Observability primer"** (opentelemetry.io/docs/concepts/observability-primer) — logs vs
  metrics vs traces, when you outgrow a JSONL file.
- See also [`AI_PII_REDACTION.md`](AI_PII_REDACTION.md) (why the log is safe) and
  [`AI_RATE_LIMIT.md`](AI_RATE_LIMIT.md) (acting on what the usage numbers reveal).
