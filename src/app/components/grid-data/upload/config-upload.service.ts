import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiDataService } from '../../../shared/api-data.service';
import { API } from '../../../shared/api-endpoints';
import { ConfigScope } from '../../../shared/api-endpoints';
import { environment } from '../../../../environments/environment';
import { RbacService } from '../../../auth/rbac.service';
import { UploadResponse } from '../../../shared/models';

/** Client for the Config Ops CSV upload endpoint. The reviewed/edited CSV is sent as `file_content`;
 *  the server re-parses + validates + loads it atomically. See UPLOAD_DESIGN.md. */
@Injectable({ providedIn: 'root' })
export class ConfigUploadService {
  private readonly api = inject(ApiDataService);
  private readonly rbac = inject(RbacService);

  private caller(): string {
    return this.rbac.snapshot().username || environment.username;
  }

  upload(scope: ConfigScope, table: string,
         body: { mode: string; delimiter: string; original_filename: string; file_content: string }): Observable<UploadResponse> {
    return this.api.post(API.config.upload(scope, table), { caller: this.caller(), ...body });
  }
}
