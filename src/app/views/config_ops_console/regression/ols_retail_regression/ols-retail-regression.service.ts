import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiDataService } from '../../../../shared/api-data.service';
import { API } from '../../../../shared/api-endpoints';
import { environment } from '../../../../../environments/environment';
import { RbacService } from '../../../../auth/rbac.service';
import {
  BatchMonitorResult, FileCopyItem, FileCopyResult, RegressionActivityRow,
  RegressionState, RunSqlResult
} from '../../../../shared/models';

/** Live-stream callbacks for a run-sql-stream (Apply / Reset / Trigger). */
export interface RunSqlStreamHandlers {
  line: (text: string) => void;         // one sqlplus output line
  result: (r: RunSqlResult) => void;    // a script×db run finished (for the results list)
  step: (status: string) => void;       // overall step status (complete | error)
  done: () => void;                     // stream ended
  error: (e: unknown) => void;
}

/**
 * Client for the Regression screen (`/api/regression/*`). Every call carries `caller` (the signed-in
 * user), which the backend re-checks (DEV/STG + CIB Config access). See regression_api.py.
 */
@Injectable({ providedIn: 'root' })
export class OlsRetailRegressionService {
  private readonly api = inject(ApiDataService);
  private readonly rbac = inject(RbacService);
  private readonly scope = 'retail';   // this app's regression stream (separate from other scopes)

  private caller(): string {
    return this.rbac.snapshot().username || environment.username;
  }

  runCurrent(): Observable<RegressionState> {
    return this.api.post(API.regression.runCurrent, { caller: this.caller(), scope: this.scope });
  }
  runStart(): Observable<RegressionState> {
    return this.api.post(API.regression.runStart, { caller: this.caller(), scope: this.scope });
  }
  markStep(run_id: number, step_key: string, status: string, forced = false, details?: string): Observable<RegressionState> {
    return this.api.post(API.regression.stepMark, { caller: this.caller(), scope: this.scope, run_id, step_key, status, forced, details });
  }
  unlockStep(run_id: number, step_key: string): Observable<RegressionState> {
    return this.api.post(API.regression.stepUnlock, { caller: this.caller(), scope: this.scope, run_id, step_key });
  }
  refreshDb(run_id: number, dbs: string[]): Observable<{ result: { status: string; message: string; details: string } }> {
    return this.api.post(API.regression.refreshDb, { caller: this.caller(), scope: this.scope, run_id, dbs });
  }
  completeRun(run_id: number, status: 'complete' | 'abandoned' = 'complete'): Observable<{ status: string }> {
    return this.api.post(API.regression.runComplete, { caller: this.caller(), scope: this.scope, run_id, status });
  }
  gitBranches(): Observable<{ branches: string[] }> {
    return this.api.post(API.regression.gitBranches, { caller: this.caller(), scope: this.scope });
  }
  gitPull(branch: string): Observable<{ scripts: string[] }> {
    return this.api.post(API.regression.gitPull, { caller: this.caller(), scope: this.scope, branch });
  }
  gitScripts(): Observable<{ scripts: string[] }> {
    return this.api.post(API.regression.gitScripts, { caller: this.caller(), scope: this.scope });
  }
  gitTree(): Observable<{ workdir: string; branch: string; files: string[] }> {
    return this.api.post(API.regression.gitTree, { caller: this.caller(), scope: this.scope });
  }
  gitFile(path: string): Observable<{ path: string; content: string }> {
    return this.api.post(API.regression.gitFile, { caller: this.caller(), scope: this.scope, path });
  }
  runSql(run_id: number, step_key: string, scripts: string[], dbs: string[], business_line?: string):
    Observable<{ results: RunSqlResult[]; step_status: string }> {
    return this.api.post(API.regression.runSql, { caller: this.caller(), scope: this.scope, run_id, step_key, scripts, dbs, business_line });
  }

