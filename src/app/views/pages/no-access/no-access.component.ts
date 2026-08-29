import { Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from '../../../auth/auth.service';
import { RbacService } from '../../../auth/rbac.service';
import { environment } from '../../../../environments/environment';

@Component({
  selector: 'app-no-access',
  templateUrl: './no-access.component.html',
  styleUrls: ['./no-access.component.scss'],
  imports: []
})
export class NoAccessComponent {
  private readonly auth = inject(AuthService);
  private readonly rbac = inject(RbacService);
  private readonly router = inject(Router);

  readonly user = this.auth.user;
  readonly supportEmail = environment.supportEmail;

  /** Two distinct cases share this page:
   *  - `notProvisioned` (gate 1 fail) — the UID isn't an active OLS user at all.
   *  - otherwise — signed in as an active user, but no features are assigned. */
  readonly notProvisioned = computed(() => !this.rbac.snapshot().active);

  logout(): void {
    this.auth.logout();
    if (!this.auth.ssoEnabled) {
      this.router.navigate(['/login']);
    }
  }
}
