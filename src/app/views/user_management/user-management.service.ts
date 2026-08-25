import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiDataService } from '../../shared/api-data.service';
import { API, apiEnv } from '../../shared/api-endpoints';
import { environment } from '../../../environments/environment';
import { RbacService } from '../../auth/rbac.service';
import { AccessCatalogue, AdminUserResponse, GrantRow, OpsAdmin } from '../../shared/models';

/** One grant to add (the natural key + level). */
export interface GrantInput {
  username: string;
  resource_type: string;
  resource_scope: string;
  resource_key: string;
  access_level: 'READ' | 'WRITE' | 'DENY';
  app_env: string;
}

/**
 * Thin client for the ops-admin User Management endpoints (`/api/access/admin/*`). Every call
 * carries `caller` — the signed-in ops-admin — which the backend re-checks against `ols_ops_access`
 * (and derives `granted_by` from at go-live). See RBAC_DESIGN.md §User Management.
 */
@Injectable({ providedIn: 'root' })
export class UserManagementService {
  private readonly api = inject(ApiDataService);
  private readonly rbac = inject(RbacService);

  /** The acting ops-admin (the resolved snapshot username, falling back to the demo user). */
  private caller(): string {
    return this.rbac.snapshot().username || environment.username;
  }

  catalogue(): Observable<{ catalogue: AccessCatalogue }> {
    return this.api.post(API.access.admin.catalogue, { caller: this.caller() });
  }

  loadUser(uid: string): Observable<AdminUserResponse> {
    return this.api.post(API.access.admin.user, {
      caller: this.caller(), uid, app_env: apiEnv(environment.appEnv)
    });
  }

  grant(g: GrantInput): Observable<{ grants: GrantRow[] }> {
    return this.api.post(API.access.admin.grant, { caller: this.caller(), ...g });
  }

  revoke(g: GrantRow): Observable<{ grants: GrantRow[] }> {
    return this.api.post(API.access.admin.grantDelete, {
      caller: this.caller(),
      username: g.username, resource_type: g.resource_type, resource_scope: g.resource_scope,
      resource_key: g.resource_key, app_env: g.app_env
    });
  }

  ops(action: 'list' | 'add' | 'disable' | 'enable' | 'remove', uid?: string): Observable<{ ops_admins: OpsAdmin[] }> {
    return this.api.post(API.access.admin.ops, { caller: this.caller(), action, uid });
  }
}
