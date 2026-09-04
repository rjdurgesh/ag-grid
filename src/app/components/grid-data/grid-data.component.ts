import { Component, DestroyRef, computed, effect, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AgGridAngular } from 'ag-grid-angular';
import {
  ColDef,
  FirstDataRenderedEvent,
  GetRowIdFunc,
  GridApi,
  GridOptions,
  GridReadyEvent,
  IRowNode,
  IsFullWidthRow,
  RowHeightParams,
  RowSelectionOptions,
  SelectionChangedEvent
} from 'ag-grid-community';
import { Observable } from 'rxjs';

import {
  ButtonCloseDirective,
  ButtonDirective,
  DropdownComponent,
  DropdownItemDirective,
  DropdownMenuDirective,
  DropdownToggleDirective,
  ModalBodyComponent,
  ModalComponent,
  ModalFooterComponent,
  ModalHeaderComponent,
  ModalTitleDirective,
  ColorModeService
} from '@coreui/angular';

import { LoaderComponent } from '../loader/loader.component';
import { ConfigUploadComponent } from './upload/config-upload.component';

import { previousWeekdayIso } from '../../shared/date-utils';
import { ConfigScope } from '../../shared/api-endpoints';
import { CellDataType, TableContent, UploadResult } from '../../shared/models';
import { ConfirmService } from '../confirm/confirm.service';
import { ErrorReportService } from '../error-report/error-report.service';
import { environment } from '../../../environments/environment';
import { DetailRowComponent } from './cell-renderers/detail-row.component';
import { RefreshHeaderComp, actionsRenderer, arrowRenderer, eyeRenderer } from './grid-cell-renderers';
import { buildDataColumnDefs } from './grid-columns';
import { ValueModalService } from './value-modal/value-modal.service';
import {
  DETAIL_FLAG,
  DETAIL_PARENT,
  DetailRow,
  GridAction,
  GridActionEvent,
  GridColumn,
  GridContext,
  GridCreateEvent,
  NEW_FLAG,
  ROW_ID,
  RetrieveEvent,
  RollDataEvent,
  RollResult,
  RowUpdate,
  RowsDeletedEvent,
  RowsUpdatedEvent,
  olsGridTheme,
  olsGridThemeDark
} from './grid-data.model';

const DEFAULT_MODAL_ACTIONS: GridAction[] = [
  { id: 'edit', label: 'Edit', color: 'primary' },
  { id: 'duplicate', label: 'Duplicate', color: 'secondary' },
  { id: 'delete', label: 'Delete', color: 'danger' }
];

/** Every calendar date from `start` to `end` inclusive as `YYYY-MM-DD` (capped at 366). Local-time
 *  formatting (no `toISOString`) so a timezone offset never shifts the date by a day. */
function expandDates(start: string, end: string): string[] {
  if (!start) { return []; }
  const fmt = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let s = new Date(`${start}T00:00:00`);
  let e = new Date(`${end || start}T00:00:00`);
  if (isNaN(s.getTime()) || isNaN(e.getTime())) { return [start]; }
  if (e < s) { [s, e] = [e, s]; }
  const out: string[] = [];
  for (const d = new Date(s); d <= e && out.length < 366; d.setDate(d.getDate() + 1)) {
    out.push(fmt(d));
  }
  return out;
}

