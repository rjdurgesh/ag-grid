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

/** Cell/column type hints the UI uses to render — never hardcoded per screen.
 * `clob` = long text (e.g. a full SQL statement): a short preview + a `⋯` that opens a popup
 * with the full value. */
export type DynColType = 'text' | 'mono' | 'num' | 'gb' | 'pct' | 'bar' | 'chip' | 'datetime' | 'clob';

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

/** Generated plan findings shown as a card on the Execution Plan panel. */
export interface PlanDiagnosis {
  sev: Sev;
  findings: string[];
  hint: string | null;
}

/** Resource profile for the session (Resource Profile panel). */
export interface ResourceProfile {
  pga_used_mb: number | null;
  pga_alloc_mb: number | null;
  pga_max_mb: number | null;
  temp_mb: number | null;
  /** CPU vs each wait class — a DynTable with a `Share` % bar. */
  activity: DynTable;
  /** Active sort/hash work areas — memory + spill passes + temp. */
  workareas: DynTable;
}

/**
 * One panel of the Section 7 SID deep-dive. `kind:'text'` → a monospace block (plan,
 * SQL Monitor); `kind:'table'` → a normal dyn-table payload; `kind:'rollback'` → the
 * killed-session rollback monitor; `kind:'resource'` → the resource profile. `available:false`
 * means that panel's own query couldn't run for this session/DB — the UI shows a notice instead.
 * The plan panel (`text`) may also carry a generated `diagnosis` card.
 */
export interface DetailPanel {
  key: string;
  label: string;
  kind: 'text' | 'table' | 'rollback' | 'resource';
  available: boolean;
  requires?: string;
  text?: string;
  table?: DynTable;
  rollback?: RollbackStatus;
  diagnosis?: PlanDiagnosis;
  resource?: ResourceProfile;
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

// --- Section 8 · SQL Intelligence -------------------------------------------

export type Sev = 'ok' | 'warn' | 'crit' | 'muted';

/** Plain-language finding shown across the SQL Intelligence panels. */
export interface SqlVerdict {
  sev: Sev;
  headline: string;
  detail: string;
}

/** One KPI tile in the overview. */
export interface SqlKpi {
  label: string;
  value: string | number;
  sev?: Sev;
}

/** `POST /sql/{id}/overview` — identity + verdict + KPIs. */
export interface SqlOverview {
  status: string;
  identity: {
    sql_id: string;
    sql_text: string;
    schema: string;
    module: string;
    first_seen: string;
    last_seen: string;
    executions: number;
  };
  verdict: SqlVerdict;
  best_phv: number | null;
  current_phv: number | null;
  kpis: SqlKpi[];
}

/** One point on the plan-instability timeline. */
export interface SqlTimelinePoint {
  label: string;
  ts: number;
  plan_hash_value: number;
  elapsed_per_exec_s: number;
  execs: number;
}

/** `POST /sql/{id}/plan_timeline` — the centrepiece "was fine yesterday" chart. */
export interface SqlTimeline {
  status: string;
  points: SqlTimelinePoint[];
  plans: { plan_hash_value: number; idx: number; best: boolean }[];
  flip: { label: string; from_phv: number; to_phv: number } | null;
  verdict: SqlVerdict;
  best_phv: number | null;
  current_phv: number | null;
}

/** Summary carried on the `plans` DynTable. */
export interface SqlPlansSummary {
  best_phv: number | null;
  current_phv: number | null;
  flip: boolean;
}

/** `POST /sql/{id}/plan_text` — one plan's DBMS_XPLAN text. */
export interface SqlPlanText {
  status: string;
  plan_hash_value: number;
  source: string;
  text: string;
}

/** `POST /sql/{id}/plan_analysis` — runtime plan (bottleneck + E/A-Rows) + table stats health. */
export interface SqlPlanAnalysis {
  status: string;
  /** True when rowsource stats were collected (A-Rows / timings present). */
  has_actual: boolean;
  /** Set when `has_actual` is false — explains why actuals are missing. */
  note: string | null;
  plan_hash_value: number | null;
  summary: {
    e_rows: number;
    cost: number;
    a_rows: number | null;
    elapsed_s: number | null;
    buffer_gets: number;
    disk_reads: number;
  };
  /** Per-line plan table (`estimate` chip + `time_pct` bar; bottleneck row hover-tinted). */
  plan: DynTable;
  /** Per-table stats health (last_analyzed / age / stale + stats-rows vs actual). */
  stats: DynTable;
}

/** One copy-ready fix script. */
export interface SqlFixScript {
  key: string;
  label: string;
  sql: string;
}

/** `POST /sql/{id}/fix` — read-only recommendation (shown to everyone). */
export interface SqlFix {
  status: string;
  recommended: { plan_hash_value: number | null; sev: Sev; rationale: string };
  verdict: SqlVerdict;
  exists: { baseline: boolean; profile: boolean; detail: string };
  scripts: SqlFixScript[];
  advisor: { available: boolean; note: string; findings?: string[] };
  /** Admin-only in-app apply button visible? (server flag SQLI_ALLOW_APPLY) */
  allow_apply: boolean;
  warning: string;
}

/** `POST /sql/{id}/apply_fix` result. */
export interface SqlApplyResult {
  status?: string;
  success?: boolean;
  message: string;
}
