import { computed, inject, Injectable, signal } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map, shareReplay, tap } from 'rxjs/operators';

import { ApiDataService } from '../shared/api-data.service';
import { API } from '../shared/api-endpoints';
import { environment } from '../../environments/environment';
import { AccessRoleResponse, UserRoles } from '../shared/models';
import { USER_KEY } from './sso-auth.service';
import { ALL_SCREENS, SALT_SCREENS, SCREEN_ROUTES, ScreenKey } from './rbac.config';

const NO_ROLES: UserRoles = { is_admin: false, is_read: false, is_salt: false };

/** Access level + role label parsed out of the `{ ACCESS: ROLE }` response. */
interface ParsedRoles {
  flags: UserRoles;
  /** Access level, e.g. "ADMIN". */
  access: string;
  /** Role label, e.g. "OMT-BOTH". */
  role: string;
}

const NO_PARSED: ParsedRoles = { flags: NO_ROLES, access: '', role: '' };

/**
 * Parse `POST /api/auth/roles` → `{ ACCESS: ROLE }` (single entry). The key is the
 * access level (ADMIN / READ / SALT) which drives the RBAC flags; the value is the
 * role label shown on the profile card. Empty / unknown → no access.
 */
function parseRoles(res: AccessRoleResponse | null | undefined): ParsedRoles {
  const [entry] = res ? Object.entries(res) : [];
  if (!entry) {
    return NO_PARSED;
  }
  const [accessRaw, roleRaw] = entry;
  const access = (accessRaw ?? '').trim();
  const a = access.toUpperCase();
  return {
    flags: { is_admin: a === 'ADMIN', is_read: a === 'READ', is_salt: a === 'SALT' },
    access,
    role: (roleRaw ?? '').trim()
  };
}

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
  /** Access level from the roles API, e.g. "ADMIN". */
  readonly access = signal<string>('');
  /** Role label from the roles API, e.g. "OMT-BOTH". */
  readonly role = signal<string>('');
  /** Combined label for the profile card, e.g. "ADMIN | OMT-BOTH". */
  readonly roleLabel = computed(() => {
    const a = this.access();
    const r = this.role();
    return a && r ? `${a} | ${r}` : a || r;
  });

  private roles$?: Observable<UserRoles>;

  /** Fetch roles once (cached). Call before the first guard/nav evaluation. */
  ensureLoaded(): Observable<UserRoles> {
    if (!this.roles$) {
      this.roles$ = this.api
        .post<AccessRoleResponse>(API.auth.roles, { username: this.currentUsername() })
        .pipe(
          map((res) => parseRoles(res)),
          catchError(() => of(NO_PARSED)),
          tap((p) => {
            this.roles.set(p.flags);
            this.access.set(p.access);
            this.role.set(p.role);
          }),
          map((p) => p.flags),
          shareReplay(1)
        );
    }
    return this.roles$;
  }

  /** Drop the cached roles (on logout). */
  reset(): void {
    this.roles$ = undefined;
    this.roles.set(NO_ROLES);
    this.access.set('');
    this.role.set('');
  }

  /** UID of the signed-in user for the roles payload (falls back to the demo user). */
  private currentUsername(): string {
    try {
      const raw = localStorage.getItem(USER_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { username?: string };
        if (parsed?.username) {
          return parsed.username;
        }
      }
    } catch {
      /* ignore malformed storage */
    }
    return environment.username;
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
