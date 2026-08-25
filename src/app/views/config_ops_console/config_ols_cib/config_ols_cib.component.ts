import { Component } from '@angular/core';

import { GridDataComponent } from '../../../components/grid-data/grid-data.component';
import { ConfigScope } from '../../../shared/api-endpoints';
import { ConfigScopeBase } from '../config-scope.base';
import { SqlStudioComponent } from '../sql_studio/sql-studio.component';

@Component({
  selector: 'app-config-ols-cib',
  templateUrl: './config_ols_cib.component.html',
  styleUrls: ['./config_ols_cib.component.scss'],
  imports: [GridDataComponent, SqlStudioComponent]
})
export class ConfigOlsCibComponent extends ConfigScopeBase {
  protected readonly scope: ConfigScope = 'cib';
}
