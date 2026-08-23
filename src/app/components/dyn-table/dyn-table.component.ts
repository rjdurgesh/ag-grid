import { Component, ElementRef, computed, inject, input, output, signal } from '@angular/core';

import { DynAction, DynColumn, DynTable } from '../../shared/oracle-models';

interface FlatRow {
  row: Record<string, unknown>;
  level: number;
  id: string;
  hasChildren: boolean;
}

/**
 * Reusable dynamic table for the Oracle Command Center. It renders whatever `columns`
 * the payload declares (no hardcoded headers), so adding a column server-side just works.
 *
 * Conventions on a row object:
 *  - `__sev`: 'ok' | 'warn' | 'crit' → warn/crit rows reveal an amber/red tint on hover
 *    (white at rest); 'ok'/none use the default hover.
 *  - `__children`: child rows (same columns) → the first cell becomes an expandable
 *    caret, drilled recursively (table → partition → subpartition, etc.).
 *  - `<col>__sev`: severity for a `chip` column's colour.
 *
 * Column `type`: text | mono | num | gb | pct (bar + %) | chip | datetime.
 */
@Component({
  selector: 'app-dyn-table',
  templateUrl: './dyn-table.component.html',
  styleUrls: ['./dyn-table.component.scss']
})
export class DynTableComponent {
  readonly model = input.required<DynTable<unknown>>();

  /** Per-row actions rendered as a trailing button column. Empty → no action column. */
  readonly actions = input<DynAction[]>([]);
  /** Fired when a row action button is clicked. */
  readonly action = output<{ key: string; row: Record<string, unknown> }>();

  /** Column keys whose cells render as an inline clickable link (e.g. `['sql_id']` to jump to
   *  SQL Intelligence). A cell links only when its value is present (not empty / `—`). */
  readonly linkColumns = input<string[]>([]);
  /** Fired when a linked cell is clicked → `{ column, value, row }`. */
  readonly cellClick = output<{ column: string; value: string; row: Record<string, unknown> }>();

  /** Cap the visible rows: past this many the table gets a vertical scrollbar (sticky header
   *  stays). Null = grow to fit. Horizontal scroll for wide/extra columns is always on. */
  readonly maxRows = input<number | null>(null);
  /** Scroll-box height = header (~34px) + maxRows × row (~39px). */
  readonly maxHeightPx = computed<number | null>(() => {
    const n = this.maxRows();
    return n && n > 0 ? 34 + n * 39 : null;
  });

  /** Freeze the first column (row identifier) to the left edge, matching the always-frozen
   *  action column. On by default; set false for narrow tables where it adds no value
   *  (e.g. Database Storage, Top Index) so it doesn't show a needless pinned divider. */
  readonly freezeFirst = input<boolean>(true);

  /** Show a client-side filter box that matches across every column (for big lists like
   *  Sessions where a DBA needs to zero in on a SID / user / SQL_ID quickly). */
  readonly filterable = input<boolean>(false);
  readonly filterPlaceholder = input<string>('Filter rows — SID, user, SQL_ID, machine…');
  protected readonly filterText = signal('');

  private readonly expandedIds = signal<Set<string>>(new Set<string>());

  readonly hasActions = computed(() => this.actions().length > 0);

  /** Rows after the text filter is applied. A parent is kept if it matches OR any descendant
   *  matches (so drilldown trees stay navigable while filtering); the pruned subtree is kept. */
  readonly visibleRows = computed<Record<string, unknown>[]>(() => {
    const q = this.filterText().trim().toLowerCase();
    const rows = this.model()?.rows ?? [];
    if (!q) {
      return rows;
    }
    const cols = this.model()?.columns ?? [];
    const prune = (list: Record<string, unknown>[]): Record<string, unknown>[] => {
      const out: Record<string, unknown>[] = [];
      for (const row of list) {
        const kids = row['__children'] as Record<string, unknown>[] | undefined;
        const keptKids = Array.isArray(kids) && kids.length ? prune(kids) : [];
        const self = cols.some((c) => String(row[c.key] ?? '').toLowerCase().includes(q));
        if (self || keptKids.length) {
          out.push(keptKids.length ? { ...row, __children: keptKids } : row);
        }
      }
      return out;
    };
    return prune(rows);
  });

  /** Total leaf+node count of the unfiltered tree, for the "x of y" filter hint. */
  readonly totalRowCount = computed<number>(() => this.countRows(this.model()?.rows ?? []));
  readonly visibleRowCount = computed<number>(() => this.countRows(this.visibleRows()));

  private countRows(rows: Record<string, unknown>[]): number {
    let n = 0;
    for (const r of rows) {
      const kids = r['__children'] as Record<string, unknown>[] | undefined;
      n += 1 + (Array.isArray(kids) ? this.countRows(kids) : 0);
    }
    return n;
  }

