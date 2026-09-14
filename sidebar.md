# Sidebar — advanced collapsible icon rail (CoreUI Angular)

A drop-in guide to replicate the OLS Dashboard sidebar in another CoreUI Angular app:

- **Expanded**: dark gradient sidebar, rounded nav pills, glowing active item with a left accent rail,
  **brand shows only the logo icon** (no wordmark).
- **Collapsed** (hamburger): a true **64px icon rail** that **never expands on hover**. Instead:
  - simple items show a **hover tooltip** (label bubble to the right),
  - parents with children (submenus) show a **hover flyout** panel listing the children,
  - section titles become thin dividers.
- All pop-outs appear **instantly** (no animation) → safe under `prefers-reduced-motion`.

> Stack: `@coreui/angular` (SidebarComponent + SidebarNav), `@coreui/icons-angular`, `ngx-scrollbar`
> (the `ng-scrollbar` around the nav). The rail is standalone-signals + zoneless friendly.

---

## 1. Behaviour & the non-obvious gotchas (read first)

The collapse uses CoreUI's **programmatic `narrow`** mode (`[narrow]` on `<c-sidebar>`), **not** the
`cSidebarToggle` `unfoldable` toggler — because `unfoldable` *expands the whole panel on hover*, which
fights the tooltip/flyout design. Key things that will bite you if you skip them:

1. **`toggle="narrow"` is NOT a valid `cSidebarToggle` value** (only `visible | unfoldable`). Drive
   `narrow` yourself with a signal + `[narrow]` binding, toggled by the hamburger via an `@Output`.
2. **The sidebar is `position: fixed`**, so CoreUI's narrow (which shrinks a *flex-basis*) leaves the
   width at `16rem`. Force the rail width by overriding the **variable** `--cui-sidebar-width` (CoreUI
   derives both the sidebar width and the content offset from it).
3. **`ng-scrollbar`'s viewport uses `contain: strict`**, which *paint-clips* descendants to its box even
   with `overflow: visible`. You must set **`contain: none`** (and `overflow: visible`) on the scroll
   containers in narrow mode, or tooltips/flyouts render but are invisible (clipped to the rail).
   Additionally, CoreUI's `.nav-link` itself has **`overflow: hidden`** — since the simple-item tooltip
   lives *inside* the link, you must also set `overflow: visible` on the rail's `.nav-link` (the flyout is
   fine because it lives in `.nav-group-items`, outside any link).
4. **CoreUI hides nav labels with `visibility:hidden; opacity:0`** (not just `display`), and collapses
   submenu groups with `height:0` too. The tooltip/flyout "show" rules must restore
   `display + visibility + opacity + height`.
5. **Simple items** wrap their label in `<c-sidebar-nav-link-content>` (an element you can `display:none`
   then reposition as a tooltip). **Group parents** render their label as a **bare text node** next to the
   icon — you can't `display:none` a text node, so collapse it with `font-size: 0` on the toggle.

---

## 2. Nav model — `_nav.ts`

Icons are CoreUI icon names; register them in your icon set (see §7). Children make an item a "parent"
(gets a flyout in the rail).

```ts
import { INavData } from '@coreui/angular';

export const navItems: INavData[] = [
  { name: 'Home', url: '/home', iconComponent: { name: 'cil-home' } },
  { title: true, name: 'Tools' },
  { name: 'Log Analytics Hub', url: '/log_analytics', iconComponent: { name: 'cil-list-numbered' } },
  {
    name: 'Config Ops Console', url: '/config_ops_console', iconComponent: { name: 'cil-spreadsheet' },
    children: [
      { name: 'OLS GROUP',  url: '/config_ops_console/group',  iconComponent: { name: 'cil-share-boxed' } },
      { name: 'OLS CIB',    url: '/config_ops_console/cib',    iconComponent: { name: 'cil-share-boxed' } },
      { name: 'OLS RETAIL', url: '/config_ops_console/retail', iconComponent: { name: 'cil-share-boxed' } }
    ]
  },
  {
    name: 'Infrastructure Pulse', url: '/infra_pulse', iconComponent: { name: 'cil-magnifying-glass' },
    children: [
      { name: 'Infrastructure Health', url: '/infra_pulse/infrastructure_health', iconComponent: { name: 'cil-chart-line' } },
      { name: 'Service Console',        url: '/infra_pulse/service_console',       iconComponent: { name: 'cil-terminal' } }
    ]
  },
  { name: 'Oracle Command Center', url: '/oracle_command_center', iconComponent: { name: 'cil-layers' } },
  { title: true, name: 'Administration' },
  { name: 'User Management', url: '/user_management', iconComponent: { name: 'cil-people' } }
];
```

