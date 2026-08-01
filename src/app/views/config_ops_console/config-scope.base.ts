import { computed, Directive, inject, OnInit, signal } from '@angular/core';
import { forkJoin, map, Observable } from 'rxjs';

import { RbacService } from '../../auth/rbac.service';
import { GridDataComponent } from '../../components/grid-data/grid-data.component';
import {
  GridActionEvent,
  GridColumn,
  GridCreateEvent,
  prettifyHeader,
  RetrieveEvent,
  RollDataEvent
} from '../../components/grid-data/grid-data.model';
import { ApiDataService } from '../../shared/api-data.service';
import { API, ConfigScope } from '../../shared/api-endpoints';
import { previousWeekdayIso } from '../../shared/date-utils';
import { CellDataType, ColumnsResponse, ColumnMeta, TableContent, TabularData } from '../../shared/models';

/** Treat true / 'Y' / 'YES' / '1' as set, so booleans and Y/N flags both work. */
function isFlagSet(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  const text = String(value ?? '').trim().toUpperCase();
  return text === 'Y' || text === 'YES' || text === 'TRUE' || text === '1';
}

/** Candidate names for the semantic catalogue columns (matched case-insensitively). */
const TABLE_NAME_KEYS = ['TABLE_NAME', 'TABLENAME', 'TABLE', 'NAME'];
const ACTIVE_KEYS = ['IS_ACTIVE', 'ACTIVE'];
const COB_KEYS = ['IS_COBDT', 'IS_COB', 'COBDT', 'COB'];

/** Find the actual column name in `cols` matching one of `candidates`. */
function resolveKey(cols: string[], candidates: string[], fallback: string): string {
  const upper = cols.map((c) => c.toUpperCase());
  for (const cand of candidates) {
    const i = upper.indexOf(cand.toUpperCase());
    if (i >= 0) {
      return cols[i];
    }
  }
  return fallback;
}

/** Catalogue column type: IS_* flags render as Yes/No badges, everything else as text. */
function catalogueType(field: string): CellDataType {
  return /^is[_a-z0-9]*$/i.test(field) ? 'boolean' : 'string';
}

/** Map an Oracle-ish DB data type (from dba_tab_columns) to a logical cell type. */
function dbTypeToCellType(dbType: string): CellDataType {
  const t = (dbType ?? '').toUpperCase();
  if (t.includes('TIMESTAMP')) {
    return 'timestamp';
  }
  if (t === 'DATE') {
    return 'date';
  }
  if (t === 'NUMBER' || t === 'INTEGER' || t === 'INT' || t === 'FLOAT' || t === 'DECIMAL' || t === 'NUMERIC') {
    return 'number';
  }
  if (t === 'CLOB' || t === 'NCLOB' || t === 'LONG') {
    return 'clob';
  }
  if (t === 'BLOB' || t === 'RAW' || t === 'BFILE') {
    return 'blob';
  }
  if (t === 'JSON') {
    return 'json';
  }
  if (t === 'XMLTYPE' || t === 'XML') {
    return 'xml';
  }
  return 'string';
}

/** Merge the columns API (types) with the content API (rows) into grid content. */
function mergeContent(colsResp: ColumnsResponse | null, content: TabularData | null): TableContent {
  const detailCols: ColumnMeta[] = (colsResp?.columns ?? []).map((c) => ({
    field: c.name,
    header: prettifyHeader(c.name),
    type: dbTypeToCellType(c.type)
  }));
  const contentCols = content?.cols ?? detailCols.map((c) => c.field);
  const columns = detailCols.length
    ? detailCols
    : contentCols.map((c) => ({ field: c, header: prettifyHeader(c), type: 'string' as CellDataType }));
  const rows = (content?.rows ?? []).map((arr) =>
    Object.fromEntries(contentCols.map((c, i) => [c, arr[i]]))
  );
  return { columns, rows };
}

/**
 * Shared behaviour for the CIB / Group / Retail sections. Each concrete
 * component only declares its {@link ConfigScope}; the catalogue fetch, column
 * lookup, content loader and action handlers live here (DRY).
 *
 * The catalogue is fully dynamic: columns come straight from the API's `cols`,
 * so adding a column to the backing table auto-appears with no UI change. Only
 * the *semantic* columns (table name, IS_ACTIVE, IS_COBDT) are looked up by name.
 */
@Directive()
export abstract class ConfigScopeBase implements OnInit {
  protected abstract readonly scope: ConfigScope;

  private readonly api = inject(ApiDataService);
  private readonly rbac = inject(RbacService);

  /** Grid columns built from the catalogue API's `cols` (dynamic). */
  readonly columns = signal<GridColumn[]>([]);
  readonly rows = signal<Record<string, unknown>[]>([]);
  readonly loading = signal(true);

  /** Resolved semantic column names (from the catalogue `cols`). */
  private tableNameKey = 'TABLE_NAME';
  private activeKey = 'IS_ACTIVE';
  private cobKey = 'IS_COBDT';
  /** The table-name field, bound to the grid's idField + titleField. */
  readonly tableNameField = signal('TABLE_NAME');

