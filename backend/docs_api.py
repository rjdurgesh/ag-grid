"""Documentation Center API (see DOCS_DESIGN.md).

Serves the doc **catalogue** (external wiki links from config + local ``.md`` files auto-discovered under
a configured base dir) and one doc's raw **markdown**. The frontend renders + sanitizes the markdown
client-side; this module is a thin, security-hardened file server.

Design decisions (locked): role-based audience gating (technical docs → ADMIN / ops-admin / S-Studio),
hybrid discovery (auto-discover ``.md`` + optional ``config/docs.json`` overrides), client-side render.

Security:
  * Docs are addressed by an OPAQUE id; the id→path mapping is server-side only and every resolved path
    is confirmed INSIDE ``base_dir`` via ``fs_browser.resolve_within_bases`` (no path traversal).
  * Only ``.md`` files are discovered/served.
  * RBAC is re-checked on BOTH the catalogue and the content fetch — technical docs are never returned
    to a non-technical user (UI hiding is never the boundary).
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

from env_loader import env_bool
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

import config_loader
import database
from utils import fs_browser
from utils.logging import get_logger

logger = get_logger(__name__)

router = APIRouter(prefix="/api/docs", tags=["docs"])

# Reuse the shared access dummy flag (stays in .env). In dummy mode every caller is treated as an active
# technical user, so the whole catalogue is browsable locally without a DB.
DOCS_USE_DUMMY = env_bool("ACCESS_USE_DUMMY", True)
_CFG = config_loader.docs_config()

_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$")


class CatalogBody(BaseModel):
    caller: str
    app_env: str = "PROD"


class ContentBody(BaseModel):
    caller: str
    id: str


# ---- access ----------------------------------------------------------------
def _docs_access(request: Request, caller: str, app_env: str = "PROD") -> tuple[bool, bool]:
    """Return ``(can_user_guide, can_technical_guide)`` for the caller — grant-driven (like every other
    screen). ADMIN / full-access (SCREEN */*) → both; else an explicit ``SCREEN / docs`` grant reveals
    the User Guide and ``SCREEN / docs_technical`` the Technical Guide. No grant → neither (Docs hidden).
    Dummy mode → both (so it is browsable locally without a DB)."""
    if DOCS_USE_DUMMY:
        return True, True
    cfg = getattr(request.app.state, "app_db_config", None)
    ident = database.fetch_user_identity(cfg, caller)
    active = bool(ident) and str(ident.get("lgcl_del_flg") or "").strip().upper() == "N"
    if not active:
        return False, False
    if str(ident.get("is_admin") or "").strip().upper() in ("Y", "YES", "1", "TRUE"):
        return True, True
    can_user = can_tech = False
    for g in (database.fetch_user_grants(cfg, caller, app_env) or []):
        if (g.get("resource_type") or "").strip().upper() != "SCREEN":
            continue
        if (g.get("access_level") or "").strip().upper() == "DENY":
            continue
        scope = (g.get("resource_scope") or "").strip().lower()
        key = (g.get("resource_key") or "").strip()
        if scope == "*" and key == "*":       # full-access wildcard → all docs
            can_user = can_tech = True
        elif scope == "docs":
            can_user = True
        elif scope == "docs_technical":
            can_tech = True
    return can_user, can_tech


# ---- catalogue building ----------------------------------------------------
def _slugify(text: str, used: set[str]) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", (text or "doc").lower()).strip("-") or "doc"
    slug, n = base, 2
    while slug in used:
        slug = f"{base}-{n}"
        n += 1
    used.add(slug)
    return slug


def _first_heading(path: Path) -> str | None:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for _ in range(200):                     # scan only the first lines
                line = fh.readline()
                if not line:
                    break
                m = _HEADING_RE.match(line)
                if m:
                    return m.group(1).strip()
    except OSError:
        return None
    return None


def _title_from_name(stem: str) -> str:
    return re.sub(r"[_-]+", " ", stem).strip().title()


def _scan_markdown() -> list[dict]:
    """Auto-discover every ``.md`` under ``base_dir`` and merge ``config/docs.json`` overrides. Each entry
    carries an internal ``_relpath`` used to resolve content; ids are stable within a scan. Files with no
    override default to the ``technical`` audience (safer: hidden from regular users)."""
    base_dir = str(_CFG.get("base_dir") or "").strip()
    if not base_dir:
        return []
    base = Path(base_dir)
    if not base.is_dir():
        logger.warning("docs: base_dir %s is not a directory", base_dir)
        return []

    overrides: dict = _CFG.get("overrides") or {}
    used: set[str] = set()
    entries: list[dict] = []
    for f in sorted(base.rglob("*.md"), key=lambda p: str(p).lower()):
        # Defence-in-depth: confirm each file really sits inside the base (rejects symlink escapes).
        resolved = fs_browser.resolve_within_bases([base_dir], str(f))
        if resolved is None or not resolved.is_file():
            continue
        rel = fs_browser.to_posix(f.relative_to(base))
        ov = overrides.get(rel, {}) if isinstance(overrides.get(rel), dict) else {}
        title = str(ov.get("title") or "").strip() or _first_heading(f) or _title_from_name(f.stem)
        # Audience resolution: an explicit override wins; else the top-level folder name
        # (user*/technical*) decides — so dropping a file under <base>/user/ shows it in the User Guide
        # and <base>/technical/ in the Technical Guide; anything else defaults to technical.
        top = rel.split("/")[0].lower() if "/" in rel else ""
        folder_aud = ("user" if top in ("user", "user_guide", "userguide")
                      else "technical" if top in ("technical", "technical_guide", "tech") else "")
        audience = str(ov.get("audience") or "").strip().lower()
        if audience not in ("user", "technical"):
            audience = folder_aud or "technical"
        try:
            updated = datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc).date().isoformat()
        except OSError:
            updated = ""
        entries.append({
            "id": _slugify(rel.rsplit(".", 1)[0], used),
            "title": title,
            "description": str(ov.get("description") or "").strip(),
            "type": "markdown",
            "audience": audience,
            "tags": ov.get("tags") if isinstance(ov.get("tags"), list) else [],
            "updated": updated,
            "file": f.name,        # the actual filename, e.g. "RBAC_DESIGN.md" (shown on the card)
            "order": ov.get("order") if isinstance(ov.get("order"), int) else 1000,
            "_relpath": rel,
        })
    return entries