---

## 3. Layout component

### `default-layout.component.ts` (the `narrow` state lives here)

```ts
import { Component, signal } from '@angular/core';
// ...other CoreUI + RouterOutlet imports as usual...

@Component({ /* selector, templateUrl, imports: [SidebarComponent, SidebarHeaderComponent,
  SidebarBrandComponent, SidebarNavComponent, SidebarFooterComponent, NgScrollbar, DefaultHeaderComponent, ...] */ })
export class DefaultLayoutComponent {
  readonly navItems = signal(navItems);           // (filter by RBAC if needed)

  /** Desktop collapse → a true icon RAIL (CoreUI `narrow`, never hover-expands). */
  readonly narrow = signal(false);
  toggleNarrow(): void { this.narrow.set(!this.narrow()); }
}
```

### `default-layout.component.html`

```html
<c-sidebar
  #sidebar1="cSidebar"
  class="d-print-none sidebar sidebar-fixed border-end"
  colorScheme="dark"
  id="sidebar1"
  [narrow]="narrow()"
  visible
>
  <c-sidebar-header class="border-bottom ols-sidebar-header">
    <c-sidebar-brand class="ols-brand" routerLink="/home">
      <span class="ols-brand__mark" aria-hidden="true">
        <img class="ols-brand__img" src="assets/logo.svg" alt="" />
      </span>
      <!-- wordmark is hidden by CSS in every state (icon-only brand); keep for a11y/expanded fallback -->
      <span class="sidebar-brand-full ols-brand__full">
        <span class="ols-brand__text">OLS<span class="ols-brand__accent"> DASHBOARD</span></span>
        <span class="ols-brand__sub">Operations Command Center</span>
      </span>
    </c-sidebar-brand>
  </c-sidebar-header>

  <ng-scrollbar pointerEventsMethod="scrollbar" visibility="hover">
    <c-sidebar-nav [navItems]="navItems()" dropdownMode="close" compact />
  </ng-scrollbar>

  <!-- version footer: horizontal pill when open; stacked (UI over API) in the collapsed rail (see CSS) -->
  <c-sidebar-footer class="border-top ols-sidebar-footer d-none d-lg-flex">
    <app-version />
  </c-sidebar-footer>
</c-sidebar>

<div class="wrapper d-flex flex-column min-vh-100">
  <app-default-header
    class="mb-4 d-print-none header header-sticky p-0 shadow-sm"
    position="sticky"
    sidebarId="sidebar1"
    (collapseToggle)="toggleNarrow()"
  />
  <div class="body flex-grow-1">
    <c-container [fluid]="true" class="h-auto px-4">
      <router-outlet />
    </c-container>
  </div>
  <app-default-footer />
</div>
```

---

## 4. Header component (the hamburger)

### `default-header.component.ts`

```ts
import { Component, output } from '@angular/core';
import { HeaderComponent } from '@coreui/angular';
// ...

export class DefaultHeaderComponent extends HeaderComponent {
  readonly sidebarId = input('sidebar1');
  /** Desktop hamburger → toggle the icon RAIL (the layout owns the `narrow` state). */
  readonly collapseToggle = output<void>();
}
```

### `default-header.component.html` (two togglers: desktop rail vs mobile off-canvas)

```html
<!-- Desktop: collapse to the icon rail (emits to the layout's narrow signal). -->
<button type="button" cHeaderToggler class="btn d-none d-lg-inline-flex"
        (click)="collapseToggle.emit()" aria-label="Collapse or expand sidebar">
  <svg cIcon name="cilMenu" size="lg"></svg>
</button>
<!-- Mobile / tablet: off-canvas show / hide (CoreUI's own toggler). -->
<button [cSidebarToggle]="sidebarId()" cHeaderToggler class="btn d-lg-none"
        toggle="visible" aria-label="Toggle sidebar navigation">
  <svg cIcon name="cilMenu" size="lg"></svg>
</button>
```

---

## 5. Styles — sidebar surface, brand, nav, and the icon rail

All of this is plain global SCSS keyed off `#sidebar1` (change the id to match your `<c-sidebar id="…">`).
Paste into a global stylesheet (e.g. `styles.scss` or an `_ols.scss` partial).

