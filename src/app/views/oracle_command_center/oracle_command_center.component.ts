import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

import { DynTableComponent } from '../../components/dyn-table/dyn-table.component';
import { LoaderComponent } from '../../components/loader/loader.component';
import { ConfirmService } from '../../components/confirm/confirm.service';
import { ErrorReportService } from '../../components/error-report/error-report.service';
import { RbacService } from '../../auth/rbac.service';
import { environment } from '../../../environments/environment';
import { formatDateTime, syncAgo } from '../../shared/date-utils';
import { DynAction, DynColumn, DynTable, OracleTarget, SessionDetail, SessionFilter, SpaceSummary } from '../../shared/oracle-models';
import { OracleCcService } from './oracle-cc.service';

/** Auto-refresh choices (minutes); default comes from environment.ts. */
const REFRESH_INTERVALS = [5, 10, 15, 30] as const;

/**
 * Oracle Command Center — a single page with one tab per database (config-driven from
 * the backend `targets` endpoint, so a new DB is a one-line add). Each section is a
 * collapsible panel fed by a self-describing `{ columns, rows, summary }` payload, so the
 * UI never hardcodes headers. Overall + per-section refresh, auto-refresh (default 30).
 *
 * Layout: row 1 = Space | Top consumers, row 2 = Locks | Blocking, row 3 = Sessions.
 * (This build wires Section 1; the rest land section-by-section.)
 */
@Component({
  selector: 'app-oracle-command-center',
  templateUrl: './oracle_command_center.component.html',
  styleUrls: ['./oracle_command_center.component.scss'],
  imports: [LoaderComponent, DynTableComponent]
})
export class OracleCommandCenterComponent implements OnInit, OnDestroy {
  private readonly svc = inject(OracleCcService);
  private readonly route = inject(ActivatedRoute);
  private readonly confirm = inject(ConfirmService);
  private readonly errorReport = inject(ErrorReportService);
  private readonly rbac = inject(RbacService);

  /** Support contact shown on a failed kill (matches Service Console). */
  readonly supportEmail = environment.supportEmail;

  readonly targets = signal<OracleTarget[]>([]);
  readonly activeKey = signal<string>('');
  readonly activeTarget = computed(() => this.targets().find((t) => t.key === this.activeKey()) ?? null);
  readonly targetsError = signal(false);

  /** Live reachability of the selected instance, used by the ribbon status dot:
   *  - `up`         → a section is currently in a healthy state (has data, no error),
   *  - `down`       → sections resolved but all with errors (can't contact the DB — this
   *                   flips red even when stale data lingers, because a *failed refresh* is
   *                   what matters for a health light),
   *  - `connecting` → still fetching / nothing attempted yet.
   *  A single bad query won't turn it red: if any section is healthy it stays green — only a
   *  DB-wide failure (every section erroring) reads as down. */
  readonly instanceStatus = computed<'up' | 'down' | 'connecting'>(() => {
    const sec: readonly [unknown, boolean][] = [
      [this.space(), this.spaceError()],
      [this.topSeg(), this.topSegError()],
      [this.topIdx(), this.topIdxError()],
      [this.idxHealth(), this.idxHealthError()],
      [this.locks(), this.locksError()],
      [this.blocking(), this.blockingError()],
      [this.sessions(), this.sessionsError()],
    ];
    if (sec.some(([d, e]) => d !== null && !e)) {
      return 'up';
    }
    return sec.some(([, e]) => e) ? 'down' : 'connecting';
  });
  instanceStatusLabel(): string {
    return { up: 'reachable', down: 'unreachable', connecting: 'connecting' }[this.instanceStatus()];
  }
  instanceStatusTitle(): string {
    switch (this.instanceStatus()) {
      case 'up': return 'Instance reachable — monitoring queries are responding';
      case 'down': return 'Cannot contact the database — recent queries failed';
      default: return 'Connecting to the instance…';
    }
  }

