# Config Ops — CSV Upload & Load (Design)

Design for the **Upload Data** feature in the Config Ops Console grid modal (the 3-dot → *Upload Data*
item, currently a placeholder). Lets an authorized user upload a CSV into the currently-open table,
review/edit/validate it on screen, then load it into the database — safely, generically, and fully
audited. Companion to [GUIDE.md](GUIDE.md), [RBAC_DESIGN.md](RBAC_DESIGN.md).

## 1. Goals & principles
- **Generic** across any config table (columns/types come from the catalogue, not hard-coded).
- **Safe**: every load is one **atomic transaction** — it fully succeeds or fully rolls back. No partial state.
- **Reviewable**: the user sees + edits the data on screen and fixes rejects **before** anything is written.
- **Authoritative server**: the client is UX; the server re-validates header, types, RBAC, and identifiers.
- **Traceable**: every successful load archives the file to NAS + writes a maximal audit row.

## 2. Where it hooks in
- **Frontend**: replace `GridDataComponent.uploadData()`'s placeholder with an upload dialog. The modal
  already holds the table's `cols`, `cols_data_types`, and the row's date flag — so header + type + COB
  decisions are available client-side. Reuse the existing `toCsv` export.
- **Gate**: same RBAC as editing — only users who can **write** that table (`canWriteTable`) see/use Upload.
  The server re-checks write permission.
- **Backend**: the Config Ops backend is **mock-only today** (no `config_api.py`). This feature ships the
  **first real Config write path** (new `config_api.py` + `database.py` functions), plus a mock for dev.

## 3. Table / date metadata (the mapping table)
A **1-to-1 mapping table** defines, per config table, its **date column name** — currently `COB_DT` or
`REPORTING_DT` (extensible: add a row if a new name appears). This is the authority for:
- whether a table is **date-partitioned** (has a date column) vs not, and
- the **exact date column name** to use in `DELETE WHERE <date_col> = :d`.

The server reads this mapping (never trusts the client). The catalogue's existing `is_cobdt`-style flag /
start-end date UI is derived from the same source.

## 4. Load modes
Both modes apply to **every** table type; only the DELETE scope differs.

| Mode | Non-date table | Date table (COB/reporting) |
|------|----------------|-----------------------------|
| **Append**  | `INSERT` only (no delete) | `INSERT` only for that date (no delete) |
| **Replace** | `DELETE FROM tgt;` then `INSERT` (full replace) | `DELETE FROM tgt WHERE <date_col> = :d;` then `INSERT` |

- **Date tables: exactly ONE distinct date per file, enforced** (client + server). If a file has >1 distinct
  date → block: *"This file has N dates (…). Upload one date per file."*
- **`DELETE`, never `TRUNCATE`** — TRUNCATE is DDL, auto-commits, and can't roll back; a failed insert
  after TRUNCATE would leave the table empty with no undo. DELETE keeps the whole load atomic.

## 5. Date & type handling
The #1 Oracle-load bug is relying on implicit `NLS_DATE_FORMAT` conversion (ambiguous, env-dependent).
We avoid it entirely:
- **Canonical input formats, enforced + shown in the dialog** (ISO 8601, **24-hour, no AM/PM, no tz**):
  - `DATE` → `YYYY-MM-DD` (time defaults to `00:00:00`); also accepts `YYYY-MM-DD HH24:MI:SS` when the DATE carries a time.
  - `TIMESTAMP` → `YYYY-MM-DD HH24:MI:SS`, optional fractional seconds `.ffffff` (≤6).
  - Unambiguous, sorts, locale-proof.
- **Date columns are known** from `cols_data_types` (the catalogue already returns Oracle types).
- **Client** validates each date cell (format + real-calendar check → `2026-02-30` rejected); 2-digit years
  rejected; users warned that Excel reformats dates (save ISO / as text).
- **Server converts explicitly** — parse each date string with the canonical format into a native
  `datetime` and **bind the datetime object** (python-oracledb → `DATE`/`TIMESTAMP`, no NLS, no ambiguity).
  The `date_col = :d` value in the DELETE is likewise a bound date.
