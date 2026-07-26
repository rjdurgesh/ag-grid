import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

import { AuthService } from '../../../auth/auth.service';

/**
 * OLS Dashboard sign-in — a single SSO action.
 *
 * When `IS_SSO_ENABLED` is true it starts the OpenID Connect flow; when false it
 * establishes a local bypass session so a click signs the user straight in.
 */
@Component({
  selector: 'app-login',
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss']
})
export class LoginComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly ssoEnabled = this.auth.ssoEnabled;
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  private redirectTarget(): string {
    return this.route.snapshot.queryParamMap.get('redirect') ?? '/home';
  }

  async signIn(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const ok = await this.auth.signIn(this.redirectTarget());
      if (ok) {
        await this.router.navigateByUrl(this.redirectTarget());
      }
      // When SSO is enabled, the browser is already redirecting to the provider.
    } catch {
      this.error.set('Sign-in could not be started. Please try again.');
      this.loading.set(false);
    }
  }
}
