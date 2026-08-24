import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from '../../../auth/auth.service';
import { environment } from '../../../../environments/environment';

@Component({
  selector: 'app-no-access',
  templateUrl: './no-access.component.html',
  styleUrls: ['./no-access.component.scss'],
  imports: []
})
export class NoAccessComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly user = this.auth.user;
  readonly supportEmail = environment.supportEmail;

  logout(): void {
    this.auth.logout();
    if (!this.auth.ssoEnabled) {
      this.router.navigate(['/login']);
    }
  }
}
