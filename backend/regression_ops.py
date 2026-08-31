"""Regression screen — OS-level operations (git, sqlplus, file copy, log files).

Kept SEPARATE from ``database.py`` (which holds SQL only): these are subprocess / filesystem
operations. The API layer (``regression_api.py``) orchestrates them and writes the audit log.

Every function takes a per-scope ``cfg`` dict (from ``config_loader.regression_scope_config(scope)``)
so cib / retail / group can each point at their OWN git repo, work dir, log dir and NAS feed path. The
cfg keys used here: ``git_url``, ``git_auth`` (secret token, from .env), ``git_workdir``,
``branch_prefix``, ``sql_subdir``, ``log_dir``, ``sqlplus_timeout``, ``git_timeout``.

SECURITY: the git token stays server-side (never sent to the UI). The DB password is fed to sqlplus
over STDIN (never on the command line). Only DEV/STG use this screen.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

from utils.logging import get_logger

logger = get_logger(__name__)


# --- git --------------------------------------------------------------------

def _auth_url(cfg: dict) -> str:
    url = cfg.get("git_url", "")
    if not url:
        raise RuntimeError("git_url is not configured for this scope (config/regression.json or REGRESSION_GIT_URL).")
    auth = cfg.get("git_auth", "")
    if auth and url.startswith("https://"):
        return url.replace("https://", f"https://{auth}@", 1)
    return url


def list_release_branches(cfg: dict) -> list[str]:
    """Remote branches whose name starts with the scope's branch prefix (e.g. release/*)."""
    prefix = cfg.get("branch_prefix", "release/")
    out = subprocess.run(["git", "ls-remote", "--heads", _auth_url(cfg)],
                         capture_output=True, text=True, timeout=cfg.get("git_timeout", 120))
    if out.returncode != 0:
        raise RuntimeError(f"git ls-remote failed: {out.stderr.strip()[:400]}")
    names = []
    for line in out.stdout.splitlines():
        ref = line.split("\t")[-1].strip()
        name = ref.replace("refs/heads/", "")
        if name.startswith(prefix):
            names.append(name)
    return sorted(names)


def git_pull_branch(cfg: dict, branch: str) -> str:
    """Checkout/refresh `branch` into the scope's work dir. Returns the working dir."""
    prefix = cfg.get("branch_prefix", "release/")
    workdir = cfg.get("git_workdir", "")
    timeout = cfg.get("git_timeout", 120)
    if not branch.startswith(prefix):
        raise RuntimeError(f"Only {prefix}* branches may be pulled.")
    if not workdir:
        raise RuntimeError("git_workdir is not configured for this scope.")
    wd = Path(workdir)
    if (wd / ".git").is_dir():
        for args in (["fetch", "origin", branch], ["checkout", branch],
                     ["reset", "--hard", f"origin/{branch}"]):
            r = subprocess.run(["git", "-C", str(wd), *args], capture_output=True, text=True, timeout=timeout)
            if r.returncode != 0:
                raise RuntimeError(f"git {' '.join(args)} failed: {r.stderr.strip()[:400]}")
    else:
        wd.parent.mkdir(parents=True, exist_ok=True)
        r = subprocess.run(["git", "clone", "--branch", branch, "--depth", "1", _auth_url(cfg), str(wd)],
                           capture_output=True, text=True, timeout=timeout)
        if r.returncode != 0:
            raise RuntimeError(f"git clone failed: {r.stderr.strip()[:400]}")
    return str(wd)


def list_branch_scripts(cfg: dict) -> list[str]:
    """.sql files under the checked-out branch's SQL dir (repo-relative paths)."""
    wd = Path(cfg.get("git_workdir", ""))
    sub = cfg.get("sql_subdir", "")
    root = wd / sub if sub else wd
    if not root.is_dir():
        return []
    return sorted(str(p.relative_to(wd)).replace("\\", "/") for p in root.rglob("*.sql"))


