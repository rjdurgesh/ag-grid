# Log Housekeeping — Technical Documentation

Automatic clean-up of the batch-log directories. A background task deletes files older than a configured
age, **but always keeps at least the newest N files in each folder**, so a quiet period (no new logs
written for a long time) can **never empty a folder**.

---

## 1. Behaviour (the rules)

For **each** configured directory, on every run:

1. List the **regular files directly inside** the folder (sub-folders are *not* descended into; dotfiles
   like `.gitkeep` are ignored).
2. Sort them **newest-first** by last-modified time.
3. **Protect** the newest `keep_min` files — these are **never** deleted, *regardless of age*. This is the
   safety floor.
4. Of the remaining (older) files, delete those older than `max_age_days`; keep the rest.

**Per-folder floor.** Each folder is processed independently, so `keep_min` applies **per folder**. A busy
folder and a quiet folder next to each other don't affect one another.

### Worked examples (defaults: `max_age_days=30`, `keep_min=2`)

| Folder state | Result |
| --- | --- |
| 5 files: ages 90, 45, 31, 3, 1 days | Delete `90, 45, 31`. Keep `3, 1` (within 30 days). |
| **Quiet** — 4 files, ages 40, 50, 60, 70 days (nothing new for 30+ days) | Keep the newest **2** (`40, 50`). Delete `60, 70`. **Folder never emptied.** |
| 2 files, both 99 days old | Keep **both** (count ≤ `keep_min`). Nothing deleted. |
| 1 file, 99 days old | Keep it. Nothing deleted. |
| Folder does not exist | Skipped, logged, no error. |

---

## 2. Configuration

Configured in **`backend/config/housekeeping.json`** (copy from the committed
`backend/config/housekeeping.example.json`; the real file is git-ignored, per-server). Each key is
resolved as:

```
config/housekeeping.json  →  LOG_HOUSEKEEP_* env var (optional override)  →  built-in default
```

Every key is **optional** — omit one and its built-in default applies. Nothing needs to be set for the
feature to run.

| JSON key | Env override | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | `LOG_HOUSEKEEP_ENABLED` | `true` | Turn the scheduled purge on/off. |
| `log_dirs` | `LOG_HOUSEKEEP_DIRS` (comma-separated) | `["Logs/BatchLogs"]` | **List** of folders to clean, each independently. A single `log_dir` / `LOG_HOUSEKEEP_DIR` string is also accepted. Relative → resolved against the backend dir; absolute → used as-is. |
| `max_age_days` | `LOG_HOUSEKEEP_MAX_DAYS` | `30` | Delete files older than this many days. |
| `keep_min` | `LOG_HOUSEKEEP_KEEP_MIN` | `2` | Always keep at least this many newest files **per folder**, regardless of age. |
| `interval_hours` | `LOG_HOUSEKEEP_INTERVAL_HOURS` | `24` | How often the background task runs. |

### Example — clean several folders

```jsonc
// backend/config/housekeeping.json
{
  "enabled": true,
  "log_dirs": ["Logs/BatchLogs", "Logs/AppLogs", "Logs/ErrorLogs"],
  "max_age_days": 30,
  "keep_min": 2,
  "interval_hours": 24
}
```

> **Only the top level of each folder is cleaned.** List each sub-folder you want purged (e.g.
> `Logs/BatchLogs`, `Logs/AppLogs`) rather than the `Logs` parent — pointing at `Logs` would only touch
> loose files sitting directly in `Logs\`, not the files inside its sub-folders.

---

## 3. Scheduling & lifecycle

- The task is started from the FastAPI **lifespan** in `app.py`: it runs **once at startup**, then every
  `interval_hours`, and is cancelled cleanly on shutdown.
- The blocking file work runs in a worker thread (`asyncio.to_thread`), so it never blocks the API.
- **Config is read once at startup.** Changing a value in `housekeeping.json` (or adding a new folder to
  `log_dirs`) takes effect **after a backend restart**.
- A folder that is **already listed** in `log_dirs` but doesn't physically exist yet is simply skipped
  each run; once it appears, the **next run cleans it automatically** — no restart needed.

---

## 4. Safety properties

- **A folder is never emptied** while `keep_min ≥ 1` — the newest `keep_min` files always survive, even if
  all are older than `max_age_days`.
- **Non-recursive** — sub-folders are never descended into, so nothing outside the listed folders is ever
  touched.
- **Dotfiles ignored** — files beginning with `.` (e.g. a `.gitkeep` placeholder) are neither deleted nor
  counted toward `keep_min`, so the floor always protects *real* log files.
- **Missing folder** → skipped and logged, never an error.
- **Idempotent deletes** — a file already gone is ignored; a permission error on one file is logged and
  the run continues. Safe even if the task happens to run in more than one worker process.
- **Disable anytime** — set `enabled: false` (or `LOG_HOUSEKEEP_ENABLED=0`) and restart.

---

## 5. Logs (what you'll see)

On startup:

```
housekeeping: scheduler started (dirs=…/Logs/BatchLogs, …/Logs/AppLogs, max_age_days=30, keep_min=2, every 24h)
```

Per run, per folder:

```
housekeeping: …/Logs/BatchLogs — scanned 12, deleted 7, kept 2 newest + 3 within age; 0 error(s)
housekeeping: deleted app-2026-07-01.log, app-2026-07-02.log, …
housekeeping: skipped — directory does not exist (…/Logs/AppLogs)     # until the folder appears
```

---

## 6. Code map

| File | Role |
| --- | --- |
| `backend/housekeeping.py` | `purge_old_logs()` (the per-folder rule), `run_housekeeping()` (loops all folders), `housekeeping_loop()` (the startup + interval scheduler). |
| `backend/config_loader.py` → `housekeeping_config()` | Resolves the settings dict (`config/housekeeping.json` → env → default) and normalises `log_dirs`. |
| `backend/app.py` (lifespan) | Starts/stops the background task. |
| `backend/config/housekeeping.json` | Per-server config (git-ignored). |
| `backend/config/housekeeping.example.json` | Committed template — copy to `housekeeping.json`. |

---

## 7. FAQ

**Q. If a folder in `log_dirs` doesn't exist yet, will it error?**
No — it's skipped and logged. When the folder appears later, it's cleaned on the next run (no restart, as
long as the path is already in `log_dirs`).

**Q. If nothing is written to a folder for 30+ days, are all files deleted?**
No. The newest `keep_min` (default 2) files are always kept, per folder — so at least 2 remain.

**Q. Does it clean sub-folders automatically?**
No. It cleans the **top level** of each listed folder. List each sub-folder explicitly.

**Q. Do I need to configure anything for it to work?**
No. With no `housekeeping.json` at all it runs on the built-in defaults (enabled, `Logs/BatchLogs`,
30 days, keep 2, every 24h). Add/edit the JSON only to change those.

**Q. How do I turn it off?**
`"enabled": false` in `housekeeping.json` (or `LOG_HOUSEKEEP_ENABLED=0`), then restart the backend.
