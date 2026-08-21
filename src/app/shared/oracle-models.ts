/** Contracts for the Oracle Command Center (per-DB DBA monitoring). */

/** One database tab — config-driven on the backend (`/api/oracle_cc/targets`). */
export interface OracleTarget {
  key: string;
  label: string;
  sub?: string | null;
  instance: string;
  connection: string;
  /** DB reachable right now? Drives the tab's status dot (green = up, grey = down). */
  reachable: boolean;
}

/** Compact per-DB snapshot for the Home 'Oracle Databases' strip (`/api/oracle_cc/overview`). */
export interface OracleOverview {
  key: string;
  label: string;
  sub?: string | null;
  instance: string;
  reachable: boolean;
  storage_pct: number;
  storage_sev: 'ok' | 'warn' | 'crit';
  blocking: number;
  active: number;
  top_object: string;
  top_gb: number;
}

/** Cell/column type hints the UI uses to render — never hardcoded per screen. */
export type DynColType = 'text' | 'mono' | 'num' | 'gb' | 'pct' | 'bar' | 'chip' | 'datetime';

/** One column in a self-describing payload. */
export interface DynColumn {
  key: string;
  label: string;
  type?: DynColType;
  align?: 'left' | 'right' | 'center';
  /** For `pct`/`bar`: amber / red thresholds. */
  warn?: number;
  crit?: number;
}

/**
 * A row action the {@link DynTable} can render as a trailing button (e.g. "Kill").
 * A row opts in by listing the action's `key` in its `__actions: string[]`; if a row
 * has no `__actions` it gets every action. Clicking emits `{ key, row }` to the parent.
 */
export interface DynAction {
  key: string;
  label: string;
  /** Colours the button; `danger` for destructive actions like kill-session. */
  tone?: 'primary' | 'danger' | 'muted';
  /** Tooltip / aria-label; defaults to `label`. */
  title?: string;
}

/**
 * The universal section payload: columns describe the shape, rows are arbitrary
 * objects keyed by `column.key`, and `summary` carries any per-section extras
 * (gauge totals, flags, tree, …). Add a column server-side → it renders, no UI change.
 */
export interface DynTable<S = Record<string, unknown>> {
  status: string;
  columns: DynColumn[];
  rows: Record<string, unknown>[];
  summary?: S;
}

/** Rollback progress for a killed session (undo being applied by PMON / rollback slaves). */
export interface RollbackStatus {
  state: string;              // 'ROLLING BACK' | 'COMPLETE' | 'NONE'
  percent: number;
  undo_blocks_total: number;
  undo_blocks_done: number;
  undo_blocks_left: number;
  undo_records_total: number;
  undo_records_done: number;
  undo_records_left: number;
  elapsed: string;
  est_remaining: string;
  note?: string;
}

/**
 * One panel of the Section 7 SID deep-dive. `kind:'text'` → a monospace block (plan,
 * SQL Monitor); `kind:'table'` → a normal dyn-table payload; `kind:'rollback'` → the
 * killed-session rollback monitor. `available:false` means that panel's own query couldn't
 * run for this session/DB — the UI shows a notice instead.
 */
export interface DetailPanel {
  key: string;
  label: string;
  kind: 'text' | 'table' | 'rollback';
  available: boolean;
  requires?: string;
  text?: string;
  table?: DynTable;
  rollback?: RollbackStatus;
}

/** The full SID deep-dive: session facts + a list of self-describing panels. */
export interface SessionDetail {
  status: string;
  session: Record<string, unknown>;
  panels: DetailPanel[];
}

/** Section 7 session-state filter (default = active). */
export type SessionFilter = 'active' | 'inactive' | 'killed' | 'all';

/** Section 1 gauge summary. */
export interface SpaceSummary {
  total_gb: number;
  used_gb: number;
  free_gb: number;
  used_pct: number;
  breached: string[];
  warn_pct: number;
  crit_pct: number;
}
