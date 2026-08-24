import { Directive, TemplateRef, ViewContainerRef, effect, inject, input } from '@angular/core';

import { RbacService } from './rbac.service';

/**
 * Structural directive that renders its content only when a **section** within a screen is allowed
 * for the user (ADMIN always; others unless an `ols_app_access` SECTION/DENY grant hides it).
 * Reactive — appears/disappears with the access snapshot.
 *
 * Usage: `<section *olsIfSection="{ screen: 'oracle_command_center', key: 'sql_intelligence' }"> … </section>`
 */
@Directive({ selector: '[olsIfSection]' })
export class IfSectionDirective {
  private readonly tpl = inject(TemplateRef<unknown>);
  private readonly vcr = inject(ViewContainerRef);
  private readonly rbac = inject(RbacService);

  readonly olsIfSection = input.required<{ screen: string; key: string; db?: string }>();

  private shown = false;

  constructor() {
    effect(() => {
      const s = this.olsIfSection();
      const can = this.rbac.sectionAllowed(s.screen, s.key, s.db);
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
