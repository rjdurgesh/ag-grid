import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs/operators';

import { RbacService } from './rbac.service';

const SCOPES = ['group', 'cib', 'retail'];

/**
 * Hard-blocks a Config Ops scope the user has no grant in (reads `route.data.scope`). The sidebar
 * already hides non-granted scopes via `configScopeVisible`; this closes the direct-URL / bookmark gap
 * by redirecting to the first scope the user CAN see (or the No-Access page). The backend still
 * re-checks every read/write per `config_ops:<scope>` — this is the UI-level hard block.
 */
export const configScopeGuard: CanActivateFn = (route) => {
  const rbac = inject(RbacService);
  const router = inject(Router);
  const scope = route.data['scope'] as string | undefined;

  return rbac.ensureLoaded().pipe(
    map(() => {
      if (!scope || rbac.configScopeVisible(scope)) {
        return true;
      }
      const firstScope = SCOPES.find((s) => rbac.configScopeVisible(s));
      if (firstScope) {
        return router.createUrlTree([`/config_ops_console/${firstScope}`]);
      }
      return router.createUrlTree([rbac.firstAllowedRoute() ?? '/no-access']);
    })
  );
};
