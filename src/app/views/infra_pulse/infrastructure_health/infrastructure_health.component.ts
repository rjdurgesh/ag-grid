import { Component, OnDestroy, OnInit, WritableSignal, inject, signal } from '@angular/core';

import { LoaderComponent } from '../../../components/loader/loader.component';
import { INFRA_APPS, INFRA_APP_LABELS, InfraApp } from '../../../shared/api-endpoints';
import { formatDateTime, timeAgo } from '../../../shared/date-utils';
import { AppHealth, HealthMetric, HealthStatus, HealthTarget, TargetOs } from '../../../shared/infra-models';
import { InfraDataService } from '../infra-data.service';
import { HealthCardComponent } from './health-card.component';

/** Grouping mode for the page. */
type ViewMode = 'app' | 'status';

/** One collapsible application section (By Application view). */
interface HealthPanel {
  app: InfraApp;
  label: string;
  data: WritableSignal<AppHealth | null>;
  loading: WritableSignal<boolean>;
  error: WritableSignal<boolean>;
  expanded: WritableSignal<boolean>;
  filter: WritableSignal<'all' | HealthStatus>;
}

/** One collapsible status section (By Status view). */
interface StatusGroup {
  status: HealthStatus;
  label: string;
  expanded: WritableSignal<boolean>;
}

/** A target plus the app it belongs to, for the status view + info dialog. */
interface AggTarget {
  app: InfraApp;
  appLabel: string;
  target: HealthTarget;
}

/** Auto-refresh choices (minutes); 30 is the default. */
const REFRESH_INTERVALS = [5, 10, 15, 30] as const;

/** Card order: Windows → Linux → Share, matching the By-Application view. */
const OS_RANK: Record<TargetOs, number> = { windows: 0, linux: 1, share: 2 };

/**
 * Infrastructure Health. Two groupings:
 *  - By Application: one collapsible section per app, each a grid of server /
 *    share cards.
 *  - By Status: three collapsible sections (Critical / Warning / Healthy),
 *    each showing every matching server across all apps with a total count.
 *
 * Data auto-refreshes on a user-chosen interval (default 30 min); each card can
 * also refresh just its own server and open an info dialog.
 */
@Component({
  selector: 'app-infrastructure-health',
  templateUrl: './infrastructure_health.component.html',
  styleUrls: ['./infrastructure_health.component.scss'],
  imports: [LoaderComponent, HealthCardComponent]
})
export class InfrastructureHealthComponent implements OnInit, OnDestroy {
  private readonly infra = inject(InfraDataService);

  readonly view = signal<ViewMode>('app');

  readonly intervals = REFRESH_INTERVALS;
  readonly refreshEveryMin = signal(30);
  private timer: ReturnType<typeof setInterval> | undefined;

  readonly panels: HealthPanel[] = INFRA_APPS.map((app) => ({
    app,
    label: INFRA_APP_LABELS[app],
    data: signal<AppHealth | null>(null),
    loading: signal(false),
    error: signal(false),
    expanded: signal(true),
    filter: signal<'all' | HealthStatus>('all')
  }));

  readonly statusGroups: StatusGroup[] = [
    { status: 'crit', label: 'Critical', expanded: signal(true) },
    { status: 'warn', label: 'Warning', expanded: signal(true) },
    { status: 'ok', label: 'Healthy', expanded: signal(true) }
  ];

  /** Target ids with an in-flight single-server refresh. */
  private readonly refreshingTargets = signal(new Set<string>());

  /** Target shown in the info dialog (null = closed). */
  readonly infoTarget = signal<AggTarget | null>(null);

  ngOnInit(): void {
    this.refreshAll();
    this.armTimer();
  }

  ngOnDestroy(): void {
    this.clearTimer();
  }

