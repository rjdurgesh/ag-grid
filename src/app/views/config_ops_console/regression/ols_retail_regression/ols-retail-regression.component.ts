import { Component, DestroyRef, WritableSignal, computed, effect, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AgGridAngular } from 'ag-grid-angular';
import { ColDef } from 'ag-grid-community';
import { ColorModeService } from '@coreui/angular';
import { forkJoin, interval } from 'rxjs';

import { OlsRetailRegressionService } from './ols-retail-regression.service';
import { LoaderComponent } from '../../../../components/loader/loader.component';
import { ConfirmService } from '../../../../components/confirm/confirm.service';
import { olsGridTheme, olsGridThemeDark } from '../../../../components/grid-data/grid-data.model';
import { formatDateTime, syncAgo } from '../../../../shared/date-utils';
import {
  BatchMonitorResult, CleanupItem, CleanupManifestLocation, CleanupResult, FileCopyItem, FileCopyManifestLocation,
  FileCopyPreflight, FileCopyResult, RegressionActivityRow, RegressionDb, RegressionState, RunSqlResult
} from '../../../../shared/models';

interface StepDef { key: string; title: string; }
interface Toast { kind: 'ok' | 'err' | 'info'; text: string; }
interface TreeNode { name: string; path: string; dir: boolean; children: TreeNode[]; }

/**
 * Regression screen (Retail, DEV/STG). An ordered, gated, fully-logged workflow — Refresh DB → Apply DB
 * changes (git) → File copy → Reset batches → Trigger batches — with a monitoring area below (batch
 * status + the activity log). Each step is disabled until the previous is complete or force-marked.
 * Every action is confirmed and audited server-side. See regression_api.py / the plan.
 */
@Component({
  selector: 'app-ols-retail-regression',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet, LoaderComponent, AgGridAngular],
  templateUrl: './ols-retail-regression.component.html',
  styleUrls: ['./ols-retail-regression.component.scss']
})
export class OlsRetailRegressionComponent implements OnInit {
  private readonly svc = inject(OlsRetailRegressionService);
  private readonly confirm = inject(ConfirmService);

  readonly steps: StepDef[] = [
    { key: 'refresh_db', title: 'Refresh DB' },
    { key: 'space_cleanup', title: 'Server Space Cleanup' },
    { key: 'apply_db', title: 'Apply DB changes' },
    { key: 'file_copy', title: 'File copy' },
    { key: 'reset', title: 'Reset batches' },
    { key: 'trigger', title: 'Trigger batches' }
  ];
  // `name` = the actual database name/SID shown to the operator (placeholders — set to your real DB names).
  readonly databases = [
    { key: 'group', label: 'OLS GROUP', name: 'OLSGD1' },
    { key: 'cib_batch', label: 'OLS CIB Batch', name: 'OLSCD1' },
    { key: 'cib_reporting', label: 'OLS CIB Reporting', name: 'OLSCR1' },
    { key: 'retail_batch', label: 'OLS RETAIL Batch', name: 'OLSRD1' },
    { key: 'retail_reporting', label: 'OLS RETAIL Reporting', name: 'OLSRR1' }
  ];
  /** The three batch schedulers — used by Reset, Trigger and Monitoring Batches. */
  readonly batchDatabases = [
    { key: 'group', label: 'OLS GROUP' },
    { key: 'cib_batch', label: 'OLS CIB Batch' },
    { key: 'retail_batch', label: 'OLS RETAIL Batch' }
  ];

  readonly state = signal<RegressionState>({ run: null, steps: {} });
  /** Set after a run is closed out, so we can show a "run completed" banner. */
  readonly lastCompleted = signal<number | null>(null);
  /** A pre-existing in-progress run was loaded on entry (page refresh / someone else's run) → offer resume. */
  readonly resumed = signal(false);
  /** Refresh DB targets — this scope's env-specific databases (loaded from the backend; DEV/STG can
   *  have several). Nothing selected by default; the operator picks which to refresh. */
  readonly refreshDbList = signal<RegressionDb[]>([]);
  readonly refreshDbs = signal<string[]>([]);
  readonly refreshOpen = signal(false);                // grouped multi-select dropdown open/closed
  /** refreshDbList grouped by category (BATCH / REPORTING / …), first-seen order preserved. */
  readonly refreshGroups = computed(() => {
    const groups: { category: string; dbs: RegressionDb[] }[] = [];
    const idx = new Map<string, number>();
    for (const d of this.refreshDbList()) {
      const cat = d.category || 'Other';
      let i = idx.get(cat);
      if (i === undefined) { i = groups.length; idx.set(cat, i); groups.push({ category: cat, dbs: [] }); }
      groups[i].dbs.push(d);
    }
    return groups;
  });
  readonly refreshSummary = computed(() => {
    const n = this.refreshDbs().length;
    return n === 0 ? 'Select databases…' : `${n} database${n === 1 ? '' : 's'} selected`;
  });
  /** DB key → most-recent successful refresh timestamp, reconstructed from the activity log (newest-first,
   *  so the first refresh row seen per DB is the latest). Shown next to each DB in the picker. */
  readonly lastRefreshedByDb = computed(() => {
    const m: Record<string, string> = {};
    for (const row of this.activityRows()) {
      if (row.step_key !== 'refresh_db' || row.action !== 'refresh' || row.status !== 'complete') { continue; }
      const d = this.parseRefreshComment(row.comments);
      const ts = row.end_time || row.start_time || '';
      if (d.db && !m[d.db]) { m[d.db] = ts; }   // activity is newest-first → first seen is latest
    }
    return m;
  });
  /** Friendly "last refreshed" label for a DB in the picker (seconds trimmed; empty if never refreshed). */
  lastRefreshedLabel(dbKey: string): string {
    const ts = this.lastRefreshedByDb()[dbKey];
    return ts ? `last refreshed ${ts.slice(0, 16)}` : 'never refreshed';
  }
  readonly loading = signal(true);
  readonly toast = signal<Toast | null>(null);
  // Auto-dismiss any toast a few seconds after it appears (e.g. "State refreshed.") so it doesn't linger.
  private readonly _toastAuto = effect((onCleanup) => {
    if (this.toast()) { const id = setTimeout(() => this.toast.set(null), 4000); onCleanup(() => clearTimeout(id)); }
  });
  readonly busy = signal<string>('');            // step_key currently running

  // Start a run: tag a CHG number (mandatory), then pick the release/* branch + release date (YYYYMMDD folder).
  readonly chgNumber = signal('');                    // Change ticket — MUST be filled before loading branches
  readonly branches = signal<string[]>([]);
  readonly selectedBranch = signal('');
  readonly scripts = signal<string[]>([]);
  readonly pulling = signal(false);
  readonly releaseDate = signal('');                 // YYYYMMDD entered at run start (manual + validated)
  readonly availableDates = signal<string[]>([]);    // release folders found in the pulled branch (type-ahead hint)
  readonly starting = signal(false);
  // Apply DB — ALL chg*.sql from the scope's single Scripts/<release_date>/ folder are listed; the operator
  // decides, PER FILE, which DB(s) it runs on, and the run sequence. (No auto per-DB mapping.)
  readonly applyScripts = signal<string[]>([]);                 // flat chg list from the single folder
  readonly applyFileDbs = signal<Record<string, string[]>>({}); // file → target DB keys (empty = not run)
  readonly applyOrder = signal<string[]>([]);                   // run sequence of the files that have ≥1 DB ticked
  readonly loadingApply = signal(false);
  readonly applyResults = signal<RunSqlResult[]>([]);
  /** Total (script × DB) executions queued across all files. */
  readonly applyExecCount = computed(() => this.applyOrder().reduce((n, f) => n + (this.applyFileDbs()[f]?.length || 0), 0));
  // Collapsible workflow steps (key → collapsed?).
  readonly stepCollapsed = signal<Record<string, boolean>>({});

  // File copy — manifest comes from the release repo (Scripts/<date>/filecopy_manifest_<date>.json),
  // discovered per Scripts folder (one labelled dropdown each). Step is Complete only when ALL items copied.
  readonly manifestLocations = signal<FileCopyManifestLocation[]>([]);
  readonly selectedManifestPath = signal<string>('');
  readonly loadingManifests = signal(false);
  readonly manifest = signal<FileCopyItem[]>([]);          // the CURRENTLY SHOWN manifest (selected dropdown)
  readonly allManifestItems = signal<FileCopyItem[]>([]);  // UNION across every discovered manifest — the step
  readonly selectedItems = signal<number[]>([]);           // is Complete only when ALL of these are copied
  readonly manifestsDiscovered = signal(false);            // discovery has finished (locations + their items loaded)
  readonly copyResults = signal<FileCopyResult[]>([]);
  readonly copyProgress = signal<{ done: number; total: number } | null>(null);
  readonly copyDetail = signal<FileCopyResult[] | null>(null);
  readonly preflight = signal<FileCopyPreflight[] | null>(null); // last readiness check (before a copy)
  readonly preflightBusy = signal(false);
  /** Per-item copy state (key 'source|destination' → status) reconstructed from the run's audit rows. */
  readonly copyState = computed(() => {
    const m: Record<string, { status: string; count?: number; folders?: number; error?: string }> = {};
    for (const row of this.activityRows()) {
      if (row.step_key !== 'file_copy' || row.action !== 'copy_item') { continue; }
      try {
        const d = JSON.parse(row.comments || '{}');
        const k = `${d.source}|${d.destination}`;
        if (d.source && d.destination && !m[k]) { m[k] = { status: row.status, count: d.count, folders: d.folders, error: d.error }; }
      } catch { /* not a JSON copy row */ }
    }
    return m;
  });
  readonly copyPending = computed(() => this.manifest().filter((it) => this.itemState(it) === 'pending').length);
  readonly copyFailed = computed(() => this.manifest().filter((it) => this.itemState(it) === 'failed').length);
  /** Manifest items not yet copied (failed + pending) — the target of a "copy remaining / retry" run. */
  readonly copyRemaining = computed(() => this.manifest().filter((it) => this.itemState(it) !== 'copied').length);
  /** How many items failed the last readiness check (source missing / dest unwritable / no space). */
  readonly preflightIssues = computed(() => (this.preflight() ?? []).filter((r) => !r.ok).length);
  /** True once discovery has settled and there is genuinely nothing to copy for this release — no manifest
   *  in any Scripts folder, or the manifest(s) are present but empty. The step can then be marked complete. */
  readonly nothingToCopy = computed(() => this.manifestsDiscovered() && !this.loadingManifests() && this.allManifestItems().length === 0);

