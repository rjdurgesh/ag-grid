import { Component, computed, DestroyRef, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { interval } from 'rxjs';
import { AgGridAngular } from 'ag-grid-angular';
import { ColDef } from 'ag-grid-community';
import { ColorModeService } from '@coreui/angular';

import { LoaderComponent } from '../../../components/loader/loader.component';
import { olsGridTheme, olsGridThemeDark } from '../../../components/grid-data/grid-data.model';
import { ConfigScope } from '../../../shared/api-endpoints';
import { formatDateTime, syncAgo } from '../../../shared/date-utils';
import {
  ReconActivityRow, ReconDb, ReconDiscrepancies, ReconRegressionRun, ReconReport, ReconReportState
} from '../../../shared/models';
import { ReconciliationService } from './reconciliation.service';

/** AG-Grid cell coloring by status text — same idea as Regression's rg-cell--ok/err/warn. */
const STATUS_CELL_RULES: Record<string, (p: { value: unknown }) => boolean> = {
  'recon-cell--pass': (p) => p.value === 'done' || p.value === 'Ready' || p.value === 'PASS',
  'recon-cell--fail': (p) => p.value === 'failed' || p.value === 'Extract failed' || p.value === 'FAIL',
  'recon-cell--warn': (p) => p.value === 'no_data' || p.value === 'No data',
  'recon-cell--run':  (p) => p.value === 'running' || p.value === 'queued' || p.value === 'Extracting…',
};

/** Poll cadence for extract status (ms) and a safety cap on how long we keep polling. */
const POLL_MS = 3000;
const POLL_MAX_TICKS = 400;   // ~20 min ceiling

/** One report row's UI presentation for its derived state. */
interface StatePill {
  label: string;
  cls: string;   // recon-pill--<kind>
}

const STATE_PILLS: Record<string, StatePill> = {
  extracting:     { label: 'Extracting…',    cls: 'recon-pill--run' },
  extract_failed: { label: 'Extract failed', cls: 'recon-pill--fail' },
  no_data:        { label: 'No data',        cls: 'recon-pill--warn' },
  ready:          { label: 'Ready',          cls: 'recon-pill--ready' },
  comparing:      { label: 'Comparing…',     cls: 'recon-pill--run' },
  pass:           { label: 'PASS',           cls: 'recon-pill--pass' },
  fail:           { label: 'FAIL',           cls: 'recon-pill--fail' },
  compare_error:  { label: 'Compare error',  cls: 'recon-pill--fail' }
};

/**
 * Data Reconciliation — Phase 1: trigger report extracts on a LIVE + Regression DB and monitor them.
 * Shared across all three config scopes (rendered by config_ols_group / _cib / _retail). Comparison +
 * results come in Phase 2. See reconciliation_api.py / reconciliation-screen-design memory.
 */
@Component({
  selector: 'app-reconciliation',
  templateUrl: './reconciliation.component.html',
  styleUrls: ['./reconciliation.component.scss'],
  imports: [LoaderComponent, AgGridAngular]
})
export class ReconciliationComponent implements OnInit {
  readonly scope = input.required<ConfigScope>();

  private readonly svc = inject(ReconciliationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly colorMode = inject(ColorModeService);

  /** Sub-tab BELOW the always-visible Run section (like Regression's monitoring area). Extract Log first. */
  readonly monitorTab = signal<'batches' | 'log'>('log');
  /** Which category's dropdown is open (one per category, at most one open at a time). */
  readonly openCategory = signal<string | null>(null);
  /** Data Reconciliation results section — collapsible/expandable (default expanded). */
  readonly resultsOpen = signal(true);
  toggleResults(): void { this.resultsOpen.set(!this.resultsOpen()); }

  // --- setup catalogue ---
  readonly databases = signal<ReconDb[]>([]);
  readonly reports = signal<ReconReport[]>([]);
  readonly regressionRuns = signal<ReconRegressionRun[]>([]);
  readonly loadingSetup = signal(true);

  // --- selections ---
  readonly liveDb = signal('');
  readonly regDb = signal('');
  readonly businessIso = signal('');            // YYYY-MM-DD from the date input
  readonly regressionRunId = signal<number | null>(null);
  readonly selected = signal<Set<string>>(new Set());

  // --- run / monitoring ---
  readonly runId = signal<number | null>(null);
  readonly reportStates = signal<ReconReportState[]>([]);
  readonly triggering = signal(false);
  readonly polling = signal(false);
  readonly error = signal('');

  // --- extract log ---
  readonly activity = signal<ReconActivityRow[]>([]);
  readonly activityLoading = signal(false);

  // --- grids (AG-Grid: filter + sort + pagination on BOTH tabs) ---
  readonly gridTheme = computed(() => (this.isDark() ? olsGridThemeDark : olsGridTheme));
  private isDark(): boolean {
    const m = this.colorMode.colorMode();
    if (m === 'dark') { return true; }
    if (m === 'light') { return false; }
    return this.colorMode.getPrefersColorScheme() === 'dark';
  }
  // Separate options objects per grid — AG-Grid attaches its api to the instance, so the two grids must NOT share one.
  readonly batchGridOptions = {
    defaultColDef: { resizable: true, sortable: true, filter: true, floatingFilter: true, minWidth: 90 },
    pagination: true, paginationPageSize: 25, paginationPageSizeSelector: [10, 25, 50, 100],
    enableCellTextSelection: true, ensureDomOrder: true,
    onRowClicked: (e: { data?: Record<string, unknown> }) => this.onBatchRowClicked(e),
  };
  readonly activityGridOptions = {
    defaultColDef: { resizable: true, sortable: true, filter: true, floatingFilter: true, minWidth: 110 },
    pagination: true, paginationPageSize: 50, paginationPageSizeSelector: [25, 50, 100, 500],
    enableCellTextSelection: true, ensureDomOrder: true,
  };
  readonly batchColDefs: ColDef[] = [
    { field: 'report', headerName: 'Report', minWidth: 180, flex: 1.4 },
    { field: 'category', headerName: 'Category', maxWidth: 150 },
    { field: 'status', headerName: 'Status', maxWidth: 150, cellClassRules: STATUS_CELL_RULES },
    { field: 'live', headerName: 'LIVE', maxWidth: 110, cellClassRules: STATUS_CELL_RULES },
    { field: 'reg', headerName: 'REG', maxWidth: 110, cellClassRules: STATUS_CELL_RULES },
    { field: 'matched', headerName: 'Matched', maxWidth: 110 },
    { field: 'changed', headerName: 'Changed', maxWidth: 110, cellClassRules: { 'recon-cell--fail': (p) => !!p.value } },
    { field: 'missing', headerName: 'Missing', maxWidth: 110, cellClassRules: { 'recon-cell--fail': (p) => !!p.value } },
    { field: 'extra', headerName: 'Extra', maxWidth: 100, cellClassRules: { 'recon-cell--fail': (p) => !!p.value } },
    { field: 'message', headerName: 'Detail', flex: 2, minWidth: 220 },
  ];
  readonly batchRowData = computed(() => this.reportStates().map((r) => ({
    report: this.reportName(r.report_code),
    category: this.reportCategory(r.report_code),
    status: this.pill(r.state).label,
    live: r.live.status,
    reg: r.reg.status,
    matched: r.matched ?? '',
    changed: r.changed ?? '',
    missing: r.missing ?? '',
    extra: r.extra ?? '',
    message: r.message,
    __code: r.report_code,   // hidden metadata for the drill-down row-click
    __state: r.state,
  })));
  readonly activityColDefs: ColDef[] = [
    { field: 'report_code', headerName: 'Report', minWidth: 180 },
    { field: 'side', headerName: 'Side', maxWidth: 100 },
    { field: 'db_source', headerName: 'Database', maxWidth: 150 },
    { field: 'business_date', headerName: 'Business date', maxWidth: 150 },
    { field: 'job_run_no', headerName: 'Job run no', maxWidth: 150 },
    { field: 'status', headerName: 'Status', maxWidth: 130, cellClassRules: STATUS_CELL_RULES },
    { field: 'triggered_by', headerName: 'By', maxWidth: 140 },
    { field: 'triggered_on', headerName: 'When', minWidth: 170 },
  ];

  // --- discrepancy drill-down (modal over a report's comparison) ---
  readonly drilldownCode = signal<string | null>(null);
  readonly drilldownName = signal('');
  readonly drilldownData = signal<ReconDiscrepancies | null>(null);
  readonly drilldownLoading = signal(false);
  readonly recomparing = signal(false);
  readonly drilldownColDefs = computed<ColDef[]>(() =>
    (this.drilldownData()?.columns ?? []).map((c) => ({
      field: c, headerName: c,
      ...(c === 'Type' ? { maxWidth: 130, cellClassRules: {
        'recon-cell--fail': (p: { value: unknown }) => p.value === 'Changed' || p.value === 'Missing',
        'recon-cell--warn': (p: { value: unknown }) => p.value === 'Extra',
      } } : {}),
    })));
  readonly drilldownRowData = computed<Record<string, unknown>[]>(() => {
    const d = this.drilldownData();
    if (!d) { return []; }
    return d.rows.map((row) => Object.fromEntries(d.columns.map((c, i) => [c, row[i]])));
  });
  readonly drilldownGridOptions = {
    defaultColDef: { resizable: true, sortable: true, filter: true, floatingFilter: true, minWidth: 110 },
    pagination: true, paginationPageSize: 50, paginationPageSizeSelector: [25, 50, 100, 500],
    enableCellTextSelection: true, ensureDomOrder: true,
  };

  // --- "Last refreshed …" labels (live, tick every 1s) ---
  private readonly nowTick = signal(Date.now());
  private readonly batchAt = signal<Date | null>(null);
  private readonly activityAt = signal<Date | null>(null);
  readonly batchRefreshed = computed(() => this.refreshedLabel(this.batchAt()));
  readonly activityRefreshed = computed(() => this.refreshedLabel(this.activityAt()));
  private refreshedLabel(at: Date | null): string {
    return at ? `Last refreshed ${formatDateTime(at)} · ${syncAgo(at, this.nowTick())}` : '';
  }

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTicks = 0;

  /** YYYYMMDD for the API (from the native date input's YYYY-MM-DD). */
  readonly businessDate = computed(() => this.businessIso().replace(/-/g, ''));

  readonly selectedRun = computed(() =>
    this.regressionRuns().find((r) => r.run_id === this.regressionRunId()) ?? null);

  readonly canTrigger = computed(() =>
    !!this.liveDb() && !!this.regDb() && this.businessDate().length === 8
    && this.selected().size > 0 && !this.triggering());

  /** One entry PER CATEGORY (→ one dropdown each), each grouped by sub-category. Order preserved from the
   *  API (sorted by category, sub_category). No category → "Reports"; no sub-category → a flat list. */
  readonly reportGroups = computed(() => {
    const cats = new Map<string, Map<string, ReconReport[]>>();
    for (const r of this.reports()) {
      const cat = this.catOf(r);
      const sub = (r.sub_category || '').trim();
      if (!cats.has(cat)) { cats.set(cat, new Map()); }
      const subs = cats.get(cat)!;
      if (!subs.has(sub)) { subs.set(sub, []); }
      subs.get(sub)!.push(r);
    }
    return [...cats.entries()].map(([category, subs]) => ({
      category,
      subs: [...subs.entries()].map(([sub, reports]) => ({ sub, reports }))
    }));
  });

  private catOf(r: ReconReport): string { return (r.category || 'Reports').trim() || 'Reports'; }

  ngOnInit(): void {
    const scope = this.scope();
    this.svc.databases(scope).subscribe({ next: (d) => this.databases.set(d.databases ?? []) });
    this.svc.regressionRuns(scope).subscribe({ next: (d) => this.regressionRuns.set(d.runs ?? []) });
    this.svc.reports(scope).subscribe({
      next: (d) => { this.reports.set(d.reports ?? []); this.loadingSetup.set(false); },
      error: () => { this.loadingSetup.set(false); }
    });
    this.loadActivity();   // Extract Log is the default (first) tab → populate it on open
    // tick the "… sec ago" labels once a second
    interval(1000).pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => this.nowTick.set(Date.now()));
    this.destroyRef.onDestroy(() => this.stopPolling());
  }

  // --- selection handlers ---
  toggleReport(code: string): void {
    const next = new Set(this.selected());
    next.has(code) ? next.delete(code) : next.add(code);
    this.selected.set(next);
  }
  isSelected(code: string): boolean { return this.selected().has(code); }
  selectAll(): void { this.selected.set(new Set(this.reports().map((r) => r.report_code))); }
  clearAll(): void { this.selected.set(new Set()); }

  setRegressionRun(value: string): void {
    this.regressionRunId.set(value ? Number(value) : null);
  }

  // --- trigger + poll ---
  trigger(): void {
    if (!this.canTrigger()) { return; }
    this.triggering.set(true);
    this.error.set('');
    this.stopPolling();
    this.svc.trigger(this.scope(), {
      live_db: this.liveDb(),
      regression_db: this.regDb(),
      business_date: this.businessDate(),
      reports: [...this.selected()],
      regression_run_id: this.regressionRunId()
    }).subscribe({
      next: (res) => {
        this.triggering.set(false);
        this.runId.set(res.run_id);
        this.reportStates.set([]);
        this.startPolling();   // results render in the always-visible "Data Reconciliation" section above
      },
      error: (e) => {
        this.triggering.set(false);
        this.error.set(e?.error?.detail || 'Could not trigger the extracts. Please retry or contact OLS Dev.');
      }
    });
  }

  private startPolling(): void {
    this.pollTicks = 0;
    this.polling.set(true);
    this.pollOnce();
  }

  private pollOnce(): void {
    const rid = this.runId();
    if (rid == null) { this.stopPolling(); return; }
    this.svc.status(this.scope(), rid).subscribe({
      next: (res) => {
        this.reportStates.set(res.reports ?? []);
        this.batchAt.set(new Date());
        this.nowTick.set(Date.now());
        const settled = (res.reports ?? []).every((r) => r.state !== 'extracting');
        if (settled || ++this.pollTicks >= POLL_MAX_TICKS) {
          this.stopPolling();
        } else {
          this.pollTimer = setTimeout(() => this.pollOnce(), POLL_MS);
        }
      },
      error: () => { this.pollTimer = setTimeout(() => this.pollOnce(), POLL_MS); }
    });
  }

  private stopPolling(): void {
    this.polling.set(false);
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  /** Manual refresh of the live monitor. */
  refreshStatus(): void {
    if (this.runId() != null && !this.polling()) { this.startPolling(); }
  }

  // --- per-category report dropdowns ---
  toggleCategory(cat: string): void { this.openCategory.set(this.openCategory() === cat ? null : cat); }
  closeCategory(): void { this.openCategory.set(null); }
  reportsInCategory(cat: string): ReconReport[] { return this.reports().filter((r) => this.catOf(r) === cat); }
  categorySelectedCount(cat: string): number {
    return this.reportsInCategory(cat).filter((r) => this.selected().has(r.report_code)).length;
  }
  categoryAllOn(cat: string): boolean {
    const rs = this.reportsInCategory(cat);
    return rs.length > 0 && rs.every((r) => this.selected().has(r.report_code));
  }
  toggleCategoryAll(cat: string): void {
    const next = new Set(this.selected());
    const rs = this.reportsInCategory(cat);
    const allOn = rs.every((r) => next.has(r.report_code));
    for (const r of rs) { allOn ? next.delete(r.report_code) : next.add(r.report_code); }
    this.selected.set(next);
  }

  // --- sub-tabs (below the run section) ---
  setMonitorTab(tab: 'batches' | 'log'): void {
    this.monitorTab.set(tab);
    if (tab === 'log') { this.loadActivity(); }
  }
  loadActivity(): void {
    this.activityLoading.set(true);
    this.svc.activity(this.scope()).subscribe({
      next: (d) => {
        this.activity.set([...(d.rows ?? [])]);
        this.activityAt.set(new Date());
        this.nowTick.set(Date.now());
        this.activityLoading.set(false);
      },
      error: () => { this.activityLoading.set(false); }
    });
  }

  // --- view helpers ---
  reportName(code: string): string {
    return this.reports().find((r) => r.report_code === code)?.report_name ?? code;
  }
  /** Main category of a report (for the "Category" column in the results grid). */
  reportCategory(code: string): string {
    const r = this.reports().find((x) => x.report_code === code);
    return r ? this.catOf(r) : '';
  }
  pill(state: string): StatePill {
    return STATE_PILLS[state] ?? { label: state, cls: 'recon-pill--run' };
  }
  dbLabel(key: string): string {
    return this.databases().find((d) => d.key === key)?.label ?? key;
  }

  // --- drill-down (discrepancies) ---
  onBatchRowClicked(e: { data?: Record<string, unknown> }): void {
    const d = e.data;
    if (!d) { return; }
    const state = String(d['__state'] ?? '');
    if (state === 'pass' || state === 'fail') {
      this.openDrilldown(String(d['__code'] ?? ''), String(d['report'] ?? ''));
    }
  }
  openDrilldown(code: string, name: string): void {
    if (!code) { return; }
    this.drilldownCode.set(code);
    this.drilldownName.set(name || code);
    this.drilldownData.set(null);
    this.loadDiscrepancies();
  }
  private loadDiscrepancies(): void {
    const code = this.drilldownCode();
    const rid = this.runId();
    if (!code || rid == null) { return; }
    this.drilldownLoading.set(true);
    this.svc.discrepancies(this.scope(), rid, code).subscribe({
      next: (d) => { this.drilldownData.set(d); this.drilldownLoading.set(false); },
      error: () => { this.drilldownData.set({ columns: [], rows: [] }); this.drilldownLoading.set(false); }
    });
  }
  closeDrilldown(): void {
    this.drilldownCode.set(null);
    this.drilldownData.set(null);
  }
  /** Force a fresh comparison for the open report, then reload its discrepancies + refresh the overview. */
  recompare(): void {
    const code = this.drilldownCode();
    const rid = this.runId();
    if (!code || rid == null || this.recomparing()) { return; }
    this.recomparing.set(true);
    this.svc.compare(this.scope(), rid, code).subscribe({
      next: () => { this.recomparing.set(false); this.loadDiscrepancies(); this.refreshStatus(); },
      error: () => { this.recomparing.set(false); }
    });
  }
  /** Client-side CSV download of the open report's discrepancy grid. */
  downloadDiscrepancies(): void {
    const d = this.drilldownData();
    if (!d || !d.columns.length) { return; }
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [d.columns.map(esc).join(','), ...d.rows.map((r) => r.map(esc).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.drilldownCode()}_discrepancies.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
