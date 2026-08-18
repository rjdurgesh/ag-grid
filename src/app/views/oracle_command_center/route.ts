import { Routes } from '@angular/router';

import { OracleCommandCenterComponent } from './oracle_command_center.component';

export const routes: Routes = [
  {
    path: '',
    component: OracleCommandCenterComponent,
    data: { title: 'Oracle Command Center' }
  }
];