  // Server Space Cleanup (Step 2) — a cleanup_manifest_<date>.json in the release repo lists disposable paths
  // to delete (free server space). DESTRUCTIVE, so it is dry-run "Preview"-able and confirmed before deleting.
  readonly cleanupLocations = signal<CleanupManifestLocation[]>([]);
  readonly selectedCleanupPath = signal<string>('');
  readonly loadingCleanupManifests = signal(false);
  readonly cleanupManifest = signal<CleanupItem[]>([]);          // the CURRENTLY SHOWN manifest (selected dropdown)
  readonly allCleanupItems = signal<CleanupItem[]>([]);          // UNION across every discovered manifest — the step
  readonly cleanupSelected = signal<number[]>([]);              // is Complete only when ALL of these are cleaned
  readonly cleanupManifestsDiscovered = signal(false);
  readonly cleanupPreview = signal<CleanupResult[] | null>(null); // last dry-run preview (deletes nothing)
  readonly cleanupPreviewBusy = signal(false);
  readonly cleanupResults = signal<CleanupResult[]>([]);          // last real run's per-path results (popup)
  readonly cleanupDetail = signal<CleanupResult[] | null>(null);  // detail popup (last run, or a clicked activity row)
  readonly cleanupInfoOpen = signal(false);                       // the ⓘ "manifest rules" popover
  /** Per-path cleanup state (path → latest status) reconstructed from the run's clean_item audit rows. */
  readonly cleanupState = computed(() => {
    const m: Record<string, { status: string; deleted?: number; bytes_freed?: number; error?: string }> = {};
    for (const row of this.activityRows()) {
      if (row.step_key !== 'space_cleanup' || row.action !== 'clean_item') { continue; }
      try {
        const d = JSON.parse(row.comments || '{}');
        if (d.path && !m[d.path]) {   // activity is newest-first → first seen is latest
          m[d.path] = { status: row.status, deleted: d.deleted, bytes_freed: d.bytes_freed, error: d.error };
        }
      } catch { /* not a JSON clean row */ }
    }
    return m;
  });
  readonly cleanupSelectedCount = computed(() => this.cleanupSelected().length);
  /** How many previewed paths reported a problem (missing path, undeletable files). */
  readonly cleanupPreviewIssues = computed(() => (this.cleanupPreview() ?? []).filter((r) => !r.ok).length);
  /** True once discovery settled and there is genuinely nothing to clean this release (no/empty manifest). */
  readonly nothingToClean = computed(() => this.cleanupManifestsDiscovered() && !this.loadingCleanupManifests() && this.allCleanupItems().length === 0);

  // Reset / Trigger — scripts come from ONE RegressionTesting folder; the operator ticks scripts (+ sequence)
  // AND ticks which DB(s) to run them on (batch/reporting only). Every selected script runs on every selected DB.
  readonly resetTriggerDbs = [
    { key: 'retail_batch', label: 'OLS RETAIL Batch' },
    { key: 'retail_reporting', label: 'OLS RETAIL Reporting' }
  ];
  readonly resetSelected = signal<string[]>([]);     // ordered — run order = array order
  readonly resetDbs = signal<string[]>(['retail_batch']);   // target DB(s) — every reset script runs on each
  readonly resetScripts = signal<string[]>([]);
  readonly resetResults = signal<RunSqlResult[]>([]);
  readonly triggerSelected = signal<string[]>([]);   // ordered — run order = array order
  readonly triggerDbs = signal<string[]>(['retail_batch']); // target DB(s) — every trigger script runs on each
  readonly triggerScripts = signal<string[]>([]);
  readonly triggerResults = signal<RunSqlResult[]>([]);

  // Release-branch browser (collapsible)
  readonly browserOpen = signal(false);
  readonly pulled = signal(false);              // a branch has been pulled → tree is meaningful
  readonly repoBranch = signal('');
  readonly repoWorkdir = signal('');
  readonly tree = signal<TreeNode[]>([]);
  readonly expanded = signal<Set<string>>(new Set<string>());
  readonly treeLoading = signal(false);

  // Viewer (sqlplus-style console for runs; file view for browsing)
  readonly logTitle = signal('');
  readonly logContent = signal('');
  readonly viewerKind = signal<'console' | 'file'>('console');
  readonly consoleCollapsed = signal(false);   // collapse the console body to just its title bar
  readonly consoleMax = signal(false);          // expand the console to a taller view
  readonly consoleRunning = signal(false);      // a live run is streaming into the console

  // Monitoring
  readonly monitorTab = signal<'batches' | 'activity'>('activity');   // Regression Activity shown first
  readonly monitorDb = signal('retail_batch');
  readonly batchResult = signal<BatchMonitorResult | null>(null);
  readonly batchError = signal(false);       // true when the last batch-monitor load failed → show a retryable message, not a stuck spinner
  readonly activityRows = signal<RegressionActivityRow[]>([]);
  readonly monitorLoading = signal(false);