def _script_abspath(cfg: dict, rel: str) -> Path:
    """Resolve a repo-relative script path, jailed to the work dir."""
    wd = Path(cfg.get("git_workdir", "")).resolve()
    p = (wd / rel).resolve()
    if not str(p).startswith(str(wd)):
        raise RuntimeError("Script path escapes the work dir.")
    if not p.is_file():
        raise RuntimeError(f"Script not found: {rel}")
    return p


def repo_info(cfg: dict) -> dict:
    """The work dir path + the currently checked-out branch (for the browser header)."""
    wd = Path(cfg.get("git_workdir", ""))
    branch = ""
    if (wd / ".git").is_dir():
        r = subprocess.run(["git", "-C", str(wd), "rev-parse", "--abbrev-ref", "HEAD"],
                           capture_output=True, text=True, timeout=cfg.get("git_timeout", 120))
        branch = r.stdout.strip()
    return {"workdir": str(wd), "branch": branch}


def list_repo_tree(cfg: dict) -> list[str]:
    """Every file in the pulled branch (repo-relative posix paths), so the UI can browse it and
    verify that referenced packages/procs exist. Excludes the .git dir."""
    wd = Path(cfg.get("git_workdir", ""))
    if not wd.is_dir():
        return []
    return sorted(
        str(p.relative_to(wd)).replace("\\", "/")
        for p in wd.rglob("*") if p.is_file() and ".git" not in p.parts
    )


def read_repo_file(cfg: dict, rel: str, max_chars: int = 400_000) -> str:
    """Read any file from the pulled branch (jailed to the work dir) — e.g. a CHG or a .pck package."""
    wd = Path(cfg.get("git_workdir", "")).resolve()
    p = (wd / rel).resolve()
    if not str(p).startswith(str(wd)) or not p.is_file():
        raise RuntimeError("File not found in the pulled branch.")
    return p.read_text(encoding="utf-8", errors="replace")[:max_chars]


# --- sqlplus ----------------------------------------------------------------

def _mask_secret(text: str, secret: str) -> str:
    """Replace every occurrence of ``secret`` (the DB password) in ``text`` with ``********``.
    No-op for empty inputs. Used to keep passwords out of logs and any returned output."""
    if not text or not secret:
        return text
    return text.replace(secret, "********")


def _resolve_password(db_config: dict) -> str:
    """Resolve the DB password for a sqlplus connect. Prefer a configured password; otherwise, when
    CyberArk is wired, fetch it at runtime by AppID/Object (the password is never stored in .env,
    never logged, and never sent to the UI). The ``cyberark_*`` hints come from the DB config."""
    pwd = db_config.get("password") or ""
    if pwd:
        return pwd
    try:
        import cyberark
    except Exception:  # noqa: BLE001 — module optional
        return pwd
    if not cyberark.is_configured():
        return pwd
    try:
        return cyberark.get_password(
            app_id=db_config.get("cyberark_app_id", ""),
            object_name=db_config.get("cyberark_object", ""),
            query=db_config.get("cyberark_query", ""),
            safe=db_config.get("cyberark_safe", ""),
        )
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"Could not retrieve the DB password from CyberArk: {exc}") from exc


def _build_sqlplus(cfg: dict, db_config: Any, db_key: str, script_rel: str):
    """Validate the connection, resolve the (never-logged) password, and build the standardized
    sqlplus command block + log path. Returns (commands, log_file, pwd). Shared by run + stream.

    Order matters for password hygiene: the connect is QUIET (echo/termout off) and OUTSIDE the
    spool, so credentials never land in the log file or captured output; echo is turned on only
    after the connect + spool, so the script's statements are visible but the connect is not."""
    if not isinstance(db_config, dict) or not (db_config.get("user") and (db_config.get("dsn") or db_config.get("connect_string"))):
        raise RuntimeError(f"No privileged connection for '{db_key}' (wire app.state.sql_db_configs).")
    log_dir_cfg = cfg.get("log_dir", "")
    if not log_dir_cfg:
        raise RuntimeError("log_dir is not configured for this scope.")
    user = db_config["user"]
    pwd = _resolve_password(db_config)
    dsn = db_config.get("dsn") or db_config.get("connect_string")
    script = _script_abspath(cfg, script_rel)

    day = datetime.now().strftime("%Y%m%d")
    log_dir = Path(log_dir_cfg) / day
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"{script.stem}__{db_key}.log"

    commands = (
        "set echo off\n"
        "set termout off\n"
        f"connect {user}/{pwd}@{dsn}\n"
        "set termout on\n"
        "whenever sqlerror continue\n"
        f"spool {log_file}\n"
        "set echo on\n"
        f"@{script}\n"
        "spool off\n"
        "exit\n"
    )
    return commands, log_file, pwd


