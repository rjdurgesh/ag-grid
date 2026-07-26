import { Routes } from '@angular/router';

import { rbacGuard } from '../../auth/rbac.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./infra_pulse.component').then((m) => m.InfraPulseComponent),
    data: { title: 'Infrastructure Pulse' },
    children: [
      { path: '', redirectTo: 'infrastructure_health', pathMatch: 'full' },
      {
        path: 'infrastructure_health',
        canActivate: [rbacGuard],
        data: { title: 'Infrastructure Health', screen: 'infra_health' },
        loadComponent: () =>
          import('./infrastructure_health/infrastructure_health.component').then(
            (m) => m.InfrastructureHealthComponent
          )
      },
      {
        path: 'service_console',
        canActivate: [rbacGuard],
        data: { title: 'Service Console', screen: 'service_console' },
        loadComponent: () =>
          import('./service_console/service_console.component').then((m) => m.ServiceConsoleComponent)
      }
    ]
  }
];
