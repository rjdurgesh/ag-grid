"""Runtime DB-password retrieval from CyberArk (Central Credential Provider / AIM).

The password for a privileged schema (e.g. OLS / OLS_SERVICE) is fetched **at runtime** from
CyberArk over a mutual-TLS (client-certificate) call, identified by an ``AppID`` — so the password is
never stored in ``.env``, never written to a log, and never sent to the browser. It lives only in
process memory for the moment it is fed to ``sqlplus`` over STDIN.

Configuration (all optional; when ``CYBERARK_CCP_URL`` + an AppID are absent this module is inert and
the caller falls back to a configured password):

  CYBERARK_CCP_URL      https://ccp.host/AIMWebService/api/Accounts   (the CCP GetPassword endpoint)
  CYBERARK_APP_ID       default AppID (a per-schema AppID can override it per request)
  CYBERARK_SAFE         default Safe (optional)
  CYBERARK_CLIENT_CERT  path to the client certificate (PEM; may also contain the key)
  CYBERARK_CLIENT_KEY   path to the client private key (PEM; omit if bundled in the cert)
  CYBERARK_CA_BUNDLE    path to a CA bundle to verify the CCP server (omit → system trust store)
  CYBERARK_TIMEOUT      request timeout seconds (default 10)
  CYBERARK_CACHE_TTL    seconds to cache a fetched password in memory (default 300; 0 disables)

Swap ``get_password`` for your organisation's existing CyberArk helper if you already have one — the
callers only rely on this signature.
"""

from __future__ import annotations

import json
import os
import ssl
import time
import urllib.parse
import urllib.request

_CCP_URL = os.getenv("CYBERARK_CCP_URL", "").strip()
_APP_ID = os.getenv("CYBERARK_APP_ID", "").strip()
_SAFE = os.getenv("CYBERARK_SAFE", "").strip()
_CERT = os.getenv("CYBERARK_CLIENT_CERT", "").strip()
_KEY = os.getenv("CYBERARK_CLIENT_KEY", "").strip()
_CA = os.getenv("CYBERARK_CA_BUNDLE", "").strip()
_TIMEOUT = int(os.getenv("CYBERARK_TIMEOUT", "10") or "10")
_CACHE_TTL = int(os.getenv("CYBERARK_CACHE_TTL", "300") or "0")

# tiny in-memory TTL cache keyed by the request signature — avoids hammering the CCP within a run.
# Holds the secret only briefly; entries expire and are never persisted.
_cache: dict[str, tuple[float, str]] = {}


def is_configured() -> bool:
    """True when CyberArk retrieval is wired (a CCP URL and some AppID are present)."""
    return bool(_CCP_URL and (_APP_ID or True))  # AppID may be supplied per-request


def _cache_get(key: str) -> str | None:
    if _CACHE_TTL <= 0:
        return None
    hit = _cache.get(key)
    if hit and (time.time() - hit[0]) < _CACHE_TTL:
        return hit[1]
    _cache.pop(key, None)
    return None


def get_password(app_id: str = "", object_name: str = "", query: str = "", safe: str = "") -> str:
    """Fetch a password from the CyberArk CCP. ``app_id`` identifies which schema's credential is
    wanted (falls back to ``CYBERARK_APP_ID``). Provide either ``object_name`` (the account's Object
    name) or a free-form ``query``. Raises on any transport/parse failure — callers surface it."""
    if not _CCP_URL:
        raise RuntimeError("CYBERARK_CCP_URL is not configured.")
    params = {"AppID": app_id or _APP_ID}
    if not params["AppID"]:
        raise RuntimeError("No CyberArk AppID supplied (set CYBERARK_APP_ID or pass one per DB).")
    if safe or _SAFE:
        params["Safe"] = safe or _SAFE
    if object_name:
        params["Object"] = object_name
    if query:
        params["Query"] = query

    cache_key = json.dumps(params, sort_keys=True)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    url = f"{_CCP_URL}?{urllib.parse.urlencode(params)}"
    ctx = ssl.create_default_context(cafile=_CA or None)
    if _CERT:
        ctx.load_cert_chain(certfile=_CERT, keyfile=_KEY or None)
    with urllib.request.urlopen(urllib.request.Request(url), timeout=_TIMEOUT, context=ctx) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    secret = payload.get("Content", "")
    if not secret:
        raise RuntimeError("CyberArk returned no password (check AppID / Safe / Object).")
    if _CACHE_TTL > 0:
        _cache[cache_key] = (time.time(), secret)
    return secret
