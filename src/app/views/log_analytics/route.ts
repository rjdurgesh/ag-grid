import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./log_analytics.component').then((m) => m.LogAnalyticsComponent),
    data: { title: 'Log Analytics Hub' }
  }
];
