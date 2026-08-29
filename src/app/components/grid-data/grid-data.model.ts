import { colorSchemeDark, IRowNode, themeQuartz } from 'ag-grid-community';

import { CellDataType } from '../../shared/models';

/** Column descriptor consumed by {@link GridDataComponent}. */
export interface GridColumn {
  field: string;
  header?: string;
  /** Logical type — drives special rendering (clob/json/xml/blob), badges, dates. */
  type?: CellDataType;
  width?: number;
  minWidth?: number;
  flex?: number;
}

/** A per-row action button rendered in the actions column (modal grid). */
export interface GridAction {
  id: string;
  label: string;
  /** CoreUI colour token, e.g. 'primary' | 'danger'. */
  color: string;
  icon?: string;
}

/** Payload emitted when a row action button is clicked. */
export interface GridActionEvent {
  action: GridAction;
  row: Record<string, unknown>;
}

/** Internal marker fields the grid adds to row data. */
export const ROW_ID = '__rid';
export const DETAIL_FLAG = '__detail';
export const DETAIL_PARENT = '__parentKey';

/** Shape of the synthetic full-width detail row inserted under an expanded row. */
export interface DetailRow {
  [DETAIL_FLAG]: true;
  [DETAIL_PARENT]: string;
  loading: boolean;
  error?: string;
  content?: { columns: GridColumn[]; rows: Record<string, unknown>[] };
  /** The parent row's business object (e.g. the catalogue row). */
  parent: Record<string, unknown>;
}

/** The types handled by the special-value cell renderer / value modal. */
export const SPECIAL_TYPES: CellDataType[] = ['clob', 'json', 'xml', 'blob'];

export function isSpecialType(type: CellDataType | undefined): boolean {
  return !!type && SPECIAL_TYPES.includes(type);
}

/** Shared params for both light and dark variants of the OLS grid theme. */
const OLS_GRID_PARAMS = {
  accentColor: '#4d5dfb',
  fontSize: 13,
  headerFontWeight: 600,
  wrapperBorderRadius: 10
} as const;

/** Branded ag-grid theme (free Quartz) — light variant. */
export const olsGridTheme = themeQuartz.withParams(OLS_GRID_PARAMS);

/**
 * Dark variant — explicit dark colour scheme (the `data-ag-theme-mode` attribute
 * alone did not switch the Theming-API theme, so the component binds this theme
 * object directly when the app is in dark mode).
 */
export const olsGridThemeDark = themeQuartz.withPart(colorSchemeDark).withParams(OLS_GRID_PARAMS);

/**
 * Callback surface the {@link GridDataComponent} exposes to its cell renderers
 * via the ag-grid `context` object.
 */
export interface GridContext {
  toggleExpand: (node: IRowNode) => void;
  isExpanded: (rid: string) => boolean;
  openEye: (row: Record<string, unknown>) => void;
  runAction: (actionId: string, row: Record<string, unknown>) => void;
  actions: GridAction[];
  /** False for rows that are not ACTIVE — their "view" control is disabled. */
  isRowEnabled: (row: Record<string, unknown>) => boolean;
  /** Re-fetch the catalogue (wired to the refresh icon in the first column header). */
  refreshTable: () => void;
  /** True while a saved row is in inline-edit mode (all its cells editable). */
  isRowEditing: (row: Record<string, unknown>) => boolean;
  /** RBAC read-only: when true, row action buttons are suppressed. */
  isReadOnly?: () => boolean;
}

/** Payload emitted when Roll Data is processed for a COB table. */
export interface RollDataEvent {
  row: Record<string, unknown>;
  tableName: string;
  source: string;            // source (From) COB date
  targets: string[];         // one or more target (To) COB dates
}

/** Per-date roll summary returned by the backend. */
export interface RollResult {
  source_date: string;
  source_count: number;
  targets: { date: string; count: number }[];
}

/** Marker on draft rows added via the modal's "Add" button. */
export const NEW_FLAG = '__new';

/**
 * Payload emitted when Retrieve is pressed on a COB table.
 * `range === false` means the two dates are discrete; `true` means everything
 * between `start` and `end`.
 */
export interface RetrieveEvent {
  row: Record<string, unknown>;
  tableName: string;
  start: string;
  end: string;
  range: boolean;
}

/**
 * Payload emitted when draft rows are saved (single row or all at once) — an
 * INSERT. `columns` is the column order; `rows` are value arrays in that order.
 */
export interface GridCreateEvent {
  tableName: string;
  columns: string[];
  rows: unknown[][];
}

/** One row's update: its DB rowid + only the columns that changed. */
export interface RowUpdate {
  rowid: unknown;
  values: Record<string, unknown>;
}

/** Payload emitted when edited saved rows are saved — an UPDATE. */
export interface RowsUpdatedEvent {
  tableName: string;
  updates: RowUpdate[];
}

/** Payload emitted when saved rows are deleted — a DELETE (by DB rowid). */
export interface RowsDeletedEvent {
  tableName: string;
  rowids: unknown[];
}

/** Prettify a snake_case field into a header label. */
export function prettifyHeader(field: string): string {
  return field
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