  // Batch-monitor grid: AG-Grid (pagination + per-column filter + sort; virtualized for large sets).
  private readonly colorMode = inject(ColorModeService);
  readonly gridTheme = computed(() => (this.isDark() ? olsGridThemeDark : olsGridTheme));
  private isDark(): boolean {
    const m = this.colorMode.colorMode();
    if (m === 'dark') { return true; }
    if (m === 'light') { return false; }
    return this.colorMode.getPrefersColorScheme() === 'dark';
  }
  readonly batchColDefs = computed<ColDef[]>(() =>
    (this.batchResult()?.columns ?? []).map((c) => ({ field: c, headerName: c })));
  readonly batchRowData = computed<Record<string, unknown>[]>(() => {
    const br = this.batchResult();
    if (!br) { return []; }
    return br.rows.map((row) => Object.fromEntries(br.columns.map((c, i) => [c, row[i]])));
  });
  // Separate options objects per grid — AG-Grid attaches its api to the gridOptions instance, so the two
  // grids must NOT share one object. Different default page sizes too.
  readonly batchGridOptions = {
    defaultColDef: { resizable: true, sortable: true, filter: true, floatingFilter: true, minWidth: 120 },
    pagination: true,
    paginationPageSize: 50,
    paginationPageSizeSelector: [25, 50, 100, 500],
    enableCellTextSelection: true, ensureDomOrder: true,   // let the user select + copy cell text
  };
  readonly activityGridOptions = {
    defaultColDef: { resizable: true, sortable: true, filter: true, floatingFilter: true, minWidth: 120 },
    pagination: true,
    paginationPageSize: 100,
    paginationPageSizeSelector: [50, 100, 500, 1000],
    enableCellTextSelection: true, ensureDomOrder: true,   // let the user select + copy cell text
    onCellClicked: (e: { colDef?: { field?: string }; data?: RegressionActivityRow }) => this.onActivityCellClicked(e),
  };
  /** Regression Activity grid columns (paginated/filterable/sortable like the batch grid). */
  readonly activityColDefs: ColDef[] = [
    { field: 'load_dt', headerName: 'Action Date', maxWidth: 130 },
    { field: 'release_date', headerName: 'Release Date', maxWidth: 130 },
    { field: 'change_number', headerName: 'Change #', maxWidth: 150 },
    { field: 'step_key', headerName: 'Step', valueFormatter: (p) => this.stepLabel(p) },
    { field: 'action', headerName: 'Action', minWidth: 180, valueFormatter: (p) => this.activityActionLabel(p) },
    { field: 'status', headerName: 'Status', maxWidth: 130,
      cellClassRules: {
        'rg-cell--ok': (p) => p.value === 'complete',
        'rg-cell--err': (p) => p.value === 'error',
        'rg-cell--warn': (p) => p.value === 'forced' || p.value === 'partial',
      } },
    { field: 'performed_by', headerName: 'Action performed By' },
    { field: 'start_time', headerName: 'Start Date' },
    { field: 'end_time', headerName: 'End Date' },
    { field: 'task_completion_time', headerName: 'Duration', maxWidth: 120, valueFormatter: (p) => this.fmtDuration(p.value as number) },
    { field: 'comments', headerName: 'Comments', flex: 2, minWidth: 220,
      valueFormatter: (p) => this.activityCommentsLabel(p),
      cellClassRules: { 'rg-cell--link': (p) => this.isDetailRow(p.data as RegressionActivityRow) } },
  ];
  private isCopyRow(r?: RegressionActivityRow): boolean {
    return !!r && r.step_key === 'file_copy' && (r.action === 'copy' || r.action === 'copy_item');
  }
  /** True for a per-script sqlplus row (Apply/Reset/Trigger) → clickable detail popup with View/Download log. */
  private isRunSqlRow(r?: RegressionActivityRow): boolean {
    return !!r && r.action === 'run_sql';
  }
  /** True for the run-summary row → clickable popup with the per-script results table. */
  private isRunSqlDoneRow(r?: RegressionActivityRow): boolean {
    return !!r && r.action === 'run_sql_done';
  }
  /** True for a per-database Refresh DB result row → clickable popup with that DB's outcome. */
  private isRefreshRow(r?: RegressionActivityRow): boolean {
    return !!r && r.step_key === 'refresh_db' && r.action === 'refresh';
  }
  /** True for the Refresh DB run-summary row → clickable popup with the per-database results table. */
  private isRefreshDoneRow(r?: RegressionActivityRow): boolean {
    return !!r && r.step_key === 'refresh_db' && r.action === 'refresh_done';
  }
  /** True for a per-path Server-Space-Cleanup result row → clickable detail popup for that path. */
  private isCleanRow(r?: RegressionActivityRow): boolean {
    return !!r && r.step_key === 'space_cleanup' && r.action === 'clean_item';
  }
  /** True for the Server-Space-Cleanup run-summary row → clickable popup with the per-path results table. */
  private isCleanDoneRow(r?: RegressionActivityRow): boolean {
    return !!r && r.step_key === 'space_cleanup' && r.action === 'clean';
  }
  /** A row whose Comments cell opens a detail popup. */
  private isDetailRow(r?: RegressionActivityRow): boolean {
    return this.isCopyRow(r) || this.isRunSqlRow(r) || this.isRunSqlDoneRow(r)
      || this.isRefreshRow(r) || this.isRefreshDoneRow(r)
      || this.isCleanRow(r) || this.isCleanDoneRow(r);
  }
  /** Parse a per-DB refresh comment (JSON {db, message}) → its parts. */
  parseRefreshComment(comment?: string): { db: string; message: string } {
    try { const d = JSON.parse(comment || '{}'); return { db: String(d.db ?? ''), message: String(d.message ?? '') }; }
    catch { return { db: '', message: comment || '' }; }
  }
  /** Parse a per-script run_sql comment ("<script>  →  <db>  ·  <status>  ·  log: <path>") → its parts. */
  parseSqlComment(comment?: string): { script: string; db: string; status: string; log_file: string } {
    const parts = (comment || '').split('  ·  ');
    const [scriptDb = '', status = '', logPart = ''] = parts;
    const [script = '', db = ''] = scriptDb.split('  →  ');
    const log_file = logPart.startsWith('log: ') ? logPart.slice(5) : '';
    return { script: script.trim(), db: db.trim(), status: status.trim(), log_file: log_file.trim() };
  }
  /** Friendly Step-column label (raw keys like 'reset' → 'Reset batches'). */
  stepLabel(p: { value?: unknown }): string {
    const map: Record<string, string> = {
      refresh_db: 'Refresh DB', space_cleanup: 'Server Space Cleanup', apply_db: 'Apply DB changes',
      file_copy: 'File copy', reset: 'Reset batches', trigger: 'Trigger batches'
    };
    const k = String(p.value ?? '');
    return map[k] ?? k;
  }
  activityActionLabel(p: { value?: unknown; data?: RegressionActivityRow }): string {
    const r = p.data;
    if (r?.step_key === 'file_copy') {
      if (r.action === 'start') { return 'Copy Operation — Started'; }
      if (r.action === 'copy_item') { return 'Copy Operation — Item'; }
      if (r.action === 'copy') {
        return r.status === 'complete' ? 'Copy Operation — Completed'
          : r.status === 'error' ? 'Copy Operation — Errored'
          : r.status === 'partial' ? 'Copy Operation — Partially Completed' : 'Copy Operation';
      }
    }
    // Apply / Reset / Trigger run .sql files via sqlplus → a Started → Completed/Error narrative per script.
    if (r?.step_key === 'apply_db' || r?.step_key === 'reset' || r?.step_key === 'trigger') {
      if (r.action === 'start') { return 'SQL Script Execution — Started'; }
      if (r.action === 'run_sql') {
        return r.status === 'in_progress' ? 'SQL Script Execution — Started'
          : r.status === 'error' ? 'SQL Script Execution — Error' : 'SQL Script Execution — Completed';
      }
      if (r.action === 'run_sql_done') { return 'SQL Script Execution — Run summary'; }
    }
    // Refresh DB — one result row per database, then a run summary.
    if (r?.step_key === 'refresh_db') {
      if (r.action === 'refresh') {
        return r.status === 'error' ? 'Database Refresh — Error'
          : r.status === 'in_progress' ? 'Database Refresh — Started' : 'Database Refresh — Completed';
      }
      if (r.action === 'refresh_done') { return 'Database Refresh — Run summary'; }
    }
    // Server Space Cleanup — one result row per path, then a run summary.
    if (r?.step_key === 'space_cleanup') {
      if (r.action === 'start') { return 'Server Space Cleanup — Started'; }
      if (r.action === 'clean_item') {
        return r.status === 'error' ? 'Server Space Cleanup — Error' : 'Server Space Cleanup — Completed';
      }
      if (r.action === 'clean') { return 'Server Space Cleanup — Run summary'; }
    }
    return String(p.value ?? '');
  }
  activityCommentsLabel(p: { value?: unknown; data?: RegressionActivityRow }): string {
    const r = p.data;
    if (this.isCopyRow(r)) {
      try {
        const d = JSON.parse(r!.comments || '{}');
        if (r!.action === 'copy') { return `${d.summary || 'Copy results'}  ⋯`; }
        return `${r!.status === 'complete' ? 'Success' : 'Failed'} · ${d.count || 0} file(s)  ⋯`;
      } catch { /* fall through */ }
    }
    if (this.isRunSqlDoneRow(r) || this.isRefreshDoneRow(r)) {
      try { return `${JSON.parse(r!.comments || '{}').summary || 'Run summary'}  ⋯`; } catch { return `${r!.comments || ''}  ⋯`; }
    }
    if (this.isRunSqlRow(r)) {
      const d = this.parseSqlComment(r!.comments);
      const name = d.script.split(/[\\/]/).pop() || d.script;
      return `${name} → ${this.dbDisplay(d.db)} · ${d.status}  ⋯`;   // short + clickable; full detail in the popup
    }
    if (this.isRefreshRow(r)) {
      const d = this.parseRefreshComment(r!.comments);
      return `${this.dbLabel(d.db)} · ${r!.status}  ⋯`;   // short + clickable; full message in the popup
    }
    if (this.isCleanRow(r)) {
      try {
        const d = JSON.parse(r!.comments || '{}');
        const files = `${d.deleted || 0} file(s)`;
        const freed = d.bytes_freed ? ` · ${this.fmtBytes(d.bytes_freed)} freed` : '';
        return `${d.path} · ${files}${freed}  ⋯`;
      } catch { return `${r!.comments || ''}  ⋯`; }
    }
    if (this.isCleanDoneRow(r)) {
      try { return `${JSON.parse(r!.comments || '{}').summary || 'Cleanup summary'}  ⋯`; } catch { return `${r!.comments || ''}  ⋯`; }
    }
    return String(p.value ?? '');
  }
  /** Human-readable byte size ('12.0 MB', '0 B') — matches the backend/mock _fmt_bytes. */
  fmtBytes(n?: number): string {
    let b = Math.max(0, Number(n) || 0);
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let u = 0;
    while (b >= 1024 && u < units.length - 1) { b /= 1024; u++; }
    return u === 0 ? `${b} B` : `${b.toFixed(1)} ${units[u]}`;
  }
  onActivityCellClicked(e: { colDef?: { field?: string }; data?: RegressionActivityRow }): void {
    if (e.colDef?.field !== 'comments' || !this.isDetailRow(e.data)) { return; }
    if (this.isRunSqlRow(e.data)) { this.openSqlDetail(e.data!); return; }
    if (this.isRunSqlDoneRow(e.data)) { this.openSqlSummary(e.data!); return; }
    if (this.isRefreshRow(e.data)) { this.openRefreshDetail(e.data!); return; }
    if (this.isRefreshDoneRow(e.data)) { this.openRefreshSummary(e.data!); return; }
    if (this.isCleanRow(e.data)) { try { this.openCleanupDetail([JSON.parse(e.data!.comments || '{}')]); } catch { /* skip */ } return; }
    if (this.isCleanDoneRow(e.data)) {
      try { const d = JSON.parse(e.data!.comments || '{}'); if (Array.isArray(d.items)) { this.openCleanupDetail(d.items); } } catch { /* skip */ }
      return;
    }
    try {
      const d = JSON.parse(e.data!.comments || '{}');
      const items: FileCopyResult[] = e.data!.action === 'copy' ? (d.items || []) : (d.source ? [d] : []);
      if (items.length) { this.openCopyDetail(items); }
    } catch { /* not parseable */ }
  }
  /** Run-summary popup — the per-script results table for a whole Apply/Reset/Trigger run. */
  readonly sqlSummary = signal<{ summary: string; items: { script: string; db: string; status: string; log_file: string }[] } | null>(null);
  openSqlSummary(r: RegressionActivityRow): void {
    try {
      const d = JSON.parse(r.comments || '{}');
      this.sqlSummary.set({ summary: d.summary || 'Run summary', items: Array.isArray(d.items) ? d.items : [] });
    } catch { this.sqlSummary.set({ summary: r.comments || 'Run summary', items: [] }); }
  }
  closeSqlSummary(): void { this.sqlSummary.set(null); }
  /** Per-database Refresh DB detail popup (which DB, status, the refresh API message). */
  readonly refreshDetail = signal<{ db: string; status: string; message: string; start?: string; end?: string } | null>(null);
  openRefreshDetail(r: RegressionActivityRow): void {
    const d = this.parseRefreshComment(r.comments);
    this.refreshDetail.set({ db: d.db, status: r.status, message: d.message, start: r.start_time, end: r.end_time });
  }
  closeRefreshDetail(): void { this.refreshDetail.set(null); }
  /** Refresh DB run-summary popup — the per-database results table for a whole refresh action. */
  readonly refreshRunSummary = signal<{ summary: string; items: { db: string; status: string; message: string }[] } | null>(null);
  openRefreshSummary(r: RegressionActivityRow): void {
    try {
      const d = JSON.parse(r.comments || '{}');
      this.refreshRunSummary.set({ summary: d.summary || 'Refresh summary', items: Array.isArray(d.items) ? d.items : [] });
    } catch { this.refreshRunSummary.set({ summary: r.comments || 'Refresh summary', items: [] }); }
  }
  closeRefreshSummary(): void { this.refreshRunSummary.set(null); }
  /** View one script's log from the summary popup (reads the server file → works after refresh). */
  viewSummaryLog(it: { script: string; db: string; log_file: string }): void {
    if (!it.log_file) { return; }
    this.closeSqlSummary();
    this.openLog({ script: it.script, db: it.db, log_file: it.log_file } as RunSqlResult);
  }
  /** Per-script sqlplus detail popup (which file, which DB, status, timing, log path + View/Download). */
  readonly sqlDetail = signal<{ script: string; db: string; status: string; log_file: string; start?: string; end?: string; seconds?: number } | null>(null);
  openSqlDetail(r: RegressionActivityRow): void {
    const d = this.parseSqlComment(r.comments);
    this.sqlDetail.set({ ...d, start: r.start_time, end: r.end_time, seconds: r.task_completion_time });
  }
  closeSqlDetail(): void { this.sqlDetail.set(null); }
  /** View the spooled log — reads the FILE from the server (works after a refresh), shown in the console dock. */
  viewSqlLog(): void {
    const d = this.sqlDetail(); if (!d?.log_file) { void this.notifyRequired('No log file recorded for this script.'); return; }
    this.closeSqlDetail();
    this.openLog({ script: d.script, db: d.db, log_file: d.log_file } as RunSqlResult);
  }
  /** Download the spooled log directly (reads it from the server by path). */
  downloadSqlLog(): void {
    const d = this.sqlDetail(); if (!d?.log_file) { return; }
    this.svc.logRead(d.log_file).subscribe({
      next: (x) => {
        const blob = new Blob([x.content], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = ((d.script.split(/[\\/]/).pop() || 'log') + '__' + d.db).replace(/[^\w.-]+/g, '_') + '.log';
        a.click(); URL.revokeObjectURL(a.href);
      },
      error: (e) => this.fail(e, 'Could not read the log')
    });
  }

  // "Last refreshed <ts> · N sec ago" per monitor tab (reuses the Home last-synced pattern).
  private readonly destroyRef = inject(DestroyRef);
  private readonly nowTick = signal(Date.now());
  private readonly batchAt = signal<Date | null>(null);
  private readonly activityAt = signal<Date | null>(null);
  readonly batchRefreshed = computed(() => this.refreshedLabel(this.batchAt()));
  readonly activityRefreshed = computed(() => this.refreshedLabel(this.activityAt()));
  private refreshedLabel(at: Date | null): string {
    return at ? `Last refreshed ${formatDateTime(at)} · ${syncAgo(at, this.nowTick())}` : '';
  }

  readonly dateFormatOk = computed(() => /^\d{8}$/.test(this.releaseDate()));
  readonly dateKnown = computed(() => this.availableDates().includes(this.releaseDate()));
  // A CHG number is MANDATORY and must start with CHG (e.g. CHG0123456) — it gates branch loading + Start.
  readonly chgOk = computed(() => /^CHG[A-Z0-9]+$/.test(this.chgNumber().trim().toUpperCase()));
  // True once something's typed but it's not a valid CHG (drives the inline format error).
  readonly chgInvalid = computed(() => this.chgNumber().trim().length > 0 && !this.chgOk());
  // Start is enabled ONLY when the chosen date is a real release folder in the pulled branch AND a CHG is set.
  readonly canStart = computed(() => this.chgOk() && this.pulled() && this.dateKnown());
  // The date picker works in ISO (YYYY-MM-DD); releaseDate stays canonical YYYYMMDD.
  readonly releaseISO = computed(() => this.toIso(this.releaseDate()));
  readonly availableDatesLabel = computed(() => this.availableDates().map((d) => this.toIso(d)).join(', '));
  readonly applyTotal = computed(() => this.applyScripts().length);   // chg files available for this release
  private toIso(d: string): string { return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : ''; }
  setReleaseFromISO(iso: string): void { this.releaseDate.set((iso || '').replaceAll('-', '')); }
  /** Every step complete or forced → the run can be closed out. */
  readonly allStepsDone = computed(() => {
    const st = this.state().steps;
    return !!this.state().run && this.steps.every((s) => ['complete', 'forced'].includes(st[s.key]?.status ?? ''));
  });

  ngOnInit(): void {
    this.svc.runCurrent().subscribe({
      next: (s) => {
        this.state.set(s); this.loading.set(false);
        // A run already in progress when the screen loads = a resume (refresh, or someone else's run).
        // The run + step statuses come back from the DB, so gating is intact; re-hydrate the working
        // context (pulled scripts) and let the user resume or start fresh.
        if (s.run) { this.resumed.set(true); this.restoreContext(); }
      },
      error: (e) => { this.loading.set(false); this.fail(e, 'Could not load the regression run'); }
    });
    this.loadRefreshDatabases(); // env-specific DBs for this scope's Refresh-DB picker
    this.loadActivity();         // Regression Activity is the default monitoring tab
    this.loadBatches();          // preload batch status too — don't make the user click Refresh
    // Tick every second so the "N sec ago" last-refreshed labels stay live.
    interval(1000).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.nowTick.set(Date.now()));
  }

