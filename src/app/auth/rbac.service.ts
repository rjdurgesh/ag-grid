import { inject, Injectable, signal } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map, shareReplay, tap } from 'rxjs/operators';

import { ApiDataService } from '../shared/api-data.service';
import { API } from '../shared/api-endpoints';
import { UserRoles } from '../shared/models';
import { ALL_SCREENS, SALT_SCREENS, SCREEN_ROUTES, ScreenKey } from './rbac.config';

const NO_ROLES: UserRoles = { is_admin: false, is_read: false, is_salt: false };

/**
 * Central RBAC authority. Fetches the user's role flags once and answers
 * `canView` / `canWrite` per screen. Rules:
 *  - admin  → view all + act everywhere
 *  - read   → view all, no actions
 *  - salt   → view + act on SALT_SCREENS only (salt wins over read there)
 *  - none   → no access
 */
@Injectable({ providedIn: 'root' })
export class RbacService {
  private readonly api = inject(ApiDataService);

  readonly roles = signal<UserRoles>(NO_ROLES);

  private roles$?: Observable<UserRoles>;

  /** Fetch roles once (cached). Call before the first guard/nav evaluation. */
  ensureLoaded(): Observable<UserRoles> {
    if (!this.roles$) {
      this.roles$ = this.api.get<UserRoles>(API.auth.roles).pipe(
        map((r) => ({ is_admin: !!r?.is_admin, is_read: !!r?.is_read, is_salt: !!r?.is_salt })),
        catchError(() => of(NO_ROLES)),
        tap((r) => this.roles.set(r)),
        shareReplay(1)
      );
    }
    return this.roles$;
  }

  /** Drop the cached roles (on logout). */
  reset(): void {
    this.roles$ = undefined;
    this.roles.set(NO_ROLES);
  }

  private salt(): boolean {
    return this.roles().is_salt;
  }

  /** Can the user see this screen? */
  canView(screen: ScreenKey): boolean {
    const r = this.roles();
    if (r.is_admin || r.is_read) {
      return true;
    }
    if (r.is_salt) {
      return SALT_SCREENS.includes(screen);
    }
    return false;
  }

  /** Can the user take actions on this screen? (read never can; salt only on its screens) */
  canWrite(screen: ScreenKey): boolean {
    const r = this.roles();
    if (r.is_admin) {
      return true;
    }
    if (r.is_salt && SALT_SCREENS.includes(screen)) {
      return true;
    }
    return false;
  }

  /** Any access at all? False → send to the No-Access page. */
  hasAnyAccess(): boolean {
    const r = this.roles();
    return r.is_admin || r.is_read || r.is_salt;
  }

  /** First screen the user is allowed to open (for redirects). */
  firstAllowedRoute(): string | null {
    const screen = ALL_SCREENS.find((s) => this.canView(s));
    return screen ? SCREEN_ROUTES[screen] : null;
  }
}
