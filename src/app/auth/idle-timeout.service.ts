import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from './auth.service';
import { SSO_CONFIG } from './sso.config';

/**
 * App-enforced INACTIVITY (idle) timeout — the one session timeout the app can control.
 *
 * The access-token lifetime is set by the identity provider and can't be extended from here; this is
 * a SEPARATE, app-side cap: after `SSO_CONFIG.idleTimeoutMinutes` with no user activity, the session
 * is ended and the user is sent to /login. Set the minutes to 0 to disable it (the default).
 *
 * Started once from the authenticated shell (DefaultLayoutComponent). Any of a small set of user
 * events resets the countdown; the reset is throttled so constant mousemove is cheap. The app is
 * zoneless, so these listeners don't trigger change detection.
 */
@Injectable({ providedIn: 'root' })
export class IdleTimeoutService {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  private timer?: ReturnType<typeof setTimeout>;
  private lastKick = 0;
  private started = false;

  /** Begin watching for inactivity. No-op if disabled (minutes ≤ 0) or already started. */
  start(): void {
    const minutes = SSO_CONFIG.idleTimeoutMinutes || 0;
    if (this.started || minutes <= 0) {
      return;
    }
    this.started = true;
    const ms = minutes * 60_000;
    const kick = () => this.onActivity(ms);
    ['click', 'keydown', 'mousemove', 'scroll', 'touchstart', 'visibilitychange']
      .forEach((ev) => window.addEventListener(ev, kick, { passive: true }));
    this.arm(ms);
  }

  private onActivity(ms: number): void {
    const now = Date.now();
    if (now - this.lastKick < 1000) {
      return;                       // throttle: reset the countdown at most once per second
    }
    this.lastKick = now;
    this.arm(ms);
  }

  private arm(ms: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.expire(), ms);
  }

  private expire(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.auth.logout();             // SSO: clears + provider/local logout; dummy: clears local session
    if (!this.auth.ssoEnabled) {
      this.router.navigate(['/login']);
    }
  }
}
