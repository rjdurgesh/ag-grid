# OSHIVA — PII & secret redaction (component notes)

**The problem.** OSHIVA runs on a **shared, self-hosted GPT-OSS** and writes an **append-only audit log**.
Once we wire real tools (config tables, DB info…), tool results can contain things that must **never** reach
a shared model or a log file: **DB passwords, connection strings, API tokens**, and **personal data**
(first/sur/last name, email, username, GUID, account number). Redaction makes sure they don't.

## Two layers of defence (use both)

1. **Minimize at the source (best).** A tool simply **doesn't fetch/return** a secret. For example
   `get_config` will drop secret columns (password / connection) so they never leave the DB layer. You can't
   leak what you never load.
2. **Redact as a safety net (this component).** A central scrubber cleans **every** tool result **before**
   the model sees it — and therefore before it can appear in the streamed answer or the audit log. It covers
   all tools, present and future, so nobody has to remember to redact.

Think of it as a seatbelt on top of careful driving: minimize first, redact always.

## What gets redacted

**By key / column name** — the field's value is replaced with a marker (default `[redacted]`):

| Category | Matched keys (normalised, case/spacing-insensitive) | Match style |
| --- | --- | --- |
| **Secrets** | `password`, `passwd`, `pwd`, `secret`, `token`, `api_key`, `credential`, `private_key`, `dsn`, `connection`/`connection_string`, `authorization`, `bearer` | **substring** (aggressive — a secret must never slip) |
| **PII** | `first_name`, `surname`, `last_name`, `full_name`, `email`, `username`, `guid`, `account_number` (+ `acct_no` / `acct_number` variants) | tighter (exact/contains) |

**By value pattern** — even when the key looks innocent (e.g. a free-text `comment` column):
- **emails** → `[redacted]:email`
- inline secrets like `...Password=hunter2;...` inside a connection string → `[redacted]`

**Deliberately NOT redacted** (so answers stay useful): operational fields like `HOST_NAME`, `APP_NAME`,
`ram`, `cpu`, Oracle schema/user names, etc. PII matching is kept tight on purpose to avoid wiping these.

## Where it runs

One line, one place — the central chokepoint in the agent loop:

```
tool runs → result → redaction.redact(result) → model sees it → (answer + audit both derive from this)
                         ▲ oshiva/agents/runner.py
```

Because it sits in `run_agent_loop` right after every tool call, it protects **all** tools automatically,
and the audit log only ever stores the already-redacted result.

## Configuration

Built-in lists always apply. `config/redaction.json` (copy from `.example.json`) can only **add** to them —
it can never shrink them, so a misconfiguration can't expose something:

```jsonc
{ "enabled": true, "placeholder": "[redacted]", "redact_values": true,
  "extra_secret_keys": [], "extra_pii_keys": [] }   // add your own column names here
```

## What it does *not* do (limits — be honest)

- **Minimize is still primary.** Redaction is a net; the real fix for secrets is not fetching them.
- **Value detection is heuristic.** Key-name matching is reliable (we control our schemas); free-text
  scanning catches emails and obvious inline secrets but can't catch every disguised value — so don't rely
  on it alone for unstructured blobs.
- **Scope today = tool results.** The user's own typed prompt and the final answer aren't scrubbed yet (the
  answer is built from already-redacted results, so tool secrets don't reach it). Prompt/answer redaction is
  an easy future extension if needed.
- **The audit's `caller` is kept on purpose** — that's *who asked*, the accountability record, not
  third-party personal data.
- **Fails closed.** Any error inside redaction returns the marker, never the raw value.

## Verified

- Unit: a payload with `DB_PASSWORD`, `connection_string`, `api_key`, `first/sur/last name`, `email`,
  `username`, `GUID`, `account_number`/`AcctNo`, a nested list, and an email + `password=` inside free text →
  all masked; `HOST_NAME`/`APP_NAME`/`ram` preserved.
- Live loop: with a tool returning a secret, the exact tool message the **model** receives contained
  `[redacted]:secret` / `[redacted]:pii` — never the raw `hunter2` / email / username. No regression on a
  normal "list all servers" query.

## Files

| File | Role |
| --- | --- |
| `backend/oshiva/security/redaction.py` | The scrubber: `redact(obj)` — deep-walks any JSON-like result, masks by key + value pattern |
| `backend/oshiva/agents/runner.py` | Calls `redaction.redact(...)` after every tool call (central chokepoint) |
| `backend/config_loader.py` | `redaction_config()` — enabled / placeholder / extra key lists |
| `backend/config/redaction.example.json` | Template for extending the key lists |

## Further reading (free & public)

- **OWASP — Top 10 for LLM Applications** (search "OWASP LLM Top 10") — "Sensitive Information Disclosure" is
  exactly this risk.
- **Simon Willison — prompt injection / data exfiltration** posts (simonwillison.net) — why data flowing to a
  model is a security boundary.