  // --- Auto-refresh ---------------------------------------------------------
  onIntervalChange(minutes: number): void {
    this.refreshEveryMin.set(minutes);
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

  // --- View -----------------------------------------------------------------
  setView(view: ViewMode): void {
    this.view.set(view);
  }

  // --- By Application -------------------------------------------------------
  refreshAll(): void {
    // One config fetch shared by all four apps, then agent fan-out per server.
    this.infra.reloadConfig();
    this.panels.forEach((panel) => this.refresh(panel));
  }

  refresh(panel: HealthPanel): void {
    panel.loading.set(true);
    panel.error.set(false);
    this.infra.health(panel.app).subscribe({
      next: (data) => {
        panel.data.set(data);
        this.normalizeFilter(panel);
        panel.loading.set(false);
      },
      error: () => {
        panel.error.set(true);
        panel.loading.set(false);
      }
    });
  }

  /** Reset an active status filter to "all" when its pill would be hidden (count 0). */
  private normalizeFilter(panel: HealthPanel): void {
    const filter = panel.filter();
    if (filter !== 'all' && (panel.data()?.counts[filter] ?? 0) === 0) {
      panel.filter.set('all');
    }
  }

  toggle(panel: HealthPanel): void {
    panel.expanded.update((v) => !v);
  }

  setFilter(panel: HealthPanel, filter: 'all' | HealthStatus): void {
    panel.filter.set(panel.filter() === filter ? 'all' : filter);
  }

  count(panel: HealthPanel, status: HealthStatus): number {
    return panel.data()?.counts[status] ?? 0;
  }

  worstOf(panel: HealthPanel): HealthStatus {
    if (this.count(panel, 'crit') > 0) {
      return 'crit';
    }
    if (this.count(panel, 'warn') > 0) {
      return 'warn';
    }
    return 'ok';
  }

  visibleTargets(panel: HealthPanel): HealthTarget[] {
    const data = panel.data();
    if (!data) {
      return [];
    }
    const filter = panel.filter();
    return filter === 'all' ? data.targets : data.targets.filter((t) => t.status === filter);
  }

  // --- By Status ------------------------------------------------------------
  toggleStatus(group: StatusGroup): void {
    group.expanded.update((v) => !v);
  }

  /** Every target across all apps with the given status. */
  statusTargets(status: HealthStatus): AggTarget[] {
    const out: AggTarget[] = [];
    for (const panel of this.panels) {
      const data = panel.data();
      if (!data) {
        continue;
      }
      for (const target of data.targets) {
        if (target.status === status) {
          out.push({ app: panel.app, appLabel: panel.label, target });
        }
      }
    }
    // Match the By-Application ordering: all Windows, then Linux, then Share.
    out.sort(
      (a, b) => OS_RANK[a.target.os] - OS_RANK[b.target.os] || a.target.name.localeCompare(b.target.name)
    );
    return out;
  }

  statusCount(status: HealthStatus): number {
    return this.statusTargets(status).length;
  }

  // --- Per-card refresh -----------------------------------------------------
  refreshTarget(app: InfraApp, target: HealthTarget): void {
    this.markTarget(target.id, true);
    this.infra.targetHealth(app, target.id).subscribe({
      next: (fresh) => {
        this.patchTarget(app, fresh);
        this.markTarget(target.id, false);
      },
      error: () => this.markTarget(target.id, false)
    });
  }

  isTargetRefreshing(targetId: string): boolean {
    return this.refreshingTargets().has(targetId);
  }

  private markTarget(targetId: string, on: boolean): void {
    const next = new Set(this.refreshingTargets());
    on ? next.add(targetId) : next.delete(targetId);
    this.refreshingTargets.set(next);
  }

  /** Replace one target inside its app panel and re-tally the counts. */
  private patchTarget(app: InfraApp, updated: HealthTarget): void {
    const panel = this.panels.find((p) => p.app === app);
    const data = panel?.data();
    if (!panel || !data) {
      return;
    }
    const targets = data.targets.map((t) => (t.id === updated.id ? updated : t));
    const counts = { ok: 0, warn: 0, crit: 0 };
    for (const t of targets) {
      counts[t.status]++;
    }
    panel.data.set({ ...data, targets, counts });
    this.normalizeFilter(panel);
  }

  // --- Info dialog ----------------------------------------------------------
  openInfo(app: InfraApp, appLabel: string, target: HealthTarget): void {
    this.infoTarget.set({ app, appLabel, target });
  }

  closeInfo(): void {
    this.infoTarget.set(null);
  }

  // --- Shared formatting ----------------------------------------------------
  osLabelFor(target: HealthTarget): string {
    return target.os === 'windows' ? 'WINDOWS' : target.os === 'linux' ? 'LINUX' : 'ShareDrive';
  }

  metricValue(metric: HealthMetric): string {
    if (metric.unit === '%') {
      return `${metric.percent}%`;
    }
    return `${metric.used.toFixed(2)} ${metric.unit} / ${metric.total.toFixed(2)} ${metric.unit} = ${metric.percent}%`;
  }

  statusText(status: HealthStatus): string {
    return status === 'crit' ? 'Critical' : status === 'warn' ? 'Warning' : 'Healthy';
  }

  readonly formatDateTime = formatDateTime;
  readonly timeAgo = timeAgo;

  trackPanel = (_: number, panel: HealthPanel): string => panel.app;
  trackStatus = (_: number, group: StatusGroup): string => group.status;
  trackAgg = (_: number, item: AggTarget): string => `${item.app}:${item.target.id}`;
  trackTarget = (_: number, target: HealthTarget): string => target.id;
}
