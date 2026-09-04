import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AgGridAngular } from 'ag-grid-angular';
import { CellValueChangedEvent, ColDef, GridApi, GridReadyEvent, IRowNode } from 'ag-grid-community';
import { ColorModeService } from '@coreui/angular';

import { ColumnMeta, UploadResult } from '../../../shared/models';
import { ConfigScope } from '../../../shared/api-endpoints';
import { environment } from '../../../../environments/environment';
import { RbacService } from '../../../auth/rbac.service';
import { ConfirmService } from '../../confirm/confirm.service';
import { ErrorReportService } from '../../error-report/error-report.service';
import { ConfigUploadService } from './config-upload.service';
import { detectDelimiter, parseCsv, resolveDelimiter, serializeCsv, validateCell } from '../../../shared/csv-util';
import { olsGridTheme, olsGridThemeDark } from '../grid-data.model';

/** Audit/system columns the load sets itself — excluded from the expected file header (mirrors the server). */
const AUDIT_COLS = new Set(['INSERTED_BY', 'INSERTED_DATE', 'INSERTED_ON', 'UPDATED_BY', 'UPDATED_DATE', 'UPDATED_ON']);
/** Known date-partition column names (the server's ols_util.get_date_column is authoritative). */
const DATE_COL_NAMES = new Set(['COB_DT', 'REPORTING_DT']);

interface GridRow { __id: number; __err: Record<string, string>; [field: string]: unknown; }

/**
 * Config Ops CSV **Upload & Load** dialog (opened from the grid modal's 3-dot → Upload Data).
 * Pick file → auto/override delimiter → parse → strict header validation → editable, virtualized
 * preview with per-cell validation + a rejected/issues view → Append/Replace → load (server is the
 * authority, atomic). See GUIDE.md (Config Ops — CSV Upload & Load).
 */
@Component({
  selector: 'app-config-upload',
  standalone: true,
  imports: [FormsModule, AgGridAngular],
  templateUrl: './config-upload.component.html',
  styleUrls: ['./config-upload.component.scss'],
})
export class ConfigUploadComponent {
  private readonly svc = inject(ConfigUploadService);
  private readonly confirm = inject(ConfirmService);
  private readonly colorMode = inject(ColorModeService);
  private readonly errorReport = inject(ErrorReportService);
  private readonly rbac = inject(RbacService);

  // --- inputs (from the grid modal) -----------------------------------------
  readonly visible = input(false);
  readonly scope = input<ConfigScope>('cib');
  readonly dbSource = input('');          // the table's physical DB (ols_cib_batch | ols_cib_reporting | …)
  readonly tableName = input('');
  readonly columns = input<ColumnMeta[]>([]);
  readonly isCob = input(false);

  readonly closed = output<void>();
  readonly loaded = output<UploadResult>();

  // --- state ----------------------------------------------------------------
  readonly delimiter = signal('auto');
  readonly fileName = signal('');
  private rawText = '';
  readonly parsed = signal<{ header: string[]; rows: string[][] } | null>(null);
  readonly usedDelimiter = signal(',');
  readonly headerError = signal<string | null>(null);
  readonly omittedCols = signal<string[]>([]);
  readonly gridRows = signal<GridRow[]>([]);
  readonly mode = signal<'append' | 'replace'>('append');
  readonly viewMode = signal<'all' | 'valid' | 'issues'>('all');
  readonly loading = signal(false);
  readonly resultMsg = signal<{ ok: boolean; text: string } | null>(null);
  private gridApi?: GridApi;
  private idSeq = 0;

  // --- derived --------------------------------------------------------------
  readonly loadableCols = computed(() => this.columns().filter((c) => !AUDIT_COLS.has((c.field || '').toUpperCase())));
  readonly providedCols = computed<ColumnMeta[]>(() => {
    const p = this.parsed();
    return p ? this.loadableCols().slice(0, p.header.length) : [];
  });
  readonly dateColField = computed<string | null>(() => {
    if (!this.isCob()) { return null; }
    const named = this.providedCols().find((c) => DATE_COL_NAMES.has((c.field || '').toUpperCase()));
    const typed = this.providedCols().find((c) => c.type === 'date' || c.type === 'timestamp');
    return (named ?? typed)?.field ?? null;
  });
  readonly validCount = computed(() => this.gridRows().filter((r) => Object.keys(r.__err).length === 0).length);
  readonly issueCount = computed(() => this.gridRows().length - this.validCount());
  readonly distinctDates = computed(() => {
    const f = this.dateColField();
    if (!f) { return []; }
    const s = new Set<string>();
    for (const r of this.gridRows()) {
      if (Object.keys(r.__err).length === 0) { const v = String(r[f] ?? '').trim(); if (v) { s.add(v); } }
    }
    return [...s];
  });
  readonly cobDate = computed(() => (this.distinctDates().length === 1 ? this.distinctDates()[0] : null));
  readonly multiDate = computed(() => this.distinctDates().length > 1);
  readonly canLoad = computed(() =>
    !!this.parsed() && !this.headerError() && this.validCount() > 0 && !this.multiDate() && !this.loading());

