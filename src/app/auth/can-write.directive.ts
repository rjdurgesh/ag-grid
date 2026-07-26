import { Directive, TemplateRef, ViewContainerRef, effect, inject, input } from '@angular/core';

import { ScreenKey } from './rbac.config';
import { RbacService } from './rbac.service';

/**
 * Structural directive that renders its content only when the user may take
 * actions on the given screen. Reactive — it appears/disappears if roles change.
 *
 * Usage: `<button *olsCanWrite="'service_console'" …>Start</button>`
 */
@Directive({ selector: '[olsCanWrite]' })
export class CanWriteDirective {
  private readonly tpl = inject(TemplateRef<unknown>);
  private readonly vcr = inject(ViewContainerRef);
  private readonly rbac = inject(RbacService);

  readonly olsCanWrite = input.required<ScreenKey>();

  private shown = false;

  constructor() {
    effect(() => {
      const can = this.rbac.canWrite(this.olsCanWrite());
      if (can && !this.shown) {
        this.vcr.createEmbeddedView(this.tpl);
        this.shown = true;
      } else if (!can && this.shown) {
        this.vcr.clear();
        this.shown = false;
      }
    });
  }
}