/** Serialise table content to RFC-4180 CSV (quotes doubled, fields escaped). */
function toCsv(content: TableContent): string {
  const escape = (value: unknown): string => {
    const text = value == null ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = content.columns.map((c) => escape(c.header ?? c.field)).join(',');
  const rows = content.rows.map((row) => content.columns.map((c) => escape(row[c.field])).join(','));
  return [header, ...rows].join('\r\n');
}


/**
 * Reusable ag-grid (Community) wrapper for the OLS Dashboard.
 *
 * Features (all free): typed cell rendering (clob/json/xml/blob/date/boolean),
 * an expand column that reveals fetched table content in a full-width detail
 * row, and a "view" column that opens the same content in a modal grid with
 * checkbox multi-selection and per-row Update/Delete actions.
 */
@Component({
  selector: 'app-grid-data',
  templateUrl: './grid-data.component.html',
  styleUrls: ['./grid-data.component.scss'],
  imports: [
    AgGridAngular,
    ModalComponent,
    ModalHeaderComponent,
    ModalTitleDirective,
    ModalBodyComponent,
    ModalFooterComponent,
    ButtonDirective,
    ButtonCloseDirective,
    DropdownComponent,
    DropdownToggleDirective,
    DropdownMenuDirective,
    DropdownItemDirective,
    LoaderComponent,
    ConfigUploadComponent
  ],
  host: { '[attr.data-ag-theme-mode]': 'themeMode()' }
})
export class GridDataComponent {
  private readonly colorModeService = inject(ColorModeService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly valueModal = inject(ValueModalService);
  private readonly confirm = inject(ConfirmService);
  private readonly errorReport = inject(ErrorReportService);

  // --- inputs ---------------------------------------------------------------
  readonly columns = input<GridColumn[]>([]);
  readonly rows = input<Record<string, unknown>[]>([]);
  readonly loading = input(false);
  /** Show the expand (down-arrow) column + enable full-width detail rows. */
  readonly expandable = input(false);
  /** Show the "view" (eye) column + enable the detail modal. */
  readonly viewable = input(false);
  /** Enable checkbox multi-selection (used by the modal grid). */
  readonly selectable = input(false);
  /** Per-row action buttons for the modal grid (defaults to Update/Delete). */
  readonly actions = input<GridAction[]>([]);
  /** Read-only mode (RBAC): hides every mutating control (Add/Save/Delete/Edit/Roll/Upload). */
  readonly readOnly = input(false);
  /** Optional PER-ROW write gate (RBAC). When provided, the content modal's mutating controls
   *  follow this predicate for the open table (so a user can edit some tables but not others).
   *  Falls back to `!readOnly()` when not supplied. */
  readonly canWriteRow = input<((row: Record<string, unknown>) => boolean) | null>(null);
  /** Loader invoked with a row to fetch its eye-modal content. */
  readonly getDetail = input<(row: Record<string, unknown>) => Observable<TableContent>>();
  /**
   * Loader for the down-arrow (expand) detail row. Falls back to {@link getDetail}
   * when not provided, so a grid that only sets one loader still expands.
   */
  readonly getExpand = input<(row: Record<string, unknown>) => Observable<TableContent>>();
  /** Optional stable id field (falls back to row index). */
  readonly idField = input<string>();
  /** Config scope (group/cib/retail) — passed to the CSV upload dialog. */
  readonly scope = input<ConfigScope>('cib');
  /** Row field used for the modal title + as the table name in API payloads. */
  readonly titleField = input('table_name');
  /** Row field holding the DB row identifier (Oracle rowid) for update/delete. */
  readonly rowIdField = input('rowid');
  readonly gridHeight = input('520px');

  // --- pagination (main grid) -----------------------------------------------
  readonly pagination = input(true);
  readonly pageSize = input(20);
  readonly pageSizeOptions = input<number[]>([10, 20, 50, 100]);

  // --- pagination (modal grid) ----------------------------------------------
  readonly modalPageSize = input(50);
  readonly modalPageSizeOptions = input<number[]>([20, 50, 100, 1000]);

  /** Rows failing this predicate are shown muted and cannot be opened. */
  readonly isRowActive = input<(row: Record<string, unknown>) => boolean>(() => true);
  /** Rows passing this predicate get the COB extras (Upload / Roll Data). */
  readonly isRowCob = input<(row: Record<string, unknown>) => boolean>(() => false);

  // --- outputs --------------------------------------------------------------
  /** Refresh icon in the first column header was clicked. */
  readonly refreshRequested = output<void>();
  /** Roll Data → Process was clicked for a COB table. */
  readonly rollData = output<RollDataEvent>();
  /** Retrieve was pressed on a COB table's date bar. */
  readonly retrieveRequested = output<RetrieveEvent>();
  /** Draft rows were saved (one row, or all at once) — INSERT. */
  readonly rowsCreated = output<GridCreateEvent>();
  /** Edited saved rows were saved (one, or all at once) — UPDATE. */
  readonly rowsUpdated = output<RowsUpdatedEvent>();
  /** Saved rows were deleted (one, or the selection) — DELETE. */
  readonly rowsDeleted = output<RowsDeletedEvent>();

  // --- outputs --------------------------------------------------------------
  readonly action = output<GridActionEvent>();

  /** Grid theme follows the app colour mode (light/dark) so the grid never stays white on dark. */
  readonly theme = computed(() => (this.themeMode() === 'dark' ? olsGridThemeDark : olsGridTheme));

  private gridApi?: GridApi;

  // --- expansion state ------------------------------------------------------
  private readonly expanded = signal<Set<string>>(new Set());
  private readonly detailData = signal<Map<string, DetailRow>>(new Map());

  // --- modal state ----------------------------------------------------------
  readonly modalVisible = signal(false);
  readonly modalTitle = signal('');
  readonly modalLoading = signal(false);
  readonly modalError = signal<string | null>(null);
  readonly modalContent = signal<TableContent | null>(null);
  readonly modalSelectedCount = signal(0);
  /** Selected rows split by kind: saved (existing) vs new drafts. */
  readonly selectedSavedCount = signal(0);
  readonly selectedDraftCount = signal(0);
  /** Selected rows that are currently in inline-edit mode. */
  readonly selectedEditingCount = signal(0);
  private modalApi?: GridApi;

  /** The catalogue row the modal was opened for (drives COB extras). */
  readonly modalRow = signal<Record<string, unknown> | null>(null);
  /** The open table's physical DB (catalogue DB_SOURCE, e.g. ols_cib_reporting) — routes per-table ops. */
  readonly modalDbSource = computed(() => String(this.modalRow()?.['DB_SOURCE'] ?? this.modalRow()?.['db_source'] ?? ''));
  readonly modalIsCob = computed(() => {
    const row = this.modalRow();
    return !!row && this.isRowCob()(row);
  });
  /** May the user WRITE the table currently open in the modal? Per-row gate if `canWriteRow` is
   *  supplied (RBAC per-table), else the global `readOnly`. Gates every mutating control. */
  readonly modalWritable = computed(() => {
    const fn = this.canWriteRow();
    const row = this.modalRow();
    if (fn && row) {
      return fn(row);
    }
    return !this.readOnly();
  });

  /**
   * All modal rows in display order — saved rows and unsaved drafts together,
   * so a draft can be inserted at any position (e.g. on the current page).
   */
  readonly modalRows = signal<Record<string, unknown>[]>([]);
  private draftSeq = 0;

  readonly draftRows = computed(() => this.modalRows().filter((r) => r[NEW_FLAG] === true));
  /** Total counts saved rows only — drafts don't inflate it until saved. */
  readonly modalTotalRows = computed(() => this.modalRows().filter((r) => r[NEW_FLAG] !== true).length);
  readonly hasDrafts = computed(() => this.draftRows().length > 0);

  /** Saved rows currently in inline-edit mode → id -> pre-edit snapshot. */
  private readonly editingRows = signal<Map<string, Record<string, unknown>>>(new Map());
  readonly hasEditing = computed(() => this.editingRows().size > 0);

  // --- Retrieve (date filter) bar, COB tables only --------------------------
  // Default to T-1 business day (Mon/Sat/Sun all fall back to Friday).
  readonly retrieveStart = signal(previousWeekdayIso());
  readonly retrieveEnd = signal(previousWeekdayIso());
  readonly retrieveRange = signal(false);

  // --- Roll Data panel ------------------------------------------------------
  readonly rollOpen = signal(false);
  readonly rollFrom = signal('');       // source (From) date
  readonly rollTo = signal('');         // target start date
  readonly rollToEnd = signal('');      // target end date (for a range / 2 discrete dates)
  readonly rollRange = signal(false);   // expand Target Start..End to every date in between
  readonly rollBusy = signal(false);
  readonly rollResult = signal<RollResult | null>(null);
  readonly rollNotice = signal<string | null>(null);
  /** How many target dates were skipped due to a DB failure (drives the partial-failure banner). */
  readonly rollFailed = computed(() => this.rollResult()?.targets.filter((t) => t.status === 'failed').length ?? 0);
  /** Rolled dates whose row count differs from the source (0 rows, doubled, etc.) — worth a second look. */
  readonly rollWarned = computed(() => {
    const rr = this.rollResult();
    if (!rr || rr.source_count == null) { return 0; }
    return rr.targets.filter((t) => t.status !== 'failed' && t.count != null && t.count !== rr.source_count).length;
  });
  /** Whether a target's row count is an anomaly vs the source (used per-row in the template). */
  rollCountMismatch(t: { status?: string; count?: number | null }): boolean {
    const rr = this.rollResult();
    return t.status !== 'failed' && rr?.source_count != null && t.count != null && t.count !== rr.source_count;
  }
  /** Target (To) dates: the range expanded, or the discrete start/end (deduped, sorted). */
  readonly rollTargets = computed(() => {
    const s = this.rollTo();
    const e = this.rollToEnd();
    if (!s) { return []; }
    if (this.rollRange()) { return expandDates(s, e || s); }
    return [...new Set([s, ...(e && e !== s ? [e] : [])])].sort();
  });
  /** Notice shown after a CSV load (success/info). */
  readonly uploadNotice = signal<string | null>(null);
  /** The CSV Upload & Load dialog is open. */
  readonly uploadOpen = signal(false);

  /** Resolve CoreUI colour mode → ag-grid theme mode. */
  readonly themeMode = computed<'light' | 'dark'>(() => {
    const mode = this.colorModeService.colorMode();
    if (mode === 'dark') {
      return 'dark';
    }
    if (mode === 'light') {
      return 'light';
    }
    return this.colorModeService.getPrefersColorScheme() === 'dark' ? 'dark' : 'light';
  });

  private readonly baseRows = computed(() =>
    this.rows().map((row, index) => ({ ...row, [ROW_ID]: this.ridFor(row, index) }))
  );

  /** Row data for the main grid, interleaving detail rows under expanded rows. */
  readonly displayRows = computed<Record<string, unknown>[]>(() => {
    const base = this.baseRows();
    const expanded = this.expanded();
    if (expanded.size === 0) {
      return base;
    }
    const details = this.detailData();
    const out: Record<string, unknown>[] = [];
    for (const row of base) {
      out.push(row);
      const rid = row[ROW_ID] as string;
      const detail = expanded.has(rid) ? details.get(rid) : undefined;
      if (detail) {
        out.push(detail as unknown as Record<string, unknown>);
      }
    }
    return out;
  });

  /**
   * Bumped once row data has rendered. ag-grid resolves cell renderers only when
   * the columnDefs genuinely change *after* rows exist — the initial binding is
   * applied while rowData is still empty, so renderers never run. Bumping this
   * rebuilds the defs (new object identities) and makes them paint.
   */
  private readonly colsVersion = signal(0);

  readonly columnDefs = computed<ColDef[]>(() => {
    this.colsVersion();
    const defs: ColDef[] = [];
    if (this.expandable()) {
      defs.push(this.arrowColumn());
    }
    defs.push(...buildDataColumnDefs(this.columns()));
    if (this.viewable()) {
      defs.push(this.eyeColumn());
    }
    return defs;
  });

  readonly modalColumnDefs = computed<ColDef[]>(() => {
    this.colsVersion();
    const content = this.modalContent();
    if (!content) {
      return [];
    }
    return [...buildDataColumnDefs(content.columns, { editableDrafts: true }), this.actionsColumn()];
  });

  /**
   * Stable, unique identity for modal rows so drafts survive re-renders.
   * Falls back to the ag-grid row index — duplicate ids silently break
   * rendering, scrolling and selection, so never return the same value twice.
   */
  private orphanRowSeq = 0;

  readonly modalGetRowId: GetRowIdFunc = (params) => {
    const id = (params.data as Record<string, unknown>)?.[ROW_ID];
    return id == null || id === '' ? `orphan-${++this.orphanRowSeq}` : String(id);
  };

  readonly defaultColDef: ColDef = { resizable: true, sortable: true, filter: false, minWidth: 110 };

  readonly modalRowSelection: RowSelectionOptions = {
    mode: 'multiRow',
    checkboxes: true,
    headerCheckbox: true,
    enableClickSelection: false
  };

  /** Freeze the checkbox column to the left edge so the row selector stays visible while the
   *  data columns scroll horizontally (native selection column — safe to pin). */
  readonly modalSelectionColumnDef: ColDef = {
    pinned: 'left',
    width: 52,
    maxWidth: 52,
    suppressMovable: true,
    resizable: false,
    lockPinned: true
  };

  readonly fullWidthCellRenderer = DetailRowComponent;

  /** Context shared with all cell renderers via ag-grid `context`. */
  readonly gridContext: GridContext = {
    toggleExpand: (node) => this.toggleExpand(node),
    isExpanded: (rid) => this.expanded().has(rid),
    openEye: (row) => this.openEye(row),
    runAction: (id, row) => this.runAction(id, row),
    actions: DEFAULT_MODAL_ACTIONS,
    isRowEnabled: (row) => this.isRowActive()(row),
    refreshTable: () => this.refreshRequested.emit(),
    isRowEditing: (row) => this.editingRows().has(String(row[ROW_ID])),
    // Per-table write gate (RBAC): respects canWriteRow for the open table, falling back to the scope
    // readOnly — so a read-only table inside a writable scope shows no per-row Edit/Duplicate/Delete either.
    isReadOnly: () => !this.modalWritable()
  };

  /** Mute rows that are not active so the state is obvious in the grid. */
  readonly getRowClass = (params: { data?: Record<string, unknown> }): string | undefined => {
    const data = params.data;
    if (!data || data[DETAIL_FLAG]) {
      return undefined;
    }
    return this.isRowActive()(data) ? undefined : 'ols-row--inactive';
  };

  readonly getRowId: GetRowIdFunc = (params) => {
    const data = params.data as Record<string, unknown>;
    if (data[DETAIL_FLAG]) {
      return `detail::${String(data[DETAIL_PARENT])}`;
    }
    return String(data[ROW_ID]);
  };

  readonly isFullWidthRow: IsFullWidthRow = (params) => params.rowNode.data?.[DETAIL_FLAG] === true;

  getRowHeight = (params: RowHeightParams): number | undefined =>
    params.data?.[DETAIL_FLAG] ? 340 : undefined;

  onGridReady(event: GridReadyEvent): void {
    this.gridApi = event.api;
    // Cold page load: data may have arrived before the grid was ready. Push it
    // now so the grid paints instead of getting stuck on the no-rows overlay.
    if (this.displayRows().length) {
      event.api.setGridOption('rowData', this.displayRows());
    }
  }


  onModalGridReady(event: GridReadyEvent): void {
    this.modalApi = event.api;
  }


  onModalSelectionChanged(_event: SelectionChangedEvent): void {
    this.recountSelection();
  }

  /**
   * Recompute the selection counts, split into saved vs draft rows, so the bulk
   * (saved-row) buttons and the draft-insert Save each react to their own subset.
   */
  private recountSelection(): void {
    const selected = (this.modalApi?.getSelectedRows() ?? []) as Record<string, unknown>[];
    const editing = this.editingRows();
    this.modalSelectedCount.set(selected.length);
    this.selectedDraftCount.set(selected.filter((r) => r[NEW_FLAG] === true).length);
    this.selectedSavedCount.set(selected.filter((r) => r[NEW_FLAG] !== true).length);
    this.selectedEditingCount.set(
      selected.filter((r) => r[NEW_FLAG] !== true && editing.has(String(r[ROW_ID]))).length
    );
  }

  /**
   * All cell-control clicks are handled by a NATIVE click listener on the grid
   * container (see the `(click)` bindings in the template), not ag-grid's
   * `cellClicked`. A real DOM click on our buttons bubbles to the container
   * regardless of what ag-grid does with focus/editing/event ordering, which
   * makes the controls reliable. `scope` selects the main vs. modal grid api.
   */
  onGridClick(event: Event, scope: 'main' | 'modal'): void {
    const target = event.target as HTMLElement | null;
    const api = scope === 'modal' ? this.modalApi : this.gridApi;
    if (!target || !api) {
      return;
    }

    const rowEl = target.closest('.ag-row') as HTMLElement | null;
    const rowId = rowEl?.getAttribute('row-id') ?? undefined;
    const node = rowId != null ? api.getRowNode(rowId) : undefined;
    const data = node?.data as Record<string, unknown> | undefined;

    // Expand / collapse (main grid).
    if (target.closest('.ols-arrow')) {
      if (node) {
        this.toggleExpand(node);
      }
      return;
    }

    // View content (eye) — ignored on disabled/inactive rows.
    if (target.closest('.ols-eye')) {
      if (data && !target.closest('.ols-eye--disabled')) {
        this.openEye(data);
      }
      return;
    }

    // Row action buttons (Edit / Duplicate / Delete / Save / Cancel).
    const actionBtn = target.closest('[data-action]') as HTMLElement | null;
    if (actionBtn && data) {
      const actionId = actionBtn.getAttribute('data-action') ?? '';
      if (actionId === 'save') {
        this.saveRow(data);
      } else if (actionId === 'cancel') {
        this.cancelRow(data);
      } else {
        this.runAction(actionId, data);
      }
      return;
    }

    const rowEditable = !!data && (data[NEW_FLAG] === true || this.editingRows().has(String(data[ROW_ID])));
    const cell = target.closest('.ag-cell') as HTMLElement | null;
    const colId = cell?.getAttribute('col-id') ?? undefined;

    // Calendar dropdown on a date cell — only opens the picker in edit mode.
    if (target.closest('[data-date-trigger]')) {
      if (rowEditable && colId && node?.rowIndex != null) {
        api.startEditingCell({ rowIndex: node.rowIndex, colKey: colId });
      }
      return;
    }

    // CLOB/JSON/XML/BLOB affordance — view the full value, or edit it in the
    // value modal (with OK/Cancel) while the row is being edited.
    if (target.closest('.ols-special') && data && colId) {
      const dataType = (api.getColumnDef(colId)?.cellRendererParams as { dataType?: CellDataType } | undefined)?.dataType;
      if (dataType) {
        if (rowEditable) {
          this.valueModal.open({
            type: dataType,
            field: colId,
            value: data[colId],
            editable: true,
            onSave: (newValue) => this.applyCellValue(data, colId, newValue)
          });
        } else {
          this.valueModal.open({ type: dataType, field: colId, value: data[colId] });
        }
      }
    }
  }

  /**
   * Write an edited value back into a modal row (used by the value modal for
   * CLOB/JSON/XML/BLOB cells). For a saved row in edit mode this becomes part of
   * the UPDATE diff; for a draft it is picked up by the INSERT.
   */
  private applyCellValue(row: Record<string, unknown>, field: string, value: unknown): void {
    const id = String(row[ROW_ID]);
    this.modalRows.update((rows) =>
      rows.map((r) => (String(r[ROW_ID]) === id ? { ...r, [field]: value } : r))
    );
    this.refreshModalCells();
  }

  // --- expand / collapse ----------------------------------------------------
  private toggleExpand(node: IRowNode): void {
    const rid = node.data?.[ROW_ID] as string | undefined;
    if (!rid) {
      return;
    }
    const expanded = new Set(this.expanded());
    const details = new Map(this.detailData());

    if (expanded.has(rid)) {
      expanded.delete(rid);
      details.delete(rid);
    } else {
      expanded.add(rid);
      const detail: DetailRow = {
        [DETAIL_FLAG]: true,
        [DETAIL_PARENT]: rid,
        loading: true,
        parent: node.data
      };
      details.set(rid, detail);
      this.loadDetail(rid, node.data);
    }

    this.expanded.set(expanded);
    this.detailData.set(details);
    this.gridApi?.refreshCells({ force: true, rowNodes: [node], columns: ['__arrow'] });
  }

  private loadDetail(rid: string, row: Record<string, unknown>): void {
    // Expand uses its own loader (columnretrieve); falls back to the eye loader.
    const loader = this.getExpand() ?? this.getDetail();
    if (!loader) {
      this.patchDetail(rid, { loading: false, error: 'No content loader provided' });
      return;
    }
    loader(row)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (content) => this.patchDetail(rid, { loading: false, content }),
        error: () => this.patchDetail(rid, { loading: false, error: 'Failed to load table content' })
      });
  }

  private patchDetail(rid: string, patch: Partial<DetailRow>): void {
    const details = new Map(this.detailData());
    const current = details.get(rid);
    if (!current) {
      return;
    }
    details.set(rid, { ...current, ...patch });
    this.detailData.set(details);
    // ag-grid does not re-render full-width rows on immutable data change, so
    // force the detail row to redraw once the new data has propagated.
    setTimeout(() => {
      const node = this.gridApi?.getRowNode(`detail::${rid}`);
      if (node) {
        this.gridApi?.redrawRows({ rowNodes: [node] });
      }
    });
  }

  // --- eye modal ------------------------------------------------------------
  private openEye(row: Record<string, unknown>): void {
    // Inactive rows cannot be opened.
    if (!this.isRowActive()(row)) {
      return;
    }
    this.gridContext.actions = this.actions().length ? this.actions() : DEFAULT_MODAL_ACTIONS;
    this.modalRow.set(row);
    this.modalTitle.set(String(row[this.titleField()] ?? 'Content'));
    this.rollOpen.set(false);
    this.rollNotice.set(null);
    this.uploadNotice.set(null);
    this.loadModalContent(row);
    this.modalVisible.set(true);
  }

  /** (Re)fetch the modal's table content — also used by the modal refresh icon. */
  private loadModalContent(row: Record<string, unknown>): void {
    this.modalContent.set(null);
    this.modalRows.set([]);
    this.editingRows.set(new Map());
    this.modalError.set(null);
    this.modalSelectedCount.set(0);
    this.modalLoading.set(true);

    const loader = this.getDetail();
    if (!loader) {
      this.modalLoading.set(false);
      this.modalError.set('No content loader provided');
      return;
    }
    loader(row)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (content) => {
          this.modalContent.set(content);
          this.modalRows.set(content.rows.map((r, i) => ({ ...r, [ROW_ID]: `r${i}` })));
          this.modalLoading.set(false);
        },
        error: () => {
          this.modalError.set('Failed to load content');
          this.modalLoading.set(false);
        }
      });
  }

  onModalVisibleChange(open: boolean): void {
    this.modalVisible.set(open);
  }

  closeModal(): void {
    this.modalVisible.set(false);
  }

  /** Modal header refresh — re-hit the API for this table's content. */
  refreshModalContent(): void {
    const row = this.modalRow();
    if (row) {
      this.loadModalContent(row);
    }
  }

  /** Export the open table's content as `<table_name>.csv`. */
  exportData(): void {
    const content = this.modalContent();
    if (!content) {
      return;
    }
    const csv = toCsv(content);
    // BOM so Excel opens UTF-8 correctly.
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.modalTitle() || 'export'}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /** Open the CSV Upload & Load dialog for the table currently open in the modal. */
  uploadData(): void {
    this.rollOpen.set(false);
    this.uploadNotice.set(null);
    this.uploadOpen.set(true);
  }

  /** A load finished — refresh the modal grid so the new data shows, and notice it. */
  onUploadLoaded(result: UploadResult): void {
    this.uploadOpen.set(false);
    const replaced = result.rows_deleted ? `, replaced ${result.rows_deleted}` : '';
    this.uploadNotice.set(`Loaded ${result.rows_loaded} row(s)${replaced} into ${this.modalTitle()}.`);
    const row = this.modalRow();
    if (row) { this.loadModalContent(row); }
  }

  toggleRollPanel(): void {
    this.uploadNotice.set(null);
    this.rollNotice.set(null);
    this.rollResult.set(null);
    this.rollOpen.update((open) => !open);
  }

  onRollFromChange(event: Event): void { this.rollFrom.set((event.target as HTMLInputElement).value); }
  onRollToChange(event: Event): void { this.rollTo.set((event.target as HTMLInputElement).value); }
  onRollToEndChange(event: Event): void { this.rollToEnd.set((event.target as HTMLInputElement).value); }
  onRollRangeChange(event: Event): void { this.rollRange.set((event.target as HTMLInputElement).checked); }

  /** Fire the roll request (source date → one or more target dates); the host performs the API call. */
  processRoll(): void {
    const row = this.modalRow();
    const source = this.rollFrom();
    const targets = this.rollTargets().filter((d) => d !== source);   // rolling onto the source is a no-op
    if (!row || !source) { this.rollNotice.set('Choose a source (From) date.'); return; }
    if (!targets.length) { this.rollNotice.set('Choose at least one target (To) date different from the source.'); return; }
    this.rollNotice.set(null);
    this.rollResult.set(null);
    this.rollBusy.set(true);
    this.rollData.emit({ row, tableName: this.modalTitle(), source, targets });
  }

  /** First line of a (possibly multi-line) roll error, with an ellipsis when there's more to see. */
  rollErrorSummary(err?: string): string {
    if (!err) { return ''; }
    const firstLine = err.split('\n')[0].trim();
    const clipped = firstLine.length > 160 ? firstLine.slice(0, 160).trimEnd() : firstLine;
    return (clipped.length < firstLine.length || err.trim().length > firstLine.length) ? clipped + ' …' : clipped;
  }
  /** Open the full (multi-line) roll error for one target date in the rich error dialog (Copy + Email). */
  showRollError(target: { date: string; error?: string }): void {
    if (!target.error) { return; }
    this.errorReport.show({ title: `Rollover failed — ${target.date}`, message: target.error, userId: environment.username });
  }

  /** Host surfaces the structured roll result. */
  setRollResult(result: RollResult): void { this.rollBusy.set(false); this.rollNotice.set(null); this.rollResult.set(result); }
  /** Host surfaces a status/error message. */
  setRollNotice(message: string): void { this.rollBusy.set(false); this.rollNotice.set(message); }

  // --- Retrieve (date filter) ----------------------------------------------
  onRetrieveStartChange(event: Event): void {
    this.retrieveStart.set((event.target as HTMLInputElement).value);
  }

  onRetrieveEndChange(event: Event): void {
    this.retrieveEnd.set((event.target as HTMLInputElement).value);
  }

  onRetrieveRangeChange(event: Event): void {
    this.retrieveRange.set((event.target as HTMLInputElement).checked);
  }

  /**
   * Retrieve rows for the chosen dates. Unchecked "Date Range" sends the two
   * dates as discrete values; checked sends them as an inclusive range.
   */
  retrieve(): void {
    const row = this.modalRow();
    if (!row || !this.retrieveStart() || !this.retrieveEnd()) {
      return;
    }
    this.retrieveRequested.emit({
      row,
      tableName: this.modalTitle(),
      start: this.retrieveStart(),
      end: this.retrieveEnd(),
      range: this.retrieveRange()
    });
  }

  /** Host hook: replace the modal's rows with a retrieved result set. */
  applyModalContent(content: TableContent): void {
    this.modalContent.set(content);
    this.modalRows.set(content.rows.map((r, i) => ({ ...r, [ROW_ID]: `r${i}` })));
    this.editingRows.set(new Map());
    this.modalLoading.set(false);
    this.modalError.set(null);
  }

  setModalLoading(loading: boolean): void {
    this.modalLoading.set(loading);
  }

  // --- Add / duplicate / save / cancel rows ---------------------------------
  /**
   * Insert a blank editable row at the **top of the first page**. Adding at the
   * bottom pushed each new draft onto a later page once the first page filled,
   * making multi-row entry painful; keeping them at the top clusters every new
   * draft together where the user is working. Order is irrelevant to the backend
   * — it is an INSERT either way.
   */
  addRow(): void {
    const content = this.modalContent();
    if (!content) {
      return;
    }
    // Add is an INSERT: cancel any pending edits so only one operation is live.
    this.beforeInsert();
    // No confirmation — Add only stages an editable draft row; nothing is
    // persisted until the user presses Save.
    const draft: Record<string, unknown> = {
      [ROW_ID]: `draft-${++this.draftSeq}`,
      [NEW_FLAG]: true
    };
    // Date columns start on today's date so the picker opens with a sensible
    // default rather than an empty value.
    const today = new Date().toISOString();
    for (const col of content.columns) {
      draft[col.field] = col.type === 'date' || col.type === 'timestamp' ? today : '';
    }
    this.insertDraft(draft, 0);
  }

  /** Clone a saved row into an editable draft placed directly beneath it. */
  private duplicateRow(row: Record<string, unknown>): void {
    // Duplicate is an INSERT: cancel any pending edits first (single operation).
    this.beforeInsert();
    const clone: Record<string, unknown> = { ...row };
    clone[ROW_ID] = `draft-${++this.draftSeq}`;
    clone[NEW_FLAG] = true;
    const index = this.modalRows().findIndex((r) => r[ROW_ID] === row[ROW_ID]);
    this.insertDraft(clone, index >= 0 ? index + 1 : this.modalRows().length);
  }

  private insertDraft(draft: Record<string, unknown>, index: number): void {
    let placed = 0;
    this.modalRows.update((rows) => {
      const next = [...rows];
      placed = Math.min(Math.max(index, 0), next.length);
      next.splice(placed, 0, draft);
      return next;
    });
    // The grid picks up the new rowData on the next change-detection pass, so
    // once the node exists: jump to the page the draft landed on (page 0 for
    // Add), auto-SELECT it (Save persists only ticked drafts) and reveal it.
    const draftId = String(draft[ROW_ID]);
    setTimeout(() => {
      const size = this.modalApi?.paginationGetPageSize() ?? placed + 1;
      this.modalApi?.paginationGoToPage(Math.floor(placed / size));
      this.modalApi?.getRowNode(draftId)?.setSelected(true);
      this.modalApi?.ensureIndexVisible(placed, 'top');
    }, 0);
  }

  // --- Inline edit of a saved row -------------------------------------------
  private startEdit(row: Record<string, unknown>): void {
    // Edit is an UPDATE: discard any pending drafts first (single operation).
    this.beforeUpdate();
    const id = String(row[ROW_ID]);
    this.editingRows.update((map) => new Map(map).set(id, { ...row }));
    this.refreshModalCells();
  }

  private async saveRow(row: Record<string, unknown>): Promise<void> {
    const isNew = row[NEW_FLAG] === true;
    const ok = await this.confirm.ask({
      title: isNew ? 'Save new row' : 'Save changes',
      message: isNew
        ? `Insert this new row into ${this.modalTitle()}?`
        : `Update this row in ${this.modalTitle()}?`,
      confirmLabel: 'Save',
      tone: 'success'
    });
    if (!ok) {
      return;
    }
    if (isNew) {
      this.commitDrafts([row]);
    } else {
      this.commitEdits([row]);
    }
  }

  private cancelRow(row: Record<string, unknown>): void {
    const id = String(row[ROW_ID]);
    if (row[NEW_FLAG] === true) {
      this.modalRows.update((rows) => rows.filter((r) => r[ROW_ID] !== id));
      setTimeout(() => this.recountSelection());
      return;
    }
    // Restore the pre-edit snapshot.
    const snapshot = this.editingRows().get(id);
    if (snapshot) {
      this.modalRows.update((rows) => rows.map((r) => (String(r[ROW_ID]) === id ? { ...snapshot } : r)));
    }
    this.editingRows.update((map) => {
      const next = new Map(map);
      next.delete(id);
      return next;
    });
    this.refreshModalCells();
  }

  /** Selected NEW draft rows (the ones that will be inserted on Save). */
  private selectedDraftRows(): Record<string, unknown>[] {
    return ((this.modalApi?.getSelectedRows() ?? []) as Record<string, unknown>[]).filter(
      (r) => r[NEW_FLAG] === true
    );
  }

  /** Selected saved rows currently in edit mode (bottom "Save selected" target). */
  private selectedEditingRows(): Record<string, unknown>[] {
    const editing = this.editingRows();
    return ((this.modalApi?.getSelectedRows() ?? []) as Record<string, unknown>[]).filter(
      (r) => r[NEW_FLAG] !== true && editing.has(String(r[ROW_ID]))
    );
  }

  /**
   * The single pending operation. INSERT (staged drafts, via Add/Duplicate) and
   * UPDATE (rows in inline-edit, via Edit) never coexist — starting one discards
   * the other (see {@link beforeInsert} / {@link beforeUpdate}) — so this is
   * unambiguous. DELETE is immediate and never leaves a pending state.
   */
  readonly pendingMode = computed<'none' | 'insert' | 'update'>(() => {
    if (this.hasDrafts()) {
      return 'insert';
    }
    if (this.hasEditing()) {
      return 'update';
    }
    return 'none';
  });

  /**
   * How many rows the bottom "Save selected" button will commit: selected drafts
   * in insert mode, selected edited rows in update mode. Un-ticked rows are
   * excluded, so the user picks exactly which of the staged rows to persist.
   */
  readonly saveSelectedCount = computed(() => {
    const mode = this.pendingMode();
    if (mode === 'insert') {
      return this.selectedDraftCount();
    }
    if (mode === 'update') {
      return this.selectedEditingCount();
    }
    return 0;
  });

  /** The bottom Save button shows only when there are selected rows to commit. */
  readonly hasPendingSave = computed(() => this.saveSelectedCount() > 0);

  // --- Single-operation enforcement -----------------------------------------
  // Only ONE kind of change can be pending at a time: Insert (Add/Duplicate),
  // Update (Edit) or Delete. Starting a new operation resets the previous one so
  // the bottom Save can never mix an INSERT and an UPDATE into one ambiguous save.

  /** Discard every unsaved draft row (used when switching to an edit/delete op). */
  private discardAllDrafts(): void {
    if (!this.hasDrafts()) {
      return;
    }
    this.modalRows.update((rows) => rows.filter((r) => r[NEW_FLAG] !== true));
    setTimeout(() => this.recountSelection());
  }

  /** Revert every in-progress inline edit back to its pre-edit snapshot. */
  private revertAllEdits(): void {
    const snaps = this.editingRows();
    if (!snaps.size) {
      return;
    }
    this.modalRows.update((rows) =>
      rows.map((r) => {
        const snap = snaps.get(String(r[ROW_ID]));
        return snap ? { ...snap } : r;
      })
    );
    this.editingRows.set(new Map());
    setTimeout(() => this.recountSelection());
  }

  /** Enforce single-operation: starting an INSERT cancels any pending edits. */
  private beforeInsert(): void {
    this.revertAllEdits();
  }

  /** Enforce single-operation: starting an UPDATE discards any pending drafts. */
  private beforeUpdate(): void {
    this.discardAllDrafts();
  }

  /** Enforce single-operation: a DELETE clears any pending insert/update first. */
  private clearPending(): void {
    this.revertAllEdits();
    this.discardAllDrafts();
  }

  /**
   * Bottom "Save selected" — commit the current pending operation for the
   * SELECTED rows only: INSERT the ticked drafts (insert mode) OR UPDATE the
   * ticked edited rows (update mode). Never both — the two modes are exclusive.
   */
  async saveSelected(): Promise<void> {
    const mode = this.pendingMode();
    if (mode === 'insert') {
      const drafts = this.selectedDraftRows();
      if (!drafts.length) {
        return;
      }
      const ok = await this.confirm.ask({
        title: 'Save new rows',
        message: `Insert ${drafts.length} new row${drafts.length === 1 ? '' : 's'} into ${this.modalTitle()}?`,
        confirmLabel: 'Save',
        tone: 'success'
      });
      if (ok) {
        this.commitDrafts(drafts);
      }
    } else if (mode === 'update') {
      const edits = this.selectedEditingRows();
      if (!edits.length) {
        return;
      }
      const ok = await this.confirm.ask({
        title: 'Save changes',
        message: `Update ${edits.length} selected row${edits.length === 1 ? '' : 's'} in ${this.modalTitle()}?`,
        confirmLabel: 'Save',
        tone: 'success'
      });
      if (ok) {
        this.commitEdits(edits);
      }
    }
  }

  private commitDrafts(drafts: Record<string, unknown>[]): void {
    const content = this.modalContent();
    if (!content) {
      return;
    }
    const ids = new Set(drafts.map((d) => String(d[ROW_ID])));
    // Promote the drafts in place — they keep their position in the grid.
    this.modalRows.update((rows) =>
      rows.map((r) => {
        if (!ids.has(String(r[ROW_ID]))) {
          return r;
        }
        const promoted: Record<string, unknown> = { ...r };
        delete promoted[NEW_FLAG];
        return promoted;
      })
    );
    this.syncContentFromRows();
    // INSERT payload: column order + each draft's values in that same order.
    const columns = content.columns.map((c) => c.field);
    const rows = drafts.map((d) => columns.map((f) => d[f] ?? null));
    this.rowsCreated.emit({ tableName: this.modalTitle(), columns, rows });
    // The promoted rows are now saved — clear their (draft) selection.
    setTimeout(() => {
      ids.forEach((id) => this.modalApi?.getRowNode(id)?.setSelected(false));
      this.recountSelection();
    });
    this.refreshModalCells();
  }

  /**
   * The actual key holding a row's DB identifier. Prefers the configured `rowIdField`
   * (default 'rowid' — what the mock and the update/delete payloads use), but falls
   * back to a CASE-INSENSITIVE match so a backend that returns the id as `ROWID` /
   * `OLS_ROWID` still resolves. Returns undefined if the row carries no id at all.
   */
  private rowIdKey(row: Record<string, unknown>): string | undefined {
    const field = this.rowIdField();
    if (field in row) {
      return field;
    }
    const aliases = new Set([field.toLowerCase(), 'rowid', 'ols_rowid']);
    return Object.keys(row).find((k) => aliases.has(k.toLowerCase()));
  }

  /** The DB identifier value for a row (via {@link rowIdKey}), or undefined if absent. */
  private rowIdOf(row: Record<string, unknown>): unknown {
    const key = this.rowIdKey(row);
    return key === undefined ? undefined : row[key];
  }

  /**
   * Commit edited saved rows → emit an UPDATE carrying each row's DB rowid and
   * only the columns whose value changed (diffed against the pre-edit snapshot).
   */
  private commitEdits(rows: Record<string, unknown>[]): void {
    const snapshots = this.editingRows();
    const fields = (this.modalContent()?.columns ?? []).map((c) => c.field);
    const updates: RowUpdate[] = rows.map((row) => {
      const snap = snapshots.get(String(row[ROW_ID]));
      const values: Record<string, unknown> = {};
      for (const f of fields) {
        if (!snap || row[f] !== snap[f]) {
          values[f] = row[f];
        }
      }
      return { rowid: this.rowIdOf(row), values };
    });
    // Leave edit mode for these rows.
    this.editingRows.update((map) => {
      const next = new Map(map);
      rows.forEach((r) => next.delete(String(r[ROW_ID])));
      return next;
    });
    this.syncContentFromRows();
    this.rowsUpdated.emit({ tableName: this.modalTitle(), updates });
    // The rows are now saved — clear their selection and recount.
    setTimeout(() => {
      rows.forEach((r) => this.modalApi?.getRowNode(String(r[ROW_ID]))?.setSelected(false));
      this.recountSelection();
    });
    this.refreshModalCells();
  }

  /**
   * Bulk edit: put every selected saved row into inline-edit mode at once and
   * KEEP them selected, so the bottom "Save selected N" can update them together
   * (each row also keeps its own per-row Save). This is an UPDATE, so any pending
   * drafts are discarded first (single operation).
   */
  editSelected(): void {
    const selected = (this.modalApi?.getSelectedRows() ?? []) as Record<string, unknown>[];
    const savedRows = selected.filter((r) => r[NEW_FLAG] !== true);
    if (!savedRows.length) {
      return;
    }
    this.beforeUpdate();
    this.editingRows.update((map) => {
      const next = new Map(map);
      savedRows.forEach((r) => next.set(String(r[ROW_ID]), { ...r }));
      return next;
    });
    // Rows stay selected on purpose — they drive the "Save selected N" button.
    this.recountSelection();
    this.refreshModalCells();
  }

  /** Bulk duplicate: clone every selected saved row into editable, pre-ticked drafts. */
  duplicateSelected(): void {
    const selected = (this.modalApi?.getSelectedRows() ?? []) as Record<string, unknown>[];
    const savedRows = selected.filter((r) => r[NEW_FLAG] !== true);
    if (!savedRows.length) {
      return;
    }
    // Duplicate is an INSERT: cancel any pending edits first (single operation).
    this.beforeInsert();
    const clones = savedRows.map((r) => {
      const clone: Record<string, unknown> = { ...r };
      clone[ROW_ID] = `draft-${++this.draftSeq}`;
      clone[NEW_FLAG] = true;
      const idKey = this.rowIdKey(clone); // a fresh row has no DB rowid yet
      if (idKey) {
        delete clone[idKey];
      }
      return clone;
    });
    // Deselect just the originals (keep any other draft ticks intact).
    savedRows.forEach((r) => this.modalApi?.getRowNode(String(r[ROW_ID]))?.setSelected(false));
    this.modalRows.update((rows) => [...rows, ...clones]);
    // Select the new draft clones (they'll be inserted on Save) once rendered.
    setTimeout(() => {
      clones.forEach((c) => this.modalApi?.getRowNode(String(c[ROW_ID]))?.setSelected(true));
      this.modalApi?.ensureIndexVisible(this.modalRows().length - 1, 'bottom');
      this.recountSelection();
    }, 0);
    this.refreshModalCells();
  }

  /** Keep the exportable content aligned with the on-screen rows. */
  private syncContentFromRows(): void {
    const content = this.modalContent();
    if (!content) {
      return;
    }
    const rows = this.modalRows()
      .filter((r) => r[NEW_FLAG] !== true)
      .map((r) => {
        const clean: Record<string, unknown> = { ...r };
        delete clean[ROW_ID];
        return clean;
      });
    this.modalContent.set({ columns: content.columns, rows });
  }

  /** Repaint modal cells so action buttons reflect the new row state. */
  private refreshModalCells(): void {
    setTimeout(() => this.modalApi?.refreshCells({ force: true }));
  }

  /**
   * Row actions. Add / Edit / Duplicate act immediately (they only stage an
   * editable row — nothing is persisted until Save). Delete mutates the table,
   * so it is confirmed first.
   */
  private async runAction(id: string, row: Record<string, unknown>): Promise<void> {
    if (id === 'edit') {
      this.startEdit(row);
      return;
    }

    if (id === 'duplicate') {
      this.duplicateRow(row);
      return;
    }

    if (id === 'delete') {
      const label = String(row['code'] ?? row['CODE'] ?? row['id'] ?? row['ID'] ?? '').trim();
      const suffix = label ? ` (${label})` : '';
      const ok = await this.confirm.ask({
        title: 'Delete this row',
        message: `Are you sure you want to delete this row${suffix}? This cannot be undone.`,
        confirmLabel: 'Delete',
        tone: 'danger'
      });
      if (!ok) {
        return;
      }
      // Delete is its own operation — clear any pending insert/update first.
      this.clearPending();
      this.rowsDeleted.emit({ tableName: this.modalTitle(), rowids: [this.rowIdOf(row)] });
      this.removeRows([row[ROW_ID]]);
      this.syncContentFromRows();
      return;
    }

    const action = this.gridContext.actions.find((a) => a.id === id) ?? { id, label: id, color: 'secondary' };
    this.action.emit({ action, row });
  }

  async deleteSelected(): Promise<void> {
    // Only SAVED rows can be deleted (drafts aren't persisted — Cancel discards them).
    const saved = ((this.modalApi?.getSelectedRows() ?? []) as Record<string, unknown>[]).filter(
      (r) => r[NEW_FLAG] !== true
    );
    if (saved.length === 0) {
      return;
    }
    const ok = await this.confirm.ask({
      title: 'Delete selected rows',
      message: `Are you sure you want to delete ${saved.length} selected row${saved.length === 1 ? '' : 's'}? This cannot be undone.`,
      confirmLabel: `Delete ${saved.length}`,
      tone: 'danger'
    });
    if (!ok) {
      return;
    }
    // Delete is its own operation — clear any pending insert/update first.
    this.clearPending();
    const rowids = saved.map((r) => this.rowIdOf(r));
    this.removeRows(saved.map((r) => r[ROW_ID]));
    this.rowsDeleted.emit({ tableName: this.modalTitle(), rowids });
    setTimeout(() => this.recountSelection());
  }

  /** Drop rows (saved or draft) from the modal by their internal id. */
  private removeRows(ids: unknown[]): void {
    const idSet = new Set(ids.map((id) => String(id)));
    this.modalRows.update((rows) => rows.filter((r) => !idSet.has(String(r[ROW_ID]))));
  }

  // --- column factories -----------------------------------------------------
  private arrowColumn(): ColDef {
    return {
      colId: '__arrow',
      headerName: '',
      width: 52,
      minWidth: 52,
      maxWidth: 52,
      // ag-grid v36 quirks for control columns:
      //  - never set `pinned`/`lockPosition`: such columns skip their cell renderer
      //  - a column with no `field` needs a `valueGetter`, else the renderer never runs
      suppressMovable: true,
      valueGetter: () => '',
      sortable: false,
      filter: false,
      resizable: false,
      cellClass: 'ols-cell-center',
      headerClass: 'ols-header-center',
      headerComponent: RefreshHeaderComp,
      cellRenderer: arrowRenderer
    };
  }

  private eyeColumn(): ColDef {
    return {
      colId: '__eye',
      headerName: '',
      width: 60,
      minWidth: 60,
      maxWidth: 60,
      suppressMovable: true,
      valueGetter: () => '',
      sortable: false,
      filter: false,
      resizable: false,
      cellClass: 'ols-cell-center',
      cellRenderer: eyeRenderer
    };
  }

  private actionsColumn(): ColDef {
    return {
      colId: '__actions',
      headerName: 'Actions',
      minWidth: 250,
      maxWidth: 290,
      // Frozen to the right edge so the row's Edit/Duplicate/Delete buttons stay
      // reachable no matter how many data columns the table has (they scroll under it).
      // ag-grid re-runs the cell renderer on the columnDefs rebuild once rows exist
      // (see `_renderFix`), so the buttons still paint even though this is pinned.
      pinned: 'right',
      lockPinned: true,
      suppressMovable: true,
      valueGetter: () => '',
      sortable: false,
      filter: false,
      resizable: false,
      cellClass: 'ols-cell-center',
      cellRenderer: actionsRenderer
    };
  }

  private rowsPainted = false;

  /**
   * ag-grid resolves cell renderers only when the columnDefs change *after* rows
   * exist; the initial binding is applied while rowData is still empty, so the
   * renderers never run. Rebuild the defs as soon as rows arrive.
   */
  private readonly _renderFix = effect(() => {
    const hasRows = this.displayRows().length > 0;
    // Columns can arrive asynchronously too (dynamic catalogues), so react to
    // them as well — otherwise function cell renderers (boolean/date/special)
    // paint before the columns settle and stay blank.
    const hasCols = this.columns().length > 0;
    if (!hasRows || !hasCols) {
      this.rowsPainted = false;
      return;
    }
    if (!this.rowsPainted) {
      this.rowsPainted = true;
      queueMicrotask(() => {
        this.colsVersion.update((v) => v + 1);
        // Cold page load: ag-grid can take the initial [rowData] into its model
        // before the body viewport exists and then never paint (model has the
        // rows, DOM shows the no-rows overlay). Re-push via the API to force the
        // first paint, then repaint function-rendered cells.
        this.gridApi?.setGridOption('rowData', this.displayRows());
        this.gridApi?.refreshCells({ force: true });
      });
    }
  });

  private modalRowsPainted = false;

  /**
   * Same one-shot fix for the modal grid: bump the defs once, when its rows
   * first arrive.
   *
   * It must stay one-shot. Re-applying columnDefs on every row change tears
   * down and rebuilds every column, which resets scroll position and cancels
   * whatever the user was doing — the grid then feels frozen. Later row-state
   * changes (add / save / delete) only need refreshCells, via refreshModalCells().
   */
  private readonly _modalRenderFix = effect(() => {
    const hasRows = !!this.modalContent() && this.modalRows().length > 0;
    if (!hasRows) {
      this.modalRowsPainted = false;
      return;
    }
    if (!this.modalRowsPainted) {
      this.modalRowsPainted = true;
      queueMicrotask(() => this.colsVersion.update((v) => v + 1));
    }
  });

  private ridFor(row: Record<string, unknown>, index: number): string {
    const field = this.idField();
    if (field && row[field] != null) {
      return String(row[field]);
    }
    return `row-${index}`;
  }
}
