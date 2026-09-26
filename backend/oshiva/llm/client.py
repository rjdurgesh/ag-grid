"""Model client for the OLS Assistant.

The agent loop (agents/runner.py) talks to the model ONLY through :func:`complete`, which returns either a final
text answer or a list of tool calls — the exact shape OpenAI-style tool-calling uses. That keeps the loop
identical whether the brain is the scaffold **stub** or the real **GPT-OSS** endpoint.

Scaffold: ``use_stub=True`` runs a deterministic planner that mimics a tool-using model (keyword routing +
result summarising) so the whole chat + tool pipeline works on a laptop with **no model**. When your
GPT-OSS details are known, implement :func:`_complete_real` (an OpenAI-compatible POST) and set
``use_stub=false`` — nothing else changes.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field


@dataclass
class LlmResponse:
    """Mirrors an OpenAI chat choice: EITHER final ``content`` OR ``tool_calls`` to run.
    ``usage`` carries token counts (from the real model's ``usage``, or estimated for the stub) so the turn
    can be costed and observed — see oshiva/observability/metrics.py."""
    content: str | None = None
    tool_calls: list[dict] = field(default_factory=list)   # [{id, name, arguments: dict}]
    usage: dict = field(default_factory=dict)              # {prompt_tokens, completion_tokens, total_tokens, estimated?}


def complete(messages: list[dict], tools: list[dict], cfg: dict) -> LlmResponse:
    """One model turn. ``messages`` is the running OpenAI-style transcript (system/user/assistant/tool);
    ``tools`` the schemas; ``cfg`` the assistant config."""
    if cfg.get("use_stub", True):
        resp = _complete_stub(messages, tools)
        if not resp.usage:                       # stub has no real token count → estimate one for cost/obs
            resp.usage = _estimate_usage(messages, resp)
        return resp
    return _complete_real(messages, tools, cfg)


def _estimate_tokens(text: str) -> int:
    """Very rough token estimate (~4 chars/token) — enough for stub-mode cost/observability, clearly flagged
    as an estimate. The real model returns exact counts in its ``usage``."""
    return max(1, len(text or "") // 4)


def _estimate_usage(messages: list[dict], resp: LlmResponse) -> dict:
    prompt = sum(_estimate_tokens(str(m.get("content") or "")) for m in messages)
    completion = _estimate_tokens(resp.content or json.dumps(resp.tool_calls, default=str))
    return {"prompt_tokens": prompt, "completion_tokens": completion,
            "total_tokens": prompt + completion, "estimated": True}


def describe(cfg: dict) -> str:
    return "stub-planner" if cfg.get("use_stub", True) else f"gpt-oss:{cfg.get('model')}"


# ===========================================================================
# STUB brain (scaffold only) — deterministic, no model required.
# ===========================================================================
def _complete_stub(messages: list[dict], tools: list[dict]) -> LlmResponse:
    # If the most recent tool result is present, summarise it into a final answer.
    last_tool = next((m for m in reversed(messages) if m.get("role") == "tool"), None)
    last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
    # Only treat a tool result as "fresh" if it came after the last user turn.
    if last_tool is not None and _after(messages, last_tool, last_user):
        return LlmResponse(content=_summarise(last_tool))

    text = (last_user or {}).get("content", "") if last_user else ""
    tl = text.lower()

    # --- keyword routing (the real model does this itself) ---
    # Agent-aware: only emit a call for a tool the CURRENT agent actually has (the coordinator already routed
    # to one agent, whose tools are in `tools`). This keeps the stub from asking for another agent's tool.
    have = {t.get("function", {}).get("name") for t in (tools or [])}

    # Oracle Command Center (read-only). Fires inside the database agent (it holds these tools).
    if have & {"blocking_sessions", "top_tables", "top_indexes", "unusable_indexes", "list_sessions", "sql_detail"}:
        if re.search(r"\b(kill|gather|rebuild|apply|refresh)\b", tl) or "compress" in tl or "collect stat" in tl:
            return LlmResponse(content=(
                "I can't kill sessions, gather stats, refresh materialized views, rebuild indexes, run "
                "compression, or apply SQL fixes from here — those are change actions. If you have access, "
                "use the [Oracle Command Center](/oracle_command_center) screen to perform them."))
        db = _parse_occ_db(text)   # OCC needs an EXACT db; the backend asks if this is ambiguous/missing
        sid = _parse_sql_id(text)
        # "show me the query / what SQL did you run" → ask the tool to surface the SQL (backend still write-gates it).
        want_sql = bool(re.search(r"\b(sql|query|queries)\b", tl)) and any(
            w in tl for w in ("show", "see", "what", "which", "actual", "raw", "run", "ran", "used", "give", "underlying"))

        def _occ_call(name: str, args: dict) -> LlmResponse:
            if want_sql:
                args["include_sql"] = True
            return _call(name, args)

        if "mviews" in have and ("mview" in tl or "materialized" in tl):
            return _occ_call("mviews", {"db": db, "stale": ("stale" in tl or "unstable" in tl)})
        if "sql_detail" in have and (sid or "sql_id" in tl or "explain" in tl):
            return _call("sql_detail", {"db": db, "sql_id": sid, "aspect": _parse_sql_aspect(tl)})
        if "unusable_indexes" in have and ("unusable" in tl or ("index" in tl and any(w in tl for w in ("health", "stale", "invisible")))):
            return _occ_call("unusable_indexes", {"db": db})
        if "top_indexes" in have and "index" in tl and any(w in tl for w in ("top", "large", "biggest", "utilized", "utilised", "consum")):
            return _occ_call("top_indexes", {"db": db})
        if "top_tables" in have and "table" in tl and any(w in tl for w in ("top", "large", "biggest", "consum", "highly")):
            return _occ_call("top_tables", {"db": db})
        if "list_sessions" in have and "session" in tl and "blocking" not in tl and "block" not in tl:
            args = {"db": db}
            if "active" in tl:
                args["status"] = "ACTIVE"
            elif "inactive" in tl:
                args["status"] = "INACTIVE"
            return _occ_call("list_sessions", args)
        if "blocking_sessions" in have and ("blocking" in tl or "block" in tl):
            return _occ_call("blocking_sessions", {"db": db})

    # Regression manifest GENERATORS (authoring; side-effect-free) — checked BEFORE the read-only status tools
    # so "generate a file-copy manifest" isn't stolen by the status fallback.
    if have & {"generate_filecopy_manifest", "generate_cleanup_manifest"}:
        kind_cleanup = ("cleanup" in tl or "clean up" in tl or "clean-up" in tl or "space clean" in tl)
        kind_filecopy = ("file copy" in tl or "filecopy" in tl or "file-copy" in tl
                         or ("copy" in tl and not kind_cleanup))
        trigger = any(w in tl for w in ("manifest", "sample", "template", "generate", "create")) or "json" in tl
        if trigger and (kind_cleanup or kind_filecopy):
            paths = _parse_paths(text)
            if kind_cleanup and "generate_cleanup_manifest" in have:
                return _call("generate_cleanup_manifest", {"items": [{"path": paths[0]}]} if paths else {})
            if "generate_filecopy_manifest" in have:
                args = {"items": [{"source": paths[0], "destination": paths[1]}]} if len(paths) >= 2 else {}
                return _call("generate_filecopy_manifest", args)

    # Regression (read-only status). Fires only inside the regression agent (it holds these tools).
    if have & {"regression_status", "regression_activity", "regression_batch_status",
               "regression_downstream_extract"}:
        if "regression_batch_status" in have and "batch" in tl:
            return _call("regression_batch_status", {"db": _parse_db(tl)})
        if "regression_downstream_extract" in have and ("downstream" in tl or "extract" in tl):
            args = {}
            if (d := _parse_date(text)):
                args["business_date"] = d
            return _call("regression_downstream_extract", args)
        if "regression_activity" in have and any(w in tl for w in ("who", "activity", "performing", "doing")):
            return _call("regression_activity", {})
        if "regression_status" in have:
            return _call("regression_status", {})

    # Config Ops: schema find / roll (write) checked BEFORE query_table (which fires on "lma"/"count").
    if "find_tables_with_column" in have and ("which table" in tl or "has column" in tl
                                              or ("find" in tl and "column" in tl)):
        return _call("find_tables_with_column", {"scope": _parse_scope(tl), "column": _parse_column(text)})
    if "export_config" in have and ("export" in tl or "download" in tl or "csv" in tl):
        args = {"scope": _parse_scope(tl), "table": _parse_table(text)}
        dates = re.findall(r"\d{4}-\d{2}-\d{2}", text)
        if len(dates) >= 2:
            args["date_from"], args["date_to"] = dates[0], dates[1]
        elif len(dates) == 1:
            args["business_date"] = dates[0]
        return _call("export_config", args)
    # roll_config is a WRITE — check it BEFORE query_table so an unambiguous "roll" intent isn't stolen by
    # query_table (whose match parser can fire on phrases like "for group").
    if "roll_config" in have and ("roll" in tl or "rollover" in tl):
        args = {"scope": _parse_scope(tl), "table": _parse_table(text)}
        dates = re.findall(r"\d{4}-\d{2}-\d{2}", text)
        if dates:
            args["from_date"] = dates[0]
            if len(dates) > 1:
                args["to_dates"] = dates[1:]
        if "confirm" in tl or tl.strip().startswith("yes"):
            args["confirm"] = True
        return _call("roll_config", args)
    # Config Ops: lookup / count / fetch data (query_table) → then describe / list / read (get_config).
    if "query_table" in have:
        mc, mv = _parse_match(text)
        is_count = any(w in tl for w in ("how many", "count", "number of rows"))
        if (is_count or mc or "lma" in tl or "lookup" in tl or "where " in tl
                or "data" in tl or "value" in tl or "fetch" in tl or "give me" in tl):
            args = {"scope": _parse_scope(tl), "table": _parse_table(text)}
            if is_count:
                args["count"] = True
            if mc:
                args["match_column"] = mc
            if mv:
                args["match_value"] = mv
            if (d := _parse_date(text)):
                args["business_date"] = d
            return _call("query_table", args)
    if ("config" in tl or "configuration" in tl) and have & {"describe_config_table", "list_config_tables", "get_config"}:
        scope = _parse_scope(tl)
        if "describe_config_table" in have and any(w in tl for w in ("column", "columns", "describe", "schema")):
            return _call("describe_config_table", {"scope": scope, "table": _parse_table(text)})
        if "list_config_tables" in have and "table" in tl and any(w in tl for w in ("list", "what", "which", "available")):
            return _call("list_config_tables", {"scope": scope})
        if "get_config" in have:
            args = {"scope": scope, "table": _parse_table(text)}
            if (d := _parse_date(text)):
                args["business_date"] = d
            return _call("get_config", args)

    if "list_shares" in have and ("share" in tl or "nas" in tl or "shares" in tl):
        args = {}
        if (s := _parse_scope(tl)):
            args["scope"] = s
        if (p := _parse_threshold(tl, "disk")) is not None or (p := _parse_threshold(tl, "share")) is not None:
            args["min_percent"] = p
        return _call("list_shares", args)
    # Service Console is READ-ONLY: refuse start/stop/restart and point to the screen (note: \bstop\b won't
    # match "stopped", so "which services are stopped" is still treated as a read).
    if "service_status" in have and re.search(r"\b(start|stop|restart)\b", tl) and ("service" in tl or _parse_server(text)):
        return LlmResponse(content=(
            "I can't start, stop, or restart services from here — that's a change action. Please use the "
            "[Service Console](/infra_pulse/service_console) screen to do it "
            "(Infrastructure Pulse → Service Console)."))
    if "service_status" in have and _parse_server(text) and any(w in tl for w in ("service", "status", "running", "stopped")):
        args = {"server": _parse_server(text)}
        if (st := _parse_svc_status(tl)):
            args["status"] = st
        return _call("service_status", args)
    if "list_services" in have and ("service" in tl or "services" in tl):
        args = {}
        if (s := _parse_scope(tl)):
            args["scope"] = s
        if (o := _parse_os(tl)):
            args["os"] = o
        if (st := _parse_svc_status(tl)):
            args["status"] = st
        return _call("list_services", args)
    if "list_servers" in have and ("server" in tl or "servers" in tl or "hosts" in tl or "drive" in tl
                                   or _parse_state(tl)):
        args: dict = {}
        if (s := _parse_scope(tl)):
            args["scope"] = s
        if (o := _parse_os(tl)):
            args["os"] = o
        if (r := _parse_threshold(tl, "ram")) is not None:
            args["min_ram_percent"] = r
        if (c := _parse_threshold(tl, "cpu")) is not None:
            args["min_cpu_percent"] = c
        if (dz := _parse_threshold(tl, "disk")) is not None:
            args["min_disk_percent"] = dz
        if (dv := _parse_drive(text)):
            args["drive"] = dv
        if (st := _parse_state(tl)):
            args["state"] = st
        return _call("list_servers", args)

    # Greetings / small talk (before the capability fallback).
    chat = _smalltalk(tl)
    if chat:
        return LlmResponse(content=chat)

    # No tool matched → a helpful capability message.
    return LlmResponse(content=(
        "I'm OSHIVA (preview). Right now I can:\n"
        "• list servers — e.g. \"list the CIB Windows servers\"\n"
        "• check service status on a server — e.g. \"service status on SRV-CIB-07\"\n"
        "• show blocking sessions on a database — e.g. \"blocking sessions on the CIB batch DB\"\n"
        "More is coming (knowledge search and data queries). What would you like?"))


def _call(name: str, arguments: dict) -> LlmResponse:
    return LlmResponse(tool_calls=[{"id": f"call_{name}", "name": name, "arguments": arguments}])


def _smalltalk(t: str) -> str | None:
    """Friendly canned replies for greetings / small talk (stub only). The REAL model handles this
    naturally — this just keeps the scaffold from feeling robotic."""
    if re.search(r"\b(hi|hello|hey|hiya|yo)\b|good\s*(morning|afternoon|evening)|greetings", t):
        return ("Hi! 👋 I'm OSHIVA, your OLS assistant. I can look up servers, service status and blocking "
                "sessions — what would you like to check?")
    if re.search(r"how\s*(are|r)\s*(you|u)|how'?s it going|how do you do|you doing", t):
        return "Running smoothly, thanks for asking! 🤖 Ask me about servers, service status or blocking sessions."
    if re.search(r"\b(thanks|thank you|thankyou|thx|ty|cheers|appreciate)\b", t):
        return "You're welcome! Anything else you'd like me to check?"
    if re.search(r"\b(bye|goodbye|see you|see ya|cya|good night)\b", t):
        return "Bye for now! 👋 I'm here whenever you need estate info."
    if re.search(r"who\s*(are|r)\s*(you|u)|your name|what are you|what'?s your name", t):
        return ("I'm OSHIVA — the OLS Hybrid Intelligence Virtual Assistant. I answer questions about the "
                "estate using live tools. Try: \"list the CIB Windows servers\".")
    return None


def _server_line(s: dict) -> str:
    """One server bullet. Tolerant of shapes: live Infra rows (name/scope/os/app + state/ram/cpu/disks when
    metrics were fetched) and any legacy row with a `role`."""
    meta = " / ".join(b for b in (str(s.get("scope", "")).upper(), s.get("os", ""), s.get("role", "")) if b)
    head = f"• **{s.get('name', '?')}**"
    if meta:
        head += f" — {meta}"
    st = s.get("state") or s.get("status")     # prefer health state when present
    if st:
        head += f" ({st})"
    extra = []
    if s.get("ram") is not None:
        extra.append(f"RAM {s['ram']}%")
    if s.get("cpu") is not None:
        extra.append(f"CPU {s['cpu']}%")
    if s.get("drive_percent") is not None:
        extra.append(f"{s.get('drive')} {s['drive_percent']}%")
    elif isinstance(s.get("disks"), dict):
        dparts = [f"{k} {v}%" for k, v in s["disks"].items() if v is not None]
        if dparts:
            extra.append("disk " + ", ".join(dparts))
    if extra:
        head += " · " + " · ".join(extra)
    return head


def _filter_phrase(filt: dict) -> str:
    """Human summary of which filters were applied, e.g. ' matching CIB, windows, RAM >= 70%'."""
    parts = []
    if filt.get("scope"):
        parts.append(str(filt["scope"]).upper())
    if filt.get("os"):
        parts.append(str(filt["os"]))
    if filt.get("min_ram_percent") is not None:
        parts.append(f"RAM >= {int(filt['min_ram_percent'])}%")
    if filt.get("min_cpu_percent") is not None:
        parts.append(f"CPU >= {int(filt['min_cpu_percent'])}%")
    if filt.get("min_disk_percent") is not None:
        drv = f"{filt.get('drive')} " if filt.get("drive") else ""
        parts.append(f"{drv}disk >= {int(filt['min_disk_percent'])}%")
    if filt.get("state"):
        parts.append(f"state={filt['state']}")
    return (" matching " + ", ".join(parts)) if parts else ""


def _occ_sql_suffix(data: dict) -> str:
    """Trailing SQL block for an OCC read result. The tool decides whether to include `query` (write user asked),
    `query_denied` (read-only user asked), or `query_note` (dummy env) — the summariser only renders what is set."""
    if data.get("query"):
        return f"\n\n_Query run:_\n```sql\n{data['query']}\n```"
    if data.get("query_denied"):
        return f"\n\n_{data['query_denied']}_"
    if data.get("query_note"):
        return f"\n\n_{data['query_note']}_"
    return ""


# Readable step labels for the regression summaries (mirrors the Regression screen / tools.regression).
_STEP_LABEL = {
    "refresh_db": "Refresh DB", "space_cleanup": "Server Space Cleanup", "apply_db": "Apply DB changes",
    "jenkins_deploy": "Jenkins deployment", "file_copy": "File copy", "reset": "Reset batches",
    "trigger": "Trigger batches", "git_pull": "Code pull",
}


def _summarise(tool_msg: dict) -> str:
    name = tool_msg.get("name", "")
    try:
        data = json.loads(tool_msg.get("content") or "{}")
    except Exception:
        data = {}
    if data.get("denied"):
        return data.get("message", "You don't have access to that.")
    if data.get("error"):
        return f"I couldn't complete that: {data['error']}"
    if data.get("needs_input"):     # tool needs a clarification (e.g. "which database?")
        return data.get("message", "I need a bit more detail to do that.")
    # Generic: a tool that returns an informational note (e.g. config in dummy mode, or a granted-tables list).
    # roll_config has richer data (source date + per-date counts) so it formats its own note.
    if data.get("note") and name not in ("list_servers", "service_status", "blocking_sessions",
                                          "roll_config", "export_config", "query_table",
                                          "generate_filecopy_manifest", "generate_cleanup_manifest"):
        gt = data.get("granted_tables")
        if gt:
            return "Config tables granted to you:\n" + "\n".join(f"• {t}" for t in gt) + f"\n\n{data['note']}"
        return data["note"]

    if name == "list_servers":
        servers = data.get("servers", [])
        crit = _filter_phrase(data.get("filters") or {})
        if not servers:
            return f"No servers{crit} matched." if crit else "No servers matched that filter."
        lines = [_server_line(s) for s in servers]
        return f"Found **{len(servers)}** server(s){crit}:\n" + "\n".join(lines)

    if name == "list_shares":
        shares = data.get("shares", [])
        crit = _filter_phrase(data.get("filters") or {})
        if not shares:
            return f"No shares{crit} matched." if crit else "No shares found."
        lines = []
        for s in shares:
            if not s.get("reachable"):
                lines.append(f"• **{s.get('name')}** — {str(s.get('scope', '')).upper()} — unreachable")
            else:
                lines.append(f"• **{s.get('name')}** — {str(s.get('scope', '')).upper()} — "
                             f"{s.get('used')}/{s.get('total')} {s.get('unit', 'GB')} "
                             f"({s.get('percent')}% used)")
        return f"Found **{len(shares)}** share(s){crit}:\n" + "\n".join(lines)

    if name == "service_status":
        if not data.get("found", True):
            return data.get("message", "No service data for that server.")
        if data.get("reachable") is False:
            return data.get("message", "The server's agent is unreachable.")
        svcs = data.get("services", [])
        filt = data.get("filters") or {}
        if not svcs:
            if filt.get("status") or filt.get("service"):
                what = " ".join(x for x in (filt.get("status"), filt.get("service")) if x)
                return f"No {what} services on **{data.get('server')}**."
            return data.get("message") or f"No services configured on {data.get('server')}."
        lines = [f"• **{s.get('service')}** — {s.get('status')}"
                 + (f" (since {s['since']})" if s.get("since") else "") for s in svcs]
        return f"Services on **{data.get('server')}**:\n" + "\n".join(lines)

    if name == "list_services":
        svcs = data.get("services", [])
        filt = data.get("filters") or {}
        crit = [x for x in (str(filt.get("scope") or "").upper(), filt.get("os"), filt.get("status")) if x]
        critstr = (" (" + ", ".join(crit) + ")") if crit else ""
        if not svcs:
            return f"No services matched{critstr}."
        lines = [f"• **{s.get('service') or '—'}** on {s.get('server')} — {s.get('status')}" for s in svcs[:30]]
        more = f"\n…and {len(svcs) - 30} more" if len(svcs) > 30 else ""
        return f"Found **{len(svcs)}** service(s){critstr}:\n" + "\n".join(lines) + more

    if name == "list_config_tables":
        gt = data.get("granted_tables")
        if gt:
            return "Config tables granted to you:\n" + "\n".join(f"• {t}" for t in gt)
        return data.get("note") or "No config tables to list."

    if name == "describe_config_table":
        cd = data.get("column_detail") or {}
        rows = cd.get("rows") or []
        if not rows:
            return data.get("note") or f"No column info for {data.get('table')}."
        return f"**{data.get('table')}** has {len(rows)} column(s)."

    if name == "get_config":
        cols = data.get("columns") or []
        rows = data.get("rows") or []
        if not cols and not rows:
            return data.get("note") or f"No rows found in {data.get('table')}."
        head = f"**{data.get('table')}** — {data.get('row_count', len(rows))} row(s)"
        if data.get("truncated"):
            head += " (showing the first " + str(len(rows)) + ")"
        if cols:
            head += "\nColumns: " + ", ".join(str(c) for c in cols)
        return head

    if name == "query_table":
        db = data.get("database")
        if "count" in data:
            s = f"**{data.get('table')}**" + (f" on `{db}`" if db else "") + f" — **{data['count']}** matching row(s)."
            if data.get("sql"):
                s += f"\n```sql\n{data['sql']}\n```"
            return s
        cols = data.get("columns") or data.get("cols") or []
        rows = data.get("rows") or []
        total = data.get("row_count", len(rows))
        if not rows:
            return data.get("note") or f"No matching rows in {data.get('table')}."
        head = f"**{data.get('table')}**" + (f" on `{db}`" if db else "") + f" — {total} row(s)"
        if data.get("preview") and total > data.get("preview"):
            head += f" (showing first {data['preview']})"
        parts = [head]
        if data.get("query"):
            parts.append(f"```sql\n{data['query']}\n```")
        parts.append(_ascii_table(cols, rows))
        if data.get("download_url"):
            parts.append(f"[Download all {total} rows (CSV)]({data['download_url']})")
        if data.get("note"):
            parts.append(f"_{data['note']}_")
        return "\n".join(parts)

    if name == "blocking_sessions":
        rows = data.get("blocking_sessions", [])
        if not rows:
            return f"No blocking sessions on **{data.get('database') or data.get('db')}** right now. ✅" + _occ_sql_suffix(data)
        cols = list(rows[0].keys())
        return f"**{len(rows)}** blocking session(s) on **{data.get('database') or data.get('db')}**:\n" + _ascii_table(cols, rows) + _occ_sql_suffix(data)

    if name == "top_tables":
        rows = data.get("top_tables", [])
        if not rows:
            return f"No table sizes returned for **{data.get('database') or data.get('db')}**." + _occ_sql_suffix(data)
        return f"Top tables on **{data.get('database') or data.get('db')}**:\n" + _ascii_table(["table", "size_gb"], rows) + _occ_sql_suffix(data)

    if name == "top_indexes":
        rows = data.get("top_indexes", [])
        if not rows:
            return f"No index sizes returned for **{data.get('database') or data.get('db')}**." + _occ_sql_suffix(data)
        return f"Top indexes on **{data.get('database') or data.get('db')}**:\n" + _ascii_table(["index", "table", "size_gb"], rows) + _occ_sql_suffix(data)

    if name == "unusable_indexes":
        rows = data.get("indexes", [])
        if not rows:
            return f"No {str(data.get('state', '')).lower()} indexes on **{data.get('database') or data.get('db')}**. ✅" + _occ_sql_suffix(data)
        return f"Index health on **{data.get('database') or data.get('db')}**:\n" + _ascii_table(["index", "table", "state", "detail"], rows) + _occ_sql_suffix(data)

    if name == "list_sessions":
        rows = data.get("sessions", [])
        if not rows:
            return f"No {str(data.get('status', '')).lower()} sessions on **{data.get('database') or data.get('db')}**." + _occ_sql_suffix(data)
        cols = list(rows[0].keys())
        return (f"**{len(rows)}** {str(data.get('status', '')).lower()} session(s) on **{data.get('database') or data.get('db')}**:\n"
                + _ascii_table(cols, rows[:30]) + _occ_sql_suffix(data))

    if name == "mviews":
        rows = data.get("mviews", [])
        if not rows:
            pre = "stale " if data.get("stale_only") else ""
            return f"No {pre}materialized views on **{data.get('database') or data.get('db')}**. ✅" + _occ_sql_suffix(data)
        cols = list(rows[0].keys())
        return f"Materialized views on **{data.get('database') or data.get('db')}**:\n" + _ascii_table(cols, rows) + _occ_sql_suffix(data)

    if name == "sql_detail":
        if data.get("download_url"):
            return (f"{data.get('label', 'Report')} for sql_id **{data.get('sql_id')}**: "
                    f"[Download]({data['download_url']})")
        aspect = data.get("aspect")
        if aspect == "overview":
            o = data.get("overview") or {}
            return (f"sql_id **{data.get('sql_id')}** — {o.get('verdict', 'overview')}: "
                    f"{o.get('plans', '?')} plan(s), {o.get('execs_5d', o.get('execs', '?'))} execs, "
                    f"avg {o.get('avg_elapsed_s', '?')}s.\n`{str(o.get('sql_text', ''))[:200]}`")
        rows = data.get("rows") or []
        if not rows:
            return f"No {aspect} data for sql_id {data.get('sql_id')}."
        keys = list(rows[0].keys())
        lines = ["• " + ", ".join(f"{k}={r.get(k)}" for k in keys) for r in rows[:15]]
        return f"{aspect} for sql_id **{data.get('sql_id')}**:\n" + "\n".join(lines)

    if name == "regression_status":
        run = data.get("run")
        if not run:
            return data.get("message") or "No regression run is currently open."
        s = (f"Regression run **{run.get('run_id')}** — {run.get('status')} "
             f"(started by {run.get('started_by')}, change {run.get('change_number')}).")
        cur = data.get("current_step")
        if cur:
            st = str(cur.get("state") or "").lower()
            sttxt = f" ({st})" if st and st != "pending" else ""
            s += f"\n**Currently on:** {cur.get('label')}{sttxt}."
        else:
            s += "\nAll steps complete. ✅"
        done, total = data.get("steps_done"), data.get("steps_total")
        if done is not None and total:
            s += f" Steps done: {done}/{total}."
        return s

    if name == "regression_batch_status":
        rows = data.get("rows") or []
        if not rows:
            return "No batch activity to report."
        lines = ["• " + " | ".join("" if c is None else str(c) for c in r) for r in rows[:20]]
        return "Batch status:\n" + "\n".join(lines)

    if name == "regression_downstream_extract":
        rows = data.get("rows") or []
        if not rows:
            bd = data.get("business_date")
            return "No downstream extract rows" + (f" for {bd}" if bd else "") + "."
        lines = [f"• {r.get('business_line')} — {r.get('filename')} "
                 f"({r.get('filerowcount')} rows) @ {r.get('post_dt')}" for r in rows[:20]]
        return "Downstream extract:\n" + "\n".join(lines)

    if name == "regression_activity":
        rows = data.get("rows") or []
        if not rows:
            return data.get("note") or "No recent regression activity."
        lines = []
        for r in rows[:12]:
            when = r.get("load_dt") or r.get("start_time") or ""
            step = _STEP_LABEL.get(str(r.get("step_key") or ""), r.get("step_key") or "")
            who = r.get("performed_by") or ""
            line = f"• {when} — {step}: {r.get('action', '')} — {r.get('status', '')}"
            if who:
                line += f" (by {who})"
            lines.append(line)
        more = f"\n…and {len(rows) - 12} more" if len(rows) > 12 else ""
        return f"Recent regression activity ({len(rows)}):\n" + "\n".join(lines) + more

    if name in ("generate_filecopy_manifest", "generate_cleanup_manifest"):
        url = data.get("download_url")
        kind = "file-copy" if data.get("kind") == "filecopy" else "server-cleanup"
        if not url:
            return data.get("note") or "I couldn't generate the manifest."
        head = (f"Here's a **sample {kind} manifest**" if data.get("sample")
                else f"Generated a **{kind} manifest** with {data.get('item_count')} item(s)")
        parts = [f"{head}: [Download JSON]({url})"]
        warns = data.get("warnings") or []
        if warns:
            parts.append("\n".join(f"⚠️ {w}" for w in warns))
        if data.get("note"):
            parts.append(f"_{data['note']}_")
        return "\n\n".join(parts)

    if name == "find_tables_with_column":
        tables = data.get("tables") or []
        if not tables:
            return data.get("note") or f"No tables found with a '{data.get('column')}' column."
        return f"Column **{data.get('column')}** is in: " + ", ".join(tables)

    if name == "export_config":
        url = data.get("download_url")
        if not url:
            return data.get("note") or "Nothing to export."
        s = f"Exported **{data.get('row_count', 0)}** row(s) of **{data.get('table')}**. [Download CSV]({url})"
        if data.get("note"):
            s += f"\n{data['note']}"
        return s

    if name == "roll_config":
        if data.get("confirm_required") or data.get("needs_input"):
            return data.get("message", "Please confirm the rollover before I proceed.")
        if data.get("executed"):
            targets = data.get("targets") or []
            lines = []
            for t in targets:
                if (t or {}).get("status") == "failed":
                    lines.append(f"• {t.get('date')} — failed ({t.get('error', '')})")
                else:
                    lines.append(f"• {t.get('date')} — {t.get('count', '?')} rows")
            src = data.get("source_date") or data.get("from_date")
            head = f"✅ Rolled **{data.get('table')}** using source date **{src}**"
            if data.get("source_count") is not None:
                head += f" ({data['source_count']} source rows)"
            out = head + " into:\n" + "\n".join(lines) if lines else head + "."
            if data.get("note"):
                out += f"\n{data['note']}"
            return out
        return data.get("message") or "Done."

    return "Done."


def _ascii_table(cols: list, rows: list[dict]) -> str:
    """A monospace, aligned table inside a fenced block — formatted and easy to copy."""
    cols = [str(c) for c in cols]
    widths = [len(c) for c in cols]
    body = []
    for r in rows:
        cells = ["" if r.get(c) is None else str(r.get(c)) for c in cols]
        for i, cell in enumerate(cells):
            widths[i] = max(widths[i], len(cell))
        body.append(cells)

    def _row(cells):
        return " | ".join(cell.ljust(widths[i]) for i, cell in enumerate(cells))

    sep = "-+-".join("-" * w for w in widths)
    return "```\n" + "\n".join([_row(cols), sep, *[_row(c) for c in body]]) + "\n```"


def _after(messages: list[dict], a: dict, b: dict | None) -> bool:
    """True if message ``a`` appears after message ``b`` in the transcript (identity comparison)."""
    if b is None:
        return True
    try:
        return messages.index(a) > messages.index(b)
    except ValueError:
        return True


def _parse_scope(t: str) -> str:
    for s in ("cib", "retail", "group"):
        if s in t:
            return s
    if "grp" in t:          # common abbreviation, e.g. grp_cost_center / grp_0001
        return "group"
    return ""


def _parse_os(t: str) -> str:
    if "windows" in t or "win " in t:
        return "windows"
    if "linux" in t or "unix" in t:
        return "linux"
    return ""


def _parse_threshold(t: str, kind: str) -> float | None:
    """Stub-only: pull a % threshold for RAM/CPU/disk out of text like 'ram over 70%', 'D drive more than
    40%', 'cpu above 80'. Only fires when the matching word is present. The REAL model extracts this from
    any phrasing — this keyword parse is a scaffold crutch."""
    words = {"ram": ("ram", "memory", "mem"), "cpu": ("cpu", "processor", "load"),
             "disk": ("disk", "drive", "storage"),
             "share": ("share", "nas", "full", "utilization", "utilisation", "storage")}[kind]
    if not any(w in t for w in words):
        return None
    m = re.search(r"(\d{1,3})\s*(?:%|percent|pct)", t)
    if not m:
        m = re.search(r"(?:over|above|more than|greater than|higher than|at least|>=?)\s*(\d{1,3})", t)
    return float(m.group(1)) if m else None


def _parse_drive(text: str) -> str:
    """Stub-only: pull a drive/mount out of 'D drive', 'drive C', 'C:', or a '/data' mount."""
    m = re.search(r"\b([a-zA-Z]):?\s*drive\b", text)
    if m:
        return m.group(1).upper()
    m = re.search(r"\bdrive\s+([a-zA-Z])\b", text, re.IGNORECASE)
    if m:
        return m.group(1).upper()
    m = re.search(r"(/[a-zA-Z0-9_]+)", text)
    return m.group(1) if m else ""


def _parse_svc_status(t: str) -> str:
    """Stub-only: a service status filter (running/stopped/unknown)."""
    if "stopped" in t:
        return "stopped"
    if "running" in t:
        return "running"
    if "unknown" in t:
        return "unknown"
    return ""


def _parse_state(t: str) -> str:
    """Stub-only: map health words to a state filter."""
    if "critical" in t:
        return "critical"
    if "warning" in t or "warn" in t:
        return "warning"
    if "unreachable" in t or "not reachable" in t or "offline" in t or re.search(r"\bdown\b", t):
        return "unreachable"
    if "healthy" in t or re.search(r"\bhealth\b", t):
        return "healthy"
    return ""


def _parse_server(text: str) -> str:
    m = re.search(r"SRV-[A-Za-z]+-\d+", text, re.IGNORECASE)
    if m:
        return m.group(0).upper()
    # Real hostnames like 'eurv12' — letters immediately followed by digits (won't match 'over 70').
    m = re.search(r"\b([A-Za-z]{2,}\d{1,4})\b", text)
    return m.group(1) if m else ""


def _parse_table(text: str) -> str:
    """Stub-only: pull a table name out of 'table EMP', 'EMP table', 'rows in EMP', or a bare UPPER_SNAKE
    token like OLS_PARAM. Best-effort — the real model reads the table name reliably."""
    _skip = {"for", "of", "in", "the", "name", "config", "data", "from", "to", "rows", "row", "roll",
             "cib", "retail", "group", "ols"}
    m = re.search(r"\btable\s+([A-Za-z][A-Za-z0-9_]{2,})", text, re.IGNORECASE)
    if m and m.group(1).lower() not in _skip:
        return m.group(1)
    m = re.search(r"\b([A-Za-z][A-Za-z0-9_]{2,})\s+table\b", text, re.IGNORECASE)
    if m and m.group(1).lower() not in _skip:
        return m.group(1)
    m = re.search(r"\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b", text)   # UPPER_SNAKE e.g. OLS_PARAM
    if m:
        return m.group(1)
    # "from EMP" / "in EMP" / "of EMP" — an uppercase-leading token after a preposition.
    m = re.search(r"\b(?:from|in|of|rows?\s+in)\s+([A-Z][A-Za-z0-9_]{1,})\b", text)
    return m.group(1) if m and m.group(1).lower() not in _skip else ""


def _parse_date(text: str) -> str:
    m = re.search(r"\b(\d{4}-\d{2}-\d{2})\b", text)
    return m.group(1) if m else ""


def _parse_paths(text: str) -> list[str]:
    """Stub-only: pull path-like tokens out of free text — 'D:/a', 'D:\\a', '//nas/x', '\\\\host\\x', '/data/x'.
    Lets 'copy A to B' / 'clean up X' build a one-item manifest without a model. GPT-OSS fills items itself."""
    return re.findall(r'[A-Za-z]:[\\/][^\s"\']+|//[^\s"\']+|\\\\[^\s"\']+|/[A-Za-z0-9_][^\s"\']*', text or "")


def _parse_column(text: str) -> str:
    """Stub-only: pull a column name out of 'column LMA_CODE' / 'has column lma_code' / a bare identifier."""
    m = re.search(r"\bcolumn\s+([A-Za-z_][A-Za-z0-9_]*)", text, re.IGNORECASE)
    if m:
        return m.group(1)
    m = re.search(r"\b([a-z_][a-z0-9_]*_[a-z0-9_]+)\b", text, re.IGNORECASE)   # snake_case token
    return m.group(1) if m else ""


def _parse_match(text: str):
    """Stub-only: pull a (column, value) filter out of 'where col = val', 'col is VALUE', or
    '... for lma_code IXLQA90'. Best-effort — the real model extracts this reliably."""
    for pat in (r"where\s+([a-z_][a-z0-9_]*)\s*=\s*'?([A-Za-z0-9_./-]+)'?",
                r"\b([a-z_][a-z0-9_]*)\s+(?:is|=)\s+'?([A-Za-z0-9_./-]{2,})'?",
                r"\bfor\s+([a-z_][a-z0-9_]*)\s+([A-Za-z0-9][A-Za-z0-9_./-]{1,})"):
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            return m.group(1), m.group(2)
    return None, None


def _parse_occ_db(text: str) -> str:
    """Stub-only: extract a DB phrase for OCC; the backend canonicalises or asks if ambiguous."""
    t = text.lower()
    for ph in ("cib batch", "cib reporting", "retail batch", "retail reporting", "group",
               "cib_batch", "cib_reporting", "retail_batch", "retail_reporting"):
        if ph in t:
            return ph
    if "cib" in t:
        return "cib"
    if "retail" in t:
        return "retail"
    return ""


def _parse_sql_id(text: str) -> str:
    """Stub-only: pull a sql_id from 'sql_id 8gk2m1p4q7xza' or a bare 13-char alnum token."""
    m = re.search(r"sql[_ ]?id\s*[:=]?\s*([0-9a-z]{6,20})", text, re.IGNORECASE)
    if m:
        return m.group(1)
    m = re.search(r"\b([0-9a-z]{13})\b", text)
    return m.group(1) if m else ""


def _parse_sql_aspect(t: str) -> str:
    if "plan" in t or "explain" in t:
        return "plan"
    if "monitor" in t:
        return "monitor"
    if "perf" in t or "performance" in t:
        return "performance"
    if "wait" in t or "ash" in t:
        return "waits"
    if "bind" in t:
        return "binds"
    return "overview"


def _parse_db(t: str) -> str:
    if "report" in t or "reporting" in t:
        return "cib_reporting"
    if "batch" in t or "cib" in t:
        return "cib_batch"
    m = re.search(r"\b([a-z]+_[a-z]+)\b", t)
    return m.group(1) if m else ""


# ===========================================================================
# REAL brain — self-hosted GPT-OSS over an OpenAI-compatible endpoint.
# ===========================================================================
def _endpoint(base_url: str) -> str:
    """Build the chat-completions URL from whatever form of base the operator configured."""
    base = (base_url or "").strip().rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    if base.endswith("/v1"):
        return base + "/chat/completions"
    return base + "/v1/chat/completions"


def _complete_real(messages: list[dict], tools: list[dict], cfg: dict) -> LlmResponse:
    """One turn against the private GPT-OSS endpoint (OpenAI-compatible ``/v1/chat/completions`` with native
    tool-calling). Configure via .env: ASSISTANT_BASE_URL / ASSISTANT_MODEL / ASSISTANT_API_KEY /
    ASSISTANT_TIMEOUT, and ASSISTANT_USE_STUB=false. Returns the same LlmResponse shape as the stub, so the
    agent loop is unchanged. Raises on a bad config / HTTP error → the loop surfaces it as an error event."""
    base_url = cfg.get("base_url") or ""
    if not base_url:
        raise NotImplementedError(
            "The real model is on (use_stub=false) but ASSISTANT_BASE_URL is empty. Set the GPT-OSS endpoint "
            "in .env (ASSISTANT_BASE_URL / ASSISTANT_MODEL / ASSISTANT_API_KEY), or set ASSISTANT_USE_STUB=true.")
    import httpx  # lazy: only needed in real mode

    headers = {"Content-Type": "application/json"}
    api_key = (cfg.get("api_key") or "").strip()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    payload: dict = {
        "model": cfg.get("model"),
        "messages": messages,
        "temperature": cfg.get("temperature", 0.1),
    }
    if tools:                                   # let the model choose when to call a tool
        payload["tools"] = tools
        payload["tool_choice"] = "auto"

    try:
        timeout = float(cfg.get("timeout", 60))
    except (TypeError, ValueError):
        timeout = 60.0
    resp = httpx.post(_endpoint(base_url), json=payload, headers=headers, timeout=timeout)
    resp.raise_for_status()
    body = resp.json()
    choice = ((body.get("choices") or [{}])[0]).get("message", {}) or {}

    tool_calls = []
    for c in (choice.get("tool_calls") or []):
        fn = c.get("function", {}) or {}
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except (TypeError, ValueError):
            args = {}
        tool_calls.append({"id": c.get("id") or f"call_{fn.get('name')}",
                           "name": fn.get("name"), "arguments": args})
    usage = body.get("usage") or {}             # exact token counts from the endpoint (for cost/observability)
    return LlmResponse(content=choice.get("content"), tool_calls=tool_calls, usage=usage)
