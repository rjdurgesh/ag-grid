# `backend/config/` — per-feature config files

Screen-specific, **non-secret** settings live in one JSON file per feature, in that feature's **own
folder** next to its code — `oraclecc/occ.json`, `regression/regression.json`,
`config_ops/config_ops.json`, `docs/docs.json`. (This central `config/` dir stays as a fallback the
loader checks second, if you'd rather keep a file here.) This keeps the shared `backend/.env` lean
(globals + secrets only) and lets each screen — and each scope — carry its own settings.

## Setup (per server)

Each server (DEV / STG / PROD) gets its own copy of these files with that environment's values:

```bash
cd backend
cp regression/regression.example.json  regression/regression.json
cp oraclecc/occ.example.json           oraclecc/occ.json
cp config_ops/config_ops.example.json  config_ops/config_ops.json
cp docs/docs.example.json              docs/docs.json
# then edit the .json files for this environment
```

Only the `*.example.json` templates are committed; the real `*.json` are **gitignored** (they hold
per-environment paths/URLs). After editing a `.json`, **restart the backend** — files are read at
import time (same as `.env`; uvicorn `--reload` is unreliable here, hard-restart).

## What lives where

| Where | Holds | Examples |
|-------|-------|----------|
| `.env` | GLOBAL + SECRETS + deploy flags | `APP_ENV`, `CYBERARK_*`, `REGRESSION_GIT_TOKEN[_<SCOPE>]`, DB creds, `*_USE_DUMMY` |
| `<feature>/<feature>.json` (or `config/…`) | that screen's non-secret settings | paths, URLs, thresholds, per-scope git repos |

**File lookup:** the loader checks the **feature folder** (`backend/<feature>/<name>.json` — `oraclecc/`,
`regression/`, …) first, then this central `config/` dir. Override the whole location with the
`OLS_CONFIG_DIR` env var. **Resolution per key (non-breaking):** the JSON value wins → else the legacy
`.env` var → else a built-in default. So a deployment that still only has `.env` keeps working until it
adopts the files. Secrets are always read from `.env`, never from these JSON files.

Loaded by [`config_loader.py`](../config_loader.py): `occ_config()`, `config_ops_config()`,
`regression_defaults()`, `regression_scope_config(scope)`.

---

## `regression.json` — Regression screen (PER SCOPE)

Each config scope (`cib` / `retail` / `group`) is a separate application with its own git release repo,
work/log dirs and NAS feed manifest. `defaults` applies to every scope unless a scope overrides it.

| Key (per scope) | Meaning |
|-----------------|---------|
| `git_url` | release repo. **HTTPS** (`https://…`) → token auth (`REGRESSION_GIT_TOKEN[_<SCOPE>]` in `.env`, injected at runtime; **never here**). **SSH** (`ssh://git@host:<port>/…`) → no token; use `git_ssh_key` below. |
| `git_ssh_key` / `git_known_hosts` | SSH auth for an `ssh://` `git_url`: private-key path (+ optional known_hosts path). The engine builds `GIT_SSH_COMMAND` from them and sets it on the git subprocess (so it works even if `.env` isn't in `os.environ`). **Use forward slashes** (`C:/Users/keys/id_ed25519`). Usually set once in `defaults`. Full override: `git_ssh_command`. |
| `git_workdir` | local checkout dir for that scope |
| `refresh_databases` | this scope's **refreshable DBs for THIS server's env**, **grouped by category** (DEV/STG can have several per group; per-server file → DEV lists DEV DBs, STG lists STG DBs). Drives the Refresh-DB grouped multi-select dropdown. Grouped object `{ "BATCH": ["OLS_CIB_BATCH_DEV","OLS_CIB_BATCH_DEV_02"], "REPORTING": ["OLS_CIB_REPORTING_DEV"] }` (or a flat array of names / `{key,label,category}`). |
| `batch_db_script_roots` | map of **DB key → repo-relative RegressionTesting folder** (parallel to Scripts); the **Reset / Trigger batches** steps list `.sql` from here. Same shape as `script_roots` (`"*"` catch-all). e.g. cib `{ "cib_batch": "CIB/Batch/RegressionTesting", "cib_reporting": "CIB/Reporting/RegressionTesting" }`. |
| `script_roots` | map of **DB key → repo-relative Scripts folder**; the tool appends the run's `<release_date>` (YYYYMMDD) folder and runs `chg*.sql` from it. Use `"*"` as the key when one root serves every DB. e.g. cib `{ "cib_batch": "CIB/Batch/Scripts", "cib_reporting": "CIB/Reporting/Scripts" }`, retail `{ "*": "RET/Scripts" }`, group `{ "*": "Scripts" }`. Falls back to `sql_subdir` if unset. |
| `log_dir` | base dir for sqlplus run logs (`<dir>\<YYYYMMDD>\<script>__<db>.log`) |
| `refresh_url` | step-1 DB-refresh API (dummy for now) |

> **File-copy manifest is NOT config** — it lives in the release repo at
> `<Scripts-root>/<release_date>/filecopy_manifest_<release_date>.json`. The tool discovers it under each
> `script_roots` folder for the run's release date; File Copy shows a labelled dropdown per folder that has one.

| Key (`defaults`) | Meaning | Default |
|------------------|---------|---------|
| `branch_prefix` | only these branches are listed/pullable | `release/` |
| `branch_limit` | newest-N release branches returned (newest first) | `10` |
| `sql_subdir` | sub-path of the repo holding `.sql` (`""` = root) | `""` |
| `sqlplus_timeout` / `git_timeout` | seconds | `3600` / `120` |
| `step_stale_minutes` | in-progress step older than this → stale/unlockable | `30` |
| `batch_max_rows` | Monitoring-Batches safety cap | `100000` |
| `filecopy_verify` | File-copy post-copy integrity check: `off` / `size` / `hash` (size+SHA-256) | `size` |

## `occ.json` — Oracle Command Center

| Key | Meaning | Default |
|-----|---------|---------|
| `use_dummy` | `true` = canned data; `false` = real `*_real` SQL | `true` |
| `schema` | app schema the storage sections report on | `OLS` |
| `warn_pct` / `crit_pct` | tablespace gauge colour thresholds (% used) | `85` / `90` |
| `top_child_limit` | biggest children shown per drill-down level | `10` |
| `temp_warn_mb` / `temp_crit_mb` | Temp-tablespace row-tint thresholds (MB) | `1024` / `5120` |
| `force_down` | dev/demo: scopes forced "unreachable" (leave `[]` in real deployments) | `[]` |
| `sqli.use_dummy` | SQL-Intelligence canned data (defaults to `use_dummy`) | inherits |
| `sqli.history_days` | AWR window for every historical query | `5` |
| `sqli.allow_apply` | show the ADMIN "Apply fix" button (`false` = recommend-only) | `true` |
| `sqli.misestimate_min_rows` / `_warn` / `_crit` | plan-analysis A-Rows vs E-Rows flags | `1000` / `10` / `100` |
| `sqli.stats_stale_days` | flag table stats older than this | `7` |

## `config_ops.json` — Config Ops · CSV Upload & Load

| Key | Meaning | Default |
|-----|---------|---------|
| `archive_dir` | NAS dir where each loaded CSV is archived (`<stem>_<user>_<token>.csv` + SHA-256) | `""` |
| `max_rows` / `max_mb` | per-upload ceilings | `200000` / `50` |
| `batch_size` | rows per `executemany` INSERT batch | `5000` |
| `audit_columns` | system/audit columns the load sets itself (never in the file) | `INSERTED_*` / `UPDATED_*` |

> The date column per table is resolved by the DB function `ols_util.get_date_column(<table>)` — no
> config key needed. The upload/roll DB connection is the privileged `app.state.sql_db_configs`, chosen by
> the request's **`db_source`** (the catalogue row's physical DB, e.g. `ols_cib_reporting`) — see
> `config_api._source_db`. So a config table in a scope's *reporting* DB loads there, not the batch DB.
