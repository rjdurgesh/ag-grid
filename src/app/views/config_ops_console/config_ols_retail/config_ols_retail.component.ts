import { Component } from '@angular/core';

import { GridDataComponent } from '../../../components/grid-data/grid-data.component';
import { LoaderComponent } from '../../../components/loader/loader.component';
import { ConfigScope } from '../../../shared/api-endpoints';
import { ConfigScopeBase } from '../config-scope.base';
import { SqlStudioComponent } from '../sql_studio/sql-studio.component';

@Component({
  selector: 'app-config-ols-retail',
  templateUrl: './config_ols_retail.component.html',
  styleUrls: ['./config_ols_retail.component.scss'],
  imports: [GridDataComponent, LoaderComponent, SqlStudioComponent]
})
export class ConfigOlsRetailComponent extends ConfigScopeBase {
  protected readonly scope: ConfigScope = 'retail';
}
