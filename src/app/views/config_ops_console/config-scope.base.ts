import { computed, Directive, inject, OnInit, signal } from '@angular/core';
import { map, Observable } from 'rxjs';

import { AuthService } from '../../auth/auth.service';
import { RbacService } from '../../auth/rbac.service';
import { ConfirmService } from '../../components/confirm/confirm.service';
import { ErrorReportService } from '../../components/error-report/error-report.service';
import { GridDataComponent } from '../../components/grid-data/grid-data.component';
import {
  GridActionEvent,
  GridColumn,
  GridCreateEvent,
  prettifyHeader,
  RetrieveEvent,
  RollDataEvent,
  RollResult,
  RowsDeletedEvent,
  RowsUpdatedEvent
} from '../../components/grid-data/grid-data.model';
import { ApiDataService } from '../../shared/api-data.service';
import { API, ConfigScope, apiEnv } from '../../shared/api-endpoints';
import { environment } from '../../../environments/environment';
import { previousWeekdayIso } from '../../shared/date-utils';
import { CellDataType, ColumnMeta, TableContent, TableContentResponse, TabularData } from '../../shared/models';

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
/** Category column (RBAC category grants). Must be returned by /api/config/{scope}/tables. */
const CATEGORY_KEYS = ['TABLE_CATEGORY', 'CATEGORY', 'TABLE_CAT'];

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

/**
 * Catalogue column type: IS_* flags (IS_COBDT / IS_ACTIVE) render as coloured
 * green/grey badges — but showing their **raw** value (Y / N / Yes / true …), not
 * a relabelled Yes/No. Everything else is plain text.
 */
function catalogueType(field: string): CellDataType {
  return /^is[_a-z0-9]*$/i.test(field) ? 'boolean' : 'string';
}

/**
 * Map a cx_Oracle DB type string to a logical cell type. Accepts the raw form
 * returned by the API, e.g. "<cx_Oracle.DbType DB_TYPE_DATE>", and drives typed
 * rendering: date → date-only calendar, timestamp → date+time calendar,
 * clob/blob/json/xml → the "…" value token.
 */
function cxOracleTypeToCellType(raw: string): CellDataType {
  const m = /DB_TYPE_([A-Z0-9_]+)/.exec(raw ?? '');
  const t = m ? m[1] : (raw ?? '').toUpperCase();
  if (t.startsWith('TIMESTAMP')) {
    return 'timestamp';
  }
  if (t === 'DATE') {
    return 'date';
  }
  if (t === 'NUMBER' || t === 'BINARY_FLOAT' || t === 'BINARY_DOUBLE' || t === 'INTEGER' || t === 'BINARY_INTEGER') {
    return 'number';
  }
  if (t === 'CLOB' || t === 'NCLOB' || t === 'LONG') {
    return 'clob';
  }
  if (t === 'BLOB' || t === 'RAW' || t === 'LONG_RAW' || t === 'BFILE') {
    return 'blob';
  }
  if (t === 'JSON') {
    return 'json';
  }
  if (t === 'XMLTYPE' || t === 'OBJECT') {
    return 'xml';
  }
  // CHAR(1) columns are Y/N flags in this schema → render as Yes/No badges.
  if (t === 'CHAR' || t === 'NCHAR') {
    return 'boolean';
  }
  // VARCHAR, VARCHAR2, NVARCHAR, … → text.
  return 'string';
}

/**
 * Build grid content from the eye-click response. Columns + their types come from
 * `cols` / `cols_data_types`; rows are `Table_data` as-is (each still carries its
 * hidden `rowid`, which never becomes a column because it isn't listed in `cols`).
 */
function buildContent(res: TableContentResponse | null): TableContent {
  const cols = res?.cols ?? [];
  const types = res?.cols_data_types ?? [];
  const columns: ColumnMeta[] = cols.map((name, i) => ({
    field: name,
    header: prettifyHeader(name),
    type: cxOracleTypeToCellType(types[i])
  }));
  return { columns, rows: res?.Table_data ?? [] };
}

/**
 * Build detail-grid content from the down-arrow `columnretrieve` response — a
 * plain `TabularData` ({ cols, rows }). Every column is shown as text (raw value)
 * — the grid just displays whatever the backend returns.
 */
