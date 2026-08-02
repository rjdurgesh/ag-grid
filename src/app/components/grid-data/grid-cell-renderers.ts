import { ICellEditorParams, ICellRendererParams, IHeaderParams } from 'ag-grid-community';

import { CellDataType } from '../../shared/models';
import { GridAction, GridContext, NEW_FLAG, ROW_ID } from './grid-data.model';

/**
 * Plain HTML-string cell renderers (arrow functions, so ag-grid treats them as
 * render functions, not component classes). These paint reliably where Angular
 * component renderers were flaky. Interactions are handled at the grid level via
 * the native container click listener (see GridDataComponent / DetailRowComponent).
 */

/**
 * True when the row is being edited (new draft or inline-edit). Null-safe: the
 * nested detail grid renders read-only and provides no GridContext, so a missing
 * `isRowEditing` must not throw.
 */
function isEditableRow(row: Record<string, unknown>, context: unknown): boolean {
  const ctx = context as GridContext | undefined;
  return row[NEW_FLAG] === true || (typeof ctx?.isRowEditing === 'function' && ctx.isRowEditing(row));
}

export const arrowRenderer = (params: ICellRendererParams): string => {
  const rid = params.data?.[ROW_ID] as string | undefined;
  const open = !!rid && (params.context as GridContext).isExpanded(rid);
  return (
    `<button type="button" class="ols-arrow${open ? ' ols-arrow--open' : ''}" tabindex="-1" aria-label="Toggle row details">` +
    `<svg viewBox="0 0 16 16" width="14" height="14"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>` +
    `</button>`
  );
};

export const eyeRenderer = (params: ICellRendererParams): string => {
  const row = (params.data ?? {}) as Record<string, unknown>;
  const enabled = (params.context as GridContext).isRowEnabled(row);
  const cls = enabled ? 'ols-eye' : 'ols-eye ols-eye--disabled';
  const title = enabled ? 'View content' : 'Row is not active';
  return (
    `<button type="button" class="${cls}" tabindex="-1" aria-label="${title}" title="${title}"` +
    `${enabled ? '' : ' disabled aria-disabled="true"'}>` +
    `<svg viewBox="0 0 24 24" width="18" height="18"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" fill="none" stroke="currentColor" stroke-width="1.8"/>` +
    `<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 4l16 16" stroke="currentColor" stroke-width="1.8"/></svg></button>`
  );
};

/**
 * Actions shown while a row is being edited — whether it is a new draft or a
 * saved row put into inline-edit mode.
 */
const EDITING_ACTIONS: GridAction[] = [
  { id: 'save', label: 'Save', color: 'primary' },
  { id: 'cancel', label: 'Cancel', color: 'secondary' }
];

export const actionsRenderer = (params: ICellRendererParams): string => {
  const row = (params.data ?? {}) as Record<string, unknown>;
  const ctx = params.context as GridContext;
  // Read-only (RBAC): no row actions at all.
  if (ctx.isReadOnly?.()) {
    return '';
  }
  const isEditing = row[NEW_FLAG] === true || ctx.isRowEditing(row);
  const actions = isEditing ? EDITING_ACTIONS : ctx.actions ?? [];
  const buttons = actions
    .map(
      (a) =>
        `<button type="button" class="ols-actions__btn ols-actions__btn--${a.color}" data-action="${a.id}">${a.label}</button>`
    )
    .join('');
  return `<div class="ols-actions">${buttons}</div>`;
};

/**
 * Factory: a token renderer for a specific special type (clob/json/xml/blob).
 *
 * - Read-only row: an empty value renders blank; a filled one shows the
 *   `type ..` token that opens the value modal for viewing.
 * - Editable row (draft or inline-edit): always renders a clickable affordance
 *   — the `type ..` token when it has content, or an "Enter data…" hint when
 *   empty — so the user can open the editor modal either way. These cells are
 *   NOT edited inline (they'd never fit a grid cell); the modal is the editor.
 */
export const specialRenderer = (type: CellDataType) => (params: ICellRendererParams): string => {
  const row = (params.data ?? {}) as Record<string, unknown>;
  const value = params.value;
  const hasValue = !(value === null || value === undefined || value === '');

  if (isEditableRow(row, params.context)) {
    const label = hasValue
      ? `<span class="ols-special__type">${type}</span><span class="ols-special__dots">..</span>`
      : `<span class="ols-cell-placeholder">Enter data…</span>`;
    return (
      `<button type="button" class="ols-special ols-special--edit" tabindex="-1" title="Edit ${type} value">` +
      `${label}<span class="ols-special__pencil" aria-hidden="true">` +
      `<svg viewBox="0 0 24 24" width="12" height="12"><path d="M4 20h4L18.5 9.5a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L4 16v4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>` +
      `</span></button>`
    );
  }

  if (!hasValue) {
    return '';
  }
  return (
    `<button type="button" class="ols-special" tabindex="-1" title="View ${type} value">` +
    `<span class="ols-special__type">${type}</span><span class="ols-special__dots">..</span></button>`
  );
};

