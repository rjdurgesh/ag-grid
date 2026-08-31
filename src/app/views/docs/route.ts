import { inject } from '@angular/core';
import { CanActivateFn, Router, Routes } from '@angular/router';
import { map } from 'rxjs/operators';

import { rbacGuard } from '../../auth/rbac.guard';
import { RbacService } from '../../auth/rbac.service';
import { UserGuideComponent } from './user_guide/user-guide.component';
import { TechnicalGuideComponent } from './technical_guide/technical-guide.component';

/**
 * `/docs` landing — send the user to the first Documentation screen they can actually see
 * (User Guide, else Technical Guide), else bounce to their first allowed route / No-Access.
 * Both screens are grant-driven, so a user with no docs grant never lands here.
 */
const docsLandingGuard: CanActivateFn = () => {
  const rbac = inject(RbacService);
  const router = inject(Router);
  return rbac.ensureLoaded().pipe(
    map(() => {
      if (rbac.canView('docs')) {
        return router.createUrlTree(['/docs/user-guide']);
      }
      if (rbac.canView('docs_technical')) {
        return router.createUrlTree(['/docs/technical-guide']);
      }
      return router.createUrlTree([rbac.firstAllowedRoute() ?? '/no-access']);
    })
  );
};

/**
 * Documentation Center — two SEPARATE screens under `/docs`, each its own component/folder:
 *   • User Guide      (`docs`)           — grant: SCREEN / docs           — views/docs/user_guide/
 *   • Technical Guide (`docs_technical`) — grant: SCREEN / docs_technical — views/docs/technical_guide/
 * ADMIN sees both; a user with neither grant sees no Docs at all. Each screen holds BOTH wiki links and
 * markdown files for its audience (the shared reader lives in DocsBrowserComponent).
 */
export const routes: Routes = [
  { path: '', pathMatch: 'full', canActivate: [docsLandingGuard], component: UserGuideComponent },
  {
    path: 'user-guide',
    component: UserGuideComponent,
    canActivate: [rbacGuard],
    data: { title: 'User Guide', screen: 'docs' }
  },
  {
    path: 'technical-guide',
    component: TechnicalGuideComponent,
    canActivate: [rbacGuard],
    data: { title: 'Technical Guide', screen: 'docs_technical' }
  }
];
