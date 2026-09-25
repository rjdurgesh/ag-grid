# OSHIVA — Tool-level Authorization (component notes)

Implements the **"tools run as the user"** principle: OSHIVA can never surface estate data the caller
couldn't see in the UI. Before this, the RBAC gate only checked *"can you use OSHIVA at all"*; now each
tool also enforces *"can you see THIS business line (group / cib / retail)"*.

## The behaviour
A caller without CIB who asks "list the CIB Windows servers" gets a polite refusal, not the data:

> I can't access CIB data with your current permissions. You can query GROUP or RETAIL data.

And "list all servers" is **filtered** to only the scopes the caller may see. Verified live for both a
limited user (retail+group → CIB denied) and a full user (`*` → CIB shown).

## How it works
1. **Once per turn**, `oshiva.api.chat` computes the caller's allowed scopes:
   `scopes = scope_access.allowed_scopes(request, caller)` (`{"*"}` = all).
2. Those `scopes` are threaded through `agents.coordinator.run → agents.runner.run_agent_loop →
   tools.registry.run_tool`.
3. **Each scope-sensitive tool checks them** and either returns the data (filtered) or a denial dict
   `{"denied": true, "message": "…"}`, which the agent relays to the user.

Where a scope comes from:
- `list_servers(scope)` — the requested scope (or, with no scope, results are filtered to allowed scopes).
- `service_status(server)` — derived from the server name (`SRV-CIB-07` → cib).
- `blocking_sessions(db)` — derived from the db key (`cib_batch` → cib).

## Where "allowed scopes" is resolved (`oshiva/auth/scope_access.py`)
- **REAL mode** (`ACCESS_USE_DUMMY` off): from the caller's RBAC — full-access wildcard → all scopes; else
  the caller's Config-Ops scopes from `access_api.build_snapshot` (the estate-scope proxy). Fails **closed**
  (no scopes) on any RBAC error — never leaks on failure.
- **DEV / DUMMY mode**: from `config/assistant.json` — `dummy_scope_grants` (`{username: ["retail","group"]}`)
  falling back to `dummy_default_scopes` (default `["*"]`). This is how we demonstrate a real denial in dev.

## Config (`config/assistant.json`)
```jsonc
"dummy_default_scopes": ["*"],                       // every dev caller sees all, unless overridden
"dummy_scope_grants":  { "OPS-10432": ["retail", "group"] }   // this dev user has NO cib → CIB is refused
```
In production these are ignored — access comes from real RBAC grants.

## Two layers of access (recap)
| Layer | Question | Enforced by |
| --- | --- | --- |
| Screen gate | "May you use OSHIVA at all?" | `oshiva.auth.gate.is_allowed` (`SCREEN/assistant` + private-beta pin) |
| **Tool authz** | "May you see THIS business line's data?" | **`scope_access.allowed_scopes` + per-tool checks (this doc)** |

## Files
| File | Role |
| --- | --- |
| `backend/oshiva/auth/scope_access.py` | Resolves the caller's allowed scopes (RBAC in prod, config in dev) |
| `backend/oshiva/tools/registry.py` | Each tool enforces scopes; returns a `denied` message otherwise |
| `backend/oshiva/agents/runner.py`, `agents/coordinator.py` | Thread `scopes` into `run_tool` |
| `backend/oshiva/api.py` | Computes `scopes` once per turn |
| `backend/oshiva/llm/client.py` | Stub relays the `denied` message naturally |

## Next (when tools go fully real)
Replace the mock tool bodies with live Infra/OCC/Service calls that ALSO filter by the same `scopes`, so the
authorization holds against real data. The scope proxy (Config-Ops scopes) can be refined per tool (e.g.
server-scope grants for Infra) at that point.
