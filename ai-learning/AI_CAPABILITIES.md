# OSHIVA — Capabilities, policies & coverage (the "do we handle every scenario?" answer)

This is the doc to read when you worry *"can we possibly cover every question a user might ask?"* The honest
enterprise answer: **you never enumerate scenarios — you enumerate capabilities and policies, and let the
model handle the infinite variety of language.**

## The one idea: three layers

| Layer | Examples | Who handles it | Is it finite? |
| --- | --- | --- | --- |
| **Language** | phrasings, synonyms, "23rd Sep" vs `23/09/2026`, asking a clarifying question, confirming before acting, mapping "lma code" → `LMA_CODE` | **the LLM, for free** | infinite — and that's fine |
| **Capability** | read a table, filter by column=value, count, describe columns, roll dates | **you** (a tool or parameter must exist) | **finite & knowable** |
| **Policy** | "ask before a write", "if a date is ambiguous, ask again", "cap at 50 rows then point to the screen" | **you** (written once in the agent's system prompt) | small |

You design **capabilities + policies**. The model adapts the language. You do **not** write code per phrasing.

> ⚠️ With today's **stub brain** none of the language magic works (it's keyword rules). Everything that feels
> "smart" — paraphrase, date formats, clarifying questions, fuzzy column names — arrives when we **wire the
> real GPT-OSS**. That's the biggest single unlock.

## The capability surface (this is what's finite)

For the Config Ops domain, the whole surface is ~8 capabilities — not infinite:

| # | Capability | Tool | Status |
| --- | --- | --- | --- |
| 1 | List the tables you may work with | `list_config_tables` | ✅ (best-effort: granted tables) |
| 2 | Describe a table's columns | `describe_config_table` | ✅ |
| 3 | Read a table (browse), optionally by COB date | `get_config` | ✅ (read-only, row-capped, secret cols dropped) |
| 4 | Look up rows by an exact column value | `query_table` | ✅ |
| 5 | Count matching rows (optionally for a date) | `query_table(count=true)` | ✅ |
| 6 | Say clearly when a table has **no date column** | `query_table` / `get_config` | ✅ |
| 7 | **Roll** dates (a WRITE, with confirmation) | `roll_config` | ✅ confirm-gated write |
| 8 | Find a table **by column** (no table name given) | `find_tables_with_column` | ✅ (cross-table text-to-SQL still later) |
| 9 | **Export** a table to CSV (any date, or no date) | `export_config` | ✅ data → file → download link (bypasses the model) |

> **Export note (an important pattern):** a full-table export must **not** stream through the model — the
> rows go to a server-side CSV and only a **download link + row count** reach the assistant. The file is
> served at `GET /api/assistant/export/<unguessable>.csv` (a capability URL). This keeps large/sensitive data
> off the model and out of the logs, while still "doing" the export. Same rule applies to Infra: `list_shares`
> (NAS/share utilization) was a **separate resource type** (SHARE_DRIVE) from `list_servers`, so it needed its
> own capability — a good example that a new *dimension* = a new tool, not a bigger prompt.

Every new user question resolves to one of two things: **(a)** it maps to a capability above → the model
just does it, or **(b)** it needs a capability you don't have → you add **one** tool/param. After the first
dozen real questions, (b) becomes rare — the surface **converges**.

## Coverage philosophy — you will never hit 100%, and that's correct

Mature agent programmes don't aim to pre-imagine everything. They:
- **Fail gracefully** (a policy): outside the tools, the agent says *"I can't do that yet — here's what I
  can help with,"* and never guesses or fabricates.
- **Observe** (audit log): record what users *actually* ask, so you fix **real** gaps, not imagined ones.
- **Evaluate** (eval set — roadmap): a growing list of "question → expected behaviour" so you *measure*
  coverage and prove it before widening access.

That loop — ship a finite surface, watch real usage, add the next capability — is how you get high coverage
without an impossible up-front scenario hunt.

## Your example scenarios, mapped

| You asked | Kind | How it's handled |
| --- | --- | --- |
| "content too big → show a few + download" | Policy | `get_config`/`query_table` cap at 50 and flag `truncated`; the model says "showing 50 of N — use the Config Ops screen (it has export)". A download button in the chat is possible later. |
| "total rows for EMP for a date" | Capability | `query_table(count=true, business_date=…)` |
| "which 2022 dates have no data" | Capability (analytical) | gap-detection — text-to-SQL phase (later) |
| "count for CONFIG (no date) → tell me it has no date filter" | Policy + capability | tool resolves the date column and, if the table lacks it, returns *"'CONFIG' has no date column, so it can't be filtered by date."* |
| "roll from 1 Sep to 5 Sep — range or 2 dates? confirm first" | Capability (write) + Policy | ✅ `roll_config` — a **confirm-gated** write (confirm=false previews, confirm=true executes) + a system-prompt policy: parse any date format → if ambiguous ask → ask *range vs those days* → restate & confirm → then roll. WRITE-level authz. |
| "lma_label where lma_code = IXLQA90" (table named) | Capability | ✅ `query_table(match_column='LMA_CODE', match_value='IXLQA90', columns=['LMA_LABEL'])` |
| "…without naming the table" | Capability (schema) | ✅ `find_tables_with_column('LMA_CODE')` finds the table, then `query_table` on it (cross-table/analytical text-to-SQL still later) |
| "I said 'lma code', not `LMA_CODE`" | Language | the model calls `describe_config_table` to see real columns, then maps — **free with the real model** |

## New this round: `query_table` (capability 4–6)

`query_table(scope, table, match_column?, match_value?, columns?, count?, business_date?)` — a **safe,
parameterized** lookup/count:
- The table and **every** column name are validated against the data dictionary (`config_table_columns`);
  an unknown identifier is rejected, never interpolated. The filter **value is always a bind** → no SQL
  injection.
- Returns a **count** (`count=true`) or **rows** (capped at 50, `truncated` flagged).
- `business_date` adds a COB day filter, and reports clearly when the table has no date column.
- Secret columns are dropped; every result still passes central **redaction** (`AI_PII_REDACTION.md`).
- Read-only. Runs against the live config DB in prod; returns a dummy note on the laptop.

## What's next (in order)

1. **Wire the real GPT-OSS** — the client is **built** (`llm/client._complete_real`); just set
   `ASSISTANT_BASE_URL`/`_MODEL`/`_API_KEY` in `.env` + `ASSISTANT_USE_STUB=false`. Unlocks all the *language*
   behaviour above (the multi-turn confirm dialogue, fuzzy columns, any phrasing).
2. **Write tools + confirmation** — ✅ done for Config Ops: `roll_config` is a **confirm-gated** write
   (preview → yes → execute) with WRITE-level authz + audit. Same pattern for future writes.
3. **Schema knowledge** — ✅ `find_tables_with_column` (find a table by a column). Still ahead: **cross-table
   / analytical text-to-SQL** ("which 2022 dates are missing", joins across tables).

## Further reading (free & public)

- **Anthropic — "Building effective agents"** (anthropic.com/engineering) — capabilities & when to add complexity.
- **Hugging Face — Agents Course** (huggingface.co/learn/agents-course) — tools & the tool-use loop.
- **OpenAI — Function calling docs** — the tool-schema format we use for capabilities.
