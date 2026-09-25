# AI_RATE_LIMIT — capping how often the bot can be called

**In one line:** *rate limiting* caps how many chat turns one caller can make per minute, so a bug, a script,
or an abusive user can't run up cost or overload the model. It's the **Edge** box in the architecture — the
cheap guard that runs *before* any expensive agent/tool/model work.

> **Where it lives:** `backend/oshiva/auth/rate_limit.py`; enforced in `oshiva/api.py` at the top of `/chat`,
> right after the access gate. Configured by `rate_limit_per_min` in `config/assistant.json` (or
> `ASSISTANT_RATE_LIMIT_PER_MIN`).

---

## 1. Why an assistant needs it especially

One chat turn is **not** one cheap request. It can fan out to several tool calls (each hitting a real backend)
**and** one or more model calls. So an unbounded caller — a runaway retry loop, a load test, someone pasting a
script — is far more expensive here than on a normal endpoint. Rate limiting is the first, cheapest line of
defence: reject early, before any of that work starts.

It sits at the **edge** on purpose: the check is a few microseconds and needs nothing but the caller's id, so
it runs before authorization data is loaded, before the coordinator, before the model.

---

## 2. How ours works (fixed window, per caller)

`rate_limit.check(caller, cfg)` keeps, per caller, the timestamps of recent turns and allows at most
`rate_limit_per_min` within a rolling 60-second window:

```python
def check(caller, cfg) -> tuple[bool, int]:
    limit = int(cfg.get("rate_limit_per_min", 20))
    if limit <= 0:                      # 0 disables limiting entirely
        return True, 0
    now = time.time()
    q = _hits.setdefault(caller, [])
    q[:] = [t for t in q if t >= now - 60]     # forget hits older than the window
    if len(q) >= limit:
        return False, retry_after_seconds      # over the limit → deny + when to retry
    q.append(now)
    return True, 0
```

It returns `(allowed, retry_after_seconds)`. The endpoint turns a denial into a proper HTTP **429** with a
`Retry-After` header:

```python
allowed, retry_after = rate_limit.check(caller, _CFG)
if not allowed:
    raise HTTPException(status_code=429, detail="Too many requests — please slow down.",
                        headers={"Retry-After": str(retry_after)})
```

Properties worth knowing:

- **Per caller** — one noisy user can't starve everyone else; each id has its own window.
- **Fail-open on config** — `rate_limit_per_min: 0` disables it (handy in tests/dev).
- **In-memory, per-process** — perfect for a single uvicorn worker or a dev box. A multi-worker/multi-host
  deployment would back the same `check()` interface with Redis so the window is shared; the call site in
  `api.py` wouldn't change (same seam idea as everywhere else in OSHIVA).
- **`reset(caller=None)`** clears counters — used by the eval/tests, or to lift a limit for one caller.

---

## 3. Choosing the number

`rate_limit_per_min` is turns-per-minute per person. 20 (the default) is generous for a human typing questions
but stops a loop dead. Lower it if the real model is slow/expensive; raise it for power users. Because it's
per-minute it also smooths bursts without blocking normal back-and-forth.

> This is a **coarse** guard (turns, not tokens). The token/cost numbers that tell you *whether* a limit is
> right come from [`AI_OBSERVABILITY.md`](AI_OBSERVABILITY.md) — watch usage, then tune the limit. A future
> refinement could cap tokens/day per caller on top of turns/minute.

---

## Further reading (free)

- **Cloudflare — "What is rate limiting?"** (cloudflare.com/learning) — the concept and where it belongs (edge).
- **MDN — HTTP 429 Too Many Requests / Retry-After** (developer.mozilla.org) — the exact response we return.
- **"Token bucket vs fixed/sliding window"** (search — many good write-ups) — the trade-offs if you later swap
  our fixed window for a burst-friendly token bucket.
- See also [`AI_OBSERVABILITY.md`](AI_OBSERVABILITY.md) (the numbers that justify the limit) and
  [`AI_TOOL_AUTHZ.md`](AI_TOOL_AUTHZ.md) (the *other* gate — what you may see, vs. how often you may ask).
