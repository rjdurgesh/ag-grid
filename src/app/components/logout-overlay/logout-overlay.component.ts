import { Component, inject } from '@angular/core';

import { AuthService } from '../../auth/auth.service';

/**
 * Full-screen "Signing you out…" overlay, mounted once at app-root and shown while
 * {@link AuthService.loggingOut} is true. It sits above all app chrome so the user never sees the
 * half-cleared dashboard between clearing the session and landing on /login.
 *
 * Reduced-motion safe (the office environment runs with `prefers-reduced-motion`): the spinner and the
 * indeterminate bar become a calm static state instead of animating.
 */
@Component({
  selector: 'app-logout-overlay',
  standalone: true,
  template: `
    @if (auth.loggingOut()) {
      <div class="lo" role="alertdialog" aria-live="assertive" aria-busy="true" aria-label="Signing out">
        <div class="lo__card">
          <div class="lo__ring" aria-hidden="true"></div>
          <div class="lo__title">Signing you out…</div>
          <div class="lo__sub">Ending your secure session</div>
          <div class="lo__bar" aria-hidden="true"><span></span></div>
        </div>
      </div>
    }
  `,
  styles: [`
    .lo {
      position: fixed; inset: 0; z-index: 20000;
      display: flex; align-items: center; justify-content: center; padding: 1rem;
      background: color-mix(in srgb, #0b1020 62%, transparent);
      -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
      animation: lo-fade 160ms ease-out both;
    }
    .lo__card {
      display: flex; flex-direction: column; align-items: center; gap: 0.35rem;
      min-width: 260px; max-width: 90vw; padding: 1.8rem 2rem 1.6rem;
      border-radius: 18px;
      background: var(--cui-card-bg, #ffffff);
      border: 1px solid var(--cui-border-color, #e4e6ec);
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
      text-align: center;
    }
    .lo__ring {
      width: 46px; height: 46px; margin-bottom: 0.7rem; border-radius: 50%;
      border: 3px solid color-mix(in srgb, var(--cui-primary, #4d5dfb) 22%, transparent);
      border-top-color: var(--cui-primary, #4d5dfb);
      animation: lo-spin 0.8s linear infinite;
    }
    .lo__title {
      font-size: 1.02rem; font-weight: 700; letter-spacing: 0.01em;
      color: var(--cui-emphasis-color, #1a1a2e);
    }
    .lo__sub {
      font-size: 0.82rem; color: var(--cui-secondary-color, #6b7280);
    }
    .lo__bar {
      position: relative; width: 200px; max-width: 60vw; height: 4px; margin-top: 1rem;
      border-radius: 999px; overflow: hidden;
      background: color-mix(in srgb, var(--cui-primary, #4d5dfb) 16%, transparent);
    }
    .lo__bar > span {
      position: absolute; top: 0; bottom: 0; left: 0; width: 40%; border-radius: 999px;
      background: var(--cui-primary, #4d5dfb);
      animation: lo-slide 1.1s ease-in-out infinite;
    }
    @keyframes lo-fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes lo-spin { to { transform: rotate(360deg); } }
    @keyframes lo-slide {
      0% { left: -40%; } 50% { left: 60%; } 100% { left: 100%; }
    }

    /* Dark theme */
    :host-context([data-theme="dark"]) .lo__card,
    :host-context(.dark-theme) .lo__card { background: #10141f; border-color: #2b3245; }
    :host-context([data-theme="dark"]) .lo__title { color: #e6ebf5; }

    /* Reduced motion — no spin / no sliding bar; show a calm, complete-looking state. */
    @media (prefers-reduced-motion: reduce) {
      .lo { animation: none; }
      .lo__ring {
        animation: none;
        border-color: color-mix(in srgb, var(--cui-primary, #4d5dfb) 30%, transparent);
        border-top-color: var(--cui-primary, #4d5dfb);
      }
      .lo__bar > span { animation: none; left: 0; width: 100%; opacity: 0.85; }
    }
  `],
})
export class LogoutOverlayComponent {
  readonly auth = inject(AuthService);
}
