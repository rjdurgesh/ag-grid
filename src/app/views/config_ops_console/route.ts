import { Routes } from '@angular/router';

import { configScopeGuard } from '../../auth/config-scope.guard';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./config_ops_console.component').then((m) => m.ConfigOpsConsoleComponent),
    data: { title: 'Config Ops Console' },
    children: [
      { path: '', redirectTo: 'group', pathMatch: 'full' },
      {
        path: 'group',
        canActivate: [configScopeGuard],
        loadComponent: () =>
          import('./config_ols_group/config_ols_group.component').then((m) => m.ConfigOlsGroupComponent),
        data: { title: 'OLS Group', scope: 'group' }
      },
      {
        path: 'cib',
        canActivate: [configScopeGuard],
        loadComponent: () =>
          import('./config_ols_cib/config_ols_cib.component').then((m) => m.ConfigOlsCibComponent),
        data: { title: 'OLS CIB', scope: 'cib' }
      },
      {
        path: 'retail',
        canActivate: [configScopeGuard],
        loadComponent: () =>
          import('./config_ols_retail/config_ols_retail.component').then((m) => m.ConfigOlsRetailComponent),
        data: { title: 'OLS Retail', scope: 'retail' }
      }
    ]
  }
];
