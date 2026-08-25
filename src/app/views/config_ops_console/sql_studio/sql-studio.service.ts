import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiDataService } from '../../../shared/api-data.service';
import { API, ConfigScope } from '../../../shared/api-endpoints';
import { environment } from '../../../../environments/environment';
import { RbacService } from '../../../auth/rbac.service';
import { SqlDatabase, SqlResult } from '../../../shared/models';

/**
 * Client for the S-Studio SQL console (`/api/sql_studio/*`). Every call carries `caller` — the
 * signed-in operator — which the backend re-checks against `ols_ops_access.can_sql`. See
 * sql_studio_api.py / RBAC_DESIGN.md §12.
 */
@Injectable({ providedIn: 'root' })
export class SqlStudioService {
  private readonly api = inject(ApiDataService);
  private readonly rbac = inject(RbacService);

  private caller(): string {
    return this.rbac.snapshot().username || environment.username;
  }

  databases(scope: ConfigScope): Observable<{ databases: SqlDatabase[] }> {
    return this.api.post(API.sqlStudio.databases, { caller: this.caller(), scope });
  }

  execute(db: string, sql: string): Observable<{ result: SqlResult }> {
    return this.api.post(API.sqlStudio.execute, { caller: this.caller(), db, sql });
  }
}