- **Numbers**: validate numeric (reject thousands separators / stray chars), bind native; **NULLs**: empty
  cell → `NULL` for nullable columns, **reject** for `NOT NULL`; strings trimmed; length checked.
- Future option: a **date-format dropdown** (like the delimiter) if a second format is ever needed.

## 6. Header validation (strict, with trailing-column omission)
Expected header = the table's business columns from `retrieve` (audit columns like `inserted_by` are
system-set, **not** in the file). Validate **name + position** from the left — case-insensitive, trimmed.

**Trailing columns may be omitted** (SQL*Loader `TRAILING NULLCOLS` behaviour): the file's columns must be a
valid **left-prefix** of the table's columns (names match in order from column 1 — **no middle gaps, no
reordering**). Omitted **trailing** columns are auto-filled `NULL`, provided:
- each omitted column is **nullable or has a DB default** — an omitted `NOT NULL` (no default) column is a
  hard error: *"Your file omits required column(s): X, Y."*;
- for a **date table**, the **date column is never omittable** (needed for the single-date rule + Replace).

**Never silent**: the preview shows the full table columns with omitted ones rendered as
`(NULL — not in file)`, and the confirm dialog states *"columns X, Y, Z will be set to NULL."*
Middle gaps / extra / reordered columns → Load stays disabled with a precise diff.

## 7. Preview, validation & the reject flow
- **Editable, virtualized grid** (AG-Grid, which we already use — virtualization handles 80–90k rows; only
  visible cells render). Header banner shows ✓/✗ + delimiter + row count.
- **Two-layer validation** (validation itself is cheap — ~1.8M cell checks at 90k×20 is sub-second in a
  loop; the costs are *rendering* (virtualized) and *insert* (batched), both solved):
  - **Client, primary**: per-cell type/format/NOT-NULL checks; bad cells **highlighted**; validated on
    edit (incremental, not the whole file per keystroke) and fully on Load.
  - **Server, authority**: re-validate header + type-cast + DB constraints; rejects are rare by then.
- **Reject flow**: preview shows a **Valid rows** grid and a **Rejected rows** section (bad cell highlighted
  + reason). The user **fixes a rejected row → re-validate → it promotes into the valid set**; may
  **proceed with valid rows only**; may **export rejected rows** to CSV to fix later.
- **Atomic load**: only the valid set is inserted, all-or-nothing. `rows_rejected` is recorded; a
  reject-CSV can be archived alongside.

## 8. Delimiter & parsing
- **Delimiter**: **Auto-detect** (sniff the header for the most consistent delimiter across the first N
  lines) with a manual **override** (`, ; | : tab`).
- **RFC-4180 parser** (quoted fields, embedded delimiters/newlines, `""` escaping, BOM strip) —
  `papaparse` (tiny, battle-tested), not `split(',')`.

## 9. Transfer & the load engine
- Because the grid is **editable**, what loads is the **edited** data — so on Load the client **regenerates
  a CSV from the (edited) valid rows** and sends *that*. The server re-parses it (authority) and inserts.
  That same CSV is what we archive — a faithful record of exactly what entered the table.
- **No per-user temp tables** (dynamic `CREATE TABLE tmp_<t>_<user>` is an anti-pattern: DDL per upload,
  library-cache churn, orphan-cleanup burden; and it doesn't prevent the real conflict on the shared
  target). Oracle already isolates per session (GTT/PTT) *if* staging were needed — but a **single-request
  atomic load needs no staging**: the user already reviewed client-side.
- **Engine (one request, one session, one transaction)**:
  1. RBAC write re-check + **identifier whitelist** (table + columns must exist in the catalogue — never
     interpolate client identifiers).
  2. Read mapping table → date column / mode scope.
  3. Take a **per-target-table application lock** (reuse the regression step-lock pattern) → reject a
     concurrent load with *"A load into TBL is in progress by X"*. (COB tables can lock at `(table, date)`.)
  4. Re-parse CSV → re-validate header → type-cast/convert every cell (collect rejects).
  5. `DELETE` per mode (none for Append) → **batched `executemany` INSERT** (5–10k rows/batch).
  6. **COMMIT** (or ROLLBACK on any error).
  7. On success: **archive to NAS** + **write audit** + return counts. UI refreshes the modal grid.