/**
 * Wrap a cell renderer so empty cells on an editable row show a muted
 * "Enter data…" hint instead of rendering blank.
 */
export const withPlaceholder =
  (inner?: (params: ICellRendererParams) => string) =>
  (params: ICellRendererParams): string => {
    const row = (params.data ?? {}) as Record<string, unknown>;
    const editable = isEditableRow(row, params.context);
    const empty = params.value === null || params.value === undefined || params.value === '';
    if (editable && empty) {
      return `<span class="ols-cell-placeholder">Enter data…</span>`;
    }
    if (inner) {
      return inner(params);
    }
    const formatted = params.valueFormatted;
    return formatted != null ? String(formatted) : params.value == null ? '' : String(params.value);
  };

/**
 * Date / timestamp cell: shows the formatted value plus a calendar dropdown
 * affordance. The trigger opens the picker only while the row is editable —
 * on read-only rows it is rendered muted and does nothing.
 */
export const dateRenderer = (params: ICellRendererParams): string => {
  const row = (params.data ?? {}) as Record<string, unknown>;
  const editable = isEditableRow(row, params.context);
  const text =
    params.valueFormatted != null && params.valueFormatted !== ''
      ? String(params.valueFormatted)
      : params.value
        ? String(params.value)
        : '';
  const label = text
    ? `<span class="ols-date-cell__text">${text}</span>`
    : `<span class="ols-cell-placeholder">Enter data…</span>`;
  // Solid dark triangle pinned to the cell's bottom-right corner, the way
  // PL/SQL Developer marks a date field.
  return (
    `<span class="ols-date-cell">${label}` +
    `<button type="button" data-date-trigger="1" tabindex="-1"` +
    ` class="ols-date-tri${editable ? '' : ' ols-date-tri--muted'}"` +
    ` title="${editable ? 'Pick a date' : 'Editable in edit mode'}" aria-label="Pick a date"></button></span>`
  );
};

/**
 * Calendar cell editor for date / timestamp columns, so users pick a date
 * instead of typing a free-form string. Plain ag-grid editor (getGui) for
 * reliable rendering.
 */
export class DateCellEditor {
  private input!: HTMLInputElement;
  private withTime = false;
  private params!: ICellEditorParams;

  init(params: ICellEditorParams & { dataType?: CellDataType }): void {
    this.params = params;
    this.withTime = params.dataType === 'timestamp';
    this.input = document.createElement('input');
    this.input.type = this.withTime ? 'datetime-local' : 'date';
    this.input.className = 'ols-date-editor';

    const raw = params.value;
    if (raw) {
      const d = new Date(String(raw));
      if (!Number.isNaN(d.getTime())) {
        const pad = (n: number) => String(n).padStart(2, '0');
        const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        this.input.value = this.withTime ? `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
      }
    }

    // Commit the moment a date is chosen from the calendar — one click selects
    // it and closes the editor, instead of leaving the cell in edit mode.
    this.input.addEventListener('change', () => this.params.stopEditing());
  }

  getGui(): HTMLElement {
    return this.input;
  }

  afterGuiAttached(): void {
    this.input.focus();
    // Open the native calendar immediately. Guarded: showPicker throws without a
    // user gesture (e.g. programmatic edits) and in some embedded contexts.
    try {
      this.input.showPicker?.();
    } catch {
      /* no-op — the field is still usable; the calendar opens on click */
    }
  }

  /** Store an ISO string so the value round-trips like the rest of the data. */
  getValue(): string {
    if (!this.input.value) {
      return '';
    }
    const d = new Date(this.input.value);
    return Number.isNaN(d.getTime()) ? this.input.value : d.toISOString();
  }

  isPopup(): boolean {
    return false;
  }
}

/**
 * Header component for the first (expand) column: a refresh control that
 * re-fetches the catalogue. Implemented as a plain ag-grid component (getGui)
 * rather than an Angular one for reliable rendering.
 */
export class RefreshHeaderComp {
  private eGui!: HTMLElement;
  private button!: HTMLButtonElement;
  private handler!: () => void;

  init(params: IHeaderParams): void {
    const ctx = params.context as GridContext;
    this.eGui = document.createElement('div');
    this.eGui.className = 'ols-head-refresh';
    this.eGui.innerHTML =
      `<button type="button" class="ols-refresh-btn" title="Refresh table data" aria-label="Refresh table data">` +
      `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">` +
      `<path d="M20 11a8 8 0 1 0-.5 4" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/>` +
      `<path d="M20 4v6h-6" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>` +
      `</svg></button>`;
    this.button = this.eGui.querySelector('button') as HTMLButtonElement;
    this.handler = () => {
      this.button.classList.add('ols-refresh-btn--spin');
      ctx.refreshTable();
      setTimeout(() => this.button.classList.remove('ols-refresh-btn--spin'), 900);
    };
    this.button.addEventListener('click', this.handler);
  }

  getGui(): HTMLElement {
    return this.eGui;
  }

  refresh(): boolean {
    return true;
  }

  destroy(): void {
    this.button?.removeEventListener('click', this.handler);
  }
}
