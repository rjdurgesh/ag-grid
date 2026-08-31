# Documentation Center — Design & Architecture

> **Status:** **Phase 1 built & browser-verified** (frontend + dev mock + backend). Phases 2–3 pending.
> When fully built, this document folds into `GUIDE.md` (same as `UPLOAD_DESIGN.md` → `GUIDE.md §4`),
> and this standalone file is removed. A summary section already lives in `GUIDE.md §4`.
>
> **As built — deviations from the locked plan (all intentional, flagged for review):**
> 1. **Rendering:** Phase 1 ships a **dependency-free** `DocsRenderService` instead of
>    `markdown-it` + `DOMPurify` — same locked decision (client-side render + sanitize), but avoids the
>    npm/supply-chain step for a bank environment. It is *safe by construction* (escapes all source,
>    emits a fixed tag whitelist, validates URL schemes; raw HTML in a `.md` renders as text). The
>    public `render()` signature is stable, so swapping in the library later is a one-file change.
> 2. **Download raw:** done **client-side** (Blob from the already-fetched markdown), so the
>    `/api/docs/download` endpoint was **not** built — one fewer auth surface. Add it later only if a
>    server-streamed download is needed.
> 3. **Reader:** the catalogue + reader engine lives in a shared `DocsBrowserComponent` (a `selected`
>    signal toggles catalogue ↔ reader), not a standalone `doc-reader.component`.
> 4. **Two SEPARATE screens (per user request):** Docs is **two sidebar screens**, each its own
>    component/folder — **User Guide** (`/docs/user-guide`, screen key `docs`, `views/docs/user_guide/`)
>    and **Technical Guide** (`/docs/technical-guide`, screen key `docs_technical`,
>    `views/docs/technical_guide/`). Each holds **both** wiki links and markdown files for its audience,
>    sub-grouped into *Guides* + *Wikis & Runbooks*. **No tabs** — the guides are independent (an earlier
>    in-page tab switcher was removed at the user's request); switch via the sidebar. Both thin screen
>    components render the shared `DocsBrowserComponent` with `audience="user" | "technical"`, so a User
>    Guide can later grow its own tabs/sections without touching the Technical Guide.
> 5. **Grant-based access (per user request, replaces role-based v1):** both screens are opt-in `SCREEN`
>    grants (`docs` / `docs_technical`) — assignable per user from User Management. **ADMIN / full-access
>    sees both; a user with no docs grant sees no Docs at all** (the sidebar group is hidden and `/docs`
>    redirects away). `/docs` lands on the first guide the user can see. Grant plumbing reuses the
>    existing `SCREEN_KEYS` mechanism; backend `docs_api._docs_access` returns `(can_user, can_technical)`
>    from the caller's grants (ADMIN/`SCREEN */*` → both), and re-filters catalogue + content by grant.
> 6. **Folder-based audience + live real files (per user request):** audience is decided by the top-level
>    **subfolder** — `<base_dir>/user/*.md` → User Guide, `<base_dir>/technical/*.md` → Technical Guide
>    (else default technical; an `overrides` entry still wins). `base_dir` is a **backend** setting
>    (`backend/config/docs.json` / `DOCS_BASE_DIR`), not `environment.ts`. Local dev serves the real files
>    by running the backend + `'/api/docs': false` in `environment.ts` `apiMocks`. The docs screen now
>    wears the shared **`ols-surface`** background (matches other screens), and the card grid is
>    `minmax(240px, 1fr)` (denser, more columns on wide screens).
> 7. **Polish (per user request):** `base_dir` is set via **`DOCS_BASE_DIR` in `backend/.env`** (removed
>    from `docs.json`). Cards show the source **filename** (`DocEntry.file`, e.g. `RBAC_DESIGN.md`) and a
>    professional layout (type-icon chip, badge, filename, clamped title/description, tags, "Open →"
>    footer, hover accent bar). The open doc is **URL state** (`?doc=<id>`) so browser-Back returns to the
>    guide catalogue and doc links are shareable. Dropping a `.md` into `<base_dir>/user|technical/`
>    appears **immediately** (scanned per request — no restart; restart only for `docs.json`/`.env` changes).

## 1. Purpose & scope

Replace the single hardcoded external "Docs" link (`_nav.ts` → `https://coreui.io/angular/docs/`)
with a first-class **Documentation Center**: a searchable, categorized portal where users can

- open **wiki / runbook URLs** in a new tab, and
- read **local `.md` files** rendered in-app (GitHub-style),

organized into two audiences — **User docs** and **Technical docs**.

Out of scope for v1: editing docs in-app, versioning, comments, full-text server search.

## 2. Decisions (locked)

| Area | Decision | Rationale |
|------|----------|-----------|
| **RBAC** | **Grant-based** (updated per user request — see as-built note 5). Two opt-in `SCREEN` grants: `docs` (User Guide) + `docs_technical` (Technical Guide). ADMIN / full-access sees both; **no grant → Docs hidden entirely**. | Per-user control over each guide, assignable from User Management; a user with no assigned docs sees no Docs at all. |
| **MD discovery** | **Hybrid.** Auto-discover every `.md` under a configured base dir; `docs.json` supplies optional per-file overrides (title, description, audience, order, tags). | Drop a file in the folder → it appears. Polish metadata only when you want to. |
| **Rendering** | **Client-side + sanitize.** Backend returns raw markdown; Angular renders with `markdown-it` + **DOMPurify**. | Backend stays a thin, secure file server; presentation lives on the frontend. Sanitizing is defense-in-depth even for trusted docs. |

## 3. Content model

Every doc — wiki link or local file — is one catalog entry:

```ts
interface DocEntry {
  id: string;                       // opaque, stable id (used to fetch content; never a raw path)
  title: string;
  description?: string;
  type: 'wiki' | 'markdown';        // how it opens: external tab vs in-app reader
  audience: 'user' | 'technical';   // grouping + RBAC
  tags?: string[];
  updated?: string;                 // ISO date (from file mtime for md, or docs.json for wiki)
  // exactly one of:
  url?: string;                     // wiki
  // path is server-side only; the client references markdown docs by `id`
}
```

- `type` = *how you open it*: `wiki` → new tab (`target=_blank`, `rel="noopener noreferrer"`); `markdown` → in-app reader.
- `audience` = the **Technical vs User** split; drives both the UI grouping and RBAC filtering.
- The client **never** sees or sends a filesystem path — markdown is addressed by opaque `id` only.

## 4. Configuration (`backend/config/docs.json`)

Follows the existing `config_loader.py` convention (JSON → env → default; per-process cache — edit = restart backend). No secrets here.

```jsonc
{
  "base_dir": "D:\\ols\\docs",          // DOCS_BASE_DIR env fallback; where .md files live
  "wikis": [                            // external links (config-only, no file access)
    { "id": "wiki-batch-runbook", "title": "Batch Recovery Runbook",
      "description": "Step-by-step batch failure recovery.",
      "url": "https://wiki.internal/…", "audience": "user",
      "tags": ["runbook","batch"] }
  ],
  "overrides": {                        // optional metadata for discovered .md files, keyed by relpath
    "regression/regression-engine.md": {
      "title": "Regression Engine Internals", "audience": "technical",
      "description": "sqlplus engine, git pull, per-date roll.", "order": 10 }
  }
}
```

**Hybrid discovery:** the backend lists every `.md` under `base_dir` (recursively) via
`fs_browser.list_dir`. For each file it emits a `DocEntry`:
- `title` from the override, else the file's first `# heading`, else a title-cased filename;
- `audience` from the override, else default **`technical`** (safer default: hidden from regular users);
- `updated` from the file mtime; `id` = a hash/slug of the relpath.
Files needing no polish just appear. `wikis[]` are merged in as `type: 'wiki'`.

## 5. Backend (`backend/docs_api.py` — new thin router)

Mirror the existing router style (`sql_studio_api.py` / `config_api.py`); register in `app.py`
next to the others. **Reuse `backend/utils/fs_browser.py`** — do not hand-roll file handling:
`resolve_within_bases()` (path-traversal-safe), `list_dir()`, `read_file_all()`, `file_properties()`.

| Endpoint | Returns | Notes |
|----------|---------|-------|
| `GET /api/docs/catalog` | `DocEntry[]` (RBAC-filtered) | Merges `wikis[]` + discovered `.md`. Technical entries omitted for non-technical users. |
| `GET /api/docs/content?id=<id>` | `{ id, title, markdown, updated }` | Server maps `id`→path, validates with `resolve_within_bases()`, reads via `read_file_all()`. RBAC re-checked. |
| `GET /api/docs/download?id=<id>` | streamed `.md` | Optional "download raw", reuses the existing streamed-download pattern. |

**Security (every request):**
1. Reference by **opaque id**; resolve to a path server-side only; validate inside `base_dir` with `resolve_within_bases()`.
2. **Whitelist** served extensions (`.md`, plus referenced images if we later inline them).
3. **RBAC re-check on content fetch**, not just catalog — UI hiding is never the boundary.
4. Cap file size (reuse `read_file_all(max_bytes=…)`).

## 6. RBAC (role-based, v1)

- The **`docs` `ScreenKey` already exists** in `rbac.config.ts` (`ALL_SCREENS`, `SCREEN_ROUTES`) — reuse it.
- **Screen visibility:** Docs screen shown to any user with the `docs` screen (default: all authenticated users; adjustable in `rbac.config.ts`).
- **Audience gating:** the **catalog endpoint filters server-side** —
  - `user` docs → returned to everyone who can see Docs;
  - `technical` docs → returned only to admin / ops-admin / technical roles (from the existing access snapshot; no new grant type).
- Frontend also hides the Technical section when the snapshot shows no technical docs (cosmetic; the server is the real gate).
- **Upgrade path (v2, deferred):** promote `audience` to a docs sub-scope in `ols_app_access`
  (snapshot emits `docs: ['user','technical']`), exactly like regression scopes — only if per-user technical control is needed.

## 7. Frontend (`src/app/views/docs/` — new)

Standalone, signals, zoneless — consistent with existing screens. Reuse existing card/table styling
and dark-theme tokens. **Reduced-motion friendly** (office env has `prefers-reduced-motion` on):
static layout, no load animations.

**Routing:** add `/docs` to `app.routes.ts` (lazy `loadChildren`, `canActivate:[rbacGuard]`,
`data.screen:'docs'`). Update `screenForNavUrl` so `/docs` → `'docs'`. Replace the bottom
`_nav.ts` "Docs" external link with an internal `/docs` nav item (kept in the Documentation group).

**Components:**
- `docs.component` — portal shell (search + catalog).
- `doc-reader.component` — in-app markdown reader.
- `DocsService` — `catalog()` / `content(id)` signals over the API.
- `DocsRenderService` — `markdown-it` + **DOMPurify**; also extracts a heading tree for the TOC and adds heading anchors + code copy buttons. (Alternative: `ngx-markdown`; we prefer `markdown-it` for sanitize control.)

**UI — Catalog (landing):**
- Prominent **search box** (client-side filter over title / description / tags).
- Sections: **User Guides**, **Technical Docs**, **Wikis & Runbooks**.
- Each entry = a **card**: title, one-line description, **type badge** (📄 In-app / 🔗 Wiki), last-updated, tags.
  Wiki cards → external-link glyph, open new tab. Markdown cards → open the reader.

**UI — Reader (`.md`):**
- Centered **readable column (~70ch)**.
- Auto-generated **Table of Contents** (from headings), sticky on the side — the enterprise-wiki feel.
- Top bar: **breadcrumb** (Docs / Technical / *title*), last-updated, **Open raw / Download**, Back.
- **Anchored headings** (deep-link to a section), **syntax-highlighted code + copy buttons**, responsive (TOC collapses on mobile), dark-mode aware.

**Shared wiring:**
- `models.ts` — `DocEntry`, `DocContent`.
- `api-endpoints.ts` — a `docs.*` block.
- `mock-api.interceptor.ts` — canned catalog (a couple of wikis + sample md across both audiences) and sample markdown content, so it's fully demoable locally.

## 8. Dev / mock story

The interceptor answers `/api/docs/*` in-browser (no network), reading the access snapshot for
audience filtering — so `admin` sees Technical + User, a read-only scenario sees User only.
Fully walkable at `appEnv=DEV` with no backend.

## 9. File-by-file change map

**Backend**
- `backend/docs_api.py` — **new** router (catalog / content / download), reuses `utils/fs_browser.py`.
- `backend/config/docs.example.json` — **new** sample config.
- `backend/config_loader.py` — add `docs_config()`.
- `backend/app.py` — `include_router(docs_router)`.
- `backend/.env.example` — add `DOCS_BASE_DIR` (fallback for `docs.json.base_dir`).

**Frontend**
- `src/app/views/docs/{docs.component.ts/html/scss, doc-reader.component.ts/html/scss, docs.service.ts, docs-render.service.ts, route.ts}` — **new**.
- `src/app/app.routes.ts` — add `/docs` route.
- `src/app/auth/rbac.config.ts` — map `/docs` → `'docs'` in `screenForNavUrl`; set `SCREEN_ROUTES.docs='/docs'`.
- `src/app/layout/default-layout/_nav.ts` — replace external "Docs" link with internal `/docs`.
- `src/app/shared/models.ts` — `DocEntry`, `DocContent`.
- `src/app/shared/api-endpoints.ts` — `docs.*` block.
- `src/app/shared/mock-api.interceptor.ts` — mock `/api/docs/*`.
- `package.json` — add `markdown-it`, `dompurify`, `highlight.js` (+ types).

**Docs**
- `GUIDE.md` — new section (absorb this file on completion); `RBAC_DESIGN.md` — note the role-based docs audience gate.

## 10. Phasing

1. **MVP** — `/docs` screen, catalog endpoint (wikis + auto-discovered md), card landing, in-app reader with sanitized render; dev mock.
2. **Polish** — search, auto-TOC, syntax highlight + copy, download raw, last-updated.
3. **Hardening / future** — grant-based audience gating (only if needed), inline images, full-text search.

## 11. Security checklist (bank-internal)

- [ ] Opaque `id` → server-side path resolution via `resolve_within_bases()` (no client paths).
- [ ] Extension whitelist (`.md`); file-size cap.
- [ ] RBAC re-check on **catalog and content**; technical docs never sent to non-technical users.
- [ ] DOMPurify-sanitize all rendered markdown; disable/sanitize raw HTML.
- [ ] Wiki links `target=_blank rel="noopener noreferrer"`.
