import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs/operators';

import { ScreenKey } from './rbac.config';
import { RbacService } from './rbac.service';

/**
 * Blocks a route the user's roles don't permit. Reads the target screen from
 * `route.data.screen`. Redirects to the first allowed screen, or the No-Access
 * page when the user has no roles at all.
 */
export const rbacGuard: CanActivateFn = (route) => {
  const rbac = inject(RbacService);
  const router = inject(Router);
  const screen = route.data['screen'] as ScreenKey | undefined;

  return rbac.ensureLoaded().pipe(
    map(() => {
      if (!rbac.hasAnyAccess()) {
        return router.createUrlTree(['/no-access']);
      }
      if (!screen || rbac.canView(screen)) {
        return true;
      }
      const first = rbac.firstAllowedRoute();
      return router.createUrlTree([first ?? '/no-access']);
    })
  );
};
