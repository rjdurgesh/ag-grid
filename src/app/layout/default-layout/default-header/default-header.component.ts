import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';

import {
  BreadcrumbRouterComponent,
  ColorModeService,
  ContainerComponent,
  DropdownComponent,
  DropdownItemDirective,
  DropdownMenuDirective,
  DropdownToggleDirective,
  HeaderComponent,
  HeaderNavComponent,
  HeaderTogglerDirective,
  ProgressComponent,
  SidebarToggleDirective
} from '@coreui/angular';

import { IconDirective } from '@coreui/icons-angular';

import { APP_ENV } from '../../../shared/api-endpoints';
import { ArrowStreamService } from '../../../shared/arrow-stream.service';
import { UserProfileComponent } from '../../../user_profile/user-profile.component';

@Component({
  selector: 'app-default-header',
  templateUrl: './default-header.component.html',
  imports: [ContainerComponent, HeaderTogglerDirective, SidebarToggleDirective, IconDirective, HeaderNavComponent, NgTemplateOutlet, BreadcrumbRouterComponent, DropdownComponent, DropdownToggleDirective, DropdownMenuDirective, DropdownItemDirective, ProgressComponent, UserProfileComponent]
})
export class DefaultHeaderComponent extends HeaderComponent {

  readonly #colorModeService = inject(ColorModeService);
  readonly colorMode = this.#colorModeService.colorMode;

  readonly #arrowStream = inject(ArrowStreamService);

  readonly colorModes = [
    { name: 'light', text: 'Light', icon: 'cilSun' },
    { name: 'dark', text: 'Dark', icon: 'cilMoon' },
    { name: 'auto', text: 'Auto', icon: 'cilContrast' }
  ];

  readonly icons = computed(() => {
    const currentMode = this.colorMode();
    return this.colorModes.find(mode => mode.name === currentMode)?.icon ?? 'cilSun';
  });

  /** Live header memory-usage feed (polls every 5s via the mock/real API). */
  readonly memory = toSignal(this.#arrowStream.memory(5000));

  /** Environment pill next to the theme switcher: PROD shows "LIVE", else the env. */
  readonly envLabel = APP_ENV === 'PROD' ? 'LIVE' : APP_ENV;
  readonly envClass = APP_ENV.toLowerCase();

  readonly memoryColor = computed(() => {
    const p = this.memory()?.percent ?? 0;
    return p >= 85 ? 'danger' : p >= 70 ? 'warning' : 'success';
  });

  constructor() {
    super();
  }

  readonly sidebarId = input('sidebar1');
}
