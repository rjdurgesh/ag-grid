import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

import { DynTableComponent } from '../../components/dyn-table/dyn-table.component';
import { LoaderComponent } from '../../components/loader/loader.component';
import { ConfirmService } from '../../components/confirm/confirm.service';
import { ErrorReportService } from '../../components/error-report/error-report.service';
import { RbacService } from '../../auth/rbac.service';
import { environment } from '../../../environments/environment';
import { formatDateTime, syncAgo } from '../../shared/date-utils';
import {
  DynAction, DynColumn, DynTable, OracleTarget, SessionDetail, SessionFilter, SpaceSummary,
  SqlFix, SqlOverview, SqlPlanAnalysis, SqlPlanText, SqlPlansSummary, SqlTimeline
} from '../../shared/oracle-models';
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
    space: false, top: false, topidx: false, idxhealth: false, locks: false, blocking: false, sessions: false,
    sqli: false
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
    if (this.copiedTimer) {
      clearTimeout(this.copiedTimer);
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
    this.clearSql();        // SQL Intelligence investigation belonged to the old DB
    this.finder.set(null);
    this.refreshAll();
    this.loadFinder();      // repopulate the "find a SQL_ID" list for the new DB
    this.armTimer();
  }

  // --- Refresh --------------------------------------------------------------
  /** True while ANY section is fetching → spins the masthead "Refresh all" button. */
  readonly anyLoading = computed(() =>
    this.spaceLoading() || this.topSegLoading() || this.topIdxLoading() || this.idxHealthLoading()
    || this.locksLoading() || this.blockingLoading() || this.sessionsLoading());

  /** Per-section loading flag by stamp key — drives the "Refreshing…" label in each header. */
  sectionLoading(key: string): boolean {
    return ({
      space: this.spaceLoading(), top: this.topSegLoading(), topidx: this.topIdxLoading(),
      idxhealth: this.idxHealthLoading(), locks: this.locksLoading(),
      blocking: this.blockingLoading(), sessions: this.sessionsLoading(),
    } as Record<string, boolean>)[key] ?? false;
  }

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

  // --- Section 8: SQL Intelligence ------------------------------------------
  // Investigate a sql_id (session may be long gone). Everything historical is a 5-day AWR/ASH
  // window on the backend. The recommend-only fix is shown to everyone; the Apply button is
  // admin-only (canApplyFix) AND server-flagged (fix.allow_apply).

  readonly sqlIdInput = signal<string>('');           // the "Investigate by SQL_ID" box
  readonly sqlId = signal<string>('');                // the sql_id currently under investigation
  readonly hasSql = computed(() => !!this.sqlId());
  readonly sqlTab = signal<string>('overview');       // overview|timeline|plans|perf|ash|binds|fix
  readonly sqlTabs: { key: string; label: string }[] = [
    { key: 'overview', label: 'Overview' }, { key: 'timeline', label: 'Plan Timeline' },
    { key: 'plans', label: 'Plans & Diff' }, { key: 'plan_analysis', label: 'Plan Analysis' },
    { key: 'perf', label: 'Performance' }, { key: 'ash', label: 'ASH' },
    { key: 'binds', label: 'Binds' }, { key: 'fix', label: 'Fix' }
  ];

  /** Finder — locate a sql_id when you don't have it. */
  readonly finderQ = signal<string>('');
  readonly finderOrder = signal<string>('elapsed');
  readonly finder = signal<DynTable | null>(null);
  readonly finderLoading = signal(false);
  readonly finderError = signal(false);
  readonly finderActions: DynAction[] = [{ key: 'open', label: 'Investigate', tone: 'primary', title: 'Open the dossier for this SQL_ID' }];
  readonly finderOrders: { key: string; label: string }[] = [
    { key: 'elapsed', label: 'Slowest' }, { key: 'execs', label: 'Most run' },
    { key: 'reads', label: 'Most reads' }, { key: 'last', label: 'Most recent' }
  ];

  /** Dossier panels (lazily loaded per tab). */
  readonly sqlOverview = signal<SqlOverview | null>(null);
  readonly sqlOverviewLoading = signal(false);
  readonly sqlOverviewError = signal(false);

  readonly sqlTimeline = signal<SqlTimeline | null>(null);
  readonly sqlTimelineLoading = signal(false);
  readonly sqlTimelineError = signal(false);

  readonly sqlPlans = signal<DynTable<SqlPlansSummary> | null>(null);
  readonly sqlPlansLoading = signal(false);
  readonly sqlPlansError = signal(false);

  readonly sqlPlanAnalysis = signal<SqlPlanAnalysis | null>(null);
  readonly sqlPlanAnalysisLoading = signal(false);
  readonly sqlPlanAnalysisError = signal(false);

  readonly sqlPerf = signal<DynTable | null>(null);
  readonly sqlPerfLoading = signal(false);
  readonly sqlPerfError = signal(false);

  readonly sqlAsh = signal<DynTable | null>(null);
  readonly sqlAshLoading = signal(false);
  readonly sqlAshError = signal(false);

  readonly sqlBinds = signal<DynTable | null>(null);
  readonly sqlBindsLoading = signal(false);
  readonly sqlBindsError = signal(false);

  readonly sqlFixData = signal<SqlFix | null>(null);
  readonly sqlFixLoading = signal(false);
  readonly sqlFixError = signal(false);
  readonly applyingFix = signal(false);
  readonly copied = signal<string>('');               // which script key was just copied
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;

  /** Plan diff — two plan_hash_values selected side by side. */
  readonly diffA = signal<number | null>(null);
  readonly diffB = signal<number | null>(null);
  readonly planTextA = signal<SqlPlanText | null>(null);
  readonly planTextB = signal<SqlPlanText | null>(null);
  readonly planTextALoading = signal(false);
  readonly planTextBLoading = signal(false);

  /** Apply-fix is a WRITE — same admin gate as kill-session. */
  readonly canApplyFix = computed(() => this.rbac.canActTechnical());

  /** Distinct plan_hash_values available for the diff selectors. */
  readonly planPhvs = computed<number[]>(() =>
    (this.sqlPlans()?.rows ?? []).map((r) => Number(r['plan_hash_value'])).filter((n) => Number.isFinite(n)));

  /**
   * SVG geometry for the plan-instability timeline (static — no animation, so it also serves
   * the office reduced-motion env). Colours points/segments by plan: best = green, current-if-
   * regressed = red, others = amber; a dashed marker sits at the flip.
   */
  readonly sqlChart = computed(() => {
    const tl = this.sqlTimeline();
    if (!tl || !tl.points.length) {
      return null;
    }
    const W = 720, H = 190, padL = 46, padR = 14, padT = 14, padB = 30;
    const pts = tl.points;
    const n = pts.length;
    const maxY = Math.max(...pts.map((p) => p.elapsed_per_exec_s), 0.001);
    const xAt = (i: number) => padL + (n === 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (n - 1));
    const yAt = (v: number) => padT + (H - padT - padB) * (1 - v / maxY);
    const colFor = (phv: number) => (phv === tl.best_phv ? '#22c55e' : phv === tl.current_phv ? '#ef4444' : '#f59e0b');
    const nodes = pts.map((p, i) => ({
      x: xAt(i), y: yAt(p.elapsed_per_exec_s), color: colFor(p.plan_hash_value),
      phv: p.plan_hash_value, label: p.label, val: p.elapsed_per_exec_s
    }));
    const segs: { x1: number; y1: number; x2: number; y2: number; color: string }[] = [];
    for (let i = 1; i < n; i++) {
      segs.push({ x1: nodes[i - 1].x, y1: nodes[i - 1].y, x2: nodes[i].x, y2: nodes[i].y, color: nodes[i].color });
    }
    let flipX: number | null = null;
    if (tl.flip) {
      const idx = pts.findIndex((p) => p.label === tl.flip!.label);
      if (idx >= 0) {
        flipX = xAt(idx);
      }
    }
    const ticks = [0, maxY / 2, maxY].map((v) => ({ y: yAt(v), label: v < 10 ? v.toFixed(1) : v.toFixed(0) }));
    return {
      W, H, padL, baseY: H - padB, nodes, segs, flipX, ticks,
      firstLabel: pts[0].label, lastLabel: pts[n - 1].label
    };
  });

  /** Colour a plan_hash_value the same way the chart does (best/current/other). */
  phvColor(phv: number | null | undefined): string {
    const tl = this.sqlTimeline() ?? this.sqlPlans()?.summary;
    const best = (tl as { best_phv?: number | null })?.best_phv;
    const current = (tl as { current_phv?: number | null })?.current_phv;
    return phv === best ? '#22c55e' : phv === current ? '#ef4444' : '#f59e0b';
  }

  // --- finder ---
  loadFinder(): void {
    const db = this.activeKey();
    if (!db) {
      return;
    }
    this.finderLoading.set(true);
    this.finderError.set(false);
    this.svc.sqlFinder(db, this.finderQ() || undefined, this.finderOrder()).subscribe({
      next: (d) => { this.finder.set(d); this.finderLoading.set(false); },
      error: () => { this.finderError.set(true); this.finderLoading.set(false); }
    });
  }

  setFinderOrder(o: string): void {
    if (o === this.finderOrder()) {
      return;
    }
    this.finderOrder.set(o);
    this.loadFinder();
  }

  onFinderAction(evt: { key: string; row: Record<string, unknown> }): void {
    if (evt.key === 'open') {
      this.investigate(String(evt.row['sql_id'] ?? ''));
    }
  }

  /** Click-through: a SQL_ID in Sessions / Locks / Blocking → open it in SQL Intelligence.
   *  Accepts any sql_id-style column (`sql_id`, `victim_sql_id`, …). */
  onSqlCell(evt: { column: string; value: string; row: Record<string, unknown> }): void {
    const id = (evt.value || '').trim();
    if (!/sql_id$/.test(evt.column) || !id || id === '—') {
      return;
    }
    this.collapsed.update((m) => ({ ...m, sqli: false }));   // make sure the section is open
    this.investigate(id);
    // scroll the section into view once it has rendered (respect reduced-motion)
    setTimeout(() => {
      const el = document.querySelector('.occ-sqli');
      const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      el?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    }, 60);
  }

  // --- investigate a sql_id ---
  investigate(id: string): void {
    const sqlId = (id || '').trim();
    if (!sqlId) {
      return;
    }
    this.sqlId.set(sqlId);
    this.sqlIdInput.set(sqlId);
    this.sqlTab.set('overview');
    // reset the dossier caches so each tab re-fetches for the new sql_id
    this.sqlOverview.set(null); this.sqlTimeline.set(null); this.sqlPlans.set(null);
    this.sqlPlanAnalysis.set(null);
    this.sqlPerf.set(null); this.sqlAsh.set(null); this.sqlBinds.set(null); this.sqlFixData.set(null);
    this.planTextA.set(null); this.planTextB.set(null); this.diffA.set(null); this.diffB.set(null);
    // eager-load the landing tab (identity + verdict + the headline timeline chart)
    this.loadSqlOverview();
    this.loadSqlTimeline();
  }

  investigateFromInput(): void {
    this.investigate(this.sqlIdInput());
  }

  /** Header refresh: re-run whatever's on screen (the finder, or the whole dossier). */
  refreshSqli(): void {
    if (this.hasSql()) {
      this.investigate(this.sqlId());
    } else {
      this.loadFinder();
    }
  }

  /** True while the SQL Intelligence header refresh should spin. */
  readonly sqliLoading = computed(() =>
    this.finderLoading() || this.sqlOverviewLoading() || this.sqlTimelineLoading()
    || this.sqlPlansLoading() || this.sqlPlanAnalysisLoading() || this.sqlPerfLoading()
    || this.sqlAshLoading() || this.sqlBindsLoading() || this.sqlFixLoading());

  clearSql(): void {
    this.sqlId.set('');
    this.sqlIdInput.set('');
  }

  setSqlTab(tab: string): void {
    this.sqlTab.set(tab);
    // lazy-load the tab the first time it's opened (each is a separate, possibly slow query)
    if (tab === 'overview' && !this.sqlOverview()) { this.loadSqlOverview(); }
    else if (tab === 'timeline' && !this.sqlTimeline()) { this.loadSqlTimeline(); }
    else if (tab === 'plans' && !this.sqlPlans()) { this.loadSqlPlans(); }
    else if (tab === 'plan_analysis' && !this.sqlPlanAnalysis()) { this.loadSqlPlanAnalysis(); }
    else if (tab === 'perf' && !this.sqlPerf()) { this.loadSqlPerf(); }
    else if (tab === 'ash' && !this.sqlAsh()) { this.loadSqlAsh(); }
    else if (tab === 'binds' && !this.sqlBinds()) { this.loadSqlBinds(); }
    else if (tab === 'fix' && !this.sqlFixData()) { this.loadSqlFix(); }
  }

  private loadSqlOverview(): void {
    const db = this.activeKey(), id = this.sqlId();
    if (!db || !id) { return; }
    this.sqlOverviewLoading.set(true); this.sqlOverviewError.set(false);
    this.svc.sqlOverview(db, id).subscribe({
      next: (d) => { this.sqlOverview.set(d); this.sqlOverviewLoading.set(false); },
      error: () => { this.sqlOverviewError.set(true); this.sqlOverviewLoading.set(false); }
    });
  }

  private loadSqlTimeline(): void {
    const db = this.activeKey(), id = this.sqlId();
    if (!db || !id) { return; }
    this.sqlTimelineLoading.set(true); this.sqlTimelineError.set(false);
    this.svc.sqlPlanTimeline(db, id).subscribe({
      next: (d) => { this.sqlTimeline.set(d); this.sqlTimelineLoading.set(false); },
      error: () => { this.sqlTimelineError.set(true); this.sqlTimelineLoading.set(false); }
    });
  }

  private loadSqlPlans(): void {
    const db = this.activeKey(), id = this.sqlId();
    if (!db || !id) { return; }
    this.sqlPlansLoading.set(true); this.sqlPlansError.set(false);
    this.svc.sqlPlans(db, id).subscribe({
      next: (d) => {
        this.sqlPlans.set(d);
        this.sqlPlansLoading.set(false);
        // default the diff to best (A) vs current (B), then pull both plan texts
        const best = d.summary?.best_phv ?? null;
        const current = d.summary?.current_phv ?? null;
        const phvs = (d.rows ?? []).map((r) => Number(r['plan_hash_value']));
        this.diffA.set(best ?? phvs[0] ?? null);
        this.diffB.set((current && current !== best) ? current : (phvs[1] ?? phvs[0] ?? null));
        if (this.diffA() != null) { this.loadPlanText('A', this.diffA()!); }
        if (this.diffB() != null) { this.loadPlanText('B', this.diffB()!); }
      },
      error: () => { this.sqlPlansError.set(true); this.sqlPlansLoading.set(false); }
    });
  }

  private loadSqlPlanAnalysis(): void {
    const db = this.activeKey(), id = this.sqlId();
    if (!db || !id) { return; }
    this.sqlPlanAnalysisLoading.set(true); this.sqlPlanAnalysisError.set(false);
    this.svc.sqlPlanAnalysis(db, id).subscribe({
      next: (d) => { this.sqlPlanAnalysis.set(d); this.sqlPlanAnalysisLoading.set(false); },
      error: () => { this.sqlPlanAnalysisError.set(true); this.sqlPlanAnalysisLoading.set(false); }
    });
  }

  private loadSqlPerf(): void {
    const db = this.activeKey(), id = this.sqlId();
    if (!db || !id) { return; }
    this.sqlPerfLoading.set(true); this.sqlPerfError.set(false);
    this.svc.sqlPerf(db, id).subscribe({
      next: (d) => { this.sqlPerf.set(d); this.sqlPerfLoading.set(false); },
      error: () => { this.sqlPerfError.set(true); this.sqlPerfLoading.set(false); }
    });
  }

  private loadSqlAsh(): void {
    const db = this.activeKey(), id = this.sqlId();
    if (!db || !id) { return; }
    this.sqlAshLoading.set(true); this.sqlAshError.set(false);
    this.svc.sqlAsh(db, id).subscribe({
      next: (d) => { this.sqlAsh.set(d); this.sqlAshLoading.set(false); },
      error: () => { this.sqlAshError.set(true); this.sqlAshLoading.set(false); }
    });
  }

  private loadSqlBinds(): void {
    const db = this.activeKey(), id = this.sqlId();
    if (!db || !id) { return; }
    this.sqlBindsLoading.set(true); this.sqlBindsError.set(false);
    this.svc.sqlBinds(db, id).subscribe({
      next: (d) => { this.sqlBinds.set(d); this.sqlBindsLoading.set(false); },
      error: () => { this.sqlBindsError.set(true); this.sqlBindsLoading.set(false); }
    });
  }

  private loadSqlFix(): void {
    const db = this.activeKey(), id = this.sqlId();
    if (!db || !id) { return; }
    this.sqlFixLoading.set(true); this.sqlFixError.set(false);
    this.svc.sqlFix(db, id).subscribe({
      next: (d) => { this.sqlFixData.set(d); this.sqlFixLoading.set(false); },
      error: () => { this.sqlFixError.set(true); this.sqlFixLoading.set(false); }
    });
  }

  // --- plan diff ---
  onDiff(which: 'A' | 'B', phv: number): void {
    if (!Number.isFinite(phv)) { return; }
    (which === 'A' ? this.diffA : this.diffB).set(phv);
    this.loadPlanText(which, phv);
  }

  private loadPlanText(which: 'A' | 'B', phv: number): void {
    const db = this.activeKey(), id = this.sqlId();
    if (!db || !id) { return; }
    const loading = which === 'A' ? this.planTextALoading : this.planTextBLoading;
    const target = which === 'A' ? this.planTextA : this.planTextB;
    loading.set(true);
    this.svc.sqlPlanText(db, id, phv).subscribe({
      next: (d) => { target.set(d); loading.set(false); },
      error: () => { target.set({ status: 'error', plan_hash_value: phv, source: '', text: '(could not load plan)' }); loading.set(false); }
    });
  }

  // --- fix: copy + apply ---
  copyScript(script: { key: string; sql: string }): void {
    const done = () => {
      this.copied.set(script.key);
      if (this.copiedTimer) { clearTimeout(this.copiedTimer); }
      this.copiedTimer = setTimeout(() => this.copied.set(''), 1600);
    };
    const nav = navigator as Navigator & { clipboard?: { writeText(t: string): Promise<void> } };
    if (nav.clipboard?.writeText) {
      nav.clipboard.writeText(script.sql).then(done).catch(() => this.notify(false, 'Could not copy — select the text manually.'));
    } else {
      this.notify(false, 'Clipboard unavailable — select the text manually.');
    }
  }

  /** Apply the recommended fix (admin only + confirm + server SQLI_ALLOW_APPLY). WRITE. */
  async applyFix(): Promise<void> {
    const fix = this.sqlFixData();
    const db = this.activeKey(), id = this.sqlId();
    const phv = fix?.recommended?.plan_hash_value;
    if (!fix || !db || !id || phv == null || !this.canApplyFix() || !fix.allow_apply) {
      return;
    }
    const dbName = this.activeTarget()?.instance ?? db;
    const ok = await this.confirm.ask({
      title: 'Apply SQL fix',
      message: `Pin plan ${phv} for SQL_ID ${id} on ${dbName} as a fixed SQL Plan Baseline?\n\n${fix.warning}`,
      confirmLabel: 'Apply fix',
      cancelLabel: 'Cancel',
      tone: 'danger'
    });
    if (!ok) {
      return;
    }
    this.applyingFix.set(true);
    this.svc.sqlApplyFix(db, id, phv).subscribe({
      next: (res) => {
        this.applyingFix.set(false);
        this.notify(res.success !== false, res.message || 'Fix submitted.');
      },
      error: () => {
        this.applyingFix.set(false);
        this.errorReport.show({
          title: 'Apply fix failed',
          message: `Could not pin plan ${phv} for ${id} on ${dbName}. It must run on a privileged, audited connection.\n\nPlease reach out to OLS Team on ${this.supportEmail}.`,
          userId: environment.username
        });
      }
    });
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
