import { Directive, ElementRef, OnDestroy, OnInit, inject } from '@angular/core';

/**
 * Relocates the host element to `<body>` so a `position: fixed` overlay it contains escapes any ancestor
 * **stacking context** or `overflow`/`transform` on the way up the tree.
 *
 * Why this exists: a modal rendered deep inside a screen can be trapped below the app chrome. For example
 * `.ols-surface` (see `src/scss/_ols.scss`) gives its direct children `position: relative; z-index: 1` to
 * sit above its decorative grid — which creates a stacking context, so a `z-index: 1055` modal inside can
 * never rise above the fixed sidebar (z-index ~1035). Moving the overlay's wrapper to `<body>` removes it
 * from that context entirely (the same reason the app's shared modals live at `app-root`).
 *
 * Angular keeps rendering the element in place after the move, so `@if`, interpolation, and `(click)`
 * bindings all keep working; component-scoped styles still apply because the element keeps its
 * `_ngcontent-*` attribute. On destroy the element is detached from `<body>`.
 *
 * Usage: wrap the overlay(s) in a single always-present host and tag it — `<div appToBody>… @if(m()){…} …</div>`.
 */
@Directive({
  selector: '[appToBody]',
  standalone: true,
})
export class ToBodyDirective implements OnInit, OnDestroy {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  ngOnInit(): void {
    // Guard for non-browser/SSR just in case; this app is a browser SPA.
    if (typeof document !== 'undefined' && document.body) {
      document.body.appendChild(this.el.nativeElement);
    }
  }

  ngOnDestroy(): void {
    const node = this.el.nativeElement;
    node.parentNode?.removeChild(node);
  }
}