```scss
/* ---- Sidebar surface + brand ------------------------------------------------ */
#sidebar1 {
  background:
    radial-gradient(130% 55% at 0% 0%, rgba(124, 58, 237, 0.18), transparent 58%),
    linear-gradient(180deg, #141b30 0%, #0f1524 55%, #0b111e 100%);
  border-right: 1px solid rgba(255, 255, 255, 0.06);
  /* CoreUI's default nav icon is faint — brighten base icon/link colours */
  --cui-sidebar-nav-link-icon-color: rgba(255, 255, 255, 0.9);
  --cui-sidebar-nav-link-color: rgba(255, 255, 255, 0.8);
}
#sidebar1 .ols-brand__mark {
  box-shadow: 0 8px 20px -8px rgba(77, 93, 251, 0.85), inset 0 1px 0 rgba(255, 255, 255, 0.25);
}
/* Brand: the full wordmark shows when the panel is OPEN; only the COLLAPSED rail drops it (CoreUI hides
   .sidebar-brand-full in narrow) and centres the lone logo mark. */
#sidebar1.sidebar-narrow .ols-brand { justify-content: center; gap: 0; width: 100%; }

/* ---- Nav items: rounded pills, hover slide, glowing active + left accent ----- */
#sidebar1 .sidebar-nav .nav-link,
#sidebar1 .sidebar-nav .nav-group-toggle {
  position: relative; margin: 2px 8px; white-space: nowrap; border-radius: 10px;
  padding-block: 9px; padding-inline: 10px;
  transition: background 0.16s ease, color 0.16s ease, transform 0.16s ease;
}
#sidebar1 .sidebar-nav .nav-group-items .nav-link { padding-left: 30px; }   /* child indent */
#sidebar1 .sidebar-nav .nav-group-items .nav-icon { margin-left: 0; }
#sidebar1 .sidebar-nav .nav-link:hover,
#sidebar1 .sidebar-nav .nav-group-toggle:hover {
  background: rgba(255, 255, 255, 0.07); color: #fff; transform: translateX(3px);
}
#sidebar1 .sidebar-nav .nav-link .nav-icon,
#sidebar1 .sidebar-nav .nav-group-toggle .nav-icon {
  color: rgba(255, 255, 255, 0.9); transition: color 0.16s ease, transform 0.16s ease;
}
#sidebar1 .sidebar-nav .nav-link:hover .nav-icon { color: #8ab4ff; }
#sidebar1 .sidebar-nav .nav-link.active {
  background: linear-gradient(90deg, rgba(77, 93, 251, 0.32), rgba(35, 211, 163, 0.10) 92%); color: #fff;
}
#sidebar1 .sidebar-nav .nav-link.active .nav-icon { color: #8ab4ff; }
#sidebar1 .sidebar-nav .nav-link.active::before {           /* left accent rail (::before survives resets) */
  content: ""; position: absolute; left: 3px; top: 8px; bottom: 8px; width: 3px; border-radius: 3px;
  background: linear-gradient(180deg, #4d5dfb, #23d3a3); box-shadow: 0 0 10px rgba(77, 93, 251, 0.9);
}
#sidebar1 .sidebar-nav .nav-title {
  color: rgba(255, 255, 255, 0.42); font-size: 10px; font-weight: 700; letter-spacing: 1.6px;
  text-transform: uppercase; margin-top: 12px;
}

/* ==========================================================================
   COLLAPSED ICON RAIL (class `.sidebar-narrow`, set by [narrow]="narrow()").
   64px icons only; hover TOOLTIP for simple items; hover FLYOUT for parents.
   ========================================================================== */

/* Fixed sidebar → force the rail width via the width VARIABLE (drives width + content offset). */
#sidebar1.sidebar-narrow {
  --cui-sidebar-width: var(--cui-sidebar-narrow-width, 4rem) !important;
  width: var(--cui-sidebar-narrow-width, 4rem) !important;
  min-width: var(--cui-sidebar-narrow-width, 4rem) !important;
}

/* Let pop-outs escape scroll clipping. ng-scrollbar's viewport uses `contain: strict` which
   paint-clips descendants regardless of overflow — so drop `contain` too. (Few items → no scroll.) */
#sidebar1.sidebar-narrow .sidebar-nav,
#sidebar1.sidebar-narrow .ng-scroll-viewport-wrapper,
#sidebar1.sidebar-narrow .ng-scroll-viewport { overflow: visible !important; contain: none !important; }

/* Icons at full strength; strip pill margins/padding/radius so the icon centres in the rail. */
#sidebar1.sidebar-narrow .sidebar-nav .nav-icon { color: #fff; }
#sidebar1.sidebar-narrow .sidebar-nav .nav-link,
#sidebar1.sidebar-narrow .sidebar-nav .nav-group-toggle {
  margin: 0 !important; padding-left: 0 !important; padding-right: 0 !important;
  border-radius: 0 !important; transform: none !important; justify-content: center !important;
  overflow: visible !important;   /* CoreUI sets nav-link overflow:hidden → would clip the tooltip inside it */
}
#sidebar1.sidebar-narrow .sidebar-nav .nav-link.active::before { display: none; }

/* Hide labels in the rail. Simple items = <c-sidebar-nav-link-content> (display:none);
   group parents = a BARE TEXT NODE → collapse with font-size:0 (svg icon unaffected). */
#sidebar1.sidebar-narrow .sidebar-nav .nav-link c-sidebar-nav-link-content { display: none; }
#sidebar1.sidebar-narrow .sidebar-nav .nav-group-toggle { font-size: 0; }
#sidebar1.sidebar-narrow .sidebar-nav .nav-group-toggle::after { display: none !important; }  /* caret */
#sidebar1.sidebar-narrow .sidebar-nav .nav-group > .nav-group-items { display: none; }         /* collapse */
/* section titles → thin dividers */
#sidebar1.sidebar-narrow .sidebar-nav .nav-title {
  font-size: 0; height: 0; overflow: hidden; padding: 0; margin: 8px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.10);
}

/* pop-out anchor */
#sidebar1.sidebar-narrow .sidebar-nav .nav-item,
#sidebar1.sidebar-narrow .sidebar-nav .nav-group { position: relative; }

/* hover TOOLTIP (TOP-LEVEL simple item) — reuse its own hidden label as the bubble.
   MUST restore visibility + opacity (CoreUI hides labels with those, not just display).
   NOTE the `.sidebar-nav > .nav-item` DIRECT-CHILD scoping: flyout children are ALSO `.nav-item > .nav-link`,
   so without it a hovered child's label gets yanked out into a bubble (its name vanishes from the flyout).
   Children already show their label in the flyout, so they need no tooltip. */
#sidebar1.sidebar-narrow .sidebar-nav > .nav-item > .nav-link:hover c-sidebar-nav-link-content {
  display: block !important; visibility: visible !important; opacity: 1 !important;
  position: absolute; left: calc(100% + 10px); top: 50%; transform: translateY(-50%);
  padding: 6px 12px; white-space: nowrap; border-radius: 8px; z-index: 1200; pointer-events: none;
  background: #1a2234; color: #fff; font-size: 0.82rem; font-weight: 600; letter-spacing: 0.2px;
  border: 1px solid rgba(255, 255, 255, 0.10); box-shadow: 0 10px 28px rgba(4, 8, 20, 0.55);
}

/* hover FLYOUT (parent) — panel of children. Override CoreUI's accordion collapse
   (display:none + height:0 + visibility:hidden + opacity:0). */
#sidebar1.sidebar-narrow .sidebar-nav .nav-group:hover > .nav-group-items {
  display: block !important; visibility: visible !important; opacity: 1 !important;
  height: auto !important; overflow: visible !important;
  position: absolute; left: 100%; top: 0; z-index: 1200;
  box-sizing: border-box; min-width: 216px; padding: 6px; font-size: 1rem;
  background: #1a2234; border: 1px solid rgba(255, 255, 255, 0.10); border-radius: 10px;
  box-shadow: 0 18px 38px rgba(4, 8, 20, 0.6);
}
#sidebar1.sidebar-narrow .sidebar-nav .nav-group:hover > .nav-group-items c-sidebar-nav-link-content {
  display: inline !important; visibility: visible !important; opacity: 1 !important;
}
#sidebar1.sidebar-narrow .sidebar-nav .nav-group:hover > .nav-group-items .nav-link {
  justify-content: flex-start !important; gap: 10px; padding: 7px 10px !important; border-radius: 7px;
}
#sidebar1.sidebar-narrow .sidebar-nav .nav-group:hover > .nav-group-items .nav-icon { margin: 0 !important; }

/* rail: STACK the version footer (UI over API) so it fits the 64px rail — drop icon/divider/padding,
   shrink type. (Assumes an app-version pill with .appver / .appver__item / __ico / __div / __k / __v.) */
#sidebar1.sidebar-narrow .ols-sidebar-footer { padding-inline: 2px; }
#sidebar1.sidebar-narrow .ols-sidebar-footer .appver {
  flex-direction: column; align-items: center; gap: 1px; padding: 3px 2px; border-radius: 8px; max-width: 100%;
}
#sidebar1.sidebar-narrow .ols-sidebar-footer .appver__ico,
#sidebar1.sidebar-narrow .ols-sidebar-footer .appver__div { display: none; }
#sidebar1.sidebar-narrow .ols-sidebar-footer .appver__item { gap: 3px; }
#sidebar1.sidebar-narrow .ols-sidebar-footer .appver__k { font-size: 8px; letter-spacing: 0.3px; }
#sidebar1.sidebar-narrow .ols-sidebar-footer .appver__v { font-size: 9px; }

/* reduced-motion: no slides/transitions (pop-outs already appear instantly) */
@media (prefers-reduced-motion: reduce) {
  #sidebar1 .sidebar-nav .nav-link,
  #sidebar1 .sidebar-nav .nav-group-toggle,
  #sidebar1 .sidebar-nav .nav-icon { transition: none; }
  #sidebar1 .sidebar-nav .nav-link:hover,
  #sidebar1 .sidebar-nav .nav-group-toggle:hover { transform: none; }
}
```