  /** Tree flattened to visible rows, honouring expand state. While a filter is active every
   *  matched branch is force-expanded so results aren't hidden inside collapsed parents. */
  readonly flat = computed<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    const exp = this.expandedIds();
    const forceOpen = this.filterText().trim().length > 0;
    const walk = (rows: Record<string, unknown>[], level: number, prefix: string): void => {
      rows.forEach((row, i) => {
        const id = prefix ? `${prefix}.${i}` : `${i}`;
        const kids = row['__children'] as Record<string, unknown>[] | undefined;
        const hasChildren = Array.isArray(kids) && kids.length > 0;
        out.push({ row, level, id, hasChildren });
        if (hasChildren && (forceOpen || exp.has(id))) {
          walk(kids as Record<string, unknown>[], level + 1, id);
        }
      });
    };
    walk(this.visibleRows(), 0, '');
    return out;
  });

  toggle(id: string): void {
    const next = new Set(this.expandedIds());
    next.has(id) ? next.delete(id) : next.add(id);
    this.expandedIds.set(next);
  }
  isExpanded(id: string): boolean {
    return this.expandedIds().has(id);
  }

  rowSev(row: Record<string, unknown>): string {
    return String(row['__sev'] ?? '');
  }
  chipSev(row: Record<string, unknown>, col: DynColumn): string {
    return String(row[`${col.key}__sev`] ?? 'muted');
  }
  pctSev(v: number, col: DynColumn): string {
    const crit = col.crit ?? 90;
    const warn = col.warn ?? 85;
    return v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok';
  }
  isNumeric(col: DynColumn): boolean {
    return col.type === 'num' || col.type === 'gb';
  }
  text(row: Record<string, unknown>, col: DynColumn): string {
    return String(row[col.key] ?? '');
  }
  fmt(v: unknown): string {
    const n = Number(v);
    if (Number.isNaN(n)) {
      return String(v ?? '');
    }
    return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  indentPx(level: number): number {
    return 12 + level * 22;
  }

  /** Actions available for this row — an explicit `__actions` whitelist, else all actions. */
  actionsFor(row: Record<string, unknown>): DynAction[] {
    const allowed = row['__actions'] as string[] | undefined;
    if (!Array.isArray(allowed)) {
      return this.actions();
    }
    return this.actions().filter((a) => allowed.includes(a.key));
  }

  onAction(key: string, row: Record<string, unknown>, ev: Event): void {
    ev.stopPropagation();
    this.action.emit({ key, row });
  }

  // --- CLOB cells (long text — e.g. full SQL statement) ---------------------
  /** The full-text popup currently open (null = closed). */
  readonly clobOpen = signal<{ label: string; text: string } | null>(null);
  /** Transient "copied" flag for the popup's Copy button. */
  readonly clobCopied = signal(false);
  private clobCopyTimer: ReturnType<typeof setTimeout> | undefined;

  /** Short inline preview of a long value — first ~18 words, then an ellipsis if trimmed. */
  clobPreview(value: unknown): string {
    const s = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!s) {
      return '';
    }
    const words = s.split(' ');
    return words.length <= 10 ? s : words.slice(0, 10).join(' ');
  }

  /** Is there more text than the preview shows (→ worth a popup)? */
  clobHasMore(value: unknown): boolean {
    const s = String(value ?? '').replace(/\s+/g, ' ').trim();
    return !!s && s !== '—' && s.split(' ').length > 10;
  }

  private readonly host = inject(ElementRef<HTMLElement>);

  openClob(label: string, value: unknown): void {
    this.clobCopied.set(false);
    this.clobOpen.set({ label, text: String(value ?? '') });
    // Portal the popup to <body> so no ancestor stacking context (e.g. the section row's
    // z-index) can trap it — otherwise a later section paints over it while scrolling. The @if
    // still owns the nodes; on close Ivy removes them from their CURRENT parent (body), cleanly.
    setTimeout(() => {
      const el = this.host.nativeElement;
      const backdrop = el.querySelector('.dt-clob-backdrop');
      const modal = el.querySelector('.dt-clob-modal');
      if (backdrop) { document.body.appendChild(backdrop); }
      if (modal) { document.body.appendChild(modal); }
    });
  }
  closeClob(): void {
    this.clobOpen.set(null);
  }
  copyClob(): void {
    const t = this.clobOpen()?.text ?? '';
    const nav = navigator as Navigator & { clipboard?: { writeText(s: string): Promise<void> } };
    if (nav.clipboard?.writeText) {
      nav.clipboard.writeText(t).then(() => {
        this.clobCopied.set(true);
        if (this.clobCopyTimer) { clearTimeout(this.clobCopyTimer); }
        this.clobCopyTimer = setTimeout(() => this.clobCopied.set(false), 1600);
      }).catch(() => undefined);
    }
  }

  /** True when this cell should render as a clickable link (column opted in + value present). */
  isLink(col: DynColumn, row: Record<string, unknown>): boolean {
    if (!this.linkColumns().includes(col.key)) {
      return false;
    }
    const v = String(row[col.key] ?? '').trim();
    return v !== '' && v !== '—';
  }

  onCell(col: DynColumn, row: Record<string, unknown>, ev: Event): void {
    ev.stopPropagation();
    this.cellClick.emit({ column: col.key, value: String(row[col.key] ?? ''), row });
  }

  /** Total column count incl. the action column (for the empty-state colspan). */
  colCount(): number {
    return this.model().columns.length + (this.hasActions() ? 1 : 0);
  }

  trackCol = (_: number, c: DynColumn): string => c.key;
  trackRow = (_: number, f: FlatRow): string => f.id;
  trackAct = (_: number, a: DynAction): string => a.key;
}
