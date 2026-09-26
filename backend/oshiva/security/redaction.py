"""Central PII / secret redaction for OSHIVA.

Scrubs sensitive values out of a tool's result **before** it reaches the model or the audit log. OSHIVA
talks to a shared, self-hosted GPT-OSS and writes an append-only audit trail, so neither must ever receive
DB passwords, connection strings, API tokens, or personal data (names, email, username, GUID, account
number). See ``AI_PII_REDACTION.md``.

Defence in depth — TWO strategies, applied together:
  1. by KEY / COLUMN name — any dict key that *looks* sensitive has its VALUE replaced with a marker
     (regardless of the value's type), e.g. ``{"DB_PASSWORD": "..."} → {"DB_PASSWORD": "«redacted:secret»"}``.
  2. by VALUE pattern — free-text values that *look* like an email or an inline ``password=...`` are masked
     even when the key name is innocent (e.g. a connection string sitting in a "comment" column).

The strongest defence is still to **not fetch secrets at all** (e.g. ``get_config`` drops secret columns at
the source); this module is the safety net on top of that, and it covers EVERY tool — present and future —
because it's applied once, centrally, in ``agents/runner.py``.

Design notes:
  * The built-in key lists always apply; ``oshiva/redaction.json`` can only ADD to them, never shrink them,
    so a misconfiguration can't expose something.
  * Secret keys use aggressive SUBSTRING matching (a secret must never leak). PII keys use tighter matching
    so we don't redact useful, non-personal fields like ``HOST_NAME`` / ``APP_NAME``.
  * Redaction never raises: on any error it fails **closed** by returning the marker, never the raw value.
"""

from __future__ import annotations

import re
from typing import Any

import config_loader

# --- what counts as sensitive ------------------------------------------------
# SECRET: substring match on the normalised key (alnum-only, lowercased). Aggressive on purpose.
_SECRET_SUBSTRINGS: tuple[str, ...] = (
    "password", "passwd", "pwd", "secret", "token", "apikey", "credential", "cred",
    "privatekey", "dsn", "connectionstring", "connstr", "connection", "authorization", "bearer",
)
# PII: exact normalised key OR contains one of the "contains" markers. Tight, to avoid over-redaction.
_PII_EXACT: set[str] = {
    "firstname", "surname", "lastname", "middlename", "fullname",
    "email", "emailaddress", "username", "guid",
    "accountnumber", "accountno", "accountnum", "acctnumber", "acctno", "acctnum",
}
_PII_CONTAINS: tuple[str, ...] = (
    "email", "accountnumber", "acctno", "acctnumber", "guid", "firstname", "surname", "lastname",
)

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# inline secret assignment inside a free-text value, e.g. "...Password=hunter2;..." in a connection string.
_INLINE_SECRET_RE = re.compile(r"(?i)\b(password|pwd|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*[^\s;,'\"]+")


def _norm(key: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(key).lower())


def _cfg() -> dict:
    try:
        return config_loader.redaction_config()
    except Exception:  # noqa: BLE001 — config must never break redaction; use safe defaults
        return {"enabled": True, "placeholder": "[redacted]", "redact_values": True,
                "extra_secret_keys": [], "extra_pii_keys": []}


def _is_secret_key(norm: str, extra: set[str]) -> bool:
    return any(m in norm for m in _SECRET_SUBSTRINGS) or norm in extra


def _is_pii_key(norm: str, extra: set[str]) -> bool:
    return norm in _PII_EXACT or norm in extra or any(c in norm for c in _PII_CONTAINS)


def is_secret_key(name: Any) -> bool:
    """Public: does this column/field name look like a secret? Used by tools that want to DROP secret
    columns at the source (minimize) rather than rely only on value redaction."""
    extra = {_norm(k) for k in _cfg().get("extra_secret_keys", [])}
    return _is_secret_key(_norm(name), extra)


def _scrub_text(text: str, placeholder: str) -> str:
    """Mask value-level patterns (emails, inline secrets) inside a free-text string."""
    text = _INLINE_SECRET_RE.sub(f"{placeholder}", text)
    text = _EMAIL_RE.sub(f"{placeholder}:email", text)
    return text


def redact(obj: Any) -> Any:
    """Return a deep copy of ``obj`` with sensitive values masked. Safe on any JSON-like structure
    (dict / list / scalar). Never raises — on error it returns the marker rather than the original."""
    cfg = _cfg()
    if not cfg.get("enabled", True):
        return obj
    placeholder = str(cfg.get("placeholder", "[redacted]"))
    redact_values = bool(cfg.get("redact_values", True))
    secret_extra = {_norm(k) for k in cfg.get("extra_secret_keys", [])}
    pii_extra = {_norm(k) for k in cfg.get("extra_pii_keys", [])}

    def _walk(value: Any) -> Any:
        try:
            if isinstance(value, dict):
                out = {}
                for k, v in value.items():
                    nk = _norm(k)
                    if _is_secret_key(nk, secret_extra):
                        out[k] = f"{placeholder}:secret"
                    elif _is_pii_key(nk, pii_extra):
                        out[k] = f"{placeholder}:pii"
                    else:
                        out[k] = _walk(v)
                return out
            if isinstance(value, (list, tuple)):
                return [_walk(x) for x in value]
            if isinstance(value, str) and redact_values:
                return _scrub_text(value, placeholder)
            return value
        except Exception:  # noqa: BLE001 — fail closed
            return f"{placeholder}"

    return _walk(obj)
