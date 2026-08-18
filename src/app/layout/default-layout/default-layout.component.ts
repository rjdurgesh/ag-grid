import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { NgScrollbar } from 'ngx-scrollbar';

import {
  ContainerComponent,
  INavData,
  ShadowOnScrollDirective,
  SidebarBrandComponent,
  SidebarComponent,
  SidebarFooterComponent,
  SidebarHeaderComponent,
  SidebarNavComponent
} from '@coreui/angular';

import { RbacService } from '../../auth/rbac.service';
import { screenForNavUrl } from '../../auth/rbac.config';
import { DefaultFooterComponent, DefaultHeaderComponent } from './';
import { navItems as NAV_ITEMS } from './_nav';

function isOverflown(element: HTMLElement) {
  return (
    element.scrollHeight > element.clientHeight ||
    element.scrollWidth > element.clientWidth
  );
}

@Component({
  selector: 'app-dashboard',
  templateUrl: './default-layout.component.html',
  styleUrls: ['./default-layout.component.scss'],
  imports: [
    SidebarComponent,
    SidebarHeaderComponent,
    SidebarBrandComponent,
    SidebarNavComponent,
    SidebarFooterComponent,
    ContainerComponent,
    DefaultFooterComponent,
    DefaultHeaderComponent,
    NgScrollbar,
    RouterOutlet,
    RouterLink,
    ShadowOnScrollDirective
  ]
})
export class DefaultLayoutComponent {
  private readonly rbac = inject(RbacService);

  /** Sidebar items filtered to what the user's roles allow (reactive). */
  readonly navItems = computed(() => filterNav(NAV_ITEMS, this.rbac));
}

/** Keep only nav entries the user can view; drop section titles left empty. */
function filterNav(items: INavData[], rbac: RbacService): INavData[] {
  const kept: INavData[] = [];

  for (const item of items) {
    if (item.children?.length) {
      const children = item.children.filter((c) => isNavAllowed(c, rbac));
      if (children.length) {
        kept.push({ ...item, children });
      }
      continue;
    }
    if (item.title) {
      kept.push(item); // resolved below
      continue;
    }
    if (isNavAllowed(item, rbac)) {
      kept.push(item);
    }
  }

  // Drop a title whose section has no following (non-title) items.
  return kept.filter((item, i) => {
    if (!item.title) {
      return true;
    }
    const next = kept[i + 1];
    return !!next && !next.title;
  });
}

function isNavAllowed(item: INavData, rbac: RbacService): boolean {
  const screen = screenForNavUrl(item.url as string | undefined);
  return screen ? rbac.canView(screen) : true;
}