---

## 6. Screen background (per-page) + content offset

The **page background** is set on `<body>` (light + dark). The main content is offset from the fixed
sidebar via CoreUI's `--cui-sidebar-occupy-start` (updates automatically with the sidebar width — including
the narrow rail). Each page wraps its content in `.ols-view`, and cards use `.ols-card`.

```scss
/* app background behind every page */
body { background-color: var(--cui-tertiary-bg); }

@include color-mode(dark) {           /* @use "@coreui/coreui/scss/mixins/color-mode" as *; */
  body { background-color: var(--cui-dark-bg-subtle); }
  .footer { --cui-footer-bg: var(--cui-body-bg); }
}

/* main content column: leaves room for the fixed sidebar (var tracks its width, incl. the rail) */
.wrapper {
  width: 100%;
  padding-inline: var(--cui-sidebar-occupy-start, 0) var(--cui-sidebar-occupy-end, 0);
  transition: padding .15s;
}

/* per-page scaffolding */
.ols-view { padding-bottom: 28px; }
.ols-view__head { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; flex-wrap: wrap; margin-bottom: 24px; }
.ols-view__title { font-size: 1.7rem; font-weight: 700; margin: 6px 0; line-height: 1.2; }
.ols-view__subtitle { color: var(--cui-secondary-color); margin: 0; max-width: 68ch; }

/* card surface used across pages (sits on the body background) */
.ols-card {
  background: var(--cui-body-bg);
  border: 1px solid var(--cui-border-color);
  border-radius: 16px;
  box-shadow: 0 1px 2px rgba(15, 23, 55, .04), 0 8px 24px rgba(20, 30, 80, .05);
  padding: 18px 20px;
}
```