function tabularToContent(data: TabularData | null): TableContent {
  const cols = data?.cols ?? [];
  const columns: ColumnMeta[] = cols.map((name) => ({
    field: name,
    header: prettifyHeader(name),
    // Same rule as the catalogue: IS_* flags get the coloured badge.
    type: catalogueType(name)
  }));
  const rows = (data?.rows ?? []).map((arr) => Object.fromEntries(cols.map((c, i) => [c, arr[i]])));
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
  private readonly auth = inject(AuthService);
  private readonly confirm = inject(ConfirmService);
  private readonly errorReport = inject(ErrorReportService);

  /** Current user id stamped onto inserted_by / updated_by / deleted_by. */
  private get actor(): string {
    return this.auth.user()?.username ?? 'unknown';
  }

  /** Grid columns built from the catalogue API's `cols` (dynamic). */
  readonly columns = signal<GridColumn[]>([]);
  readonly rows = signal<Record<string, unknown>[]>([]);
  readonly loading = signal(true);

  /** Resolved semantic column names (from the catalogue `cols`). */
  private tableNameKey = 'TABLE_NAME';
  private activeKey = 'IS_ACTIVE';
  private cobKey = 'IS_COBDT';
  private categoryKey = 'TABLE_CATEGORY';
  /** The table-name field, bound to the grid's idField + titleField. */
  readonly tableNameField = signal('TABLE_NAME');

  /** RBAC scope-level read-only: true when the user can't write ANY table in this scope (hides
   *  catalogue-level controls). Per-table write is decided by {@link canWriteRow} in the modal. */
  readonly readOnly = computed(() => !this.rbac.configScopeWritable(this.scope));

  /** RBAC per-table write gate for the content modal — bound to the grid's `[canWriteRow]`.
   *  A user can edit some tables and not others (per-table / category grants). */
  readonly canWriteRow = (row: Record<string, unknown>): boolean =>
    this.rbac.canWriteTable(this.scope, String(row[this.tableNameKey] ?? ''), String(row[this.categoryKey] ?? ''));

  /** In-page tab: config grid, MISC activity, S-Studio, or the Regression workflow. */
  readonly activeTab = signal<'config' | 'misc' | 'sstudio' | 'regression'>('config');

  /** Brief entrance loader on tab switch, so MISC / S-Studio / Regression match the config page's
   *  loading style (the config grid has its own loader, so it's excluded). */
  readonly tabLoading = signal(false);
  private tabLoadTimer: ReturnType<typeof setTimeout> | null = null;

  selectTab(tab: 'config' | 'misc' | 'sstudio' | 'regression'): void {
    if (this.activeTab() === tab) { return; }
    this.activeTab.set(tab);
    if (this.tabLoadTimer) { clearTimeout(this.tabLoadTimer); this.tabLoadTimer = null; }
    if (tab === 'config') { this.tabLoading.set(false); return; }
    this.tabLoading.set(true);
    this.tabLoadTimer = setTimeout(() => { this.tabLoading.set(false); this.tabLoadTimer = null; }, 450);
  }

  /** S-Studio tab visible ONLY for authorised operators (`ols_ops_access.can_sql`). */
  readonly canSql = computed(() => this.rbac.canSql());

  /** Regression tab visible only in DEV/STG (rendered only on the CIB scope screen). */
  readonly showRegression = computed(() => environment.appEnv === 'DEV' || environment.appEnv === 'STG');

  /** The config scope, exposed for the S-Studio child (`[scope]`). */
  get scopeKey(): ConfigScope {
    return this.scope;
  }

  /** Display label for this scope, e.g. "OLS CIB". */
  get label(): string {
    return `OLS ${this.scope.toUpperCase()}`;
  }

  ngOnInit(): void {
    this.fetchTables();
  }

  private fetchTables(): void {
    this.loading.set(true);
    // POST so the environment + username travel in the BODY — username never lands
    // in the URL/query string (or server access logs). `LIVE` is sent as `PROD`.
    this.api.post<TabularData>(API.config.tables(this.scope), {
      app_env: apiEnv(),
      username: this.actor
    }).subscribe({
      next: (data) => {
        const cols = data?.cols ?? [];
        this.tableNameKey = resolveKey(cols, TABLE_NAME_KEYS, 'TABLE_NAME');
        this.activeKey = resolveKey(cols, ACTIVE_KEYS, 'IS_ACTIVE');
        this.cobKey = resolveKey(cols, COB_KEYS, 'IS_COBDT');
        this.categoryKey = resolveKey(cols, CATEGORY_KEYS, 'TABLE_CATEGORY');
        this.tableNameField.set(this.tableNameKey);

        this.columns.set(
          cols.map((field) => ({
            field,
            header: prettifyHeader(field),
            type: catalogueType(field),
            ...(field === this.tableNameKey ? { minWidth: 240, flex: 2 } : {})
          }))
        );
        // RBAC opt-in read: show only the tables this user may see (per-table / category grants).
        // ADMIN sees all. A table the user has no grant for is filtered out entirely.
        const all = (data?.rows ?? []).map((arr) => Object.fromEntries(cols.map((c, i) => [c, arr[i]])));
        this.rows.set(all.filter((r) =>
          this.rbac.configTableAccess(this.scope, String(r[this.tableNameKey] ?? ''), String(r[this.categoryKey] ?? '')) !== 'none'
        ));
        this.loading.set(false);
      },
      error: () => this.loading.set(false)
    });
  }

  /**
   * Down-arrow (expand) loader → `columnretrieve`. Passes the row's table name;
   * renders the returned `{ cols, rows }` as-is in the nested detail grid.
   */
  getExpand = (row: Record<string, unknown>): Observable<TableContent> => {
    return this.api
      .post<TabularData>(API.config.columnRetrieve(this.scope), { table_name: String(row[this.tableNameKey]) })
      .pipe(map(tabularToContent));
  };

  /**
   * Eye (view content) loader → `retrieve`. Sends `is_cobdt` from the catalogue
   * row; for a COB table (Y) the two dates default to T-1 (discrete, not a range);
   * for a non-COB table (N) both dates are sent as null.
   */
  getDetail = (row: Record<string, unknown>): Observable<TableContent> => {
    const tableName = String(row[this.tableNameKey]);
    const isCob = isFlagSet(row[this.cobKey]);
    return this.loadContent(tableName, isCob, defaultDates());
  };

  /**
   * Fetch the table content (columns + types + rows) in one `retrieve` call. The
   * response is self-describing (`cols` + `cols_data_types` + `Table_data`). The
   * payload always carries `is_cobdt`; the dates are the selected range for a COB
   * table, or `null` when the table is not COB-partitioned.
   */
  private loadContent(
    tableName: string,
    isCob: boolean,
    dates: { start: string; end: string; range: boolean }
  ): Observable<TableContent> {
    const body = {
      table_name: tableName,
      is_cobdt: isCob ? 'Y' : 'N',
      start_date: isCob ? dates.start : null,
      end_date: isCob ? dates.end : null,
      date_range: dates.range
    };
    return this.api.post<TableContentResponse>(API.config.retrieve(this.scope), body).pipe(map(buildContent));
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
   * Modal Retrieve → re-fetch via the same `retrieve` API with the user's chosen
   * dates and Date-Range checkbox. The bar only shows for COB tables, so
   * `is_cobdt` is resolved from the modal row (Y). `date_range` = the checkbox.
   */
  onRetrieve(event: RetrieveEvent, grid: GridDataComponent): void {
    grid.setModalLoading(true);
    const isCob = isFlagSet(event.row[this.cobKey]);
    this.loadContent(event.tableName, isCob, { start: event.start, end: event.end, range: event.range }).subscribe({
      next: (content) => grid.applyModalContent(content),
      error: () => grid.setModalLoading(false)
    });
  }

  /** INSERT — new rows (values in column order) + inserted_by. Popups the count. */
  onRowsCreated(event: GridCreateEvent): void {
    this.api
      .post<{ inserted?: number }>(API.config.createRows(this.scope, event.tableName), {
        inserted_by: this.actor,
        columns: event.columns,
        rows: event.rows
      })
      .subscribe({
        next: (res) => this.notifyOk(res?.inserted ?? event.rows.length, 'inserted'),
        error: (err) => this.notifyErr('insert', err)
      });
  }

  /**
   * UPDATE — the backend identifies each row by its DB rowid, so `updates` is an
   * array of `{ <rowid>: { changedColumn: value } }` objects (not `{ rowid, values }`).
   */
  onRowsUpdated(event: RowsUpdatedEvent): void {
    const updates = event.updates.map((u) => ({ [String(u.rowid)]: u.values }));
    this.api
      .post<{ updated?: number }>(API.config.updateRows(this.scope, event.tableName), {
        updated_by: this.actor,
        updates
      })
      .subscribe({
        next: (res) => this.notifyOk(res?.updated ?? updates.length, 'updated'),
        error: (err) => this.notifyErr('update', err)
      });
  }

  /** DELETE — rowids + deleted_by. Popups the count returned by the DB. */
  onRowsDeleted(event: RowsDeletedEvent): void {
    this.api
      .post<{ deleted?: number }>(API.config.deleteRows(this.scope, event.tableName), {
        deleted_by: this.actor,
        rowids: event.rowids
      })
      .subscribe({
        next: (res) => this.notifyOk(res?.deleted ?? event.rowids.length, 'deleted'),
        error: (err) => this.notifyErr('delete', err)
      });
  }

  /** Success result popup with the affected-row count from the API. */
  private notifyOk(count: number, verb: string): void {
    this.confirm.notify({
      title: 'Success',
      message: `${count} row${count === 1 ? '' : 's'} ${verb} successfully.`,
      tone: 'success'
    });
  }

  /**
   * Error popup showing the FULL message the API returned — in the rich error
   * dialog (scrollable, with Email / Copy / OK / Close). Handles the backend's
   * `{ details }` shape as well as `{ message }`, a plain-string body, or the
   * transport error.
   */
  private notifyErr(op: string, err: unknown): void {
    const e = err as {
      error?: { details?: string; message?: string } | string;
      message?: string;
      statusText?: string;
    };
    const body = e?.error;
    const msg =
      (typeof body === 'string' && body) ||
      (typeof body === 'object' && (body?.details || body?.message)) ||
      e?.message ||
      e?.statusText ||
      `The ${op} could not be completed.`;
    this.errorReport.show({
      title: `${op.charAt(0).toUpperCase()}${op.slice(1)} failed`,
      message: String(msg),
      userId: this.actor,
    });
  }

  /**
   * Roll Data → Process: hand the table + range to the backend, stamped with the
   * actor (`rolled_by`) and the scope's Oracle tablespace (GROUP → `OLS_RPT32`,
   * CIB / RETAIL → `OLS`).
   */
  onRollData(event: RollDataEvent, grid: GridDataComponent): void {
    this.api
      .post<RollResult & { status?: string }>(API.config.rollData(this.scope), {
        rolled_by: this.actor,
        tablespace: this.scope === 'group' ? 'OLS_RPT32' : 'OLS',
        table_name: event.tableName,
        source_date: event.source,
        target_dates: event.targets
      })
      .subscribe({
        next: (res) => {
          if (res && Array.isArray(res.targets)) {
            grid.setRollResult(res);
          } else {
            grid.setRollNotice('Roll completed.');
          }
        },
        error: (err) => {
          const e = err as { error?: { detail?: string; details?: string; message?: string } | string; message?: string; statusText?: string };
          const b = e?.error;
          const msg =
            (typeof b === 'string' && b) ||
            (typeof b === 'object' && (b?.detail || b?.details || b?.message)) ||
            e?.message || e?.statusText || 'The roll could not be completed.';
          grid.setRollNotice('Roll failed — see the error details.');
          // Rich error dialog with Copy + Email-to-OLS-dev (environment.supportEmail), same as insert/update/delete.
          this.errorReport.show({ title: 'Rollover failed', message: String(msg), userId: this.actor });
        }
      });
  }
}

/** Default COB date window: the previous business day (T-1), discrete (not a range). */
function defaultDates(): { start: string; end: string; range: boolean } {
  const day = previousWeekdayIso();
  return { start: day, end: day, range: false };
}