  readonly theme = computed(() => (this.isDark() ? olsGridThemeDark : olsGridTheme));
  private isDark(): boolean {
    const m = this.colorMode.colorMode();
    if (m === 'dark') { return true; }
    if (m === 'light') { return false; }
    return this.colorMode.getPrefersColorScheme() === 'dark';
  }

  readonly colDefs = computed<ColDef[]>(() => this.providedCols().map((c) => ({
    field: c.field,
    headerName: c.header ?? c.field,
    editable: true,
    minWidth: 130,
    cellClassRules: { 'upl-cell-bad': (p) => !!((p.data as GridRow)?.__err?.[c.field!]) },
    tooltipValueGetter: (p) => (p.data as GridRow)?.__err?.[c.field!] ?? null,
  })));

  readonly gridOptions = {
    defaultColDef: { resizable: true, sortable: true, filter: true, floatingFilter: true, minWidth: 130 },
    tooltipShowDelay: 200,
    pagination: true,
    paginationPageSize: 100,
    paginationPageSizeSelector: [50, 100, 500, 1000],
    // 3-way view: 'all' → no filter; 'valid' → rows with no errors; 'issues' → rows with errors.
    isExternalFilterPresent: (): boolean => this.viewMode() !== 'all',
    doesExternalFilterPass: (node: IRowNode): boolean => {
      const bad = Object.keys((node.data as GridRow).__err).length > 0;
      return this.viewMode() === 'issues' ? bad : !bad;
    },
    getRowId: (p: { data: GridRow }) => String(p.data.__id),
  };

  constructor() {
    // reset each time the dialog opens
    effect(() => { if (this.visible()) { this.reset(); } });
  }

  onGridReady(e: GridReadyEvent): void { this.gridApi = e.api; }

  private reset(): void {
    this.delimiter.set('auto'); this.fileName.set(''); this.rawText = '';
    this.parsed.set(null); this.headerError.set(null); this.omittedCols.set([]);
    this.gridRows.set([]); this.mode.set('append'); this.viewMode.set('all');
    this.loading.set(false); this.resultMsg.set(null);
  }

  onFile(ev: Event): void {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (!f) { return; }
    this.fileName.set(f.name);
    this.parsed.set(null); this.gridRows.set([]); this.headerError.set(null); this.resultMsg.set(null);
    const reader = new FileReader();
    reader.onload = () => { this.rawText = String(reader.result || ''); };
    reader.readAsText(f);
  }

  parse(): void {
    if (!this.rawText) { this.resultMsg.set({ ok: false, text: 'Pick a CSV file first.' }); return; }
    const delim = this.delimiter() === 'auto' ? detectDelimiter(this.rawText) : resolveDelimiter(this.delimiter());
    this.usedDelimiter.set(delim);
    const { header, rows } = parseCsv(this.rawText, delim);
    this.parsed.set({ header, rows });
    this.resultMsg.set(null);

    const lc = this.loadableCols().map((c) => (c.field || '').toUpperCase());
    const fh = header.map((h) => h.trim().toUpperCase());
    if (fh.length === 0) { this.headerError.set('The file has no header row.'); this.gridRows.set([]); return; }
    if (fh.length > lc.length) {
      this.headerError.set(`File has ${fh.length} columns but the table expects at most ${lc.length}.`); this.gridRows.set([]); return;
    }
    for (let i = 0; i < fh.length; i++) {
      if (fh[i] !== lc[i]) {
        this.headerError.set(`Column ${i + 1}: expected "${this.loadableCols()[i].field}", got "${header[i] || '(empty)'}". Columns must match name and order.`);
        this.gridRows.set([]); return;
      }
    }
    this.headerError.set(null);
    this.omittedCols.set(this.loadableCols().slice(fh.length).map((c) => c.field!));

    const prov = this.providedCols();
    const grows: GridRow[] = rows.map((r) => {
      const g: GridRow = { __id: this.idSeq++, __err: {} };
      prov.forEach((c, i) => { g[c.field!] = r[i] ?? ''; });
      this.validateRow(g);
      return g;
    });
    this.gridRows.set(grows);
  }