  readonly intervals = REFRESH_INTERVALS;
  readonly refreshEveryMin = signal(environment.oracleCommandCenterRefreshMinutes);
  private timer: ReturnType<typeof setInterval> | undefined;
  readonly lastRefreshed = signal<Date | null>(null);

  /** Per-section / per-panel "last fetched" epochs (ms), keyed by section id or `panel:<key>`. */
  private readonly stamps = signal<Record<string, number>>({});
  /** Ticks so the relative "x min ago" labels re-compute without a fetch. */
  private readonly nowTick = signal(Date.now());
  private clockTimer: ReturnType<typeof setInterval> | undefined;

  private markStamp(key: string): void {
    this.stamps.update((m) => ({ ...m, [key]: Date.now() }));
  }
  hasStamp(key: string): boolean {
    return !!this.stamps()[key];
  }
  /** Absolute time of the last fetch, e.g. `2026-08-16 14:36:17`. */
  stampAbs(key: string): string {
    const t = this.stamps()[key];
    return t ? formatDateTime(t) : '';
  }
  /** Relative time of the last fetch, e.g. `just now` / `10 min ago` (ticks live). */
  stampRel(key: string): string {
    const t = this.stamps()[key];
    return t ? syncAgo(t, this.nowTick()) : '';
  }

  // --- Section 1: space ---
  readonly space = signal<DynTable<SpaceSummary> | null>(null);
  readonly spaceLoading = signal(false);
  readonly spaceError = signal(false);

  // --- Section 2: top table consumers ---
  readonly topSeg = signal<DynTable | null>(null);
  readonly topSegLoading = signal(false);
  readonly topSegError = signal(false);

  // --- Section 3: top index consumers ---
  readonly topIdx = signal<DynTable | null>(null);
  readonly topIdxLoading = signal(false);
  readonly topIdxError = signal(false);

  // --- Section 4: index health ---
  readonly idxHealth = signal<DynTable | null>(null);
  readonly idxHealthLoading = signal(false);
  readonly idxHealthError = signal(false);

  // --- Section 5: critical locks ---
  readonly locks = signal<DynTable | null>(null);
  readonly locksLoading = signal(false);
  readonly locksError = signal(false);

  // --- Section 6: blocking sessions ---
  readonly blocking = signal<DynTable | null>(null);
  readonly blockingLoading = signal(false);
  readonly blockingError = signal(false);

  // --- Section 7: sessions & deep-dive ---
  readonly sessionFilters: { key: SessionFilter; label: string }[] = [
    { key: 'active', label: 'Active' },
    { key: 'inactive', label: 'Inactive' },
    { key: 'killed', label: 'Killed' },
    { key: 'all', label: 'All' }
  ];
  readonly sessionFilter = signal<SessionFilter>('active');
  readonly sessions = signal<DynTable | null>(null);
  readonly sessionsLoading = signal(false);
  readonly sessionsError = signal(false);

  /** SID deep-dive drawer. */
  readonly detail = signal<SessionDetail | null>(null);
  readonly detailLoading = signal(false);
  readonly detailError = signal(false);
  readonly detailOpen = signal(false);
  readonly activePanel = signal<string>('');

  /** Kill requires ADMIN access + a technical/both role (OMT-TECHNICAL / OMT-BOTH);
   *  ADMIN+functional and any READ are view-only. Drives the Kill buttons + drawer action. */
  readonly canKill = computed(() => this.rbac.canActTechnical());
  readonly killActions: DynAction[] = [{ key: 'kill', label: 'Kill', tone: 'danger', title: 'Kill this session' }];
  /** Session-row actions: deep-dive always; kill only for admins (per-row whitelist hides it on KILLED rows). */
  readonly sessionActions = computed<DynAction[]>(() => {
    const acts: DynAction[] = [{ key: 'detail', label: 'Deep-dive', tone: 'primary', title: 'Open the SID deep-dive' }];
    if (this.canKill()) {
      acts.push({ key: 'kill', label: 'Kill', tone: 'danger', title: 'Kill this session' });
    }
    return acts;
  });

