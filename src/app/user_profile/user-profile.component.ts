import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import {
  DropdownComponent,
  DropdownMenuDirective,
  DropdownToggleDirective
} from '@coreui/angular';

import { AuthService } from '../auth/auth.service';
import { formatDateTime } from '../shared/date-utils';

/**
 * Header account menu. Shows an initials avatar (no photos) with the signed-in
 * user's UID, email and role — the fields OpenID returns — plus the session
 * age and sign out. Self-contained so the header stays lean.
 */
@Component({
  selector: 'app-user-profile',
  templateUrl: './user-profile.component.html',
  styleUrls: ['./user-profile.component.scss'],
  imports: [DropdownComponent, DropdownToggleDirective, DropdownMenuDirective]
})
export class UserProfileComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  readonly user = this.auth.user;

  /** Ticks every 30s so the "signed in … ago" stays fresh. */
  private readonly now = signal(Date.now());

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  /** Up to two initials derived from the full name (falls back to the UID). */
  readonly initials = computed(() => {
    const name = this.user()?.displayName?.trim() || this.user()?.username || 'User';
    const parts = name.split(/\s+/).filter(Boolean);
    const letters = parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2);
    return letters.toUpperCase();
  });

  /** A stable hue from the name, so each user gets a consistent avatar colour. */
  readonly hue = computed(() => {
    const seed = this.user()?.username ?? this.user()?.displayName ?? 'ols';
    let h = 0;
    for (const ch of seed) {
      h = (h * 31 + ch.charCodeAt(0)) % 360;
    }
    return h;
  });

  /** Absolute login timestamp (for the tooltip / second line). */
  readonly loginAtText = computed(() => {
    const at = this.auth.loginAt;
    return at ? formatDateTime(at) : null;
  });

  /** Compact elapsed time since login, e.g. "5m", "7h 30m", "2d 3h". */
  readonly sinceLogin = computed(() => {
    const at = this.auth.loginAt;
    if (!at) {
      return null;
    }
    const ms = this.now() - new Date(at).getTime();
    const min = Math.floor(ms / 60_000);
    if (min < 1) {
      return 'just now';
    }
    if (min < 60) {
      return `${min}m ago`;
    }
    const hours = Math.floor(min / 60);
    const mins = min % 60;
    if (hours < 24) {
      return mins ? `${hours}h ${mins}m ago` : `${hours}h ago`;
    }
    const days = Math.floor(hours / 24);
    const hrs = hours % 24;
    return hrs ? `${days}d ${hrs}h ago` : `${days}d ago`;
  });

  logout(): void {
    this.auth.logout();
    // In SSO mode logout() already redirects via the provider; this covers bypass mode.
    if (!this.auth.ssoEnabled) {
      this.router.navigate(['/login']);
    }
  }
}
