"""Regression tools — READ-ONLY status of the CIB regression workflow.

Reuses the SAME data functions the Regression screen uses (``database.regression_*`` / ``fetch_batch_monitor``)
in-process. The Regression feature is **CIB-only** and **DEV/STG-only**, so these tools enforce CIB scope and
(in real mode) that env. Read-only: the gated workflow *actions* (start / mark / refresh / file-copy / trigger)
stay in the screen with their locks + audit — a future bot **write phase** with restate-and-confirm.

Answers: "is a regression running / who started it / which step is it on", "batch status", "downstream
extract for a date", "recent activity".

Plus two side-effect-free AUTHORING tools — ``generate_filecopy_manifest`` / ``generate_cleanup_manifest`` —
that build a DOWNLOADABLE manifest JSON (from the user's paths, or a labeled sample). They copy/delete
nothing: the real File-copy / Server-cleanup steps still run only from the gated screen (pre-flight + confirm).
"""

from __future__ import annotations

import json
import re

import database   # top-level so a missing/renamed data layer fails at startup, not on first tool call

from . import base
from ..auth import scope_access as authz   # top-level so a missing/renamed authz module fails at startup

_REG_SCOPE = "cib"   # regression is scoped to CIB

# The canonical regression step order + labels (mirrors the Regression screen's stepLabel/step sequence).
# Used to name the step a run is CURRENTLY on (first step not yet 'done'), not just a done-count.
_STEP_ORDER = ("refresh_db", "space_cleanup", "apply_db", "jenkins_deploy", "file_copy", "reset", "trigger")
_STEP_LABELS = {
    "refresh_db": "Refresh DB", "space_cleanup": "Server Space Cleanup", "apply_db": "Apply DB changes",
    "jenkins_deploy": "Jenkins deployment", "file_copy": "File copy", "reset": "Reset batches",
    "trigger": "Trigger batches", "git_pull": "Code pull",
}
_DONE_STATES = {"done", "complete", "completed"}


def _current_step(steps: dict) -> dict | None:
    """The step a run is on now: the first step (in canonical order) whose state isn't done. Returns
    ``{key, label, state}`` (state one of in_progress/error/forced/pending/…), or None when every step is done."""
    steps = steps or {}
    for key in _STEP_ORDER:
        st = str((steps.get(key) or {}).get("state") or "").lower()
        if st not in _DONE_STATES:
            return {"key": key, "label": _STEP_LABELS.get(key, key), "state": st or "pending"}
    return None

# Canned dummy (mirrors the regression_api dummy) so it's demoable on the laptop.
_DUMMY_BATCH = {
    "columns": ["BUSINESS_LINE", "BATCH", "STATUS_ID", "STARTED", "FINISHED"],
    "rows": [["CB", "CB_LOAD", 2, "2026-08-28 09:00", "2026-08-28 09:12"],
             ["CB", "CB_VALUATION", 1, "2026-08-28 09:12", None],
             ["ALMT", "ALMT_ETL", 2, "2026-08-28 08:40", "2026-08-28 09:05"],
             ["FI", "FI_POST", 3, "2026-08-28 08:30", "2026-08-28 08:31"]],
}
_DUMMY_EXTRACT = [
    {"business_date": "2026-08-28", "post_dt": "2026-08-28 09:35:00", "load_id": 910244,
     "business_line": "CB", "filename": "CB_POSITION_20260828.csv", "filerowcount": 24813},
    {"business_date": "2026-08-28", "post_dt": "2026-08-28 09:32:00", "load_id": 910243,
     "business_line": "ALMT", "filename": "ALMT_PNL_20260828.csv", "filerowcount": 12890},
]


def _gate(scopes: set[str], ctx: dict):
    """CIB scope check (+ DEV/STG only in real mode). Returns (dummy, deny_or_error_or_None)."""
    if not authz.scope_allowed(scopes, _REG_SCOPE):
        return False, base.deny(_REG_SCOPE, scopes)
    try:
        import regression_api
    except Exception as exc:  # noqa: BLE001
        return False, {"error": f"Regression service unavailable ({exc})."}
    if regression_api.REGRESSION_USE_DUMMY:
        return True, None                       # dummy mode → serve canned data
    env = str((ctx or {}).get("app_env") or "").upper()
    if env not in ("DEV", "STG"):
        return False, {"note": "Regression runs only in DEV/STG environments."}
    return False, None