  /**
   * LIVE run: stream sqlplus output line-by-line into the console. Against the real backend this reads
   * the SSE stream via `fetch`; in the in-app mock (no streaming transport) it fetches the canned
   * result and animates it into the console so the experience is the same locally.
   */
  runSqlStream(run_id: number, step_key: string, scripts: string[], dbs: string[],
               handlers: RunSqlStreamHandlers, business_line?: string): void {
    if (this.isMocked(API.regression.runSqlStream)) {
      this.simulateStream(run_id, step_key, scripts, dbs, handlers);
    } else {
      void this.fetchStream(API.regression.runSqlStream,
        { caller: this.caller(), scope: this.scope, run_id, step_key, scripts, dbs, business_line }, handlers);
    }
  }

  /** Mirror the mock interceptor's longest-prefix rule: is this URL answered by the in-app mock? */
  private isMocked(url: string): boolean {
    let path = url;
    try { path = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost').pathname; } catch { /* keep url */ }
    const prefixes = Object.keys(environment.apiMocks).filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length);
    return prefixes.length ? environment.apiMocks[prefixes[0]] : environment.useMock;
  }

  private async fetchStream(url: string, body: unknown, h: RunSqlStreamHandlers): Promise<void> {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(body)
      });
      if (!resp.ok || !resp.body) { h.error(new Error(`Stream failed (HTTP ${resp.status})`)); return; }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { break; }
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          this.dispatchSse(buffer.slice(0, sep), h);
          buffer = buffer.slice(sep + 2);
        }
      }
      h.done();
    } catch (e) { h.error(e); }
  }

  private dispatchSse(frame: string, h: RunSqlStreamHandlers): void {
    let event = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) { event = line.slice(6).trim(); }
      else if (line.startsWith('data:')) { data += line.slice(5).trim(); }
    }
    if (!data) { return; }
    let parsed: { text?: string; step_status?: string; script?: string; db?: string; status?: string; log_file?: string };
    try { parsed = JSON.parse(data); } catch { return; }
    if (event === 'line') { h.line(parsed.text ?? ''); }
    else if (event === 'result') { h.result(parsed as unknown as RunSqlResult); }
    else if (event === 'step') { h.step(parsed.step_status ?? 'complete'); }
  }

  private simulateStream(run_id: number, step_key: string, scripts: string[], dbs: string[], h: RunSqlStreamHandlers): void {
    this.runSql(run_id, step_key, scripts, dbs).subscribe({
      next: (resp) => {
        const results = resp.results ?? [];
        let i = 0;
        const nextCombo = (): void => {
          if (i >= results.length) { h.step(resp.step_status); h.done(); return; }
          const r = results[i++];
          h.line(`===== ${r.script} · ${r.db} =====`);
          const lines = (r.tail || '(no output)').split('\n');
          let j = 0;
          const emit = (): void => {
            if (j < lines.length) { h.line(lines[j++]); setTimeout(emit, 70); }
            else { h.result(r); setTimeout(nextCombo, 140); }
          };
          emit();
        };
        nextCombo();
      },
      error: (e) => h.error(e)
    });
  }
  logRead(log_file: string): Observable<{ content: string }> {
    return this.api.post(API.regression.logRead, { caller: this.caller(), scope: this.scope, log_file });
  }
  fileCopyManifest(): Observable<{ items: FileCopyItem[] }> {
    return this.api.post(API.regression.fileCopyManifest, { caller: this.caller(), scope: this.scope });
  }
  fileCopyRun(run_id: number, items: FileCopyItem[]): Observable<{ results: FileCopyResult[] }> {
    return this.api.post(API.regression.fileCopyRun, { caller: this.caller(), scope: this.scope, run_id, items });
  }
  batchMonitor(db: string): Observable<BatchMonitorResult> {
    return this.api.post(API.regression.batchMonitor, { caller: this.caller(), scope: this.scope, db });
  }
  activity(run_id?: number): Observable<{ rows: RegressionActivityRow[] }> {
    return this.api.post(API.regression.activity, { caller: this.caller(), scope: this.scope, run_id });
  }
}