  /** Transient result banner after a kill (auto-dismisses), same UX as Service Console. */
  readonly toast = signal<{ ok: boolean; text: string } | null>(null);
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  /** Collapse state per section (all expanded by default). */
  readonly collapsed = signal<Record<string, boolean>>({
    space: false, top: false, topidx: false, idxhealth: false, locks: false, blocking: false, sessions: false
  });

  ngOnInit(): void {
    this.loadTargets();
    // Tick the relative-time clock so "x min ago" labels stay current between fetches.
    this.clockTimer = setInterval(() => this.nowTick.set(Date.now()), 20_000);
  }

  ngOnDestroy(): void {
    this.clearTimer();
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
    }
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
    }
  }

  // --- DB tabs --------------------------------------------------------------
  private loadTargets(): void {
    this.svc.targets().subscribe({
      next: (ts) => {
        this.targets.set(ts);
        this.targetsError.set(false);
        if (ts.length) {
          // Deep-link: land on the tab named by `?db=<key>` (e.g. from a Home tile), else the first.
          const wanted = this.route.snapshot.queryParamMap.get('db');
          const initial = ts.some((t) => t.key === wanted) ? wanted! : ts[0].key;
          this.selectDb(initial);
        }
      },
      error: () => this.targetsError.set(true)
    });
  }

  selectDb(key: string): void {
    if (key === this.activeKey()) {
      return;
    }
    this.activeKey.set(key);
    // Clear the previous DB's data so each panel shows its LOADER (not the old tab's stale
    // numbers) while the new DB's queries run. (A same-tab refresh keeps its data — no flicker —
    // because the loaders don't clear; only a DB switch resets here.)
    this.space.set(null);
    this.topSeg.set(null);
    this.topIdx.set(null);
    this.idxHealth.set(null);
    this.locks.set(null);
    this.blocking.set(null);
    this.sessions.set(null);
    this.stamps.set({});
    if (this.detailOpen()) {
      this.closeDetail();   // the drawer belonged to the old DB's session
    }
    this.refreshAll();
    this.armTimer();
  }

  // --- Refresh --------------------------------------------------------------
  refreshAll(): void {
    this.loadSpace();
    this.loadTopSegments();
    this.loadTopIndexes();
    this.loadIndexHealth();
    this.loadLocks();
    this.loadBlocking();
    this.loadSessions();
    this.lastRefreshed.set(new Date());
  }

  loadSpace(): void {
    const db = this.activeKey();
    if (!db) {
      return;
    }
    this.spaceLoading.set(true);
    this.spaceError.set(false);
    this.svc.space(db).subscribe({
      next: (d) => {
        this.space.set(d);
        this.spaceLoading.set(false);
        this.markStamp('space');
      },
      error: () => {
        this.spaceError.set(true);
        this.spaceLoading.set(false);
      }
    });
  }

  loadTopSegments(): void {
    const db = this.activeKey();
    if (!db) {
      return;
    }
    this.topSegLoading.set(true);
    this.topSegError.set(false);
    this.svc.topSegments(db).subscribe({
      next: (d) => { this.topSeg.set(d); this.topSegLoading.set(false); this.markStamp('top'); },
      error: () => { this.topSegError.set(true); this.topSegLoading.set(false); }
    });
  }

  loadTopIndexes(): void {
    const db = this.activeKey();
    if (!db) {
      return;
    }
    this.topIdxLoading.set(true);
    this.topIdxError.set(false);
    this.svc.topIndexes(db).subscribe({
      next: (d) => { this.topIdx.set(d); this.topIdxLoading.set(false); this.markStamp('topidx'); },
      error: () => { this.topIdxError.set(true); this.topIdxLoading.set(false); }
    });
  }

  loadIndexHealth(): void {
    const db = this.activeKey();
    if (!db) {
      return;
    }
    this.idxHealthLoading.set(true);
    this.idxHealthError.set(false);
    this.svc.indexHealth(db).subscribe({
      next: (d) => { this.idxHealth.set(d); this.idxHealthLoading.set(false); this.markStamp('idxhealth'); },
      error: () => { this.idxHealthError.set(true); this.idxHealthLoading.set(false); }
    });
  }

  loadLocks(): void {
    const db = this.activeKey();
    if (!db) {
      return;
    }
    this.locksLoading.set(true);
    this.locksError.set(false);
    this.svc.locks(db).subscribe({
      next: (d) => { this.locks.set(d); this.locksLoading.set(false); this.markStamp('locks'); },
      error: () => { this.locksError.set(true); this.locksLoading.set(false); }
    });
  }

  loadBlocking(): void {
    const db = this.activeKey();
    if (!db) {
      return;
    }
    this.blockingLoading.set(true);
    this.blockingError.set(false);
    this.svc.blocking(db).subscribe({
      next: (d) => { this.blocking.set(d); this.blockingLoading.set(false); this.markStamp('blocking'); },
      error: () => { this.blockingError.set(true); this.blockingLoading.set(false); }
    });
  }

  // --- Section 7: sessions --------------------------------------------------
  loadSessions(): void {
    const db = this.activeKey();
    if (!db) {
      return;
    }
    this.sessionsLoading.set(true);
    this.sessionsError.set(false);
    this.svc.sessions(db, this.sessionFilter()).subscribe({
      next: (d) => { this.sessions.set(d); this.sessionsLoading.set(false); this.markStamp('sessions'); },
      error: () => { this.sessionsError.set(true); this.sessionsLoading.set(false); }
    });
  }

  setSessionFilter(f: SessionFilter): void {
    if (f === this.sessionFilter()) {
      return;
    }
    this.sessionFilter.set(f);
    this.loadSessions();
  }

  /** Full-state counts for the filter tabs (from the sessions summary). */
  sessionCount(key: SessionFilter): number | null {
    const s = this.sessions()?.summary as Record<string, number> | undefined;
    if (!s) {
      return null;
    }
    return key === 'all' ? (s['total'] ?? null) : (s[key] ?? null);
  }

  onSessionAction(evt: { key: string; row: Record<string, unknown> }): void {
    if (evt.key === 'kill') {
      void this.killSession(evt.row);
    } else if (evt.key === 'detail') {
      this.openDetail(evt.row);
    }
  }

  // --- SID deep-dive drawer -------------------------------------------------
  openDetail(row: Record<string, unknown>): void {
    const db = this.activeKey();
    const sid = Number(row['sid']);
    const serial = Number(row['serial']);
    if (!db || !Number.isFinite(sid) || !Number.isFinite(serial)) {
      return;
    }
    this.detailOpen.set(true);
    this.detail.set(null);
    this.detailError.set(false);
    this.detailLoading.set(true);
    this.svc.sessionDetail(db, sid, serial, row['sql_id'] ? String(row['sql_id']) : undefined).subscribe({
      next: (d) => {
        this.detail.set(d);
        const first = d.panels.find((p) => p.available) ?? d.panels[0];
        this.activePanel.set(first ? first.key : '');
        this.detailLoading.set(false);
        this.markStamp('detail');
        d.panels.forEach((p) => this.markStamp('panel:' + p.key));
      },
      error: () => { this.detailError.set(true); this.detailLoading.set(false); }
    });
  }

  closeDetail(): void {
    this.detailOpen.set(false);
    this.detail.set(null);
  }

  setPanel(key: string): void {
    this.activePanel.set(key);
  }

  /** The currently-selected deep-dive panel. */
  currentPanel = computed(() => {
    const d = this.detail();
    const key = this.activePanel();
    return d?.panels.find((p) => p.key === key) ?? null;
  });

  /** Whole-drawer refresh in flight. */
  readonly detailRefreshingAll = signal(false);
  /** Panels currently re-fetching (per-tab refresh). */
  private readonly panelRefreshing = signal<Set<string>>(new Set<string>());
  isPanelRefreshing(key: string): boolean {
    return this.panelRefreshing().has(key);
  }

  /** sid/serial/sql_id of the session shown in the drawer, for re-fetching. */
  private detailArgs(): { db: string; sid: number; serial: number; sqlId?: string } | null {
    const d = this.detail();
    const db = this.activeKey();
    if (!d || !db) {
      return null;
    }
    const sid = Number(d.session['sid']);
    const serial = Number(d.session['serial']);
    if (!Number.isFinite(sid) || !Number.isFinite(serial)) {
      return null;
    }
    return { db, sid, serial, sqlId: d.session['sql_id'] ? String(d.session['sql_id']) : undefined };
  }

  /** Consolidated refresh — re-pull every panel (keeps the open tab if it still exists). */
  refreshDetailAll(): void {
    const a = this.detailArgs();
    if (!a) {
      return;
    }
    this.detailRefreshingAll.set(true);
    this.svc.sessionDetail(a.db, a.sid, a.serial, a.sqlId).subscribe({
      next: (d) => {
        this.detail.set(d);
        if (!d.panels.some((p) => p.key === this.activePanel())) {
          const first = d.panels.find((p) => p.available) ?? d.panels[0];
          this.activePanel.set(first ? first.key : '');
        }
        this.detailRefreshingAll.set(false);
        this.markStamp('detail');
        d.panels.forEach((p) => this.markStamp('panel:' + p.key));
      },
      error: () => this.detailRefreshingAll.set(false)
    });
  }

  /** Per-tab refresh — re-pull just one panel and swap it in place. */
  refreshPanel(key: string): void {
    const a = this.detailArgs();
    if (!a) {
      return;
    }
    this.panelRefreshing.update((s) => new Set(s).add(key));
    this.svc.sessionDetail(a.db, a.sid, a.serial, a.sqlId, key).subscribe({
      next: (d) => {
        const fresh = d.panels.find((p) => p.key === key);
        if (fresh) {
          this.detail.update((cur) => (cur ? { ...cur, panels: cur.panels.map((p) => (p.key === key ? fresh : p)) } : cur));
        }
        this.markStamp('panel:' + key);
        this.clearPanelRefreshing(key);
      },
      error: () => this.clearPanelRefreshing(key)
    });
  }

  private clearPanelRefreshing(key: string): void {
    this.panelRefreshing.update((s) => {
      const next = new Set(s);
      next.delete(key);
      return next;
    });
  }

  /** Kill the session shown in the deep-dive drawer (admin only), then close + refresh. */
  killFromDetail(): void {
    const d = this.detail();
    if (!d || !this.canKill()) {
      return;
    }
    void this.killSession(d.session).then((done) => {
      if (done) {
        this.closeDetail();
      }
    });
  }

  detailText(session: Record<string, unknown>, key: string): string {
    return String(session[key] ?? '—');
  }

  // --- Kill session (Locks / Blocking rows) ---------------------------------
  /** dyn-table action handler; today the only action is `kill`. */
  onTableAction(evt: { key: string; row: Record<string, unknown> }): void {
    if (evt.key === 'kill') {
      void this.killSession(evt.row);
    }
  }

  /** Confirm → kill → toast/refresh (locks + blocking + sessions). Admin-gated (button is hidden
   * otherwise, and this re-checks defensively). Failure surfaces the persistent error popup with
   * the OLS email. Resolves `true` only when the kill was confirmed and submitted. */
  private async killSession(row: Record<string, unknown>): Promise<boolean> {
    if (!this.canKill()) {
      return false;
    }
    const db = this.activeKey();
    const sid = Number(row['sid']);
    const serial = Number(row['serial']);
    if (!db || !Number.isFinite(sid) || !Number.isFinite(serial)) {
      return false;
    }
    const label = String(row['session'] ?? row['sid_serial'] ?? `${sid},${serial}`);
    const who = row['username'] ? ` (${row['username']})` : '';
    const dbName = this.activeTarget()?.instance ?? db;

    const ok = await this.confirm.ask({
      title: 'Kill session',
      message: `Permanently kill session ${label}${who} on ${dbName}?\n\n`
        + 'Its in-flight transaction will be rolled back. This cannot be undone.',
      confirmLabel: 'Kill session',
      cancelLabel: 'Cancel',
      tone: 'danger'
    });
    if (!ok) {
      return false;
    }

    this.svc.killSession(db, sid, serial).subscribe({
      next: (res) => {
        if (res.success) {
          this.notify(true, `Session ${label} marked for kill.`);
        } else {
          this.showKillError(label, dbName, res.message || 'The database rejected the request.');
        }
        // The kill reply only says success/message — re-read the affected sections so they settle.
        this.loadLocks();
        this.loadBlocking();
        this.loadSessions();
      },
      error: () => {
        this.showKillError(label, dbName, 'The request could not be completed — the database may be unreachable.');
      }
    });
    return true;
  }

  private showKillError(label: string, dbName: string, detail: string): void {
    this.errorReport.show({
      title: 'Kill session failed',
      message: `Session ${label} on ${dbName}: ${detail}\n\nPlease reach out to OLS Team on ${this.supportEmail}.`,
      userId: environment.username
    });
  }

  private notify(ok: boolean, text: string): void {
    this.toast.set({ ok, text });
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
    }
    this.toastTimer = setTimeout(() => this.toast.set(null), 4200);
  }

  onIntervalChange(min: number): void {
    this.refreshEveryMin.set(min);
    this.armTimer();
  }

  private armTimer(): void {
    this.clearTimer();
    this.timer = setInterval(() => this.refreshAll(), this.refreshEveryMin() * 60_000);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // --- Collapse -------------------------------------------------------------
  toggle(section: string): void {
    this.collapsed.update((m) => ({ ...m, [section]: !m[section] }));
  }
  isCollapsed(section: string): boolean {
    return !!this.collapsed()[section];
  }

  // --- Dynamic-cell + gauge helpers -----------------------------------------
  /** Traffic-light for a percent against a column's thresholds. */
  sevFor(value: number, col?: DynColumn): 'ok' | 'warn' | 'crit' {
    const crit = col?.crit ?? 90;
    const warn = col?.warn ?? 85;
    return value >= crit ? 'crit' : value >= warn ? 'warn' : 'ok';
  }

  /** Overall gauge colour from the summary used %. */
  gaugeSev(pct: number): 'ok' | 'warn' | 'crit' {
    return pct >= 90 ? 'crit' : pct >= 85 ? 'warn' : 'ok';
  }

  /** Row stripe severity from the row's used_pct (Section 1). */
  rowSev(row: Record<string, unknown>): 'ok' | 'warn' | 'crit' {
    return this.sevFor(Number(row['used_pct'] ?? 0));
  }

  /** Format a numeric cell (GB / counts) with grouping + 2 dp for decimals. */
  fmtNum(v: unknown): string {
    const n = Number(v);
    if (Number.isNaN(n)) {
      return String(v ?? '');
    }
    return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  cellText(row: Record<string, unknown>, col: DynColumn): string {
    return String(row[col.key] ?? '');
  }

  /** Chip colour for a session status (deep-dive header). */
  statusSev(status: string): string {
    return status === 'ACTIVE' ? 'ok' : status === 'KILLED' ? 'crit' : 'muted';
  }

  readonly formatDateTime = formatDateTime;
  trackCol = (_: number, c: DynColumn): string => c.key;
  trackTarget = (_: number, t: OracleTarget): string => t.key;
}
