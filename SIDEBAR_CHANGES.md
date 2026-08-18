# Left Sidebar — Changes & Reusable CSS (CoreUI Angular)

A copy-paste reference for the sidebar/left-panel behaviour used in this app: collapse to an
**icon rail** (not full hide), **icon-only centered brand** when collapsed, a **premium look**
(gradient, pill nav, glowing active rail), and the **fix for faint icons in the collapsed rail**.

> Generalising to another project: this is a stock **CoreUI Angular** sidebar. The CSS is scoped
> to `#sidebar1` (the sidebar's `id`). Either give your sidebar `id="sidebar1"`, or replace
> `#sidebar1` with your id / `.sidebar`. The behaviour attributes (`toggle="unfoldable"`,
> `toggle="visible"`) and the `--cui-sidebar-*` variables are CoreUI built-ins.

---

## Files changed

| File | What changed |
|---|---|
| `src/app/layout/default-layout/default-header/default-header.component.html` | Split the header hamburger into **two responsive buttons**: desktop folds to an icon rail, mobile does off-canvas show/hide. |
| `src/app/layout/default-layout/default-layout.component.html` | Brand = **icon only** (removed the narrow wordmark span so the collapsed rail shows just the icon); **removed the redundant footer fold-toggle** (kept the tagline). |
| `src/app/layout/default-layout/default-layout.component.ts` | Removed now-unused CoreUI imports (`SidebarToggleDirective`, `SidebarTogglerDirective`, `IconDirective`) after the markup changes. |
| `src/scss/_ols.scss` | All the sidebar CSS below (brand tile, collapsed centering, gradient surface, pill nav + hover + active accent rail, **icon-visibility fix**, footer centering, reduced-motion). |

---

## 1. Header toggle — fold on desktop, off-canvas on mobile

`default-header.component.html` — one button per breakpoint:

```html
<!-- Desktop (≥lg): collapse the sidebar to an icon rail (never fully hidden) -->
<button [cSidebarToggle]="sidebarId()" cHeaderToggler class="btn d-none d-lg-inline-flex" toggle="unfoldable">
  <svg cIcon name="cilMenu" size="lg"></svg>
</button>
<!-- Mobile/tablet (<lg): off-canvas show / hide -->
<button [cSidebarToggle]="sidebarId()" cHeaderToggler class="btn d-lg-none" toggle="visible">
  <svg cIcon name="cilMenu" size="lg"></svg>
</button>
```

- `toggle="unfoldable"` → CoreUI's `.sidebar-narrow-unfoldable` (icon rail, expands on hover).
- `toggle="visible"` → off-canvas visibility (correct behaviour on mobile).
- `d-none d-lg-inline-flex` / `d-lg-none` are Bootstrap/CoreUI display utilities that pick the right one per screen size.

## 2. Brand markup (icon only when collapsed)

`default-layout.component.html` — the brand has **just the mark + the full wordmark**; there is
**no** narrow/`sidebar-brand-narrow` element, so when collapsed only the icon remains:

```html
<c-sidebar-brand class="ols-brand" routerLink="/home">
  <span class="ols-brand__mark"><img class="ols-brand__img" src="assets/your-icon.gif" alt="" /></span>
  <span class="sidebar-brand-full ols-brand__full">…full wordmark…</span>
</c-sidebar-brand>
```

Footer keeps only a tagline (no toggle button) so there's a single collapse control (the header one).

---

## 3. The CSS (`src/scss/_ols.scss`)

### 3a. THE FIX you asked about — faint icons in the collapsed rail
CoreUI's default sidebar nav-icon colour is `rgba(255,255,255,.38)` — fine next to a text label,
but too faint when the rail shows **icons only**. Brighten it via the CoreUI variables **and** a
direct rule:

```scss
#sidebar1 {
  /* brighten icons + link text so the collapsed icon-rail is legible */
  --cui-sidebar-nav-link-icon-color: rgba(255, 255, 255, 0.9);
  --cui-sidebar-nav-link-color: rgba(255, 255, 255, 0.8);
}
#sidebar1 .sidebar-nav .nav-link .nav-icon,
#sidebar1 .sidebar-nav .nav-group-toggle .nav-icon {
  color: rgba(255, 255, 255, 0.9);
}
/* Collapsed rail = icons only → render them at full strength */
#sidebar1.sidebar-narrow .sidebar-nav .nav-icon,
#sidebar1.sidebar-narrow-unfoldable:not(:hover) .sidebar-nav .nav-icon {
  color: #ffffff;
}
```

### 3b. Brand tile + icon image
```scss
.ols-brand__mark {
  display: inline-flex; align-items: center; justify-content: center;
  width: 40px; height: 40px; border-radius: 11px;
  background: #fff; overflow: hidden; padding: 2px; flex: 0 0 40px;
}
.ols-brand__img { width: 100%; height: 100%; object-fit: contain; display: block; }
#sidebar1 .ols-brand__mark {
  box-shadow: 0 8px 20px -8px rgba(77, 93, 251, 0.85), inset 0 1px 0 rgba(255, 255, 255, 0.25);
}
```

### 3c. Centre the brand icon when collapsed
```scss
.sidebar-narrow .ols-brand,
.sidebar-narrow-unfoldable:not(:hover) .ols-brand {
  justify-content: center; gap: 0; width: 100%;
}
.ols-sidebar-footer { align-items: center; justify-content: center; gap: 10px; }
```

### 3d. Premium surface
```scss
#sidebar1 {
  background:
    radial-gradient(130% 55% at 0% 0%, rgba(124, 58, 237, 0.18), transparent 58%),
    linear-gradient(180deg, #141b30 0%, #0f1524 55%, #0b111e 100%);
  border-right: 1px solid rgba(255, 255, 255, 0.06);
}
```

### 3e. Nav pills + hover + glowing active accent rail
```scss
#sidebar1 .sidebar-nav .nav-link,
#sidebar1 .sidebar-nav .nav-group-toggle {
  position: relative; margin: 2px 8px; border-radius: 10px;
  padding-block: 9px; padding-inline: 10px;   /* tighter side padding: the longest label ('Oracle Command Center') fits on ONE line */
  white-space: nowrap;   /* single line; the reduced margin+padding give it room so it doesn't overflow the pill */
  transition: background .16s ease, color .16s ease, transform .16s ease;
}
#sidebar1 .sidebar-nav .nav-link:hover,
#sidebar1 .sidebar-nav .nav-group-toggle:hover {
  background: rgba(255, 255, 255, .07); color: #fff; transform: translateX(3px);
}
#sidebar1 .sidebar-nav .nav-link:hover .nav-icon { color: #8ab4ff; }

#sidebar1 .sidebar-nav .nav-link.active {
  background: linear-gradient(90deg, rgba(77, 93, 251, .32), rgba(35, 211, 163, .10) 92%);
  color: #fff;
}
/* left accent rail as ::before so CoreUI's box-shadow reset can't wipe it */
#sidebar1 .sidebar-nav .nav-link.active::before {
  content: ""; position: absolute; left: 3px; top: 8px; bottom: 8px; width: 3px;
  border-radius: 3px; background: linear-gradient(180deg, #4d5dfb, #23d3a3);
  box-shadow: 0 0 10px rgba(77, 93, 251, .9);
}
#sidebar1 .sidebar-nav .nav-link.active .nav-icon { color: #8ab4ff; }

#sidebar1 .sidebar-nav .nav-title {
  color: rgba(255, 255, 255, .42); font-size: 10px; font-weight: 700;
  letter-spacing: 1.6px; text-transform: uppercase; margin-top: 12px;
}
```

### 3g. Collapsed rail — centre icons, no clipping (THE icon-position fix)
The expanded pill's side **margins/padding/radius/left-accent** shift and clip the icon inside the
~50px collapsed rail (icon shows half). Reset them in the collapsed state so CoreUI centres the icon:

```scss
#sidebar1.sidebar-narrow .sidebar-nav .nav-link,
#sidebar1.sidebar-narrow .sidebar-nav .nav-group-toggle,
#sidebar1.sidebar-narrow-unfoldable:not(:hover) .sidebar-nav .nav-link,
#sidebar1.sidebar-narrow-unfoldable:not(:hover) .sidebar-nav .nav-group-toggle {
  margin-left: 0 !important; margin-right: 0 !important;
  padding-left: 0 !important; padding-right: 0 !important;
  border-radius: 0 !important; transform: none !important;
  justify-content: center !important;   /* icon dead-centre whatever the rail width */
}
/* hide the left accent rail in the collapsed state (it'd sit at the edge) */
#sidebar1.sidebar-narrow .sidebar-nav .nav-link.active::before,
#sidebar1.sidebar-narrow-unfoldable:not(:hover) .sidebar-nav .nav-link.active::before {
  display: none;
}
```
> Root cause worth remembering: **any horizontal `margin`/`padding` you add to `.nav-link` for the
> expanded pill look will shift/clip the icon in CoreUI's narrow rail** — always reset them for
> `.sidebar-narrow` / `.sidebar-narrow-unfoldable:not(:hover)`.

### 3f. Reduced-motion fallback
```scss
@media (prefers-reduced-motion: reduce) {
  #sidebar1 .sidebar-nav .nav-link,
  #sidebar1 .sidebar-nav .nav-group-toggle,
  #sidebar1 .sidebar-nav .nav-icon { transition: none; }
  #sidebar1 .sidebar-nav .nav-link:hover,
  #sidebar1 .sidebar-nav .nav-group-toggle:hover { transform: none; }
}
```

---

**Minimum to reuse elsewhere:** section **3a** alone fixes faint collapsed-rail icons; add **1**
for the fold-on-desktop toggle; **3b–3f** are the visual polish.
