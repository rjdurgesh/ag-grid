import { Component, inject } from '@angular/core';

import { ButtonDirective } from '@coreui/angular';

import { ConfirmService } from './confirm.service';

/**
 * Confirmation prompt driven by {@link ConfirmService}, mounted once at app root.
 *
 * Deliberately NOT a CoreUI `c-modal`: when it shared CoreUI's modal/backdrop
 * machinery with the data grid modal, dismissing the confirm also collapsed the
 * underlying modal. This is a standalone fixed overlay layered above everything,
 * so it never touches another modal's state.
 */
@Component({
  selector: 'app-confirm',
  imports: [ButtonDirective],
  template: `
    @if (pending(); as p) {
      <div class="ols-confirm-backdrop" (click)="cancel()"></div>
      <div class="ols-confirm-box" role="alertdialog" aria-modal="true" aria-labelledby="olsConfirmTitle">
        <div class="ols-confirm-box__head">
          <span class="ols-confirm__icon" [class]="'ols-confirm__icon--' + (p.tone ?? 'primary')">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M12 8v5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              <circle cx="12" cy="16.6" r="1.2" fill="currentColor" />
              <path d="M10.3 3.9 2.6 17.4A2 2 0 0 0 4.3 20.4h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
                fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
            </svg>
          </span>
          <h5 id="olsConfirmTitle" class="ols-confirm__title">{{ p.title }}</h5>
        </div>

        <p class="ols-confirm__msg">{{ p.message }}</p>

        <div class="ols-confirm-box__actions">
          <button cButton color="secondary" variant="outline" size="sm" (click)="cancel()">
            {{ p.cancelLabel ?? 'Cancel' }}
          </button>
          <button cButton [color]="p.tone ?? 'primary'" size="sm" (click)="confirm()">
            {{ p.confirmLabel ?? 'OK' }}
          </button>
        </div>
      </div>
    }
  `,
  styleUrls: ['./confirm.component.scss']
})
export class ConfirmComponent {
  private readonly svc = inject(ConfirmService);
  readonly pending = this.svc.pending;

  confirm(): void {
    this.svc.accept();
  }

  cancel(): void {
    this.svc.dismiss();
  }
}
