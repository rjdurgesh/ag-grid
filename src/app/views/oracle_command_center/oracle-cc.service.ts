import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { ApiDataService } from '../../shared/api-data.service';
import { API } from '../../shared/api-endpoints';
import { DynTable, OracleOverview, OracleTarget, SessionDetail, SessionFilter, SpaceSummary } from '../../shared/oracle-models';

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
}

/** Result of a kill-session call. */
export interface KillResult {
  status?: string;
  success: boolean;
  message: string;
}
