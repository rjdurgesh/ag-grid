# AI_AUTHENTICATION — proving *who* is asking

**In one line:** *authentication* answers **"who are you?"** — it establishes the caller's real identity — as
opposed to *authorization* ("what may you do?", covered in [`AI_TOOL_AUTHZ.md`](AI_TOOL_AUTHZ.md)). Every
guardrail in OSHIVA (the access gate, per-line scopes, the audit log) is only as trustworthy as this identity,
so it must come from a source the user **cannot forge**.

> **Where it lives:** `backend/auth_token.py` (shared by the whole OLS app), used by OSHIVA in `oshiva/api.py`
> via `resolve_caller(...)`. The go-live guide is `AUTH_SETUP.md`; the SSO write-up is
> `OPENID_SSO_FLASK_GUIDE.md`.

---

## 1. The golden rule: identity from the token, never the body

A chat request carries a `caller` field in its JSON body. **We do not trust it.** If we did, anyone could type
someone else's username and inherit their access. Instead, the first line of every OSHIVA endpoint is:

```python
caller = resolve_caller(request, body.caller)   # ← the REAL identity; overrides the body
gate.require_assistant(request, caller)          # ← now safe to gate on it
```

`resolve_caller` returns the **validated** identity and we assign it back over `body.caller`, so the access
gate ([`gate.py`](../backend/oshiva/auth/gate.py)), the per-tool scopes, and the audit log all use the real
person — never a spoofable field. This is the same rule as "tool output is data, never instructions": **the
request body is data, never identity.**

---

## 2. How the identity is established (two modes)

`auth_token.py` has one switch — `validate_token` (`AUTH_VALIDATE_TOKEN`) — chosen per environment in
`config/oidc_config.yml` (dev/stg/prod section picked by `APP_ENV`):

### OIDC ON (production) — trust the token
`current_username(request)` reads the `Authorization: Bearer <jwt>` header and validates the JWT against the
bank's identity provider:

1. **Signature** — checked against the provider's JWKS (public keys), so a forged/edited token is rejected.
2. **Claims** — `iss` (issuer), `aud` (audience), `exp`/`iat` (not expired, with small clock-skew leeway).
3. **Identity** — the username is taken from a configured claim (`username_claim`, default
   `preferred_username`, falling back to `sub`) — the corporate UID that matches `ols_users.USERNAME`.

A missing/invalid token → **HTTP 401**. So calling `resolve_caller` at the top of an endpoint also *enforces*
authentication, not just reads it.

### OIDC OFF (dev/dummy) — no token
`current_username` returns `""`, so the caller falls back to `AUTH_DEV_USER` (a hardcoded debug identity, if
set) or finally the body's own username. This is why the whole app runs locally without PyJWT or an IdP — and
why, with SSO off, everyone shares one dummy identity. `jwt` is imported **lazily**, so the backend runs
without PyJWT until you turn OIDC on.

> **Precedence per value:** the matching env var (break-glass) → the YAML section for `APP_ENV` → a built-in
> default. Values are read once at import — restart after changing them.

---

## 3. Why "SSO off" matters for OSHIVA specifically

The OSHIVA access gate has a private-beta pin (`allowed_users: ["B27886"]`). That pin only *means* something
when the caller is the **real** person — i.e. **SSO on**. With SSO off the app can't tell developers apart
(one shared dummy identity), so the pin can't truly limit to one human; there, the master `enabled` switch
(and the per-machine config file) is the real gate. This is called out in `gate.py` and
[`AI_AGENT_DESIGN.md`](AI_AGENT_DESIGN.md). It's the honest limitation to remember when reasoning about "only
B27886 can use it."

---

## 4. Where authentication sits vs. the other gates

```
request → [ Authentication ]  who are you?         auth_token.resolve_caller (401 if bad token)
        → [ Authorization  ]  may you use OSHIVA?   oshiva/auth/gate.require_assistant (403)
        → [ Authorization  ]  which business line?  oshiva/auth/scope_access (per-tool filter/deny)
        → [ Edge           ]  how often?            oshiva/auth/rate_limit (429)   ← see AI_RATE_LIMIT.md
```

Four different questions, four different modules. Authentication is the foundation: get it wrong and the other
three are meaningless because they'd be deciding about the wrong person.

---

## Further reading (free)

- ⭐ **"OAuth 2.0 and OpenID Connect (in plain English)" — Okta / Nate Barbettini** (YouTube) — the clearest
  intro to what a token *is* and how the flow works.
- **jwt.io — "Introduction to JSON Web Tokens"** — anatomy of a JWT (header/payload/signature); paste a token
  to see its claims.
- **OWASP — Authentication Cheat Sheet** (cheatsheetseries.owasp.org) — do's/don'ts, incl. "never trust
  client-supplied identity", which is exactly our golden rule.
- Our own **`AUTH_SETUP.md`** (go-live steps) and **`OPENID_SSO_FLASK_GUIDE.md`** (the SSO integration), plus
  [`AI_TOOL_AUTHZ.md`](AI_TOOL_AUTHZ.md) (the *authorization* half).