  /** Re-hydrate the pulled-branch context after a refresh/resume: branch, release date, scripts, and the
   *  current release's chg-per-DB so Apply/Reset/Trigger work again without re-pulling. */
  private restoreContext(): void {
    const run = this.state().run;
    if (run?.git_branch) { this.selectedBranch.set(run.git_branch); this.repoBranch.set(run.git_branch); }
    if (run?.release_date) { this.releaseDate.set(run.release_date); }
    this.svc.gitScripts().subscribe({
      next: (r) => { if (r.scripts?.length) { this.scripts.set(r.scripts); this.pulled.set(true); } }
    });
    this.svc.releaseDates().subscribe({ next: (r) => this.availableDates.set(r.release_dates ?? []) });
    if (run?.release_date) { this.loadReleaseScripts(); this.loadManifests(); this.loadCleanupManifests(); }
    this.loadResetScripts(); this.loadTriggerScripts();       // RegressionTesting scripts for the default DB
  }

  /** Dismiss the resume banner and keep working on the existing run. */
  resumeRun(): void { this.resumed.set(false); }

  /** Abandon the in-progress run (logged) and open a brand-new one. */
  async startFresh(): Promise<void> {
    const old = this.runId;
    const ok = await this.confirm.ask({
      title: 'Start a fresh run',
      message: `Abandon regression run #${old} and start a new one? The old run is closed out (logged as abandoned).`,
      confirmLabel: 'Start fresh', tone: 'danger'
    });
    if (!ok) { return; }
    this.resumed.set(false);
    this.svc.completeRun(old, 'abandoned').subscribe({
      next: () => this.newRun(),                    // back to the start panel — pick branch + release date again
      error: (e) => this.fail(e, 'Could not close the old run')
    });
  }

  /** Re-read the run + step state + activity from the backend (e.g. after a dropped connection). */
  refreshState(): void {
    this.reloadState();
    this.restoreContext();
    this.toast.set({ kind: 'info', text: 'State refreshed.' });
  }

  // --- run + step helpers ----------------------------------------------------
  get runId(): number { return this.state().run?.run_id ?? 0; }

  stepStatus(key: string): string { return this.state().steps[key]?.status ?? 'not_started'; }
  stepMeta(key: string) { return this.state().steps[key]; }

  /** Step N enabled once N-1 is complete or forced (step 0 always enabled). */
  isEnabled(index: number): boolean {
    if (!this.state().run) { return false; }
    if (index === 0) { return true; }
    const prev = this.stepStatus(this.steps[index - 1].key);
    return prev === 'complete' || prev === 'forced';
  }

  badgeClass(status: string): string {
    switch (status) {
      case 'complete': return 'st-complete';
      case 'forced': return 'st-forced';
      case 'error': return 'st-error';
      case 'partial': return 'st-partial';
      case 'in_progress': return 'st-progress';
      default: return 'st-none';
    }
  }
  badgeLabel(status: string): string {
    return { complete: 'Complete', forced: 'Forced', error: 'Error', partial: 'Partial', in_progress: 'In progress', not_started: 'Not started' }[status] ?? status;
  }
  /** Status to show: while this step is actively running, reflect "In progress". */
  effectiveStatus(key: string): string { return this.busy() === key ? 'in_progress' : this.stepStatus(key); }

  /** Timestamp of the last time this step ran (for the "last run" line). */
  lastRun(key: string): string { const m = this.stepMeta(key); return m?.end_time || m?.start_time || ''; }
  stepBy(key: string): string { return this.stepMeta(key)?.performed_by ?? ''; }

  // --- concurrency lock + stuck detection ------------------------------------
  isStepRunning(key: string): boolean { return this.stepStatus(key) === 'in_progress'; }
  isStepStale(key: string): boolean { return this.stepMeta(key)?.stale === true; }
  /** Locked = actively running and not stale → nobody may re-run it until it finishes/errors. */
  isStepLocked(key: string): boolean { return this.isStepRunning(key) && !this.isStepStale(key); }
  stepAgeMin(key: string): number { return Math.max(1, Math.round((this.stepMeta(key)?.age_seconds ?? 0) / 60)); }

