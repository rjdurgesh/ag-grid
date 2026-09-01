import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { ApiDataService } from '../../shared/api-data.service';
import { API } from '../../shared/api-endpoints';
import { environment } from '../../../environments/environment';

/**
 * Compact UI + backend version indicator (a small pill). UI version is a build-time constant
 * (`environment.uiVersion`); the API version is fetched from the running backend
 * (`GET /api/system/version` → set by `APP_VERSION` in backend/.env). Styled for the dark sidebar
 * footer, but self-contained so it can be dropped anywhere.
 */
@Component({
  selector: 'app-version',
  templateUrl: './app-version.component.html',
  styleUrl: './app-version.component.scss'
})
export class AppVersionComponent {
  private readonly api = inject(ApiDataService);
  private readonly destroyRef = inject(DestroyRef);

  /** UI version — bump in environment.ts. */
  readonly uiVersion = environment.uiVersion;
  /** Backend version — bump via APP_VERSION in backend/.env. */
  readonly apiVersion = signal<string>('');

  constructor() {
    this.api
      .get<{ version: string }>(API.system.version)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => this.apiVersion.set(res?.version ?? ''));
  }
}
