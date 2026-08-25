import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./user_management.component').then((m) => m.UserManagementComponent),
    data: { title: 'User Management' }
  }
];