  /** RBAC read-only: true when the user may view but not act on Config Ops. */
  readonly readOnly = computed(() => !this.rbac.canWrite('config_ops_console'));

  /** In-page tab: the config grid or the (currently empty) MISC activity view. */
  readonly activeTab = signal<'config' | 'misc'>('config');

  /** Display label for this scope, e.g. "OLS CIB". */
  get label(): string {
    return `OLS ${this.scope.toUpperCase()}`;
  }

  ngOnInit(): void {
    this.fetchTables();
  }

  private fetchTables(): void {
    this.loading.set(true);
    this.api.get<TabularData>(API.config.tables(this.scope)).subscribe({
      next: (data) => {
        const cols = data?.cols ?? [];
        this.tableNameKey = resolveKey(cols, TABLE_NAME_KEYS, 'TABLE_NAME');
        this.activeKey = resolveKey(cols, ACTIVE_KEYS, 'IS_ACTIVE');
        this.cobKey = resolveKey(cols, COB_KEYS, 'IS_COBDT');
        this.tableNameField.set(this.tableNameKey);

        this.columns.set(
          cols.map((field) => ({
            field,
            header: prettifyHeader(field),
            type: catalogueType(field),
            ...(field === this.tableNameKey ? { minWidth: 240, flex: 2 } : {})
          }))
        );
        this.rows.set((data?.rows ?? []).map((arr) => Object.fromEntries(cols.map((c, i) => [c, arr[i]]))));
        this.loading.set(false);
      },
      error: () => this.loading.set(false)
    });
  }

  /**
   * Loader passed to <app-grid-data> for row-expand + eye-modal content. Fetches
   * the table's columns (dba_tab_columns) and its rows in parallel. A COB table
   * (IS_COBDT = Y) loads its most-recent business day by default; a non-COB table
   * passes only the table name (no date).
   */
  getDetail = (row: Record<string, unknown>): Observable<TableContent> => {
    const tableName = String(row[this.tableNameKey]);
    const isCob = isFlagSet(row[this.cobKey]);
    return this.loadContent(tableName, isCob ? defaultDates() : undefined);
  };

  /** Fetch column metadata + row content, merged into grid content. */
  private loadContent(
    tableName: string,
    dates?: { start: string; end: string; range: boolean }
  ): Observable<TableContent> {
    const body: Record<string, unknown> = { table_name: tableName };
    if (dates) {
      body['start'] = dates.start;
      body['end'] = dates.end;
      body['range'] = dates.range;
    }
    return forkJoin({
      columns: this.api.post<ColumnsResponse>(API.config.columns(this.scope), { table_name: tableName }),
      content: this.api.post<TabularData>(API.config.retrieve(this.scope), body)
    }).pipe(map(({ columns, content }) => mergeContent(columns, content)));
  }

  /** ACTIVE flag — accepts booleans or Y/N strings from the backend. */
  isRowActive = (row: Record<string, unknown>): boolean => isFlagSet(row[this.activeKey]);

  /** IS_COBDT flag — COB tables get the date bar + Upload / Roll Data extras. */
  isRowCob = (row: Record<string, unknown>): boolean => isFlagSet(row[this.cobKey]);

  /** Refresh icon in the first column header. */
  reload(): void {
    this.fetchTables();
  }

  onAction(event: GridActionEvent): void {
    // Mock backend: log the intent. A real backend would PUT/DELETE here.
    // eslint-disable-next-line no-console
    console.info(`[config:${this.scope}] ${event.action.id}`, event.row);
  }

  /**
   * Retrieve → fetch rows for the chosen dates and push them into the modal.
   * `range: false` sends the two dates as discrete values. (COB tables only.)
   */
  onRetrieve(event: RetrieveEvent, grid: GridDataComponent): void {
    grid.setModalLoading(true);
    this.loadContent(event.tableName, { start: event.start, end: event.end, range: event.range }).subscribe({
      next: (content) => grid.applyModalContent(content),
      error: () => grid.setModalLoading(false)
    });
  }

  /** Draft rows saved in the modal — persist them. */
  onRowsCreated(event: GridCreateEvent): void {
    this.api
      .post(API.config.createRows(this.scope), { table_name: event.tableName, rows: event.rows })
      .subscribe({
        // eslint-disable-next-line no-console
        error: () => console.warn(`[config:${this.scope}] failed to insert rows into ${event.tableName}`)
      });
  }

  /** Roll Data → Process: hand the table + range to the backend. */
  onRollData(event: RollDataEvent, grid: GridDataComponent): void {
    grid.setRollNotice('Processing roll…');
    this.api
      .post<{ message?: string; rolledRows?: number }>(API.config.rollData(this.scope), {
        table_name: event.tableName,
        from: event.from,
        to: event.to
      })
      .subscribe({
        next: (res) =>
          grid.setRollNotice(res.message ?? `Rolled ${event.tableName} (${res.rolledRows ?? 0} rows).`),
        error: () => grid.setRollNotice('Roll failed. Please try again.')
      });
  }
}

/** Default COB date window: the previous business day (T-1), discrete (not a range). */
function defaultDates(): { start: string; end: string; range: boolean } {
  const day = previousWeekdayIso();
  return { start: day, end: day, range: false };
}
