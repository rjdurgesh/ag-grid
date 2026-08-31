import { Component } from '@angular/core';

import { GridDataComponent } from '../../../components/grid-data/grid-data.component';
import { LoaderComponent } from '../../../components/loader/loader.component';
import { ConfigScope } from '../../../shared/api-endpoints';
import { ConfigScopeBase } from '../config-scope.base';
import { SqlStudioComponent } from '../sql_studio/sql-studio.component';
import { OlsRetailRegressionComponent } from '../regression/ols_retail_regression/ols-retail-regression.component';

@Component({
  selector: 'app-config-ols-retail',
  templateUrl: './config_ols_retail.component.html',
  styleUrls: ['./config_ols_retail.component.scss'],
  imports: [GridDataComponent, LoaderComponent, SqlStudioComponent, OlsRetailRegressionComponent]
})
export class ConfigOlsRetailComponent extends ConfigScopeBase {
  protected readonly scope: ConfigScope = 'retail';
}
