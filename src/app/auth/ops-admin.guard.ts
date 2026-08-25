import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs/operators';

import { RbacService } from './rbac.service';

/**
 * Guards the User Management screen. Access is the super-exclusive `ols_ops_access` gate ONLY —
 * not the normal RBAC screens — so this is separate from {@link rbacGuard}. A non-ops-admin is
 * bounced to their first allowed screen (or /no-access). Hiding the route is UX; every write
 * endpoint re-checks ops-admin server-side.
 */
export const opsAdminGuard: CanActivateFn = () => {
  const rbac = inject(RbacService);
  const router = inject(Router);

  return rbac.ensureLoaded().pipe(
    map(() => {
      if (rbac.isOpsAdmin()) {
        return true;
      }
      const first = rbac.firstAllowedRoute();
      return router.createUrlTree([first ?? '/no-access']);
    })
  );
};
