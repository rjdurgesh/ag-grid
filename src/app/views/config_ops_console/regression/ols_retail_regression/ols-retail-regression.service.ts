import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiDataService } from '../../../../shared/api-data.service';
import { API } from '../../../../shared/api-endpoints';
import { environment } from '../../../../../environments/environment';
import { RbacService } from '../../../../auth/rbac.service';
import {
  BatchMonitorResult, CleanupItem, CleanupManifestLocation, CleanupResult, FileCopyItem, FileCopyManifestLocation,
  FileCopyPreflight, FileCopyResult, RegressionActivityRow, RegressionDb, RegressionState, RunSqlResult
} from '../../../../shared/models';

/** Live-stream callbacks for a run-sql-stream (Apply / Reset / Trigger). */
export interface RunSqlStreamHandlers {
  line: (text: string) => void;         // one sqlplus output line
  result: (r: RunSqlResult) => void;    // a script×db run finished (for the results list)
  step: (status: string) => void;       // overall step status (complete | error)
  done: () => void;                     // stream ended
  error: (e: unknown) => void;
}

/** Live-stream callbacks for a file-copy run (progress bar + per-file ✓/✗). */
export interface FileCopyStreamHandlers {
  item: (r: FileCopyResult, done: number, total: number) => void;
  step: (status: string) => void;
  done: () => void;
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
  runStart(branch: string, release_date: string, change_number: string): Observable<RegressionState> {
    return this.api.post(API.regression.runStart, { caller: this.caller(), scope: this.scope, branch, release_date, change_number });
  }
  markStep(run_id: number, step_key: string, status: string, forced = false, details?: string): Observable<RegressionState> {
    return this.api.post(API.regression.stepMark, { caller: this.caller(), scope: this.scope, run_id, step_key, status, forced, details });
  }
  unlockStep(run_id: number, step_key: string): Observable<RegressionState> {
    return this.api.post(API.regression.stepUnlock, { caller: this.caller(), scope: this.scope, run_id, step_key });
  }
  /** This scope's refreshable DBs for the current env (DEV/STG can have several; scope-specific). */
  refreshDatabases(): Observable<{ databases: RegressionDb[] }> {
    return this.api.post(API.regression.refreshDatabases, { caller: this.caller(), scope: this.scope });
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
  gitPull(branch: string): Observable<{ scripts: string[]; release_dates: string[] }> {
    return this.api.post(API.regression.gitPull, { caller: this.caller(), scope: this.scope, branch });
  }
  gitScripts(): Observable<{ scripts: string[] }> {
    return this.api.post(API.regression.gitScripts, { caller: this.caller(), scope: this.scope });
  }
  /** Release folders (YYYYMMDD) in the pulled branch — the date hint + validation source. */
  releaseDates(): Observable<{ release_dates: string[] }> {
    return this.api.post(API.regression.releaseDates, { caller: this.caller(), scope: this.scope });
  }
  /** chg*.sql for a release, PER DB ({ db: paths[] }) — each DB runs only its own folder's scripts. */
  releaseScripts(release_date: string, dbs: string[]): Observable<{ scripts: Record<string, string[]> }> {
    return this.api.post(API.regression.releaseScripts, { caller: this.caller(), scope: this.scope, release_date, dbs });
  }
  /** .sql from the DB's RegressionTesting folder — the Reset / Trigger script pickers. */
  batchDBScripts(db: string): Observable<{ scripts: string[] }> {
    return this.api.post(API.regression.batchDBScripts, { caller: this.caller(), scope: this.scope, db });
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
  /** Discover manifests in the pulled branch for a release → labelled dropdown(s) per Scripts folder. */
  fileCopyManifests(release_date: string): Observable<{ locations: FileCopyManifestLocation[] }> {
    return this.api.post(API.regression.fileCopyManifests, { caller: this.caller(), scope: this.scope, release_date });
  }
  fileCopyManifest(path: string): Observable<{ items: FileCopyItem[] }> {
    return this.api.post(API.regression.fileCopyManifest, { caller: this.caller(), scope: this.scope, path });
  }
  /** Readiness check BEFORE copying — source exists / dest writable / free space. Copies nothing. */
  fileCopyPreflight(items: FileCopyItem[]): Observable<{ results: FileCopyPreflight[] }> {
    return this.api.post(API.regression.fileCopyPreflight, { caller: this.caller(), scope: this.scope, items });
  }
  fileCopyRun(run_id: number, items: FileCopyItem[], manifest: FileCopyItem[]): Observable<{ results: FileCopyResult[]; step_status: string }> {
    return this.api.post(API.regression.fileCopyRun, { caller: this.caller(), scope: this.scope, run_id, items, manifest });
  }
  // --- Server Space Cleanup (Step 2) ---
  /** Discover cleanup_manifest*.json in the pulled branch for a release → labelled dropdown(s) per folder. */
  cleanupManifests(release_date: string): Observable<{ locations: CleanupManifestLocation[] }> {
    return this.api.post(API.regression.cleanupManifests, { caller: this.caller(), scope: this.scope, release_date });
  }
  /** Read one chosen cleanup manifest (by repo path) → its normalised path/flag entries. */
  cleanupManifest(path: string): Observable<{ items: CleanupItem[] }> {
    return this.api.post(API.regression.cleanupManifest, { caller: this.caller(), scope: this.scope, path });
  }
  /** DRY-RUN preview: report what WOULD be deleted per path. Deletes + logs nothing. */
  cleanupPreview(items: CleanupItem[]): Observable<{ results: CleanupResult[] }> {
    return this.api.post(API.regression.cleanupPreview, { caller: this.caller(), scope: this.scope, items });
  }
  /** REAL cleanup: delete the matching files for the selected paths (the UI confirms first). */
  cleanupRun(run_id: number, items: CleanupItem[], manifest: CleanupItem[]): Observable<{ results: CleanupResult[]; step_status: string }> {
    return this.api.post(API.regression.cleanupRun, { caller: this.caller(), scope: this.scope, run_id, items, manifest });
  }
  /** LIVE copy: stream per-item results (progress + per-file ✓/✗). SSE for real; mock animates /file-copy/run. */
  fileCopyRunStream(run_id: number, items: FileCopyItem[], manifest: FileCopyItem[], h: FileCopyStreamHandlers): void {
    if (this.isMocked(API.regression.fileCopyRunStream)) {
      this.fileCopyRun(run_id, items, manifest).subscribe({
        next: (resp) => {
          const results = resp.results ?? [];
          let i = 0;
          const next = (): void => {
            if (i >= results.length) { h.step(resp.step_status); h.done(); return; }
            const r = results[i++];
            h.item(r, i, results.length);
            setTimeout(next, 260);
          };
          next();
        },
        error: (e) => h.error(e)
      });
    } else {
      void this.fileCopyStream(API.regression.fileCopyRunStream, { caller: this.caller(), scope: this.scope, run_id, items, manifest }, h);
    }
  }
  private async fileCopyStream(url: string, body: unknown, h: FileCopyStreamHandlers): Promise<void> {
    try {
      const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body) });
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
          const frame = buffer.slice(0, sep); buffer = buffer.slice(sep + 2);
          let ev = 'message'; let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) { ev = line.slice(6).trim(); }
            else if (line.startsWith('data:')) { data += line.slice(5).trim(); }
          }
          if (!data) { continue; }
          const p = JSON.parse(data);
          if (ev === 'item') { h.item(p.result as FileCopyResult, p.done as number, p.total as number); }
          else if (ev === 'step') { h.step(p.step_status as string); }
        }
      }
      h.done();
    } catch (e) { h.error(e); }
  }
  batchMonitor(db: string): Observable<BatchMonitorResult> {
    return this.api.post(API.regression.batchMonitor, { caller: this.caller(), scope: this.scope, db });
  }
  activity(run_id?: number): Observable<{ rows: RegressionActivityRow[] }> {
    return this.api.post(API.regression.activity, { caller: this.caller(), scope: this.scope, run_id });
  }
}
