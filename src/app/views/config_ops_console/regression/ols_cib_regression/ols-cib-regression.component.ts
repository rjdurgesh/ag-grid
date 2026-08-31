import { Component, DestroyRef, computed, effect, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AgGridAngular } from 'ag-grid-angular';
import { ColDef } from 'ag-grid-community';
import { ColorModeService } from '@coreui/angular';
import { interval } from 'rxjs';

import { OlsCibRegressionService } from './ols-cib-regression.service';
import { LoaderComponent } from '../../../../components/loader/loader.component';
import { ConfirmService } from '../../../../components/confirm/confirm.service';
import { olsGridTheme, olsGridThemeDark } from '../../../../components/grid-data/grid-data.model';
import { formatDateTime, syncAgo } from '../../../../shared/date-utils';
import {
  BatchMonitorResult, FileCopyItem, FileCopyResult, RegressionActivityRow,
  RegressionState, RunSqlResult
} from '../../../../shared/models';

interface StepDef { key: string; title: string; }
interface Toast { kind: 'ok' | 'err' | 'info'; text: string; }
interface TreeNode { name: string; path: string; dir: boolean; children: TreeNode[]; }

/**
 * Regression screen (CIB, DEV/STG). An ordered, gated, fully-logged workflow — Refresh DB → Apply DB
 * changes (git) → File copy → Reset batches → Trigger batches — with a monitoring area below (batch
 * status + the activity log). Each step is disabled until the previous is complete or force-marked.
 * Every action is confirmed and audited server-side. See regression_api.py / the plan.
 */
@Component({
  selector: 'app-ols-cib-regression',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet, LoaderComponent, AgGridAngular],
  templateUrl: './ols-cib-regression.component.html',
  styleUrls: ['./ols-cib-regression.component.scss']
})
export class OlsCibRegressionComponent implements OnInit {
  private readonly svc = inject(OlsCibRegressionService);
  private readonly confirm = inject(ConfirmService);

  readonly steps: StepDef[] = [
    { key: 'refresh_db', title: 'Refresh DB' },
    { key: 'apply_db', title: 'Apply DB changes' },
    { key: 'file_copy', title: 'File copy' },
    { key: 'reset', title: 'Reset batches' },
    { key: 'trigger', title: 'Trigger batches' }
  ];
  readonly databases = [
    { key: 'group', label: 'OLS GROUP' },
    { key: 'cib_batch', label: 'OLS CIB Batch' },
    { key: 'cib_reporting', label: 'OLS CIB Reporting' },
    { key: 'retail_batch', label: 'OLS RETAIL Batch' },
    { key: 'retail_reporting', label: 'OLS RETAIL Reporting' }
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
  /** Refresh DB targets — all 5 DBs selectable, default OLS CIB Batch. */
  readonly refreshDbs = signal<string[]>(['cib_batch']);
  readonly loading = signal(true);
  readonly toast = signal<Toast | null>(null);
  // Auto-dismiss any toast a few seconds after it appears (e.g. "State refreshed.") so it doesn't linger.
  private readonly _toastAuto = effect((onCleanup) => {
    if (this.toast()) { const id = setTimeout(() => this.toast.set(null), 4000); onCleanup(() => clearTimeout(id)); }
  });
  readonly busy = signal<string>('');            // step_key currently running

  // Apply DB
  readonly branches = signal<string[]>([]);
  readonly selectedBranch = signal('');
  readonly scripts = signal<string[]>([]);
  readonly pulling = signal(false);
  readonly applyScripts = signal<string[]>([]);  // selected CHG_*.sql
  readonly applyDbs = signal<string[]>(['cib_batch']);
  readonly applyResults = signal<RunSqlResult[]>([]);

  // File copy
  readonly manifest = signal<FileCopyItem[]>([]);
  readonly selectedItems = signal<number[]>([]);
  readonly copyResults = signal<FileCopyResult[]>([]);

  // Reset / Trigger
  readonly resetScript = signal('');
  readonly resetDb = signal('cib_batch');
  readonly resetResults = signal<RunSqlResult[]>([]);
  readonly triggerScript = signal('');
  readonly triggerDb = signal('cib_batch');
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
  readonly monitorTab = signal<'batches' | 'activity'>('batches');
  readonly monitorDb = signal('cib_batch');
  readonly batchResult = signal<BatchMonitorResult | null>(null);
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
  };
  readonly activityGridOptions = {
    defaultColDef: { resizable: true, sortable: true, filter: true, floatingFilter: true, minWidth: 120 },
    pagination: true,
    paginationPageSize: 100,
    paginationPageSizeSelector: [50, 100, 500, 1000],
  };
  /** Regression Activity grid columns (paginated/filterable/sortable like the batch grid). */
  readonly activityColDefs: ColDef[] = [
    { field: 'load_dt', headerName: 'Date', maxWidth: 120 },
    { field: 'step_key', headerName: 'Step' },
    { field: 'action', headerName: 'Action' },
    { field: 'status', headerName: 'Status', maxWidth: 130,
      cellClassRules: {
        'rg-cell--ok': (p) => p.value === 'complete',
        'rg-cell--err': (p) => p.value === 'error',
        'rg-cell--warn': (p) => p.value === 'forced',
      } },
    { field: 'performed_by', headerName: 'By' },
    { field: 'start_time', headerName: 'Start' },
    { field: 'end_time', headerName: 'End' },
    { field: 'task_completion_time', headerName: 'Dur (s)', maxWidth: 110 },
    { field: 'comments', headerName: 'Comments', flex: 2, minWidth: 220, tooltipField: 'comments' },
  ];

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