def _wiki_entries() -> list[dict]:
    out: list[dict] = []
    for w in _CFG.get("wikis") or []:
        if not isinstance(w, dict) or not w.get("url") or not w.get("title"):
            continue
        audience = str(w.get("audience") or "user").strip().lower()
        if audience not in ("user", "technical"):
            audience = "user"
        out.append({
            "id": str(w.get("id") or _slugify(str(w.get("title")), set())),
            "title": str(w.get("title")),
            "description": str(w.get("description") or ""),
            "type": "wiki",
            "audience": audience,
            "tags": w.get("tags") if isinstance(w.get("tags"), list) else [],
            "updated": str(w.get("updated") or ""),
            "url": str(w.get("url")),
        })
    return out


def _public_entry(e: dict) -> dict:
    """Strip server-only fields (``_relpath``, ``order``) before returning to the client."""
    return {k: v for k, v in e.items() if not k.startswith("_") and k != "order"}


# ---- endpoints -------------------------------------------------------------
@router.post("/catalog")
def docs_catalog(request: Request, body: CatalogBody) -> dict:
    """The RBAC-filtered catalogue: local markdown docs + wiki links. Entries are kept per the caller's
    grants — user-audience entries need the User Guide grant, technical-audience the Technical Guide
    grant. A caller with neither gets an empty list (Docs hidden)."""
    can_user, can_tech = _docs_access(request, body.caller, body.app_env)
    if not (can_user or can_tech):
        return {"status": "success", "entries": []}

    def allowed(e: dict) -> bool:
        aud = e.get("audience")
        return (aud == "user" and can_user) or (aud == "technical" and can_tech)

    entries = [e for e in (_scan_markdown() + _wiki_entries()) if allowed(e)]
    entries.sort(key=lambda e: (e.get("order", 1000), e.get("title", "").lower()))
    return {"status": "success", "entries": [_public_entry(e) for e in entries]}


@router.post("/content")
def docs_content(request: Request, body: ContentBody) -> dict:
    """Raw markdown for one local doc (addressed by opaque id). RBAC re-checked; path confirmed inside
    the base dir before reading."""
    can_user, can_tech = _docs_access(request, body.caller, getattr(request.app.state, "app_env", "PROD"))
    if not (can_user or can_tech):
        raise HTTPException(status_code=403, detail="No Documentation access.")
    entry = next((e for e in _scan_markdown() if e["id"] == body.id), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    aud = entry.get("audience")
    if (aud == "technical" and not can_tech) or (aud == "user" and not can_user):
        raise HTTPException(status_code=403, detail="You do not have access to this document.")

    base_dir = str(_CFG.get("base_dir") or "")
    resolved = fs_browser.resolve_within_bases([base_dir], f"{fs_browser.to_posix(base_dir)}/{entry['_relpath']}")
    if resolved is None or not resolved.is_file():
        raise HTTPException(status_code=404, detail="Document file is missing.")
    markdown = fs_browser.read_file_all(resolved, fs_browser.MAX_READ_BYTES)
    return {"status": "success", "doc": {
        "id": entry["id"], "title": entry["title"], "markdown": markdown, "updated": entry.get("updated", ""),
    }}
