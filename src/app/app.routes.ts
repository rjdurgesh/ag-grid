import { Routes } from '@angular/router';

import { authGuard } from './auth/auth.guard';
import { rbacGuard } from './auth/rbac.guard';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'home',
    pathMatch: 'full'
  },
  {
    // Authenticated application shell. The guard bounces anonymous visitors to
    // /login, so a cold hit on any URL shows the login page first.
    path: '',
    loadComponent: () => import('./layout').then((m) => m.DefaultLayoutComponent),
    canActivate: [authGuard],
    data: {
      title: 'Home'
    },
    children: [
      {
        path: 'home',
        canActivate: [rbacGuard],
        data: { screen: 'home' },
        loadChildren: () => import('./views/home/route').then((m) => m.routes)
      },
      {
        path: 'log_analytics',
        canActivate: [rbacGuard],
        data: { screen: 'log_analytics' },
        loadChildren: () => import('./views/log_analytics/route').then((m) => m.routes)
      },
      {
        path: 'config_ops_console',
        canActivate: [rbacGuard],
        data: { screen: 'config_ops_console' },
        loadChildren: () => import('./views/config_ops_console/route').then((m) => m.routes)
      },
      {
        path: 'infra_pulse',
        loadChildren: () => import('./views/infra_pulse/route').then((m) => m.routes)
      },
      {
        path: 'oracle_command_center',
        canActivate: [rbacGuard],
        data: { screen: 'oracle_command_center' },
        loadChildren: () => import('./views/oracle_command_center/route').then((m) => m.routes)
      }
    ]
  },
  {
    path: 'login',
    loadComponent: () => import('./views/pages/login/login.component').then((m) => m.LoginComponent),
    data: {
      title: 'Login'
    }
  },
  {
    // Utility: opens the backend's Swagger UI ({apiBaseUrl}/docs) in a new tab.
    // Top-level (no shell / no auth guard) so the URL always resolves.
    path: 'swagger/docs',
    loadComponent: () => import('./swagger_docs/swagger-docs.component').then((m) => m.SwaggerDocsComponent),
    data: {
      title: 'API Docs'
    }
  },
  {
    // OpenID Connect redirect landing (used only when IS_SSO_ENABLED).
    path: 'auth/callback',
    loadComponent: () => import('./auth/sso-callback.component').then((m) => m.SsoCallbackComponent),
    data: {
      title: 'Signing in…'
    }
  },
  {
    // Authenticated but no roles assigned.
    path: 'no-access',
    canActivate: [authGuard],
    loadComponent: () => import('./views/pages/no-access/no-access.component').then((m) => m.NoAccessComponent),
    data: { title: 'No access' }
  },
  {
    path: '404',
    loadComponent: () => import('./views/pages/page404/page404.component').then((m) => m.Page404Component),
    data: {
      title: 'Page 404'
    }
  },
  {
    path: '500',
    loadComponent: () => import('./views/pages/page500/page500.component').then((m) => m.Page500Component),
    data: {
      title: 'Page 500'
    }
  },
  {
    // Any unknown URL → the 404 page (rendered at the typed URL, not redirected away),
    // so mistyped / dead links are handled instead of silently bouncing to Home.
    path: '**',
    loadComponent: () => import('./views/pages/page404/page404.component').then((m) => m.Page404Component),
    data: { title: 'Page not found' }
  }
];
