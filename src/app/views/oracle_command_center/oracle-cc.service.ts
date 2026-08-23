import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { ApiDataService } from '../../shared/api-data.service';
import { API } from '../../shared/api-endpoints';
import {
  DynTable, OracleOverview, OracleTarget, SessionDetail, SessionFilter, SpaceSummary,
  SqlApplyResult, SqlFix, SqlMonitor, SqlOverview, SqlPlanAnalysis, SqlPlanText, SqlPlansSummary, SqlTimeline
} from '../../shared/oracle-models';

/**
 * Data access for the Oracle Command Center. DB tabs are fetched from the backend
 * (`targets`) so a new database is a config-only change. Every section returns the
 * same self-describing `DynTable` shape.
 */
@Injectable({ providedIn: 'root' })
export class OracleCcService {
  private readonly api = inject(ApiDataService);

  /** The DB tabs to render (config-driven). */
  targets(): Observable<OracleTarget[]> {
    return this.api
      .get<{ status: string; data: OracleTarget[] }>(API.oracle.targets)
      .pipe(map((r) => r?.data ?? []));
  }

  /** Compact per-DB snapshot for the Home 'Oracle Databases' strip (one call). */
  overview(): Observable<OracleOverview[]> {
    return this.api
      .get<{ status: string; data: OracleOverview[] }>(API.oracle.overview)
      .pipe(map((r) => r?.data ?? []));
  }

  /** Section 1 — tablespace/owner space + gauge summary. */
  space(db: string): Observable<DynTable<SpaceSummary>> {
    return this.api.post<DynTable<SpaceSummary>>(API.oracle.space(db), {});
  }

  /** Section 2 — top table storage consumers (partition/subpartition as `__children`). */
  topSegments(db: string): Observable<DynTable> {
    return this.api.post<DynTable>(API.oracle.topSegments(db), {});
  }

  /** Section 3 — top index storage consumers. */
  topIndexes(db: string): Observable<DynTable> {
    return this.api.post<DynTable>(API.oracle.topIndexes(db), {});
  }

  /** Section 4 — index health & stability (unusable / invisible / stale). */
  indexHealth(db: string): Observable<DynTable> {
    return this.api.post<DynTable>(API.oracle.indexHealth(db), {});
  }

  /** Section 5 — critical locks (TX/TM, blocking/waiting/held), each killable. */
  locks(db: string): Observable<DynTable> {
    return this.api.post<DynTable>(API.oracle.locks(db), {});
  }

  /** Section 6 — blocker → waiter tree (chained blocking as `__children`). */
  blocking(db: string): Observable<DynTable> {
    return this.api.post<DynTable>(API.oracle.blocking(db), {});
  }

  /** Section 7 — session inventory filtered by state (summary carries full per-state counts). */
  sessions(db: string, status: SessionFilter): Observable<DynTable> {
    return this.api.post<DynTable>(API.oracle.sessions(db), { status });
  }

  /**
   * Section 7 — SID deep-dive. With no `panel`, returns every panel (plan / ASH / SQL Monitor /
   * stats / locks / AWR, + rollback for killed). With `panel`, returns just that one (per-tab refresh).
   */
  sessionDetail(db: string, sid: number, serial: number, sqlId?: string, panel?: string): Observable<SessionDetail> {
    return this.api.post<SessionDetail>(API.oracle.sessionDetail(db), {
      sid, serial, sql_id: sqlId ?? null, panel: panel ?? null
    });
  }

  /** Kill a session (admin + confirm gated in the UI). Returns `{ success, message }`. */
  killSession(db: string, sid: number, serial: number, immediate = true): Observable<KillResult> {
    return this.api.post<KillResult>(API.oracle.killSession(db), { sid, serial, immediate });
  }

  // --- Section 8 · SQL Intelligence (all keyed by sql_id; 5-day window) ------

  /** Locate a sql_id — top SQL over the window (optional text/module filter + order). */
  sqlFinder(db: string, q?: string, order = 'elapsed'): Observable<DynTable> {
    return this.api.post<DynTable>(API.oracle.sqlFinder(db), { q: q ?? null, order });
  }

  /** Identity + verdict + KPIs for a sql_id. */
  sqlOverview(db: string, sqlId: string): Observable<SqlOverview> {
    return this.api.post<SqlOverview>(API.oracle.sqlOverview(db, sqlId), {});
  }

  /** Plan-instability timeline (per-snapshot plan_hash + elapsed/exec). */
  sqlPlanTimeline(db: string, sqlId: string): Observable<SqlTimeline> {
    return this.api.post<SqlTimeline>(API.oracle.sqlPlanTimeline(db, sqlId), {});
  }

  /** Distinct plans this sql_id used (drives the diff selector). */
  sqlPlans(db: string, sqlId: string): Observable<DynTable<SqlPlansSummary>> {
    return this.api.post<DynTable<SqlPlansSummary>>(API.oracle.sqlPlans(db, sqlId), {});
  }

  /** Runtime plan — bottleneck + E/A-Rows misestimate + table stats health (live cursor). */
  sqlPlanAnalysis(db: string, sqlId: string): Observable<SqlPlanAnalysis> {
    return this.api.post<SqlPlanAnalysis>(API.oracle.sqlPlanAnalysis(db, sqlId), {});
  }

  /** Real-time SQL Monitor report (live/recent only; `monitored:false` otherwise). */
  sqlMonitor(db: string, sqlId: string): Observable<SqlMonitor> {
    return this.api.post<SqlMonitor>(API.oracle.sqlMonitor(db, sqlId), {});
  }

  /** One plan's DBMS_XPLAN text (call twice for a side-by-side diff). */
  sqlPlanText(db: string, sqlId: string, planHashValue: number): Observable<SqlPlanText> {
    return this.api.post<SqlPlanText>(API.oracle.sqlPlanText(db, sqlId), { plan_hash_value: planHashValue });
  }

  /** Per-snapshot performance table. */
  sqlPerf(db: string, sqlId: string): Observable<DynTable> {
    return this.api.post<DynTable>(API.oracle.sqlPerf(db, sqlId), {});
  }

  /** ASH breakdown (top waits) for the sql_id. */
  sqlAsh(db: string, sqlId: string): Observable<DynTable> {
    return this.api.post<DynTable>(API.oracle.sqlAsh(db, sqlId), {});
  }

  /** Captured bind variables. */
  sqlBinds(db: string, sqlId: string): Observable<DynTable> {
    return this.api.post<DynTable>(API.oracle.sqlBinds(db, sqlId), {});
  }

  /** Read-only fix recommendation (best plan + copy-ready SQL). Shown to all users. */
  sqlFix(db: string, sqlId: string): Observable<SqlFix> {
    return this.api.post<SqlFix>(API.oracle.sqlFix(db, sqlId), {});
  }

  /** WRITE — apply the fix (admin + confirm; server also gates on SQLI_ALLOW_APPLY). */
  sqlApplyFix(db: string, sqlId: string, planHashValue: number, method = 'baseline'): Observable<SqlApplyResult> {
    return this.api.post<SqlApplyResult>(API.oracle.sqlApplyFix(db, sqlId), {
      sql_id: sqlId, plan_hash_value: planHashValue, method
    });
  }
}

/** Result of a kill-session call. */
export interface KillResult {
  status?: string;
  success: boolean;
  message: string;
}