> `--cui-tertiary-bg`, `--cui-dark-bg-subtle`, `--cui-body-bg`, `--cui-border-color` etc. are CoreUI theme
> tokens — override them in your theme if you want a different page background.

---

## 7. Register the icons

```ts
// app.config.ts (or a provider)
import { IconSetService } from '@coreui/icons-angular';
import { cilHome, cilNotes, cilSpreadsheet, cilShareBoxed, cilMagnifyingGlass, cilChartLine,
         cilTerminal, cilLayers, cilPeople, cilMenu /* … */ } from '@coreui/icons';

// provide IconSetService, then in the root component:
// this.iconSet.icons = { cilHome, cilNotes, cilSpreadsheet, cilShareBoxed, cilMagnifyingGlass,
//                        cilChartLine, cilTerminal, cilLayers, cilPeople, cilMenu };
```

---

## 8. Quick verification checklist

- Hamburger collapses to a **64px** rail (`#sidebar1` gets class `sidebar-narrow`, width 64).
- Rail shows **icons only** — no clipped label text, section titles are dividers, brand is icon-only.
- Hover a **simple** icon → tooltip label to the right (does not expand the panel).
- Hover a **parent** icon (Config Ops / Infra Pulse / Docs) → flyout panel of children, clickable.
- No horizontal scrollbar / layout jump on hover; content offset matches the 64px rail.
