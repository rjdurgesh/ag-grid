import { Routes } from '@angular/router';

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
        loadComponent: () =>
          import('./config_ols_group/config_ols_group.component').then((m) => m.ConfigOlsGroupComponent),
        data: { title: 'OLS Group' }
      },
      {
        path: 'cib',
        loadComponent: () =>
          import('./config_ols_cib/config_ols_cib.component').then((m) => m.ConfigOlsCibComponent),
        data: { title: 'OLS CIB' }
      },
      {
        path: 'retail',
        loadComponent: () =>
          import('./config_ols_retail/config_ols_retail.component').then((m) => m.ConfigOlsRetailComponent),
        data: { title: 'OLS Retail' }
      }
    ]
  }
];
