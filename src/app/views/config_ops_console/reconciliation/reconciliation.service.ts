import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiDataService } from '../../../shared/api-data.service';
import { API, ConfigScope } from '../../../shared/api-endpoints';
import { environment } from '../../../../environments/environment';
import { RbacService } from '../../../auth/rbac.service';
import {
  ReconActivityRow, ReconCompareResult, ReconDb, ReconDiscrepancies, ReconExtract,
  ReconRegressionRun, ReconReport, ReconReportState
} from '../../../shared/models';

export interface ReconReportsResponse { reports: ReconReport[]; }
export interface ReconDbResponse { databases: ReconDb[]; }
export interface ReconRegressionRunsResponse { runs: ReconRegressionRun[]; }
export interface ReconTriggerBody {
  live_db: string;
  regression_db: string;
  business_date: string;                 // YYYYMMDD
  reports: string[];
  regression_run_id?: number | null;
}
export interface ReconTriggerResponse { run_id: number; extracts: ReconExtract[]; }
export interface ReconStatusResponse { run_id: number; reports: ReconReportState[]; }
export interface ReconActivityResponse { rows: ReconActivityRow[]; }
export interface ReconCompareResponse { report_code: string; result: ReconCompareResult; }

/**
 * Client for the Data Reconciliation screen (`/api/reconciliation/*`). Shared across all three config
 * scopes — every call carries `caller` (re-checked server-side) + `scope`. See reconciliation_api.py.
 */
@Injectable({ providedIn: 'root' })
export class ReconciliationService {
  private readonly api = inject(ApiDataService);
  private readonly rbac = inject(RbacService);

  private caller(): string {
    return this.rbac.snapshot().username || environment.username;
  }

  reports(scope: ConfigScope): Observable<ReconReportsResponse> {
    return this.api.post(API.reconciliation.reports, { caller: this.caller(), scope });
  }

  databases(scope: ConfigScope): Observable<ReconDbResponse> {
    return this.api.post(API.reconciliation.databases, { caller: this.caller(), scope });
  }

  regressionRuns(scope: ConfigScope): Observable<ReconRegressionRunsResponse> {
    return this.api.post(API.reconciliation.regressionRuns, { caller: this.caller(), scope });
  }

  trigger(scope: ConfigScope, body: ReconTriggerBody): Observable<ReconTriggerResponse> {
    return this.api.post(API.reconciliation.trigger, { caller: this.caller(), scope, ...body });
  }

  status(scope: ConfigScope, runId: number): Observable<ReconStatusResponse> {
    return this.api.post(API.reconciliation.status, { caller: this.caller(), scope, run_id: runId });
  }

  compare(scope: ConfigScope, runId: number, reportCode: string): Observable<ReconCompareResponse> {
    return this.api.post(API.reconciliation.compare, { caller: this.caller(), scope, run_id: runId, report_code: reportCode });
  }

  discrepancies(scope: ConfigScope, runId: number, reportCode: string): Observable<ReconDiscrepancies> {
    return this.api.post(API.reconciliation.discrepancies, { caller: this.caller(), scope, run_id: runId, report_code: reportCode });
  }

  activity(scope: ConfigScope): Observable<ReconActivityResponse> {
    return this.api.post(API.reconciliation.activity, { caller: this.caller(), scope });
  }
}
