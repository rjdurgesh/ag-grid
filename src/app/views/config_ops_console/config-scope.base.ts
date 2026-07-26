import { computed, Directive, inject, OnInit, signal } from '@angular/core';
import { Observable } from 'rxjs';

import { RbacService } from '../../auth/rbac.service';
import { GridDataComponent } from '../../components/grid-data/grid-data.component';
import {
  GridActionEvent,
  GridColumn,
  GridCreateEvent,
  RetrieveEvent,
  RollDataEvent
} from '../../components/grid-data/grid-data.model';
import { ApiDataService } from '../../shared/api-data.service';
import { API, ConfigScope } from '../../shared/api-endpoints';
import { TableContent } from '../../shared/models';

/** Treat true / 'Y' / 'YES' / '1' as set, so booleans and Y/N flags both work. */
function isFlagSet(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  const text = String(value ?? '').trim().toUpperCase();
  return text === 'Y' || text === 'YES' || text === 'TRUE' || text === '1';
}

/** Catalogue columns shared by every Config Ops Console scope. */
export const CONFIG_CATALOGUE_COLUMNS: GridColumn[] = [
  { field: 'table_name', header: 'Table Name', type: 'string', minWidth: 240, flex: 2 },
  { field: 'active', header: 'Active', type: 'boolean' },
  { field: 'is_cob', header: 'Is COB', type: 'boolean' },
  { field: 'last_update', header: 'Last Update', type: 'date' }
];

/**
 * Shared behaviour for the CIB / Group / Retail sections. Each concrete
 * component only declares its {@link ConfigScope}; the catalogue fetch, detail
 * loader and action handler live here (DRY).
 */
@Directive()
export abstract class ConfigScopeBase implements OnInit {
  protected abstract readonly scope: ConfigScope;

  private readonly api = inject(ApiDataService);
  private readonly rbac = inject(RbacService);

  readonly columns = CONFIG_CATALOGUE_COLUMNS;
  readonly rows = signal<Record<string, unknown>[]>([]);
  readonly loading = signal(true);

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
    this.api.get<Record<string, unknown>[]>(API.config.tables(this.scope)).subscribe({
      next: (rows) => {
        this.rows.set(rows);
        this.loading.set(false);
      },
      error: () => this.loading.set(false)
    });
  }

  /** Loader passed to <app-grid-data> for row-expand + eye-modal content. */
  getDetail = (row: Record<string, unknown>): Observable<TableContent> =>
    this.api.get<TableContent>(API.config.tableContent(this.scope, String(row['table_name'])));

  /** ACTIVE flag — accepts booleans or Y/N strings from the backend. */
  isRowActive = (row: Record<string, unknown>): boolean => isFlagSet(row['active']);

  /** IS_COB flag — COB tables get the Upload / Roll Data extras. */
  isRowCob = (row: Record<string, unknown>): boolean => isFlagSet(row['is_cob']);

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
   * `range: false` sends the two dates as discrete values.
   */
  onRetrieve(event: RetrieveEvent, grid: GridDataComponent): void {
    grid.setModalLoading(true);
    this.api
      .post<TableContent>(API.config.retrieve(this.scope), {
        table_name: event.tableName,
        start: event.start,
        end: event.end,
        range: event.range
      })
      .subscribe({
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
