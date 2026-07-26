import { ColDef, ICellRendererParams, ValueFormatterParams } from 'ag-grid-community';

import { formatDateTime } from '../../shared/date-utils';
import { DateCellEditor, dateRenderer, specialRenderer, withPlaceholder } from './grid-cell-renderers';
import { GridColumn, GridContext, NEW_FLAG, prettifyHeader } from './grid-data.model';

/** Beyond this many columns we stop flexing so the grid scrolls horizontally. */
const FLEX_COLUMN_LIMIT = 8;

export interface BuildColumnOptions {
  /** Make cells editable on unsaved draft rows (the modal's Add flow). */
  editableDrafts?: boolean;
}

/**
 * Build ag-grid column definitions for a set of {@link GridColumn}s, wiring the
 * correct renderer/formatter/editor per logical type. Shared by the main grid,
 * the modal grid and the nested detail grid so they all render CLOB/JSON/XML/BLOB,
 * booleans and dates identically.
 */
export function buildDataColumnDefs(columns: GridColumn[], options: BuildColumnOptions = {}): ColDef[] {
  // With many columns, flexing squeezes them all into the viewport and no
  // horizontal scrollbar appears. Switch to fixed widths so the grid scrolls.
  const useFlex = columns.length <= FLEX_COLUMN_LIMIT;

  return columns.map((col) => {
    const def: ColDef = {
      field: col.field,
      headerName: col.header ?? prettifyHeader(col.field),
      minWidth: col.minWidth ?? 120,
      sortable: true,
      resizable: true,
      filter: true
    };
    if (useFlex) {
      def.flex = col.flex ?? 1;
    } else {
      def.width = col.width ?? Math.max(col.minWidth ?? 160, 160);
    }
    if (col.width) {
      def.width = col.width;
      def.flex = 0;
    }

    // Editable while the row is a new draft, or a saved row put into edit mode.
    if (options.editableDrafts) {
      def.editable = (params) => {
        const row = (params.data ?? {}) as Record<string, unknown>;
        return row[NEW_FLAG] === true || (params.context as GridContext).isRowEditing(row);
      };
    }

    switch (col.type) {
      case 'boolean':
        def.cellRenderer = booleanRenderer;
        def.maxWidth = 140;
        def.cellClass = 'ols-cell-center';
        if (options.editableDrafts) {
          def.cellEditor = 'agSelectCellEditor';
          def.cellEditorParams = { values: [true, false] };
        }
        break;
      case 'date':
      case 'timestamp':
        def.valueFormatter = (p: ValueFormatterParams) => formatDateTime(p.value as string);
        def.minWidth = 185;
        // Value + corner triangle affordance; picked from a calendar, never typed.
        // The reduced right padding lets the marker sit in the true cell corner.
        def.cellClass = 'ols-cell-date';
        def.cellRenderer = dateRenderer;
        def.cellEditor = DateCellEditor;
        def.cellEditorParams = { dataType: col.type };
        break;
      case 'clob':
      case 'json':
      case 'xml':
      case 'blob':
        def.cellRenderer = specialRenderer(col.type);
        def.cellRendererParams = { dataType: col.type };
        def.sortable = false;
        def.filter = false;
        if (options.editableDrafts) {
          def.cellEditor = 'agLargeTextCellEditor';
          def.cellEditorPopup = true;
          def.cellEditorParams = { dataType: col.type, rows: 10, cols: 60 };
        }
        break;
      case 'number':
        if (options.editableDrafts) {
          def.cellEditor = 'agNumberCellEditor';
        }
        break;
      default:
        break;
    }

    // Show a muted "Enter data…" hint in empty cells of editable rows.
    // Date columns are skipped — dateRenderer already renders its own hint and
    // must keep its calendar trigger visible when empty.
    const handlesOwnPlaceholder = col.type === 'date' || col.type === 'timestamp';
    if (options.editableDrafts && !handlesOwnPlaceholder) {
      def.cellRenderer = withPlaceholder(def.cellRenderer as ((p: ICellRendererParams) => string) | undefined);
    }
    return def;
  });
}

/**
 * HTML badge renderer for boolean cells. Declared as an arrow function (no
 * prototype) so ag-grid treats it as a render function rather than a component
 * class to instantiate. Blank on empty (new draft rows).
 */
const booleanRenderer = (params: ICellRendererParams): string => {
  if (params.value === null || params.value === undefined || params.value === '') {
    return '';
  }
  const value = params.value === true || String(params.value).toUpperCase() === 'TRUE';
  const cls = value ? 'text-bg-success' : 'text-bg-secondary';
  return `<span class="badge ${cls} ols-bool-badge">${value ? 'Yes' : 'No'}</span>`;
};
