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

import { previousWeekdayIso } from '../../shared/date-utils';
import { CellDataType, TableContent } from '../../shared/models';
import { ConfirmService } from '../confirm/confirm.service';
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
  olsGridTheme,
  olsGridThemeDark
} from './grid-data.model';

const DEFAULT_MODAL_ACTIONS: GridAction[] = [
  { id: 'edit', label: 'Edit', color: 'primary' },
  { id: 'duplicate', label: 'Duplicate', color: 'secondary' },
  { id: 'delete', label: 'Delete', color: 'danger' }
];

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
    LoaderComponent
  ],
  host: { '[attr.data-ag-theme-mode]': 'themeMode()' }
})
export class GridDataComponent {
  private readonly colorModeService = inject(ColorModeService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly valueModal = inject(ValueModalService);
  private readonly confirm = inject(ConfirmService);

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
  /** Loader invoked with a row to fetch its detail/modal content. */
  readonly getDetail = input<(row: Record<string, unknown>) => Observable<TableContent>>();
  /** Optional stable id field (falls back to row index). */
  readonly idField = input<string>();
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
  /** Draft rows were saved (one row, or all at once). */
  readonly rowsCreated = output<GridCreateEvent>();

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
  private modalApi?: GridApi;

  /** The catalogue row the modal was opened for (drives COB extras). */
  readonly modalRow = signal<Record<string, unknown> | null>(null);
  readonly modalIsCob = computed(() => {
    const row = this.modalRow();
    return !!row && this.isRowCob()(row);
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
  readonly rollFrom = signal('');
  readonly rollTo = signal('');
  readonly rollNotice = signal<string | null>(null);
  /** Placeholder notice for the not-yet-built Upload Data feature. */
  readonly uploadNotice = signal<string | null>(null);

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
    isReadOnly: () => this.readOnly()
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
  }


  onModalGridReady(event: GridReadyEvent): void {
    this.modalApi = event.api;
  }


  onModalSelectionChanged(event: SelectionChangedEvent): void {
    this.modalSelectedCount.set(event.api.getSelectedRows().length);
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

    // CLOB/JSON/XML/BLOB token — view the full value (not while inline-editing).
    if (target.closest('.ols-special') && data && !rowEditable && colId) {
      const dataType = (api.getColumnDef(colId)?.cellRendererParams as { dataType?: CellDataType } | undefined)?.dataType;
      if (dataType) {
        this.valueModal.open({ type: dataType, field: colId, value: data[colId] });
      }
    }
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
    const loader = this.getDetail();
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
    this.modalTitle.set(String(row['table_name'] ?? 'Content'));
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

  /** Upload Data is a placeholder for now. */
  uploadData(): void {
    this.rollOpen.set(false);
    this.uploadNotice.set('Upload Data is under development — this feature is coming soon.');
  }

  toggleRollPanel(): void {
    this.uploadNotice.set(null);
    this.rollNotice.set(null);
    this.rollOpen.update((open) => !open);
  }

  onRollFromChange(event: Event): void {
    this.rollFrom.set((event.target as HTMLInputElement).value);
  }

  onRollToChange(event: Event): void {
    this.rollTo.set((event.target as HTMLInputElement).value);
  }

  /** Fire the roll request; the host view performs the API call. */
  processRoll(): void {
    const row = this.modalRow();
    const from = this.rollFrom();
    const to = this.rollTo();
    if (!row || !from || !to) {
      this.rollNotice.set('Please choose both a From and a To date.');
      return;
    }
    this.rollNotice.set(null);
    this.rollData.emit({ row, tableName: this.modalTitle(), from, to });
  }

  /** Called by the host to surface the roll result. */
  setRollNotice(message: string): void {
    this.rollNotice.set(message);
  }

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
   * Insert a blank editable row at the end of the page the user is currently
   * on, so the new line appears where they are working rather than on the last
   * page. Order is irrelevant to the backend — it is an INSERT either way.
   */
  addRow(): void {
    const content = this.modalContent();
    if (!content) {
      return;
    }
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
    this.insertDraft(draft, this.currentPageEndIndex());
  }

  /** Clone a saved row into an editable draft placed directly beneath it. */
  private duplicateRow(row: Record<string, unknown>): void {
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
    // scroll the draft into view once it exists rather than synchronously here.
    setTimeout(() => this.modalApi?.ensureIndexVisible(placed, 'bottom'), 0);
  }

  /**
   * Index at which to place a new row so it lands at the bottom of the page the
   * user is currently viewing. On a partially filled page the draft is appended
   * after the last row; on a full page it takes the last visible slot (the row
   * that was last spills to the next page), so the user always sees it.
   */
  private currentPageEndIndex(): number {
    const api = this.modalApi;
    const total = this.modalRows().length;
    if (!api) {
      return total;
    }
    const size = api.paginationGetPageSize();
    const pageStart = api.paginationGetCurrentPage() * size;
    const pageEndExclusive = Math.min(pageStart + size, total);
    const rowsOnPage = pageEndExclusive - pageStart;
    return rowsOnPage < size ? pageEndExclusive : pageStart + size - 1;
  }

  // --- Inline edit of a saved row -------------------------------------------
  private startEdit(row: Record<string, unknown>): void {
    const id = String(row[ROW_ID]);
    this.editingRows.update((map) => new Map(map).set(id, { ...row }));
    this.refreshModalCells();
  }

  private async saveRow(row: Record<string, unknown>): Promise<void> {
    const id = String(row[ROW_ID]);
    const isNew = row[NEW_FLAG] === true;
    const ok = await this.confirm.ask({
      title: isNew ? 'Save new row' : 'Save changes',
      message: isNew
        ? `Insert this new row into ${this.modalTitle()}?`
        : `Are you sure you want to update the data of this row?`,
      confirmLabel: 'Save',
      tone: 'success'
    });
    if (!ok) {
      return;
    }
    if (isNew) {
      this.commitDrafts([row]);
      return;
    }
    // Saved row leaving edit mode.
    this.editingRows.update((map) => {
      const next = new Map(map);
      next.delete(id);
      return next;
    });
    this.syncContentFromRows();
    this.action.emit({ action: { id: 'update', label: 'Update', color: 'primary' }, row });
    this.refreshModalCells();
  }

  private cancelRow(row: Record<string, unknown>): void {
    const id = String(row[ROW_ID]);
    if (row[NEW_FLAG] === true) {
      this.modalRows.update((rows) => rows.filter((r) => r[ROW_ID] !== id));
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

  /** Bottom "Save" — commit every pending draft in one go. */
  async saveAllDrafts(): Promise<void> {
    const drafts = this.draftRows();
    if (!drafts.length) {
      return;
    }
    const ok = await this.confirm.ask({
      title: 'Save all new rows',
      message: `Insert ${drafts.length} new row${drafts.length === 1 ? '' : 's'} into ${this.modalTitle()}?`,
      confirmLabel: `Save ${drafts.length}`,
      tone: 'success'
    });
    if (ok) {
      this.commitDrafts(drafts);
    }
  }

  private commitDrafts(drafts: Record<string, unknown>[]): void {
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
    const saved = drafts.map((d) => {
      const clean: Record<string, unknown> = { ...d };
      delete clean[NEW_FLAG];
      return clean;
    });
    this.rowsCreated.emit({ tableName: this.modalTitle(), rows: saved });
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
      const label = String(row['code'] ?? row['id'] ?? '').trim();
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
      this.action.emit({ action: { id: 'delete', label: 'Delete', color: 'danger' }, row });
      this.removeRows([row[ROW_ID]]);
      this.syncContentFromRows();
      return;
    }

    const action = this.gridContext.actions.find((a) => a.id === id) ?? { id, label: id, color: 'secondary' };
    this.action.emit({ action, row });
  }

  async deleteSelected(): Promise<void> {
    const selected = this.modalApi?.getSelectedRows() ?? [];
    if (selected.length === 0) {
      return;
    }
    const ok = await this.confirm.ask({
      title: 'Delete selected rows',
      message: `Are you sure you want to delete ${selected.length} selected row${selected.length === 1 ? '' : 's'}? This cannot be undone.`,
      confirmLabel: `Delete ${selected.length}`,
      tone: 'danger'
    });
    if (!ok) {
      return;
    }
    this.removeRows(selected.map((r) => (r as Record<string, unknown>)[ROW_ID]));
    selected.forEach((row) => this.action.emit({ action: { id: 'delete', label: 'Delete', color: 'danger' }, row }));
    this.modalSelectedCount.set(0);
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
    if (!hasRows) {
      this.rowsPainted = false;
      return;
    }
    if (!this.rowsPainted) {
      this.rowsPainted = true;
      queueMicrotask(() => this.colsVersion.update((v) => v + 1));
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