  private validateRow(g: GridRow): void {
    const err: Record<string, string> = {};
    for (const c of this.providedCols()) {
      const e = validateCell(c.type, String(g[c.field!] ?? ''));
      if (e) { err[c.field!] = e; }
    }
    g.__err = err;
  }

  /** Auto-validate the edited row immediately (no separate "validate" click) and refresh the view. */
  onCellChanged(ev: CellValueChangedEvent): void {
    this.validateRow(ev.data as GridRow);
    this.gridRows.set([...this.gridRows()]);
    ev.api.refreshCells({ rowNodes: [ev.node], force: true });
    if (this.viewMode() !== 'all') { ev.api.onFilterChanged(); }   // a fixed row leaves Issues / enters Valid
  }

  setView(mode: 'all' | 'valid' | 'issues'): void {
    this.viewMode.set(mode);
    this.gridApi?.onFilterChanged();
  }

  export(which: 'all' | 'issues'): void {
    const prov = this.providedCols();
    const header = prov.map((c) => c.field!);
    const rows = this.gridRows()
      .filter((r) => which === 'all' || Object.keys(r.__err).length > 0)
      .map((r) => prov.map((c) => String(r[c.field!] ?? '')));
    const csv = serializeCsv(header, rows);
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.tableName() || 'upload'}_${which}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async load(): Promise<void> {
    if (!this.canLoad()) { return; }
    const dateMsg = this.dateColField() && this.cobDate() ? ` (date ${this.cobDate()})` : '';
    const scopePhrase = this.mode() === 'replace'
      ? (this.dateColField() ? `replace date ${this.cobDate()} in` : 'REPLACE ALL rows of')
      : 'append to';
    const ok = await this.confirm.ask({
      title: 'Load data',
      message: `${this.mode() === 'replace' ? 'Replace' : 'Append'}: ${scopePhrase} ${this.tableName()} — ${this.validCount()} row(s)${dateMsg}. Proceed?`,
      confirmLabel: 'Load', tone: this.mode() === 'replace' ? 'danger' : 'primary'
    });
    if (!ok) { return; }

    const prov = this.providedCols();
    const header = prov.map((c) => c.field!);
    const validRows = this.gridRows()
      .filter((r) => Object.keys(r.__err).length === 0)
      .map((r) => prov.map((c) => String(r[c.field!] ?? '')));
    const csv = serializeCsv(header, validRows, this.usedDelimiter());

    this.loading.set(true);
    this.svc.upload(this.scope(), this.tableName(), {
      mode: this.mode(), delimiter: this.usedDelimiter(), db_source: this.dbSource(),
      is_cobdt: this.isCob() ? 'Y' : 'N',
      original_filename: this.fileName() || 'upload.csv', file_content: csv
    }).subscribe({
      next: (resp) => {
        this.loading.set(false);
        if (resp.status === 'rejected') {
          this.resultMsg.set({ ok: false, text: `Server rejected ${resp.rows_rejected ?? resp.rejects?.length ?? 0} row(s) — fix and retry.` });
          return;
        }
        const r = resp.result;
        this.resultMsg.set({ ok: true, text: `Loaded ${r?.rows_loaded ?? 0} row(s)${r?.rows_deleted ? `, replaced ${r.rows_deleted}` : ''}.` });
        if (r) { this.loaded.emit(r); }
      },
      error: (e) => {
        this.loading.set(false);
        const err = e as { error?: { detail?: string; details?: string; message?: string } | string; message?: string; statusText?: string };
        const b = err?.error;
        const msg =
          (typeof b === 'string' && b) ||
          (typeof b === 'object' && (b?.detail || b?.details || b?.message)) ||
          err?.message || err?.statusText || 'The load could not be completed.';
        this.resultMsg.set({ ok: false, text: 'Load failed — see the error details.' });
        // Full DB error (e.g. ORA-14400 partition does not exist) in the rich dialog with Copy + Email-to-dev.
        this.errorReport.show({ title: 'Upload failed', message: String(msg), userId: this.rbac.snapshot().username || environment.username });
      }
    });
  }

  close(): void { this.closed.emit(); }
}
