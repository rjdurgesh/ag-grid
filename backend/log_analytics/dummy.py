"""Dummy data for the Log Analytics Hub — used when ``LOG_ANALYTICS_USE_DUMMY`` is on (the backend analog
of the UI's per-screen mock switch). Serves a canned server catalogue + an in-memory folder tree so the
screen is fully demoable WITHOUT real log servers on disk. One configured base path
(``D:/apps/Logs/ols_missing``) is deliberately ABSENT from the tree so ``/dir`` returns 404 for it — the UI
then shows an inline "Path not available" on that root only, leaving the other paths browsable (a live test
of the tree's per-path resilience).
"""

from __future__ import annotations

from fastapi import HTTPException


def _norm(p: str) -> str:
    """Backslashes → forward slashes, drop any trailing slash — for tree-key lookups."""
    return (p or "").replace("\\", "/").rstrip("/")


# Canned tree: path → (subfolders, files). Anything not listed is treated as "not available" (404),
# which is exactly what we want for the intentionally-missing base path below.
_TREE: dict[str, tuple[list[str], list[str]]] = {
    "D:/apps/Logs/ols": (["app", "web", "archive"], ["startup.log", "error.log"]),
    "D:/apps/Logs/ols/app": (["old"], ["app-2026-09-01.log", "app-2026-09-02.log", "app.config"]),
    "D:/apps/Logs/ols/app/old": ([], ["app-2026-08-01.log", "app-2026-08-02.log"]),
    "D:/apps/Logs/ols/web": ([], ["access.log", "web.xml"]),
    "D:/apps/Logs/ols/archive": ([], ["release-2026-08.zip"]),
    "D:/apps/Logs/group": (["batch"], ["group.log"]),
    "D:/apps/Logs/group/batch": ([], ["batch-2026-09-01.log", "batch-2026-09-02.log"]),
}

# A short canned log body for the file preview (any file returns this).
_SAMPLE_LOG = (
    "2026-09-02 08:00:01 INFO  [startup] OLS service starting…\n"
    "2026-09-02 08:00:02 INFO  [config] loaded 42 settings\n"
    "2026-09-02 08:00:03 WARN  [pool] connection pool at 80% capacity\n"
    "2026-09-02 08:00:05 INFO  [ready] service is up on port 8443\n"
    "2026-09-02 08:15:10 ERROR [job] batch OLS_LOAD failed: ORA-00942: table or view does not exist\n"
    "2026-09-02 08:15:11 INFO  [retry] scheduling retry in 60s\n"
)


def servers_dummy(app_env: str | None = None) -> dict[str, list[dict]]:
    """Canned catalogue keyed ``{db_source}_{server_type}_{server_name}`` — same shape as fetch_log_path.
    eur17 has TWO base paths: one real (``…/ols``) and one MISSING (``…/ols_missing``) to demo the
    'path not available' handling; eur12 has a single valid path."""
    return {
        "OLSCIB_WEB_A_1_eur17": [
            {"server_name": "eur17", "base_log_path": "D:/apps/Logs/ols", "server_type": "WEB_A_1", "db_source": "OLSCIB"},
            {"server_name": "eur17", "base_log_path": "D:/apps/Logs/ols_missing", "server_type": "WEB_A_1", "db_source": "OLSCIB"},
        ],
        "OLSGROUP_APP_1_eur12": [
            {"server_name": "eur12", "base_log_path": "D:/apps/Logs/group", "server_type": "APP_1", "db_source": "OLSGROUP"},
        ],
    }


def dir_dummy(base: str, path: str) -> dict:
    """Immediate children of a canned folder. A path not in the tree (e.g. the intentionally-missing base)
    → 404, so the UI renders one 'Path not available' node and the rest of the tree keeps working."""
    key = _norm(path) or _norm(base)
    node = _TREE.get(key)
    if node is None:
        raise HTTPException(status_code=404, detail="Path not found")
    folders, files = node
    entries = [{"name": f, "type": "folder", "path": f"{key}/{f}"} for f in folders] \
        + [{"name": f, "type": "file", "path": f"{key}/{f}"} for f in files]
    return {"entries": entries, "total": len(entries), "truncated": False}


def file_dummy(path: str) -> dict:
    """Canned file content for the preview (always the small/full shape)."""
    content = f"# {_norm(path)}\n{_SAMPLE_LOG}"
    return {"mode": "full", "content": content, "total_size": len(content.encode("utf-8"))}


def file_properties_dummy(path: str) -> dict:
    """Canned Properties-dialog metadata."""
    p = _norm(path)
    name = p.rsplit("/", 1)[-1] or p
    location = p.rsplit("/", 1)[0] if "/" in p else p
    return {
        "name": name, "type": "Log File", "location": location,
        "size": len(_SAMPLE_LOG.encode("utf-8")),
        "created": "2026-09-01 08:00:00", "modified": "2026-09-02 08:15:11", "accessed": "2026-09-02 09:00:00",
        "lines": _SAMPLE_LOG.count("\n"), "attributes": "Read & Write",
    }