def run_sqlplus(cfg: dict, db_config: Any, db_key: str, script_rel: str) -> dict:
    """Run one .sql via sqlplus against `db_config`, spooling to the scope's log dir.
    Returns {status, log_file, tail, rows_hint}. Password is fed over STDIN, never the cmd line."""
    commands, log_file, pwd = _build_sqlplus(cfg, db_config, db_key, script_rel)
    try:
        proc = subprocess.run(["sqlplus", "-s", "/nolog"], input=commands,
                              capture_output=True, text=True, timeout=cfg.get("sqlplus_timeout", 3600))
    except FileNotFoundError as exc:
        raise RuntimeError("sqlplus not found on the server (install Instant Client + sqlplus).") from exc

    # Belt & braces: scrub the password from the on-disk log in case it ever leaked in.
    if pwd and log_file.is_file():
        try:
            raw = log_file.read_text(encoding="utf-8", errors="replace")
            if pwd in raw:
                log_file.write_text(_mask_secret(raw, pwd), encoding="utf-8")
        except OSError:
            pass

    body = ""
    if log_file.is_file():
        try:
            body = log_file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            body = ""
    if not body:
        body = (proc.stdout or "") + (proc.stderr or "")
    body = _mask_secret(body, pwd)      # never return the password in the tail either
    status = "error" if (proc.returncode != 0 or "ORA-" in body or "SP2-" in body) else "complete"
    return {"status": status, "log_file": str(log_file), "tail": body[-8000:], "db": db_key, "script": script_rel}


