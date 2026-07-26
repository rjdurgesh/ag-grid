import { Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { IconDirective } from '@coreui/icons-angular';

/** A single router-driven tab. */
export interface TabItem {
  label: string;
  link: string | unknown[];
  icon?: string;
}

/**
 * Reusable, router-aware tab strip. Renders `<ng-content>` below the tabs so a
 * host can drop a `<router-outlet>` in for the active tab's content.
 */
@Component({
  selector: 'app-tabs',
  templateUrl: './tabs.component.html',
  styleUrls: ['./tabs.component.scss'],
  imports: [RouterLink, RouterLinkActive, IconDirective]
})
export class TabsComponent {
  readonly tabs = input<TabItem[]>([]);
}
