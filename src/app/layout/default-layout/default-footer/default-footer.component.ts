import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { FooterComponent } from '@coreui/angular';

import { ApiDataService } from '../../../shared/api-data.service';
import { API } from '../../../shared/api-endpoints';

@Component({
  selector: 'app-default-footer',
  templateUrl: './default-footer.component.html',
  styleUrls: ['./default-footer.component.scss']
})
export class DefaultFooterComponent extends FooterComponent {
  private readonly api = inject(ApiDataService);
  private readonly destroyRef = inject(DestroyRef);

  /** Configured database names, joined for display (e.g. "OLS1 | OLS2 | OLS3"). */
  readonly dbName = signal<string>('');

  constructor() {
    super();
    this.api
      .get<{ databases: string[] }>(API.system.database)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => this.dbName.set((res?.databases ?? []).join(' | ')));
  }
}
