import { ColDef, ICellRendererParams, ValueFormatterParams } from 'ag-grid-community';

import { formatDate, formatDateTime } from '../../shared/date-utils';
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
          // Y/N flags round-trip to Oracle CHAR(1) columns.
          def.cellEditorParams = { values: ['Y', 'N'] };
        }
        break;
      case 'date':
      case 'timestamp':
        // Date columns show the date only; timestamps keep the time component.
        def.valueFormatter = (p: ValueFormatterParams) =>
          col.type === 'date' ? formatDate(p.value as string) : formatDateTime(p.value as string);
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
        // These values never fit an inline grid cell — they are edited in the
        // value modal (opened by clicking the cell's affordance), not inline.
        // Force editable off so ag-grid never starts its own cell editor here.
        def.editable = false;
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
    // Date and special (clob/json/xml/blob) columns are skipped — their own
    // renderers already draw the hint plus the affordance that opens the picker
    // or value editor, and must keep it visible when empty.
    const handlesOwnPlaceholder =
      col.type === 'date' ||
      col.type === 'timestamp' ||
      col.type === 'clob' ||
      col.type === 'json' ||
      col.type === 'xml' ||
      col.type === 'blob';
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
  const raw = params.value;
  if (raw === null || raw === undefined || raw === '') {
    return '';
  }
  const s = String(raw).trim().toUpperCase();
  const truthy = raw === true || s === 'TRUE' || s === 'Y' || s === 'YES' || s === '1';
  const falsy = raw === false || s === 'FALSE' || s === 'N' || s === 'NO' || s === '0';
  // Unknown value → show it verbatim rather than mislabelling it.
  if (!truthy && !falsy) {
    return `<span class="badge text-bg-light ols-bool-badge">${s}</span>`;
  }
  const cls = truthy ? 'text-bg-success' : 'text-bg-secondary';
  return `<span class="badge ${cls} ols-bool-badge">${truthy ? 'Yes' : 'No'}</span>`;
};
