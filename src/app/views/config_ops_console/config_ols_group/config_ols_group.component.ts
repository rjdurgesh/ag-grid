import { Component } from '@angular/core';

import { GridDataComponent } from '../../../components/grid-data/grid-data.component';
import { ConfigScope } from '../../../shared/api-endpoints';
import { ConfigScopeBase } from '../config-scope.base';

@Component({
  selector: 'app-config-ols-group',
  templateUrl: './config_ols_group.component.html',
  styleUrls: ['./config_ols_group.component.scss'],
  imports: [GridDataComponent]
})
export class ConfigOlsGroupComponent extends ConfigScopeBase {
  protected readonly scope: ConfigScope = 'group';
}