  readonly chgScripts = computed(() => this.scripts().filter((s) => /(^|\/)CHG_/i.test(s)));
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
    this.loadActivity();
    this.loadBatches();          // show batch status by default — don't make the user click Refresh
    // Tick every second so the "N sec ago" last-refreshed labels stay live.
    interval(1000).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.nowTick.set(Date.now()));
  }

  /** Re-hydrate the pulled-branch scripts after a refresh/resume so Apply/Reset/Trigger work again. */
  private restoreContext(): void {
    this.svc.gitScripts().subscribe({
      next: (r) => { if (r.scripts?.length) { this.scripts.set(r.scripts); this.pulled.set(true); } }
    });
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
      next: () => this.startRun(),
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
      case 'in_progress': return 'st-progress';
      default: return 'st-none';
    }
  }
  badgeLabel(status: string): string {
    return { complete: 'Complete', forced: 'Forced', error: 'Error', in_progress: 'In progress', not_started: 'Not started' }[status] ?? status;
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

  startRun(): void {
    this.svc.runStart().subscribe({
      next: (s) => {
        this.state.set(s); this.toast.set({ kind: 'ok', text: 'Regression run started.' });
        this.lastCompleted.set(null); this.resumed.set(false);
        // fresh run — nothing pulled yet; reset the branch browser
        this.pulled.set(false); this.tree.set([]); this.scripts.set([]); this.repoBranch.set(''); this.repoWorkdir.set('');
        this.loadActivity();
      },
      error: (e) => this.fail(e, 'Could not start the run')
    });
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
  toggleRefreshDb(d: string): void { this.refreshDbs.set(this.toggle(this.refreshDbs(), d)); }

  async refreshDb(): Promise<void> {
    if (!this.refreshDbs().length) { await this.notifyRequired('Select at least one database to refresh.'); return; }
    const ok = await this.confirmStepRun(this.step('refresh_db'), `Refresh ${this.refreshDbs().length} database(s) via the refresh API?`, 'Refresh');
    if (!ok) { return; }
    this.busy.set('refresh_db');
    this.svc.refreshDb(this.runId, this.refreshDbs()).subscribe({
      next: (r) => { this.busy.set(''); this.toast.set({ kind: 'ok', text: r.result?.message ?? 'Refresh triggered.' }); this.reloadState(); },
      error: (e) => { this.busy.set(''); this.fail(e, 'Refresh failed'); }
    });
  }

  // --- step 2: Apply DB (git) ------------------------------------------------
  loadBranches(): void {
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
        this.tree.set([]);                 // drop the previous branch's tree; reload for this one
        this.toast.set({ kind: 'ok', text: `Pulled ${b} — ${r.scripts?.length ?? 0} script(s).` });
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
  toggleApplyScript(s: string): void { this.applyScripts.set(this.toggle(this.applyScripts(), s)); }
  toggleApplyDb(d: string): void { this.applyDbs.set(this.toggle(this.applyDbs(), d)); }

  async runApply(): Promise<void> {
    if (!this.applyScripts().length || !this.applyDbs().length) {
      await this.notifyRequired(
        !this.applyScripts().length && !this.applyDbs().length ? 'Select at least one CHG script and one target database before applying.'
        : !this.applyScripts().length ? 'Select at least one CHG script to apply.'
        : 'Select at least one target database before applying.');
      return;
    }
    const ok = await this.confirmStepRun(this.step('apply_db'),
      `Run ${this.applyScripts().length} script(s) on ${this.applyDbs().length} database(s) via sqlplus?`, 'Apply');
    if (!ok) { return; }
    this.runSqlStep('apply_db', this.applyScripts(), this.applyDbs(), this.applyResults);
  }

  // --- step 3: File copy -----------------------------------------------------
  loadManifest(): void {
    this.svc.fileCopyManifest().subscribe({
      next: (r) => { this.manifest.set(r.items ?? []); this.selectedItems.set([]); },
      error: (e) => this.fail(e, 'Could not read the file-copy manifest')
    });
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
  async runCopy(): Promise<void> {
    const items = this.selectedItems().map((i) => this.manifest()[i]);
    if (!items.length) { await this.notifyRequired('Select at least one item to copy.'); return; }
    const ok = await this.confirmStepRun(this.step('file_copy'),
      `Copy ${items.length} item(s) to their destinations?`, 'Copy');
    if (!ok) { return; }
    this.busy.set('file_copy');
    this.svc.fileCopyRun(this.runId, items).subscribe({
      next: (r) => {
        this.busy.set('');
        this.copyResults.set(r.results ?? []);
        const fails = (r.results ?? []).filter((x) => !x.ok).length;
        this.toast.set(fails ? { kind: 'err', text: `${fails} item(s) failed.` } : { kind: 'ok', text: 'Files copied.' });
        this.reloadState();
      },
      error: (e) => { this.busy.set(''); this.fail(e, 'File copy failed'); }
    });
  }

  // --- steps 4 & 5: Reset / Trigger -----------------------------------------
  async runReset(): Promise<void> {
    if (!this.resetScript()) { await this.notifyRequired('Pick a reset script to run.'); return; }
    const ok = await this.confirmStepRun(this.step('reset'),
      `Run ${this.resetScript()} on ${this.dbLabel(this.resetDb())}?`, 'Reset');
    if (!ok) { return; }
    this.runSqlStep('reset', [this.resetScript()], [this.resetDb()], this.resetResults);
  }
  async runTrigger(): Promise<void> {
    if (!this.triggerScript()) { await this.notifyRequired('Pick a trigger script to run.'); return; }
    const ok = await this.confirmStepRun(this.step('trigger'),
      `Run ${this.triggerScript()} on ${this.dbLabel(this.triggerDb())}?`, 'Trigger');
    if (!ok) { return; }
    this.runSqlStep('trigger', [this.triggerScript()], [this.triggerDb()], this.triggerResults);
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
    if (r.tail) { this.logTitle.set(`${r.script} · ${this.dbLabel(r.db)}`); this.logContent.set(r.tail); return; }
    if (!r.log_file) { return; }
    this.svc.logRead(r.log_file).subscribe({
      next: (x) => { this.logTitle.set(`${r.script} · ${this.dbLabel(r.db)}`); this.logContent.set(x.content); },
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
    this.svc.batchMonitor(this.monitorDb()).subscribe({
      next: (r) => { this.monitorLoading.set(false); this.batchResult.set(r); this.batchAt.set(new Date()); this.nowTick.set(Date.now()); },
      error: (e) => { this.monitorLoading.set(false); this.fail(e, 'Could not load batch status'); }
    });
  }
  loadActivity(): void {
    this.svc.activity(this.runId || undefined).subscribe({
      next: (r) => { this.activityRows.set(r.rows ?? []); this.activityAt.set(new Date()); this.nowTick.set(Date.now()); }
    });
  }
  cell(v: unknown): string { return v === null || v === undefined ? '' : String(v); }

  // --- utils -----------------------------------------------------------------
  private toggle(list: string[], v: string): string[] {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  }
  dbLabel(key: string): string { return this.databases.find((d) => d.key === key)?.label ?? key; }
  private fail(e: unknown, fallback: string): void {
    const err = e as { error?: { detail?: string; message?: string }; message?: string };
    this.toast.set({ kind: 'err', text: err?.error?.detail || err?.error?.message || err?.message || fallback });
  }
}