def run_sqlplus_stream(cfg: dict, db_config: Any, db_key: str, script_rel: str):
    """GENERATOR variant of run_sqlplus for the LIVE console: yields sqlplus output line-by-line as
    it prints. Yields {"type":"line","text":...} per line, then one final
    {"type":"done","status":...,"log_file":...}. Password is masked on every line + in the log."""
    commands, log_file, pwd = _build_sqlplus(cfg, db_config, db_key, script_rel)
    try:
        proc = subprocess.Popen(["sqlplus", "-s", "/nolog"], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    except FileNotFoundError as exc:
        raise RuntimeError("sqlplus not found on the server (install Instant Client + sqlplus).") from exc

    saw_err = False
    try:
        if proc.stdin:
            proc.stdin.write(commands)
            proc.stdin.flush()
            proc.stdin.close()
        if proc.stdout:
            for raw in proc.stdout:
                line = _mask_secret(raw.rstrip("\n"), pwd)
                if "ORA-" in line or "SP2-" in line:
                    saw_err = True
                yield {"type": "line", "text": line}
        proc.wait(timeout=cfg.get("sqlplus_timeout", 3600))
    finally:
        try:
            if proc.stdout:
                proc.stdout.close()
        except Exception:  # noqa: BLE001
            pass

    # scrub the on-disk log (belt & braces — the connect is outside the spool, but be safe)
    if pwd and log_file.is_file():
        try:
            raw = log_file.read_text(encoding="utf-8", errors="replace")
            if pwd in raw:
                log_file.write_text(_mask_secret(raw, pwd), encoding="utf-8")
        except OSError:
            pass

    status = "error" if (proc.returncode not in (0, None) or saw_err) else "complete"
    yield {"type": "done", "status": status, "log_file": str(log_file)}


def read_log(cfg: dict, log_file: str, max_chars: int = 200_000) -> str:
    """Read a log file (jailed to the scope's log dir)."""
    base = Path(cfg.get("log_dir", "")).resolve()
    p = Path(log_file).resolve()
    if not str(p).startswith(str(base)) or not p.is_file():
        raise RuntimeError("Log file not found.")
    return p.read_text(encoding="utf-8", errors="replace")[:max_chars]


# --- file copy --------------------------------------------------------------

def read_manifest(path: str) -> list[dict]:
    """Parse the developer file-copy JSON: {items:[{source,destination}]} or a bare list."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    items = data.get("items", []) if isinstance(data, dict) else data
    out = []
    for it in items:
        src = str(it.get("source", "")).strip()
        dst = str(it.get("destination", "")).strip()
        if src and dst:
            out.append({"source": src, "destination": dst})
    return out


class _PartialCopyError(Exception):
    """A folder copy failed partway. Carries how many files were copied before the failing one, so the
    item can be reported errored with context. NOTE: a folder item is all-or-nothing — a partial copy
    is a FAILURE and re-running re-copies the WHOLE folder (overwrite); we never resume file-by-file."""
    def __init__(self, copied: int, failed_file: str, cause: str):
        self.copied = copied
        self.failed_file = failed_file
        self.cause = cause
        super().__init__(f"copied {copied} file(s), then failed on {failed_file}: {cause}")


def _copy_tree(src_dir: str, dst_dir: str) -> list[str]:
    """Recurse-copy ``src_dir`` into ``dst_dir``; return the list of destination files written. If any
    file fails, raise ``_PartialCopyError`` with the count copied so far (the folder is treated as a
    single unit — the caller marks the whole item failed)."""
    copied: list[str] = []
    for root, _dirs, files in os.walk(src_dir):
        rel = os.path.relpath(root, src_dir)
        target = dst_dir if rel == "." else os.path.join(dst_dir, rel)
        os.makedirs(target, exist_ok=True)
        for f in files:
            dstf = os.path.join(target, f)
            try:
                shutil.copy2(os.path.join(root, f), dstf)
            except Exception as exc:  # noqa: BLE001
                raise _PartialCopyError(len(copied), os.path.join(root, f), str(exc)) from exc
            copied.append(dstf)
    return copied


# cap the file list returned/logged per item so a huge folder can't bloat the response / CLOB
_MAX_FILES = 1000


def _copy_folder(src: str, dst: str, base: str) -> dict:
    """Copy a whole folder as ONE unit. Success → all files; partial failure → errored item that must
    be re-copied in full (no file-level resume)."""
    try:
        files = _copy_tree(base, dst)
        return {"source": src, "destination": dst, "ok": True, "count": len(files), "kind": "folder", "files": files[:_MAX_FILES]}
    except _PartialCopyError as pe:
        return {"source": src, "destination": dst, "ok": False, "kind": "folder", "count": pe.copied,
                "error": (f"Folder copy FAILED after {pe.copied} file(s) — the WHOLE folder must be re-copied "
                          f"(re-run the step). Failed on {pe.failed_file}: {pe.cause}")}


def copy_items(items: list[dict]) -> list[dict]:
    """Copy each {source,destination}. `*` (or a directory) → recurse the whole tree as ONE unit.
    Returns per-item result. A folder that fails partway is reported errored (re-run re-copies it all)."""
    results = []
    for it in items:
        src, dst = it["source"], it["destination"]
        try:
            if src.rstrip("/\\").endswith("*"):
                results.append(_copy_folder(src, dst, src.rstrip("*").rstrip("/\\")))
            elif os.path.isdir(src):
                results.append(_copy_folder(src, dst, src))
            else:
                os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
                shutil.copy2(src, dst)
                results.append({"source": src, "destination": dst, "ok": True, "count": 1, "kind": "file", "files": [dst]})
        except Exception as exc:  # noqa: BLE001 — report per item, keep going
            results.append({"source": src, "destination": dst, "ok": False, "error": str(exc)})
    return results