def _regression_status(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    dummy, stop = _gate(scopes, ctx or {})
    if stop is not None:
        return stop
    if dummy:
        return {"note": "No regression run is active in this environment (dummy). In DEV/STG this shows the "
                        "current run, who started it, its change number, and each step's state."}
    ctx = ctx or {}
    data = database.regression_run_current(ctx.get("app_db_config"), ctx.get("app_env")) or {}
    run = data.get("run")
    if not run:
        return {"run": None, "message": "No regression run is currently open."}
    steps = data.get("steps", {})
    done = sum(1 for v in steps.values() if str((v or {}).get("state", "")).lower() in _DONE_STATES)
    return {"run": run, "steps": steps, "current_step": _current_step(steps),
            "steps_done": done, "steps_total": len(_STEP_ORDER)}


def _scope_gate(scopes: set[str]) -> dict | None:
    """Lighter gate for the manifest GENERATORS: they need CIB access (regression is CIB-scoped) but NOT the
    DEV/STG restriction — a manifest is authored ahead of time, in any environment, and touches nothing."""
    if not authz.scope_allowed(scopes, _REG_SCOPE):
        return base.deny(_REG_SCOPE, scopes)
    return None


def _regression_activity(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    dummy, stop = _gate(scopes, ctx or {})
    if stop is not None:
        return stop
    if dummy:
        return {"rows": [], "note": "No recent regression activity in this environment (dummy)."}
    ctx = ctx or {}
    run_id = args.get("run_id")
    return {"rows": database.regression_activity(ctx.get("app_db_config"), run_id)}


def _regression_batch_status(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    dummy, stop = _gate(scopes, ctx or {})
    if stop is not None:
        return stop
    if dummy:
        return dict(_DUMMY_BATCH)
    ctx = ctx or {}
    db = str(args.get("db") or "").strip()
    cfgs = ctx.get("sql_db_configs") or ctx.get("db_configs") or {}
    cfg = cfgs.get(db) if db else None
    if cfg is None:
        return {"error": f"Please name the regression database to check (unknown db '{db}')."}
    try:
        return database.fetch_batch_monitor(cfg)
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Batch monitor failed: {exc}"}


def _regression_downstream_extract(args: dict, caller: str, use_mock: bool, scopes: set[str], ctx: dict | None = None) -> dict:
    dummy, stop = _gate(scopes, ctx or {})
    if stop is not None:
        return stop
    bd = str(args.get("business_date") or "").strip() or None
    if dummy:
        rows = [r for r in _DUMMY_EXTRACT if not bd or r["business_date"] == bd]
        return {"rows": rows, "business_date": bd}
    ctx = ctx or {}
    try:
        return {"rows": database.regression_downstream_extract(ctx.get("app_db_config"), bd), "business_date": bd}
    except Exception as exc:  # noqa: BLE001
        return {"error": f"Downstream extract failed: {exc}"}


# ---------------------------------------------------------------------------
# Manifest GENERATORS — author a downloadable JSON the user reviews. These do NOT copy/delete anything and do
# NOT touch the workflow: the real File-copy / Server-cleanup steps still run only from the gated Regression
# screen (locks + audit + pre-flight/confirm). This is the safe, side-effect-free "authoring" capability.
# ---------------------------------------------------------------------------
_FILECOPY_COMMENT = (
    "FILE-COPY manifest for a release. Put the real file in the RELEASE REPO at "
    "<Scripts>/<release_date>/filecopy_manifest_<release_date>.json (e.g. "
    "sql/Scripts/20260930/filecopy_manifest_20260930.json) - the screen discovers it automatically. Each item "
    "copies source -> destination. If 'source' is a DIRECTORY or ends with '*', the whole tree is copied as ONE "
    "unit (all-or-nothing; re-run recopies the folder). Use forward slashes (recommended), or escape "
    "backslashes as \\\\ in Windows/UNC paths. A pre-flight readiness check (source exists, destination "
    "writable, enough free space) runs before the copy."
)
_CLEANUP_COMMENT = (
    "SERVER SPACE CLEANUP manifest for a release. Put the real file in the RELEASE REPO at "
    "<Scripts>/<release_date>/cleanup_manifest_<release_date>.json - discovered automatically. Each item "
    "deletes files under 'path'. Fields: include_subdir Y/N (recurse into subfolders); remove_empty_dir Y/N "
    "(delete subfolders left empty - NEVER the root 'path' itself); include_pattern / exclude_pattern filter by "
    "filename (* = all, e.g. *.log, tmp_*); older_than_days > 0 deletes only files older than N days (0 = no age "
    "filter). Defaults if omitted: include_subdir=N, remove_empty_dir=N, include_pattern=*, exclude_pattern='', "
    "older_than_days=0. The step runs a PREVIEW (dry-run) first - it lists exactly what WOULD be removed + space "
    "to be freed - and the real Clean is confirmed with that list. Use forward slashes or escape backslashes as \\\\."
)
_FILECOPY_SAMPLE_ITEMS = [
    {"source": "//nas/ols/releases/20260930/app.config", "destination": "D:/ols/app/config/app.config"},
    {"source": "//nas/ols/releases/20260930/reports/*", "destination": "D:/ols/app/reports"},
    {"source": "D:/ols/staging/bm/bm.jar", "destination": "D:/ols/app/lib/bm.jar"},
]
_CLEANUP_SAMPLE_ITEMS = [
    {"path": "D:/ols/app/logs", "include_subdir": "Y", "remove_empty_dir": "N",
     "include_pattern": "*.log", "exclude_pattern": "", "older_than_days": 30},
    {"path": "D:/ols/app/tmp", "include_subdir": "Y", "remove_empty_dir": "Y",
     "include_pattern": "*", "exclude_pattern": "*.keep", "older_than_days": 0},
    {"path": "//nas/ols/archive/20260830", "include_subdir": "N", "remove_empty_dir": "N",
     "include_pattern": "*.bak", "exclude_pattern": "", "older_than_days": 7},
]


def _coerce_items(args: dict) -> list[dict]:
    """Normalize the many shapes a caller/model might pass into a list of item dicts:
    ``items``: [...] | ``item``: {...} | a single item spread at the top level. Empty → sample."""
    args = args or {}
    raw = args.get("items")
    if isinstance(raw, list):
        return [x for x in raw if isinstance(x, dict)]
    if isinstance(args.get("item"), dict):
        return [args["item"]]
    top = {k: v for k, v in args.items() if k not in ("items", "item")}
    return [top] if top else []


def _looks_absolute(p: str) -> bool:
    p = str(p or "")
    return bool(re.match(r"^[A-Za-z]:[\\/]", p)) or p.startswith(("//", "\\\\", "/"))


def _yn(v, default: str) -> str:
    s = str(v if v is not None else "").strip().upper()
    if s in ("Y", "YES", "TRUE", "1"):
        return "Y"
    if s in ("N", "NO", "FALSE", "0"):
        return "N"
    return default


def _to_int(v, default: int) -> int:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return default


def _write_manifest(kind: str, manifest: dict, ctx: dict | None, sample: bool,
                    warnings: list[str], item_count: int) -> dict:
    api_base = str((ctx or {}).get("api_base") or "").rstrip("/")
    fname = base.write_export(f"{kind}_manifest", json.dumps(manifest, indent=2), ext="json")
    note = ("This is a SAMPLE template - replace the paths with your real ones. " if sample
            else "Review the file before use. ")
    note += ("Nothing was copied or deleted. Rename it to the release convention and drop it in the release "
             "repo, then run the step from the Regression screen (it does the pre-flight + confirm there).")
    return {"download_url": f"{api_base}/api/assistant/export/{fname}", "filename": fname,
            "kind": kind, "item_count": item_count, "sample": sample,
            "warnings": warnings, "note": note}


def _generate_filecopy_manifest(args: dict, caller: str, use_mock: bool, scopes: set[str],
                                ctx: dict | None = None) -> dict:
    """Build a downloadable FILE-COPY manifest JSON. With items → those items; with none → a labeled sample."""
    deny = _scope_gate(scopes)
    if deny is not None:
        return deny
    warnings: list[str] = []
    items: list[dict] = []
    for i, it in enumerate(_coerce_items(args), 1):
        src = str(it.get("source") or "").strip()
        dst = str(it.get("destination") or "").strip()
        if not src or not dst:
            warnings.append(f"Item {i} skipped: needs both 'source' and 'destination'.")
            continue
        for lbl, p in (("source", src), ("destination", dst)):
            if not _looks_absolute(p) and "*" not in p:
                warnings.append(f"Item {i} {lbl} '{p}' isn't an absolute path (drive letter, / or \\\\).")
        items.append({"source": src, "destination": dst})
    sample = not items
    if sample:
        items = [dict(x) for x in _FILECOPY_SAMPLE_ITEMS]
    return _write_manifest("filecopy", {"_comment": _FILECOPY_COMMENT, "items": items},
                           ctx, sample, warnings, len(items))


def _generate_cleanup_manifest(args: dict, caller: str, use_mock: bool, scopes: set[str],
                               ctx: dict | None = None) -> dict:
    """Build a downloadable SERVER-CLEANUP manifest JSON. With items → those items; with none → a labeled sample."""
    deny = _scope_gate(scopes)
    if deny is not None:
        return deny
    warnings: list[str] = []
    items: list[dict] = []
    for i, it in enumerate(_coerce_items(args), 1):
        path = str(it.get("path") or "").strip()
        if not path:
            warnings.append(f"Item {i} skipped: needs a 'path'.")
            continue
        if not _looks_absolute(path):
            warnings.append(f"Item {i} path '{path}' isn't an absolute path (drive letter, / or \\\\).")
        items.append({
            "path": path,
            "include_subdir": _yn(it.get("include_subdir"), "N"),
            "remove_empty_dir": _yn(it.get("remove_empty_dir"), "N"),
            "include_pattern": str(it.get("include_pattern") or "*"),
            "exclude_pattern": str(it.get("exclude_pattern") or ""),
            "older_than_days": _to_int(it.get("older_than_days"), 0),
        })
    sample = not items
    if sample:
        items = [dict(x) for x in _CLEANUP_SAMPLE_ITEMS]
    return _write_manifest("cleanup", {"_comment": _CLEANUP_COMMENT, "items": items},
                           ctx, sample, warnings, len(items))


SCHEMAS: list[dict] = [
    {"type": "function", "function": {
        "name": "regression_status",
        "description": "The current CIB regression run: whether one is active, who started it, its change "
                       "number, and each step's state. Use for 'is a regression running?' / 'what's the "
                       "regression state?'.",
        "parameters": {"type": "object", "properties": {}},
    }},
    {"type": "function", "function": {
        "name": "regression_activity",
        "description": "Recent regression activity (who did what, and when). Use for 'who is working on the "
                       "regression?'.",
        "parameters": {"type": "object", "properties": {
            "run_id": {"type": "integer", "description": "Optional run id; omit for the current run."},
        }},
    }},
    {"type": "function", "function": {
        "name": "regression_batch_status",
        "description": "Batch monitor for the regression: each business line's batch, status, start/finish. "
                       "Use for 'batch status' / 'what's running / completed'.",
        "parameters": {"type": "object", "properties": {
            "db": {"type": "string", "description": "The regression database key to check (e.g. ols_cib_batch)."},
        }},
    }},
    {"type": "function", "function": {
        "name": "regression_downstream_extract",
        "description": "Downstream extract rows produced by the regression (files, row counts), optionally "
                       "for a business date. Use for 'downstream extract' / 'what files were extracted'.",
        "parameters": {"type": "object", "properties": {
            "business_date": {"type": "string", "description": "Optional date (any common format)."},
        }},
    }},
    {"type": "function", "function": {
        "name": "generate_filecopy_manifest",
        "description": "Build a DOWNLOADABLE file-copy manifest JSON for a regression release from source -> "
                       "destination pairs. Call with NO items to get a labeled SAMPLE/template. This only "
                       "AUTHORS the file (returns a download link) - it copies nothing; the copy still runs "
                       "from the Regression screen. Use for 'make/generate a file copy manifest', 'sample "
                       "file copy json', 'copy X to Y'.",
        "parameters": {"type": "object", "properties": {
            "items": {"type": "array", "description": "Copy pairs; omit for a sample template.",
                      "items": {"type": "object", "properties": {
                          "source": {"type": "string", "description": "Source file/dir (or a path ending in * to copy a tree)."},
                          "destination": {"type": "string", "description": "Destination path."},
                      }, "required": ["source", "destination"]}},
        }},
    }},
    {"type": "function", "function": {
        "name": "generate_cleanup_manifest",
        "description": "Build a DOWNLOADABLE server-space-cleanup manifest JSON for a regression release. Call "
                       "with NO items to get a labeled SAMPLE/template. This only AUTHORS the file (returns a "
                       "download link) - it deletes nothing; the cleanup still runs (preview + confirm) from "
                       "the Regression screen. Use for 'make/generate a cleanup manifest', 'sample server "
                       "cleanup json'.",
        "parameters": {"type": "object", "properties": {
            "items": {"type": "array", "description": "Cleanup targets; omit for a sample template.",
                      "items": {"type": "object", "properties": {
                          "path": {"type": "string", "description": "Folder to clean."},
                          "include_subdir": {"type": "string", "description": "Y/N - recurse into subfolders (default N)."},
                          "remove_empty_dir": {"type": "string", "description": "Y/N - delete emptied subfolders, never the root (default N)."},
                          "include_pattern": {"type": "string", "description": "Filename filter, e.g. *.log (default *)."},
                          "exclude_pattern": {"type": "string", "description": "Filename to keep, e.g. *.keep (default none)."},
                          "older_than_days": {"type": "integer", "description": "Only delete files older than N days (default 0 = no age filter)."},
                      }, "required": ["path"]}},
        }},
    }},
]

TOOLS = {
    "regression_status": _regression_status,
    "regression_activity": _regression_activity,
    "regression_batch_status": _regression_batch_status,
    "regression_downstream_extract": _regression_downstream_extract,
    "generate_filecopy_manifest": _generate_filecopy_manifest,
    "generate_cleanup_manifest": _generate_cleanup_manifest,
}
