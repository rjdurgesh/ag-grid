import { Directive, TemplateRef, ViewContainerRef, effect, inject } from '@angular/core';

import { RbacService } from './rbac.service';

/**
 * Structural directive that renders its content only for users who may take **technical
 * actions** — ADMIN access with an `OMT-TECHNICAL` / `OMT-BOTH` role (see
 * {@link RbacService.canActTechnical}). Used for Service Console start/stop; the Oracle
 * Command Center gates kill-session on the same rule. Reactive — appears/disappears with roles.
 *
 * Usage: `<button *olsCanAct …>Start</button>`
 */
@Directive({ selector: '[olsCanAct]' })
export class CanActDirective {
  private readonly tpl = inject(TemplateRef<unknown>);
  private readonly vcr = inject(ViewContainerRef);
  private readonly rbac = inject(RbacService);

  private shown = false;

  constructor() {
    effect(() => {
      const can = this.rbac.canActTechnical();
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