  /** Clear a step stuck in_progress (crash/drop) so the run isn't deadlocked. Logged. */
  async unlockStep(step: StepDef): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Unlock step',
      message: `“${step.title}” has been running with no result — the server or connection may have dropped. Clear it so it can be re-run? This is logged.`,
      confirmLabel: 'Unlock', tone: 'danger'
    });
    if (!ok) { return; }
    this.svc.unlockStep(this.runId, step.key).subscribe({
      next: () => { this.toast.set({ kind: 'info', text: `${step.title} unlocked — you can re-run it.` }); this.reloadState(); },
      error: (e) => this.fail(e, 'Could not unlock the step')
    });
  }
  hasRun(key: string): boolean {
    const s = this.stepStatus(key);
    return s === 'complete' || s === 'forced' || s === 'error' || s === 'in_progress';
  }

  /**
   * Confirm before running a step. If the step is already complete/forced, warn that it's already
   * done and ask whether to run it again; otherwise show the normal action confirm.
   */
  private confirmStepRun(step: StepDef, message: string, confirmLabel: string): Promise<boolean> {
    const st = this.stepStatus(step.key);
    if (st === 'complete' || st === 'forced') {
      return this.confirm.ask({
        title: `${step.title} already completed`,
        message: `“${step.title}” is already marked ${st === 'forced' ? 'forced complete' : 'complete'}. Are you sure you want to run it again?`,
        confirmLabel: 'Run again', tone: 'danger'
      });
    }
    return this.confirm.ask({ title: step.title, message, confirmLabel, tone: 'danger' });
  }
  private step(key: string): StepDef { return this.steps.find((s) => s.key === key)!; }

  /** Start a run for a specific release: the pulled branch + the entered release date (hard-validated
   *  server-side against the folders in that branch — a wrong/absent date is rejected, no run created). */
  startRun(): void {
    const b = this.selectedBranch();
    const d = this.releaseDate();
    const chg = this.chgNumber().trim().toUpperCase();
    if (!this.chgOk()) { void this.notifyRequired('Enter a valid Change (CHG) number — it must start with CHG (e.g. CHG0123456).'); return; }
    if (!b || !this.pulled()) { void this.notifyRequired('Select a release branch and Pull it first.'); return; }
    if (!/^\d{8}$/.test(d)) { void this.notifyRequired('Enter the release date as YYYYMMDD (e.g. 20260910).'); return; }
    this.starting.set(true);
    this.svc.runStart(b, d, chg).subscribe({
      next: (s) => {
        this.starting.set(false);
        this.state.set(s); this.toast.set({ kind: 'ok', text: `Regression run started for ${chg} · release ${d}.` });
        this.lastCompleted.set(null); this.resumed.set(false);
        this.applyScripts.set([]); this.applyFileDbs.set({}); this.applyOrder.set([]); this.applyResults.set([]);
        this.manifestLocations.set([]); this.selectedManifestPath.set(''); this.manifest.set([]);
        this.cleanupLocations.set([]); this.selectedCleanupPath.set(''); this.cleanupManifest.set([]);
        this.loadReleaseScripts();     // preload the default DB(s)' chg for this release
        this.loadResetScripts(); this.loadTriggerScripts();   // RegressionTesting scripts for the default DB
        this.loadManifests();          // discover file-copy manifest(s) for this release
        this.loadCleanupManifests();   // discover cleanup manifest(s) for this release
        this.loadActivity();
      },
      error: (e) => { this.starting.set(false); this.fail(e, 'Could not start the run'); }
    });
  }

  // --- collapsible steps -----------------------------------------------------
  isStepCollapsed(key: string): boolean { return !!this.stepCollapsed()[key]; }
  toggleStepCollapse(key: string): void { this.stepCollapsed.update((m) => ({ ...m, [key]: !m[key] })); }

  /** Return to the "start a run" panel (after completing/abandoning) so the user picks a branch + date. */
  newRun(): void {
    this.state.set({ run: null, steps: {} });
    this.resumed.set(false);
    this.pulled.set(false); this.tree.set([]); this.scripts.set([]); this.repoBranch.set(''); this.repoWorkdir.set('');
    this.chgNumber.set(''); this.branches.set([]);
    this.selectedBranch.set(''); this.releaseDate.set(''); this.availableDates.set([]);
    this.applyScripts.set([]); this.applyFileDbs.set({}); this.applyOrder.set([]); this.applyResults.set([]);
  }

  /** Close out the run once every step is complete/forced — logs completion + marks it finished. */
  async completeRun(): Promise<void> {
    const rid = this.runId;
    const ok = await this.confirm.ask({
      title: 'Complete regression run',
      message: `Mark regression run #${rid} complete? This closes out the cycle and is logged.`,
      confirmLabel: 'Complete run', tone: 'success'
    });
    if (!ok) { return; }
    this.svc.completeRun(rid).subscribe({
      next: () => {
        this.lastCompleted.set(rid);
        // keep the completed run on screen (pill → Completed, activity shows the entry) rather than
        // collapsing to the start prompt — just mark it complete locally and refresh the audit log.
        this.state.update((s) => (s.run ? { ...s, run: { ...s.run, status: 'complete' } } : s));
        this.toast.set({ kind: 'ok', text: `Regression run #${rid} completed.` });
        this.loadActivity();
      },
      error: (e) => this.fail(e, 'Could not complete the run')
    });
  }

  /** A single-button popup for "you must select X first" validation (per user request, not a toast). */
  private notifyRequired(message: string): Promise<boolean> {
    return this.confirm.notify({ title: 'Selection required', message, tone: 'danger' });
  }

  private reloadState(): void {
    this.svc.runCurrent().subscribe({ next: (s) => this.state.set(s) });
    this.loadActivity();
  }

  async forceComplete(step: StepDef): Promise<void> {
    // Already done (run or forced)? Block re-forcing with a warning naming the release.
    const st = this.stepStatus(step.key);
    if (st === 'complete' || st === 'forced') {
      await this.notifyRequired(`“${step.title}” is already ${st === 'forced' ? 'force-' : ''}completed for release ${this.state().run?.release_date ?? ''}. There's nothing to force.`);
      return;
    }
    const ok = await this.confirm.ask({
      title: 'Force-mark complete',
      message: `Force “${step.title}” to Complete without running it? This is logged as a forced override.`,
      confirmLabel: 'Force complete', tone: 'danger'
    });
    if (!ok) { return; }
    this.svc.markStep(this.runId, step.key, 'complete', true, 'Force-marked complete').subscribe({
      next: () => { this.toast.set({ kind: 'info', text: `${step.title} force-marked complete.` }); this.reloadState(); },
      error: (e) => this.fail(e, 'Could not force the step')
    });
  }

  async markComplete(step: StepDef): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Mark complete', message: `Mark “${step.title}” complete?`, confirmLabel: 'Mark complete', tone: 'primary'
    });
    if (!ok) { return; }
    this.svc.markStep(this.runId, step.key, 'complete').subscribe({
      next: () => this.reloadState(), error: (e) => this.fail(e, 'Could not mark the step')
    });
  }

  // --- step 1: Refresh DB ----------------------------------------------------
  /** Load this scope's refreshable DBs for the current env (DEV/STG may have several). */
  loadRefreshDatabases(): void {
    this.svc.refreshDatabases().subscribe({
      next: (r) => this.refreshDbList.set(r.databases ?? []),
      error: (e) => this.fail(e, 'Could not load the databases for this environment')
    });
  }
  toggleRefreshDb(d: string): void { this.refreshDbs.set(this.toggle(this.refreshDbs(), d)); }
  toggleRefreshOpen(): void { this.refreshOpen.set(!this.refreshOpen()); }
  closeRefreshMenu(): void { this.refreshOpen.set(false); }
  /** Select all / none of this env's refreshable DBs. */
  toggleAllRefreshDbs(): void {
    const all = this.refreshDbList().map((d) => d.key);
    this.refreshDbs.set(this.refreshDbs().length === all.length ? [] : all);
  }
  /** Select all / none within one category group. */
  toggleGroupRefreshDbs(dbs: RegressionDb[]): void {
    const keys = dbs.map((d) => d.key);
    const allOn = keys.every((k) => this.refreshDbs().includes(k));
    const cur = new Set(this.refreshDbs());
    keys.forEach((k) => (allOn ? cur.delete(k) : cur.add(k)));
    this.refreshDbs.set([...cur]);
  }
  groupAllOn(dbs: RegressionDb[]): boolean { return dbs.length > 0 && dbs.every((d) => this.refreshDbs().includes(d.key)); }

  async refreshDb(): Promise<void> {
    if (!this.refreshDbs().length) { await this.notifyRequired('Select at least one database to refresh.'); return; }
    const names = this.refreshDbs().map((k) => this.dbLabel(k)).join(', ');
    const n = this.refreshDbs().length;
    const ok = await this.confirmStepRun(this.step('refresh_db'),
      `Refresh ${n} database${n === 1 ? '' : 's'} via the refresh API?\n\n${names}`, 'Refresh');
    if (!ok) { return; }
    this.busy.set('refresh_db');
    this.svc.refreshDb(this.runId, this.refreshDbs()).subscribe({
      next: (r) => {
        this.busy.set('');
        const failed = r.result?.status === 'error';
        this.toast.set({ kind: failed ? 'err' : 'ok', text: r.result?.message ?? 'Refresh completed.' });
        this.reloadState(); this.loadActivity();
      },
      error: (e) => { this.busy.set(''); this.fail(e, 'Refresh failed'); }
    });
  }

  // --- step 2: Apply DB (git) ------------------------------------------------
  loadBranches(): void {
    if (!this.chgOk()) { void this.notifyRequired('Enter a valid Change (CHG) number first — it must start with CHG (e.g. CHG0123456).'); return; }
    this.svc.gitBranches().subscribe({
      next: (r) => this.branches.set(r.branches ?? []),
      error: (e) => this.fail(e, 'Could not list release branches')
    });
  }
  pullBranch(): void {
    const b = this.selectedBranch();
    if (!b) { return; }
    this.pulling.set(true);
    this.svc.gitPull(b).subscribe({
      next: (r) => {
        this.pulling.set(false);
        this.pulled.set(true);
        this.repoBranch.set(b);            // reflect the just-pulled branch immediately
        this.scripts.set(r.scripts ?? []);
        this.availableDates.set(r.release_dates ?? []);   // release folders in THIS branch → the date hint
        this.tree.set([]);                 // drop the previous branch's tree; reload for this one
        const nd = r.release_dates?.length ?? 0;
        this.toast.set({ kind: 'ok', text: `Pulled ${b} — ${nd} release date(s) found.` });
        if (this.browserOpen()) { this.loadTree(); }
      },
      error: (e) => { this.pulling.set(false); this.fail(e, 'Pull failed'); }
    });
  }

  // --- release-branch browser -----------------------------------------------
  toggleBrowser(): void {
    const open = !this.browserOpen();
    this.browserOpen.set(open);
    // only load the tree once a branch has actually been pulled (otherwise show the "pull first" hint)
    if (open && this.pulled() && !this.tree().length) { this.loadTree(); }
  }
  private loadTree(): void {
    this.treeLoading.set(true);
    this.svc.gitTree().subscribe({
      next: (r) => {
        this.treeLoading.set(false);
        this.repoBranch.set(r.branch); this.repoWorkdir.set(r.workdir);
        this.tree.set(this.buildTree(r.files ?? []));
        this.expanded.set(new Set(this.tree().filter((n) => n.dir).map((n) => n.path)));
      },
      error: (e) => { this.treeLoading.set(false); this.fail(e, 'Could not load the branch tree'); }
    });
  }
  private buildTree(files: string[]): TreeNode[] {
    const root: TreeNode = { name: '', path: '', dir: true, children: [] };
    for (const f of files) {
      const parts = f.split('/');
      let node = root; let acc = '';
      parts.forEach((part, i) => {
        acc = acc ? `${acc}/${part}` : part;
        const isDir = i < parts.length - 1;
        let child = node.children.find((c) => c.name === part && c.dir === isDir);
        if (!child) { child = { name: part, path: acc, dir: isDir, children: [] }; node.children.push(child); }
        node = child;
      });
    }
    const sortNode = (n: TreeNode) => {
      n.children.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      n.children.forEach(sortNode);
    };
    sortNode(root);
    return root.children;
  }
  isExpanded(path: string): boolean { return this.expanded().has(path); }
  toggleDir(path: string): void {
    const s = new Set(this.expanded());
    if (s.has(path)) { s.delete(path); } else { s.add(path); }
    this.expanded.set(s);
  }
  viewFile(path: string): void {
    this.svc.gitFile(path).subscribe({
      next: (r) => {
        this.viewerKind.set('file'); this.consoleCollapsed.set(false); this.consoleMax.set(false);
        this.logTitle.set(path); this.logContent.set(r.content);
      },
      error: (e) => this.fail(e, 'Could not read the file')
    });
  }
  /** Load ALL chg*.sql for this release from the scope's SINGLE Scripts folder. The operator then decides,
   *  per file, which DB(s) to run it on (+ the sequence). A re-scan preserves your existing per-file picks. */
  loadReleaseScripts(): void {
    const d = this.state().run?.release_date;
    if (!d) { this.applyScripts.set([]); this.applyFileDbs.set({}); this.applyOrder.set([]); return; }
    const seq = ++this.applyLoadSeq;   // guard: only the newest load may apply its result
    this.loadingApply.set(true);
    this.svc.releaseScripts(d).subscribe({
      next: (r) => {
        if (seq !== this.applyLoadSeq) { return; }
        this.loadingApply.set(false);
        const list = r.scripts ?? [];
        this.applyScripts.set(list);
        // Keep prior per-file DB picks + order for files that still exist in the branch.
        const keep: Record<string, string[]> = {};
        for (const [f, dbs] of Object.entries(this.applyFileDbs())) { if (list.includes(f) && dbs.length) { keep[f] = dbs; } }
        this.applyFileDbs.set(keep);
        this.applyOrder.set(this.applyOrder().filter((f) => keep[f]?.length));
      },
      error: (e) => { if (seq === this.applyLoadSeq) { this.loadingApply.set(false); } this.fail(e, 'Could not load release scripts'); }
    });
  }
  applyDbsOf(file: string): string[] { return this.applyFileDbs()[file] ?? []; }
  applyFileHas(file: string, db: string): boolean { return this.applyDbsOf(file).includes(db); }
  applyFileRuns(file: string): boolean { return this.applyDbsOf(file).length > 0; }
  applyFileName(file: string): string { return file.split('/').pop() || file; }
  /** Keep a file's DB list in the fixed `databases` order (so per-file DB order is stable). */
  private applyOrderDbs(keys: Set<string>): string[] { return this.databases.map((x) => x.key).filter((k) => keys.has(k)); }
  /** Tick/untick one DB for one file. A file joins the run sequence when it gets its first DB and leaves it
   *  when the last DB is removed (a file with no DB ticked is simply not run). */
  toggleApplyFileDb(file: string, db: string): void {
    const map = { ...this.applyFileDbs() };
    const cur = new Set(map[file] ?? []);
    cur.has(db) ? cur.delete(db) : cur.add(db);
    const had = (map[file]?.length || 0) > 0;
    map[file] = this.applyOrderDbs(cur);
    this.applyFileDbs.set(map);
    this.syncApplyOrder(file, map[file].length > 0, had);
  }
  /** Select all / clear the 5 DBs for one file. */
  toggleApplyFileAllDbs(file: string): void {
    const all = this.databases.map((x) => x.key);
    const map = { ...this.applyFileDbs() };
    const had = (map[file]?.length || 0) > 0;
    map[file] = (map[file]?.length || 0) === all.length ? [] : [...all];
    this.applyFileDbs.set(map);
    this.syncApplyOrder(file, map[file].length > 0, had);
  }
  applyFileAllDbsOn(file: string): boolean { return this.applyDbsOf(file).length === this.databases.length; }
  private syncApplyOrder(file: string, hasDbs: boolean, hadDbs: boolean): void {
    if (hasDbs && !hadDbs) { this.applyOrder.set([...this.applyOrder(), file]); }
    else if (!hasDbs && hadDbs) { this.applyOrder.set(this.applyOrder().filter((f) => f !== file)); }
  }
  applyFileOrder(file: string): number { return this.applyOrder().indexOf(file) + 1; }   // 0 = not running
  moveApplyFile(file: string, dir: -1 | 1): void { this.moveInList(this.applyOrder, file, dir); }
  applyFileIsFirst(file: string): boolean { return this.applyFileOrder(file) <= 1; }
  applyFileIsLast(file: string): boolean { return this.applyFileOrder(file) >= this.applyOrder().length; }

  async runApply(): Promise<void> {
    const d = this.state().run?.release_date;
    if (!d) { await this.notifyRequired('This run has no release date.'); return; }
    // Ordered (script → DB) executions: each file in sequence, on each of its ticked DBs.
    const executions = this.applyOrder().flatMap((f) => this.applyDbsOf(f).map((db) => ({ script: f, db })));
    if (!executions.length) { await this.notifyRequired('Tick at least one database for at least one chg file.'); return; }
    const dbCount = new Set(executions.map((e) => e.db)).size;
    const ok = await this.confirmStepRun(this.step('apply_db'),
      `Run ${this.applyOrder().length} chg file(s) — ${executions.length} execution(s) across ${dbCount} database(s) — for release ${d}, in the listed order?`, 'Apply');
    if (!ok) { return; }
    this.applyResults.set([]);
    this.busy.set('apply_db');
    this.viewerKind.set('console'); this.consoleCollapsed.set(false); this.consoleMax.set(false); this.consoleRunning.set(true);
    this.logTitle.set('Execution log — running…'); this.logContent.set('');
    this.svc.runSqlStream(this.runId, 'apply_db', [], [], {
      line: (t) => { if (this.consoleRunning()) { this.logContent.update((c) => (c ? `${c}\n${t}` : t)); } },
      result: (r) => this.applyResults.update((a) => [...a, r]),
      step: () => { /* status folded into the final summary */ },
      done: () => {
        this.busy.set(''); this.consoleRunning.set(false);
        const anyErr = this.applyResults().some((r) => r.status !== 'complete');
        this.logTitle.set(anyErr ? 'Execution log — completed with errors' : 'Execution log');
        this.toast.set(anyErr ? { kind: 'err', text: 'Apply completed with errors — check the console.' }
                              : { kind: 'ok', text: 'Apply completed successfully.' });
        this.reloadState();
      },
      error: (e) => { this.busy.set(''); this.consoleRunning.set(false); this.fail(e, 'Apply failed'); }
    }, undefined, executions);
  }
  private applyLoadSeq = 0;   // increments per loadReleaseScripts call; only the latest response is applied
  private manifestLoadSeq = 0; // same guard for selectManifest (fast Batch↔Reporting switches)

  // --- step 3: File copy -----------------------------------------------------
  /** Discover filecopy_manifest*.json in the pulled branch for this run's release → dropdown(s). */
  loadManifests(): void {
    const d = this.state().run?.release_date;
    if (!d) { this.manifestLocations.set([]); this.allManifestItems.set([]); this.manifestsDiscovered.set(false); return; }
    this.loadingManifests.set(true);
    this.manifestsDiscovered.set(false);
    this.svc.fileCopyManifests(d).subscribe({
      next: (r) => {
        this.loadingManifests.set(false);
        const locs = r.locations ?? [];
        this.manifestLocations.set(locs);
        const all = locs.flatMap((l) => l.files);
        this.loadAllManifestItems(all);   // union of EVERY discovered manifest → drives step Complete/Partial
        if (all.length === 1 && !this.selectedManifestPath()) { this.selectManifest(all[0]); }
      },
      error: (e) => { this.loadingManifests.set(false); this.fail(e, 'Could not discover file-copy manifests'); }
    });
  }
  /** Fetch every discovered manifest's items and union them (dedup by source|destination) so the step is
   *  Complete only when ALL files across BOTH folders (Batch + Reporting) are copied — copying just one
   *  folder's manifest leaves the step Partial, not Complete. */
  private loadAllManifestItems(paths: string[]): void {
    if (!paths.length) { this.allManifestItems.set([]); this.manifestsDiscovered.set(true); return; }
    forkJoin(paths.map((p) => this.svc.fileCopyManifest(p))).subscribe({
      next: (resList) => {
        const seen = new Set<string>(); const union: FileCopyItem[] = [];
        for (const res of resList) {
          for (const it of (res.items ?? [])) {
            const k = `${it.source}|${it.destination}`;
            if (!seen.has(k)) { seen.add(k); union.push(it); }
          }
        }
        this.allManifestItems.set(union);
        this.manifestsDiscovered.set(true);
      },
      error: () => { this.manifestsDiscovered.set(true); /* keep what we had; selected manifest still governs the copy */ }
    });
  }
  /** No files to copy for this release (no manifest, or empty manifest) → complete the step cleanly (logged,
   *  NOT a force-override, since there is legitimately nothing to do). */
  async markNothingToCopy(): Promise<void> {
    const note = this.manifestLocations().length
      ? 'Manifest(s) present but empty — no files to copy for this release.'
      : 'No file-copy manifest for this release — nothing to copy.';
    const ok = await this.confirm.ask({
      title: 'Nothing to copy', message: `${note} Mark the File copy step complete?`,
      confirmLabel: 'Mark complete', tone: 'primary'
    });
    if (!ok) { return; }
    this.svc.markStep(this.runId, 'file_copy', 'complete', false, note).subscribe({
      next: () => { this.toast.set({ kind: 'ok', text: 'File copy marked complete — nothing to copy.' }); this.reloadState(); this.loadActivity(); },
      error: (e) => this.fail(e, 'Could not mark the step complete')
    });
  }
  /** Load the chosen manifest's items; pre-tick the not-yet-copied ones. Switching folders (Batch ↔
   *  Reporting) clears the previous manifest's transient view (last result / progress / pre-flight) so
   *  nothing from the other folder lingers, and a load-guard ignores a stale response from a fast switch. */
  selectManifest(path: string): void {
    this.selectedManifestPath.set(path);
    this.copyResults.set([]); this.copyDetail.set(null); this.preflight.set(null);   // drop the other manifest's view
    if (this.busy() !== 'file_copy') { this.copyProgress.set(null); }                // keep an in-flight copy's bar
    if (!path) { this.manifest.set([]); this.selectedItems.set([]); return; }
    const seq = ++this.manifestLoadSeq;
    this.svc.fileCopyManifest(path).subscribe({
      next: (r) => {
        if (seq !== this.manifestLoadSeq) { return; }   // a later switch superseded this response
        const items = r.items ?? [];
        this.manifest.set(items);
        this.selectedItems.set(items.map((_, i) => i).filter((i) => this.itemState(items[i]) !== 'copied'));
      },
      error: (e) => this.fail(e, 'Could not read the manifest')
    });
  }
  itemState(it: FileCopyItem): 'copied' | 'failed' | 'pending' {
    const s = this.copyState()[`${it.source}|${it.destination}`];
    return s?.status === 'complete' ? 'copied' : s?.status === 'error' ? 'failed' : 'pending';
  }
  toggleItem(i: number): void {
    const cur = this.selectedItems();
    this.selectedItems.set(cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]);
  }
  toggleAllItems(): void {
    this.selectedItems.set(this.selectedItems().length === this.manifest().length ? [] : this.manifest().map((_, i) => i));
  }
  friendly(p: string): string {
    // \\server\d$\path -> d:\path (display only; the real UNC is sent to the backend)
    const m = /^\\\\[^\\]+\\([a-zA-Z])\$\\(.*)$/.exec(p);
    return m ? `${m[1].toLowerCase()}:\\${m[2]}` : p;
  }
  /** LIVE copy of the ticked items — progress bar + per-file ✓/✗, then the detail popup. */
  async runCopy(): Promise<void> {
    const items = this.selectedItems().map((i) => this.manifest()[i]).filter(Boolean);
    if (!items.length) { await this.notifyRequired('Tick at least one file to copy.'); return; }
    const ok = await this.confirmStepRun(this.step('file_copy'), `Copy ${items.length} item(s) to their destinations?`, 'Copy');
    if (!ok) { return; }
    this.busy.set('file_copy');
    this.copyResults.set([]);
    this.preflight.set(null);   // a new copy supersedes the last readiness check
    this.copyProgress.set({ done: 0, total: items.length });
    // finalize the step against EVERY discovered manifest (Batch + Reporting), not just the selected one,
    // so copying one folder leaves the step Partial until the other is copied too.
    const fullManifest = this.allManifestItems().length ? this.allManifestItems() : this.manifest();
    this.svc.fileCopyRunStream(this.runId, items, fullManifest, {
      item: (r, done, total) => { this.copyResults.update((a) => [...a, r]); this.copyProgress.set({ done, total }); },
      step: () => { /* badge updates from reloadState */ },
      done: () => {
        this.busy.set(''); this.copyProgress.set(null);
        const fails = this.copyResults().filter((x) => !x.ok).length;
        this.copyDetail.set(this.copyResults());
        this.toast.set(fails ? { kind: 'err', text: `${fails} item(s) failed — see details.` } : { kind: 'ok', text: 'Copy completed.' });
        this.reloadState(); this.loadActivity();
      },
      error: (e) => { this.busy.set(''); this.copyProgress.set(null); this.fail(e, 'File copy failed'); }
    });
  }
  openCopyDetail(items: FileCopyResult[]): void { this.copyDetail.set(items); }
  closeCopyDetail(): void { this.copyDetail.set(null); }
  /** Readiness check for the ticked items BEFORE copying — source exists / dest writable / free space. */
  runPreflight(): void {
    const items = this.selectedItems().map((i) => this.manifest()[i]).filter(Boolean);
    if (!items.length) { void this.notifyRequired('Tick at least one file to check.'); return; }
    this.preflightBusy.set(true);
    this.svc.fileCopyPreflight(items).subscribe({
      next: (r) => {
        this.preflightBusy.set(false);
        this.preflight.set(r.results ?? []);
        const bad = (r.results ?? []).filter((x) => !x.ok).length;
        this.toast.set(bad
          ? { kind: 'err', text: `Pre-flight found ${bad} issue(s) — resolve before copying.` }
          : { kind: 'ok', text: 'Pre-flight passed — all sources, destinations and space look good.' });
      },
      error: (e) => { this.preflightBusy.set(false); this.fail(e, 'Pre-flight check failed'); }
    });
  }
  /** Re-copy only the items not yet copied (failed + pending) — drives a Partial/Error step toward Complete. */
  retryFailed(): void {
    const items = this.manifest();
    const idx = items.map((_, i) => i).filter((i) => this.itemState(items[i]) !== 'copied');
    if (!idx.length) { return; }
    this.selectedItems.set(idx);
    void this.runCopy();
  }
  /** Human-readable duration: '8s', '2m 30s', '1h 05m' — never a raw '600s' for a 10-minute copy. */
  fmtDuration(secs?: number): string {
    if (secs == null) { return '—'; }
    const s = Math.max(0, Math.round(secs));
    if (s < 60) { return `${s}s`; }
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) { return rs ? `${m}m ${rs}s` : `${m}m`; }
    const h = Math.floor(m / 60), rm = m % 60;
    return rm ? `${h}h ${String(rm).padStart(2, '0')}m` : `${h}h`;
  }
  /** Label for how a copied item was integrity-checked (shown in the popup Verified column + CSV). */
  verifyLabel(r: FileCopyResult): string {
    if (!r.ok) { return '—'; }
    if (r.verified === false || r.verify === 'off') { return 'off'; }
    return r.verify === 'hash' ? '✓ hash' : '✓ size';
  }
  /** One-line totals for the shown results (popup header): items OK, files, folders, elapsed, failures. */
  copySummary(rows: FileCopyResult[]): string {
    const ok = rows.filter((r) => r.ok).length;
    const fails = rows.length - ok;
    const files = rows.reduce((n, r) => n + (r.count || 0), 0);
    const folders = rows.reduce((n, r) => n + (r.folders || 0), 0);
    const secs = rows.reduce((n, r) => n + (r.seconds || 0), 0);
    const parts = [`${ok}/${rows.length} item(s) OK`, `${files} file(s)`];
    if (folders) { parts.push(`${folders} folder(s)`); }
    parts.push(`${this.fmtDuration(secs)} total`);
    if (fails) { parts.push(`${fails} failed`); }
    return parts.join('  ·  ');
  }
  /** Folder slug for the report filename (from the manifest path) so batch vs reporting downloads differ. */
  private reportSlug(): string {
    const p = this.selectedManifestPath();
    if (p) {
      const parts = p.split(/[\\/]/).filter(Boolean).slice(0, -1)   // drop the manifest filename
        .filter((x) => !/^\d{8}$/.test(x));                          // drop the YYYYMMDD release folder
      if (parts.length) { return parts.join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
    }
    return 'retail';
  }
  /** Export the shown per-item results as a CSV audit artifact (attach to the release ticket). */
  downloadCopyReport(): void {
    const rows = this.copyDetail() ?? [];
    if (!rows.length) { return; }
    const head = ['Source', 'Destination', 'Status', 'Files', 'Folders', 'Verified', 'Started', 'Finished', 'Seconds', 'Duration', 'Error'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [head.map(esc).join(',')];
    for (const r of rows) {
      lines.push([r.source, r.destination, r.ok ? 'Success' : 'Failed', r.count || 0, r.folders || 0,
        r.ok ? (r.verified === false ? 'off' : (r.verify || 'size')) : '', r.started || '', r.finished || '',
        r.seconds ?? '', r.seconds == null ? '' : this.fmtDuration(r.seconds), r.error || ''].map(esc).join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `filecopy-report-${this.reportSlug()}-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // --- step 2: Server Space Cleanup -----------------------------------------
  private cleanupLoadSeq = 0;   // guard for fast manifest switches (drop a stale response)
  /** Discover cleanup manifest(s) in the pulled branch for this release → labelled dropdown(s) per folder. */
  loadCleanupManifests(): void {
    const d = this.state().run?.release_date;
    if (!d) { this.cleanupLocations.set([]); this.allCleanupItems.set([]); this.cleanupManifestsDiscovered.set(false); return; }
    this.loadingCleanupManifests.set(true);
    this.cleanupManifestsDiscovered.set(false);
    this.svc.cleanupManifests(d).subscribe({
      next: (r) => {
        this.loadingCleanupManifests.set(false);
        const locs = r.locations ?? [];
        this.cleanupLocations.set(locs);
        const all = locs.flatMap((l) => l.files);
        this.loadAllCleanupItems(all);
        if (all.length === 1 && !this.selectedCleanupPath()) { this.selectCleanupManifest(all[0]); }   // single → auto-open
      },
      error: (e) => { this.loadingCleanupManifests.set(false); this.fail(e, 'Could not discover cleanup manifests'); }
    });
  }
  /** Union every discovered manifest's entries (dedup by path) → the step is Complete only when ALL paths are cleaned. */
  private loadAllCleanupItems(paths: string[]): void {
    if (!paths.length) { this.allCleanupItems.set([]); this.cleanupManifestsDiscovered.set(true); return; }
    forkJoin(paths.map((p) => this.svc.cleanupManifest(p))).subscribe({
      next: (resList) => {
        const seen = new Set<string>(); const union: CleanupItem[] = [];
        for (const res of resList) {
          for (const it of (res.items ?? [])) {
            if (it.path && !seen.has(it.path)) { seen.add(it.path); union.push(it); }
          }
        }
        this.allCleanupItems.set(union);
        this.cleanupManifestsDiscovered.set(true);
      },
      error: () => { this.cleanupManifestsDiscovered.set(true); }
    });
  }
  /** Load the chosen cleanup manifest; pre-tick the not-yet-cleaned paths; drop the other folder's transient view. */
  selectCleanupManifest(path: string): void {
    this.selectedCleanupPath.set(path);
    this.cleanupResults.set([]); this.cleanupDetail.set(null); this.cleanupPreview.set(null);
    if (!path) { this.cleanupManifest.set([]); this.cleanupSelected.set([]); return; }
    const seq = ++this.cleanupLoadSeq;
    this.svc.cleanupManifest(path).subscribe({
      next: (r) => {
        if (seq !== this.cleanupLoadSeq) { return; }
        const items = r.items ?? [];
        this.cleanupManifest.set(items);
        this.cleanupSelected.set(items.map((_, i) => i).filter((i) => this.cleanupItemState(items[i]) !== 'cleaned'));
      },
      error: (e) => this.fail(e, 'Could not read the cleanup manifest')
    });
  }
  /** Per-path cleanup state for the manifest row: cleaned ✓ / failed ✗ / pending ⏳. */
  cleanupItemState(it: CleanupItem): 'cleaned' | 'failed' | 'pending' {
    const s = this.cleanupState()[it.path];
    return s?.status === 'complete' ? 'cleaned' : s?.status === 'error' ? 'failed' : 'pending';
  }
  toggleCleanupItem(i: number): void {
    const cur = this.cleanupSelected();
    this.cleanupSelected.set(cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]);
  }
  toggleAllCleanup(): void {
    const all = this.cleanupManifest().map((_, i) => i);
    this.cleanupSelected.set(this.cleanupSelected().length === all.length ? [] : all);
  }
  private cleanupSelectedItems(): CleanupItem[] {
    return this.cleanupSelected().map((i) => this.cleanupManifest()[i]).filter(Boolean);
  }
  /** DRY-RUN preview — show exactly what WOULD be deleted for the ticked paths (deletes nothing). */
  runCleanupPreview(): void {
    const items = this.cleanupSelectedItems();
    if (!items.length) { void this.notifyRequired('Tick at least one path to preview.'); return; }
    this.cleanupPreviewBusy.set(true);
    this.svc.cleanupPreview(items).subscribe({
      next: (r) => {
        this.cleanupPreviewBusy.set(false);
        const res = r.results ?? [];
        this.cleanupPreview.set(res);
        const files = res.reduce((n, x) => n + (x.deleted || 0), 0);
        const freed = res.reduce((n, x) => n + (x.bytes_freed || 0), 0);
        const bad = res.filter((x) => !x.ok).length;
        this.toast.set(bad
          ? { kind: 'err', text: `Preview: ${bad} path(s) have issues — review before deleting.` }
          : { kind: 'ok', text: `Preview: ${files} file(s) · ${this.fmtBytes(freed)} would be freed.` });
      },
      error: (e) => { this.cleanupPreviewBusy.set(false); this.fail(e, 'Cleanup preview failed'); }
    });
  }
  /** REAL cleanup — permanently delete the matching files for the ticked paths (confirmed first). */
  async runCleanup(): Promise<void> {
    const items = this.cleanupSelectedItems();
    if (!items.length) { await this.notifyRequired('Tick at least one path to clean up.'); return; }
    const paths = items.map((it) => `• ${it.path}`).join('\n');
    const ok = await this.confirmStepRun(this.step('space_cleanup'),
      `Permanently delete the matching files from ${items.length} path(s)? This cannot be undone.\n\n${paths}\n\nTip: run Preview first to see exactly what will be removed.`,
      'Delete files');
    if (!ok) { return; }
    this.busy.set('space_cleanup');
    this.cleanupResults.set([]);
    this.cleanupPreview.set(null);   // a real run supersedes the preview
    const fullManifest = this.allCleanupItems().length ? this.allCleanupItems() : this.cleanupManifest();
    this.svc.cleanupRun(this.runId, items, fullManifest).subscribe({
      next: (r) => {
        this.busy.set('');
        const results = r.results ?? [];
        this.cleanupResults.set(results);
        this.cleanupDetail.set(results);
        const fails = results.filter((x) => !x.ok).length;
        this.toast.set(fails ? { kind: 'err', text: `${fails} path(s) failed — see details.` } : { kind: 'ok', text: 'Cleanup completed.' });
        this.reloadState(); this.loadActivity();
      },
      error: (e) => { this.busy.set(''); this.fail(e, 'Cleanup failed'); }
    });
  }
  openCleanupDetail(items: CleanupResult[]): void { this.cleanupDetail.set(items); }
  closeCleanupDetail(): void { this.cleanupDetail.set(null); }
  toggleCleanupInfo(): void { this.cleanupInfoOpen.set(!this.cleanupInfoOpen()); }
  closeCleanupInfo(): void { this.cleanupInfoOpen.set(false); }
  /** No paths to clean this release (no/empty manifest) → complete the step cleanly (logged, not a force). */
  async markNothingToClean(): Promise<void> {
    const note = this.cleanupLocations().length
      ? 'Cleanup manifest(s) present but empty — nothing to clean for this release.'
      : 'No cleanup manifest for this release — nothing to clean.';
    const ok = await this.confirm.ask({
      title: 'Nothing to clean', message: `${note} Mark the Server Space Cleanup step complete?`,
      confirmLabel: 'Mark complete', tone: 'primary'
    });
    if (!ok) { return; }
    this.svc.markStep(this.runId, 'space_cleanup', 'complete', false, note).subscribe({
      next: () => { this.toast.set({ kind: 'ok', text: 'Server Space Cleanup marked complete — nothing to clean.' }); this.reloadState(); this.loadActivity(); },
      error: (e) => this.fail(e, 'Could not mark the step complete')
    });
  }
  /** One-line totals for the shown cleanup results (popup header). */
  cleanupSummaryLine(rows: CleanupResult[]): string {
    const ok = rows.filter((r) => r.ok).length;
    const fails = rows.length - ok;
    const files = rows.reduce((n, r) => n + (r.deleted || 0), 0);
    const dirs = rows.reduce((n, r) => n + (r.dirs_removed || 0), 0);
    const freed = rows.reduce((n, r) => n + (r.bytes_freed || 0), 0);
    const parts = [`${ok}/${rows.length} path(s) OK`, `${files} file(s)`];
    if (dirs) { parts.push(`${dirs} dir(s)`); }
    parts.push(`${this.fmtBytes(freed)} freed`);
    if (fails) { parts.push(`${fails} failed`); }
    return parts.join('  ·  ');
  }
  /** Export the shown cleanup results as a CSV audit artifact — one row per affected file (with its path's
   *  rules + totals), so the full deleted-file list can be attached to the release ticket. */
  downloadCleanupReport(rows: CleanupResult[]): void {
    if (!rows?.length) { return; }
    const head = ['Path', 'Status', 'Include subdir', 'Remove empty dir', 'Include pattern', 'Exclude pattern',
      'Older than (days)', 'Files deleted', 'Bytes freed', 'Empty dirs removed', 'File', 'Error'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [head.map(esc).join(',')];
    for (const r of rows) {
      const status = r.ok ? (r.dry_run ? 'would clean' : 'cleaned') : 'error';
      const base = [r.path, status, r.include_subdir || 'N', r.remove_empty_dir || 'N', r.include_pattern || '*',
        r.exclude_pattern || '', r.older_than_days || 0, r.deleted || 0, r.bytes_freed || 0, r.dirs_removed || 0];
      const files = r.sample || [];
      if (files.length) { for (const f of files) { lines.push([...base, f, r.error || ''].map(esc).join(',')); } }
      else { lines.push([...base, '', r.error || ''].map(esc).join(',')); }
    }
    const kind = rows[0]?.dry_run ? 'preview' : 'result';
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `cleanup-${kind}-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // --- steps 4 & 5: Reset / Trigger -----------------------------------------
  // Multi-select + ordered (like Apply): the selection array's order IS the run order (▲▼ to change).
  private toggleInList(sig: WritableSignal<string[]>, s: string): void {
    const cur = sig(); sig.set(cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]);
  }
  private moveInList(sig: WritableSignal<string[]>, s: string, dir: -1 | 1): void {
    const arr = [...sig()]; const i = arr.indexOf(s); const j = i + dir;
    if (i < 0 || j < 0 || j >= arr.length) { return; }
    [arr[i], arr[j]] = [arr[j], arr[i]]; sig.set(arr);
  }
  resetIsSel(s: string): boolean { return this.resetSelected().includes(s); }
  resetOrder(s: string): number { return this.resetSelected().indexOf(s) + 1; }
  toggleResetScript(s: string): void { this.toggleInList(this.resetSelected, s); }
  moveResetScript(s: string, dir: -1 | 1): void { this.moveInList(this.resetSelected, s, dir); }
  resetIsFirst(s: string): boolean { return this.resetOrder(s) <= 1; }
  resetIsLast(s: string): boolean { return this.resetOrder(s) >= this.resetSelected().length; }
  toggleAllReset(): void { this.resetSelected.set(this.resetSelected().length === this.resetScripts().length ? [] : [...this.resetScripts()]); }
  triggerIsSel(s: string): boolean { return this.triggerSelected().includes(s); }
  triggerOrder(s: string): number { return this.triggerSelected().indexOf(s) + 1; }
  toggleTriggerScript(s: string): void { this.toggleInList(this.triggerSelected, s); }
  moveTriggerScript(s: string, dir: -1 | 1): void { this.moveInList(this.triggerSelected, s, dir); }
  triggerIsFirst(s: string): boolean { return this.triggerOrder(s) <= 1; }
  triggerIsLast(s: string): boolean { return this.triggerOrder(s) >= this.triggerSelected().length; }
  toggleAllTrigger(): void { this.triggerSelected.set(this.triggerSelected().length === this.triggerScripts().length ? [] : [...this.triggerScripts()]); }

  /** Load the RegressionTesting scripts for the selected Reset DB (prune any selection no longer present). */
  loadResetScripts(): void {
    this.svc.batchScripts().subscribe({
      next: (r) => { const list = r.scripts ?? []; this.resetScripts.set(list); this.resetSelected.set(this.resetSelected().filter((s) => list.includes(s))); },
      error: (e) => this.fail(e, 'Could not load reset scripts')
    });
  }
  loadTriggerScripts(): void {
    this.svc.batchScripts().subscribe({
      next: (r) => { const list = r.scripts ?? []; this.triggerScripts.set(list); this.triggerSelected.set(this.triggerSelected().filter((s) => list.includes(s))); },
      error: (e) => this.fail(e, 'Could not load trigger scripts')
    });
  }
  // Target-DB multi-select (shared: every selected script runs on every selected DB, in sequence).
  toggleResetDb(db: string): void { this.resetDbs.set(this.toggle(this.resetDbs(), db)); }
  toggleTriggerDb(db: string): void { this.triggerDbs.set(this.toggle(this.triggerDbs(), db)); }
  resetDbOn(db: string): boolean { return this.resetDbs().includes(db); }
  triggerDbOn(db: string): boolean { return this.triggerDbs().includes(db); }

  async runReset(): Promise<void> {
    const scripts = this.resetSelected(); const dbs = this.resetDbs();
    if (!scripts.length) { await this.notifyRequired('Tick at least one reset script to run.'); return; }
    if (!dbs.length) { await this.notifyRequired('Tick at least one target database.'); return; }
    const names = dbs.map((d) => this.dbDisplay(d)).join(', ');
    const ok = await this.confirmStepRun(this.step('reset'),
      `Run ${scripts.length} reset script(s) on ${dbs.length} database(s) — ${names} — in the listed order?`, 'Reset');
    if (!ok) { return; }
    this.runSqlStep('reset', scripts, dbs, this.resetResults);
  }
  async runTrigger(): Promise<void> {
    const scripts = this.triggerSelected(); const dbs = this.triggerDbs();
    if (!scripts.length) { await this.notifyRequired('Tick at least one trigger script to run.'); return; }
    if (!dbs.length) { await this.notifyRequired('Tick at least one target database.'); return; }
    const names = dbs.map((d) => this.dbDisplay(d)).join(', ');
    const ok = await this.confirmStepRun(this.step('trigger'),
      `Run ${scripts.length} trigger script(s) on ${dbs.length} database(s) — ${names} — in the listed order?`, 'Trigger');
    if (!ok) { return; }
    this.runSqlStep('trigger', scripts, dbs, this.triggerResults);
  }

  /** Run a step LIVE: open the console immediately and stream sqlplus output into it as it prints. */
  private runSqlStep(stepKey: string, scripts: string[], dbs: string[], sink: { set: (v: RunSqlResult[]) => void }): void {
    this.busy.set(stepKey);
    this.viewerKind.set('console');
    this.consoleCollapsed.set(false); this.consoleMax.set(false); this.consoleRunning.set(true);
    this.logTitle.set('Execution log — running…');
    this.logContent.set('');
    const results: RunSqlResult[] = [];
    let stepStatus = 'complete';
    this.svc.runSqlStream(this.runId, stepKey, scripts, dbs, {
      line: (t) => { if (this.consoleRunning()) { this.logContent.update((c) => (c ? `${c}\n${t}` : t)); } },
      result: (r) => { results.push(r); sink.set([...results]); },
      step: (status) => { stepStatus = status; },
      done: () => {
        this.busy.set(''); this.consoleRunning.set(false);
        this.logTitle.set(stepStatus === 'error' ? 'Execution log — completed with errors' : 'Execution log');
        this.toast.set(stepStatus === 'complete'
          ? { kind: 'ok', text: 'Completed successfully.' }
          : { kind: 'err', text: 'Completed with errors — check the console.' });
        this.reloadState();
      },
      error: (e) => { this.busy.set(''); this.consoleRunning.set(false); this.fail(e, 'Run failed'); }
    });
  }

  // --- sqlplus console / file viewer -----------------------------------------
  toggleConsole(): void { this.consoleCollapsed.set(!this.consoleCollapsed()); }
  toggleConsoleMax(): void { this.consoleMax.set(!this.consoleMax()); if (this.consoleMax()) { this.consoleCollapsed.set(false); } }
  openLog(r: RunSqlResult): void {
    this.viewerKind.set('console'); this.consoleCollapsed.set(false); this.consoleMax.set(false);
    if (r.tail) { this.logTitle.set(`${r.script} · ${this.dbDisplay(r.db)}`); this.logContent.set(r.tail); return; }
    if (!r.log_file) { return; }
    this.svc.logRead(r.log_file).subscribe({
      next: (x) => { this.logTitle.set(`${r.script} · ${this.dbDisplay(r.db)}`); this.logContent.set(x.content); },
      error: (e) => this.fail(e, 'Could not read the log')
    });
  }
  closeLog(): void { this.consoleRunning.set(false); this.logTitle.set(''); this.logContent.set(''); }
  downloadLog(): void {
    const blob = new Blob([this.logContent()], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const ext = this.viewerKind() === 'file' ? '' : '.log';
    a.download = (this.logTitle().replace(/[^\w.-]+/g, '_') || 'regression') + ext;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // --- monitoring ------------------------------------------------------------
  loadBatches(): void {
    this.monitorLoading.set(true);
    this.batchError.set(false);
    this.svc.batchMonitor(this.monitorDb()).subscribe({
      next: (r) => { this.monitorLoading.set(false); this.batchResult.set(r); this.batchAt.set(new Date()); this.nowTick.set(Date.now()); },
      // On failure clear the spinner AND flag the error so the panel shows a retryable message instead of
      // "Loading…" forever (batchResult stays null on error, which the template otherwise reads as loading).
      error: (e) => { this.monitorLoading.set(false); this.batchError.set(true); this.fail(e, 'Could not load batch status'); }
    });
  }
  loadActivity(): void {
    this.svc.activity(this.runId || undefined).subscribe({
      // spread into a fresh array so the signal always emits (the dev mock returns its live store ref) →
      // the copyState computed + the activity grid refresh.
      next: (r) => { this.activityRows.set([...(r.rows ?? [])]); this.activityAt.set(new Date()); this.nowTick.set(Date.now()); }
    });
  }
  cell(v: unknown): string { return v === null || v === undefined ? '' : String(v); }

  // --- utils -----------------------------------------------------------------
  private toggle(list: string[], v: string): string[] {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  }
  dbLabel(key: string): string { return this.databases.find((d) => d.key === key)?.label ?? key; }
  /** Operator-facing DB name: the actual DB name/SID + friendly label, e.g. "OLSCD1 (OLS CIB Batch)". */
  dbDisplay(key: string): string {
    const d = this.databases.find((x) => x.key === key);
    return d ? (d.name ? `${d.name} (${d.label})` : d.label) : key;
  }
  private fail(e: unknown, fallback: string): void {
    const err = e as { error?: { detail?: string; message?: string }; message?: string };
    this.toast.set({ kind: 'err', text: err?.error?.detail || err?.error?.message || err?.message || fallback });
  }
}