- **Scale**: batched insert (the "streamed/batched" path). Define ceilings (e.g., ~100k rows / configurable
  max MB); beyond that, direct users to SQL*Loader/external tables.

## 10. NAS archive
- On success, copy the loaded CSV to a configurable base dir (`CONFIG_UPLOAD_ARCHIVE_DIR`), renamed
  **`<original_stem>_<username>_<loadid>.csv`** (username for at-a-glance, `loadid` for uniqueness even if
  the same user re-uploads the same filename). Store its SHA-256 in the audit row.

## 11. Audit — `ols_upload_audit` (maximal)
`load_id (PK, identity)`, `app_env`, `scope`, `table_name`, `mode` (append/replace), `date_column`,
`cob_dt`, `original_filename`, `archived_path`, `file_hash` (SHA-256), `delimiter`, `uploaded_by`,
`uploaded_on`, `finished_on`, `duration_secs`, `rows_in_file`, `rows_loaded`, `rows_rejected`,
`rows_deleted`, `status` (success/partial/failed), `error_detail` (CLOB). *(Optional `ols_upload_reject`
for per-row reject detail if we want rejects persisted server-side; default is client-side export.)*

## 12. Security
- **RBAC**: server re-checks per-table write permission (`canWriteTable`). Upload hidden without it.
- **SQL injection surface** (the genericity is the risk): table + column identifiers must be **whitelisted**
  against the catalogue; **all values bound as parameters**; never string-concatenate identifiers/values.
- **Privileged connection**: writes use `app.state.sql_db_configs` (privileged), never the read-only OCC
  monitor `db_configs`.
- **File**: `.csv` only, max size/rows enforced, streamed. CSV-injection: sanitize leading `= + - @` on
  any re-export.

## 13. Code layout
- **Backend** (data/API split): `database.config_load_table(cfg, scope, table, columns, rows, mode,
  date_col, cob_dt)` holds **all** SQL (lock, delete, executemany, audit-insert, mapping read); new thin
  `config_api.py` — `POST /api/config/{scope}/table/{table}/upload` — validates + parses + calls it;
  register router in `app.py`. DDL in `sql/upload_setup.sql` (`ols_upload_audit`).
- **Frontend**: an upload dialog component (file pick, delimiter, editable AG-Grid preview, valid/reject
  panes, export, load), a CSV util (papaparse + validation), RBAC gate; reuse `toCsv`.
- **Mock**: `mock-api.interceptor.ts` handles the upload endpoint for dev parity.
- **Config** (`.env`): `CONFIG_UPLOAD_ARCHIVE_DIR`, `CONFIG_UPLOAD_MAX_ROWS`, `CONFIG_UPLOAD_MAX_MB`,
  `CONFIG_UPLOAD_BATCH_SIZE`, `CONFIG_UPLOAD_LOCK_STALE_MINUTES`.

## 14. Failure & concurrency
- Any error → ROLLBACK → target unchanged; audit row written `failed` with `error_detail`.
- Per-table (or per table+date) lock serializes concurrent loads; a stuck lock reuses the regression
  stale-threshold + unlock pattern.

## 15. Phased build
1. **Backend foundation** — `sql/upload_setup.sql` (`ols_upload_audit`), `database.config_load_table` +
   mapping read + audit + NAS archive, `config_api.py` endpoint, router, `.env` keys, mock.
2. **Frontend dialog** — file pick + delimiter + parse + header validation + editable preview.
3. **Validation + reject flow** — per-cell validation, highlight, valid/reject panes, fix→promote, export.
4. **Load** — confirm (mode/date/counts), call API, refresh grid, success/audit surfacing.
5. **Polish + docs** — GUIDE/DEPLOYMENT notes, memory, in-browser verification (incl. the 90k-row path).

## 16. Open / future
- Second date format via dropdown (if needed). Per-row server-side reject persistence. Progress streaming
  (SSE, like the regression console) for very large loads. SQL*Loader path beyond the row ceiling.
