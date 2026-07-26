import { Component, inject, OnInit, signal } from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from './auth.service';

/**
 * Landing route for the OIDC redirect (`/auth/callback`). Completes the token
 * exchange, then navigates to the originally requested page. On failure it falls
 * back to the login page.
 */
@Component({
  selector: 'app-sso-callback',
  template: `
    <div class="sso-callback">
      <div class="sso-callback__spinner" aria-hidden="true"></div>
      <p class="sso-callback__text">{{ message() }}</p>
    </div>
  `,
  styles: [
    `
      .sso-callback {
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 16px;
        background: radial-gradient(1200px 600px at 50% -10%, #1b2440, #0b1020 60%);
        color: #e7ecf5;
      }
      .sso-callback__spinner {
        width: 46px;
        height: 46px;
        border-radius: 50%;
        border: 3px solid rgba(255, 255, 255, 0.15);
        border-top-color: #6b78ff;
        animation: sso-spin 0.9s linear infinite;
      }
      .sso-callback__text {
        margin: 0;
        font-size: 14px;
        color: #9aa4bd;
      }
      @keyframes sso-spin {
        to {
          transform: rotate(360deg);
        }
      }
    `
  ]
})
export class SsoCallbackComponent implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly message = signal('Completing secure sign-in…');

  async ngOnInit(): Promise<void> {
    try {
      const returnUrl = await this.auth.completeSsoLogin();
      await this.router.navigateByUrl(returnUrl);
    } catch {
      this.message.set('Sign-in could not be completed. Redirecting…');
      await this.router.navigate(['/login']);
    }
  }
}
