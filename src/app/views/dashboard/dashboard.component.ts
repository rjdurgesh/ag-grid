import { Component, DestroyRef, computed, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { forkJoin, interval } from 'rxjs';

import { AuthService } from '../../auth/auth.service';
import { INFRA_APP_LABELS, INFRA_APPS, InfraApp } from '../../shared/api-endpoints';
import { environment } from '../../../environments/environment';
import { formatDateTime, syncAgo } from '../../shared/date-utils';
import { AppHealth, AppServices, HealthStatus, serviceCategory } from '../../shared/infra-models';
import { OracleOverview } from '../../shared/oracle-models';
import { InfraDataService } from '../infra_pulse/infra-data.service';
import { OracleCcService } from '../oracle_command_center/oracle-cc.service';

type Posture = 'operational' | 'degraded' | 'critical';

/** A flattened, app-tagged server/share for the attention lists. */
interface FlatTarget {
  app: InfraApp;
  appLabel: string;
  name: string;
  kind: 'server' | 'share';
  status: HealthStatus;
  detail: string;
}

/** A flattened, app-tagged down/unaccessible service. */
interface FlatService {
  app: InfraApp;
  appLabel: string;
  server: string;
  name: string;
  state: string;
  down: boolean;
}

/** One row of the per-application status matrix. */
interface AppRow {
  app: InfraApp;
  label: string;
  ok: number;
  warn: number;
  crit: number;
  running: number;
  down: number;
  unaccessible: number;
  posture: Posture;
}

/**
 * Home — OLS Operations Command Center. A single live glimpse across the estate,
 * driven purely by the Infrastructure Health + Service Console data (config →
 * agent fan-out): overall posture + health index, fleet KPIs, a per-application
 * status matrix, and what needs attention.
 */
@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss'],
  imports: [RouterLink]
})
export class DashboardComponent implements OnInit {
  private readonly infra = inject(InfraDataService);
  private readonly oracle = inject(OracleCcService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly env = environment.appEnv;
  readonly loading = signal(true);
  /** Absolute timestamp of the last successful sync (shown as a hover tooltip). */
  readonly lastSync = signal<string>('');
  /** Same moment as a Date, plus a ticking clock, so the relative label re-computes. */
  private readonly lastSyncAt = signal<Date | null>(null);
  private readonly nowTick = signal<number>(Date.now());

  /** Live "5 min ago" style label for the last sync. */
  readonly lastSyncRel = computed(() => {
    const at = this.lastSyncAt();
    return at ? syncAgo(at, this.nowTick()) : '';
  });

  readonly healthByApp = signal<AppHealth[]>([]);
  readonly servicesByApp = signal<AppServices[]>([]);

  /** Per-DB Oracle snapshot for the 'Oracle Databases' strip. */
  readonly oracleDbs = signal<OracleOverview[]>([]);
  /** Total blocking sessions across all DBs (drives the strip's alert accent). */
  readonly oracleBlocking = computed(() => this.oracleDbs().reduce((n, d) => n + d.blocking, 0));

  readonly user = this.auth.user;

  readonly greeting = computed(() => {
    const hour = new Date().getHours();
    const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    return `${part}, ${this.user()?.displayName ?? 'Operator'}`;
  });

  // --- Aggregates -----------------------------------------------------------
  private readonly allTargets = computed<FlatTarget[]>(() =>
    this.healthByApp().flatMap((h) =>
      h.targets.map((t) => ({
        app: h.app,
        appLabel: h.label,
        name: t.name,
        kind: t.kind,
        status: t.status,
        detail: this.worstMetricText(t)
      }))
    )
  );

  private readonly allServices = computed<FlatService[]>(() =>
    this.servicesByApp().flatMap((s) =>
      s.servers.flatMap((srv) =>
        srv.services.map((v) => ({
          app: s.app,
          appLabel: s.label,
          server: srv.serverName,
          name: v.name,
          state: v.state,
          down: serviceCategory(v.state) !== 'up'
        }))
      )
    )
  );

  readonly serverCounts = computed(() => this.tallyStatus(this.allTargets().filter((t) => t.kind === 'server')));
  readonly shareCounts = computed(() => this.tallyStatus(this.allTargets().filter((t) => t.kind === 'share')));

  readonly serviceCounts = computed(() => {
    let running = 0;
    let down = 0;
    let unaccessible = 0;
    for (const s of this.allServices()) {
      const cat = serviceCategory(s.state as never);
      cat === 'up' ? running++ : cat === 'unaccessible' ? unaccessible++ : down++;
    }
    return { running, down, unaccessible, total: this.allServices().length };
  });

  readonly serverTotal = computed(() => this.allTargets().filter((t) => t.kind === 'server').length);
  readonly shareTotal = computed(() => this.allTargets().filter((t) => t.kind === 'share').length);

  /** Weighted 0–100 posture score (warnings count half). */
  readonly healthScore = computed(() => {
    const s = this.serverCounts();
    const v = this.serviceCounts();
    const total = s.ok + s.warn + s.crit + v.running + v.down + v.unaccessible;
    if (!total) {
      return 100;
    }
    const good = s.ok + v.running;
    const partial = s.warn * 0.5 + v.unaccessible * 0.5;
    return Math.round(((good + partial) / total) * 100);
  });

  readonly posture = computed<Posture>(() => {
    if (this.serverCounts().crit > 0 || this.serviceCounts().down > 0) {
      return 'critical';
    }
    if (this.serverCounts().warn > 0 || this.serviceCounts().unaccessible > 0) {
      return 'degraded';
    }
    return 'operational';
  });

  readonly postureText = computed(() => {
    switch (this.posture()) {
      case 'critical':
        return 'Action required';
      case 'degraded':
        return 'Degraded — watch';
      default:
        return 'All systems operational';
    }
  });

  /** Conic gauge for the health score. */
  readonly scoreGauge = computed(() => {
    const p = this.healthScore();
    const color = this.posture() === 'critical' ? '#ef4444' : this.posture() === 'degraded' ? '#f59e0b' : '#22c55e';
    return `conic-gradient(${color} ${p * 3.6}deg, rgba(148,163,184,0.18) 0deg)`;
  });

  readonly appRows = computed<AppRow[]>(() =>
    INFRA_APPS.map((app) => {
      const h = this.healthByApp().find((x) => x.app === app);
      const s = this.servicesByApp().find((x) => x.app === app);
      const crit = h?.counts.crit ?? 0;
      const warn = h?.counts.warn ?? 0;
      const down = s?.counts.down ?? 0;
      const unaccessible = s?.counts.unaccessible ?? 0;
      const posture: Posture = crit > 0 || down > 0 ? 'critical' : warn > 0 || unaccessible > 0 ? 'degraded' : 'operational';
      return {
        app,
        label: INFRA_APP_LABELS[app],
        ok: h?.counts.ok ?? 0,
        warn,
        crit,
        running: s?.counts.running ?? 0,
        down,
        unaccessible,
        posture
      };
    })
  );

  /** Servers that need attention (critical first, then warnings). */
  readonly attentionServers = computed(() =>
    this.allTargets()
      .filter((t) => t.status !== 'ok')
      .sort((a, b) => rank(b.status) - rank(a.status))
  );

  /** Services that are not running (down first, then unaccessible). */
  readonly attentionServices = computed(() =>
    this.allServices()
      .filter((s) => s.down)
      .sort((a, b) => (b.state === 'Stopped' || b.state === 'Faulted' ? 1 : 0) - (a.state === 'Stopped' || a.state === 'Faulted' ? 1 : 0))
  );

  ngOnInit(): void {
    this.load();
    // Tick every 10s so the "x ago" last-synced label stays current.
    interval(10_000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.nowTick.set(Date.now()));
  }

  /** Pull health + services for every app (1 shared config call + agent fan-out). */
  load(): void {
    this.loading.set(true);
    this.infra.reloadConfig();

    forkJoin(INFRA_APPS.map((app) => this.infra.health(app)))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (list) => {
          this.healthByApp.set(list);
          const at = new Date();
          this.lastSyncAt.set(at);
          this.lastSync.set(formatDateTime(at));
          this.nowTick.set(at.getTime());
          this.loading.set(false);
        },
        error: () => this.loading.set(false)
      });

    forkJoin(INFRA_APPS.map((app) => this.infra.services(app)))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((list) => this.servicesByApp.set(list));

    // Oracle snapshot (one call powers the whole strip).
    this.oracle.overview()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (list) => this.oracleDbs.set(list),
        error: () => this.oracleDbs.set([])
      });
  }

  /** Conic gauge for a DB's storage %, coloured by severity. */
  oraGauge(db: OracleOverview): string {
    const color = db.storage_sev === 'crit' ? '#ef4444' : db.storage_sev === 'warn' ? '#f59e0b' : '#22c55e';
    return `conic-gradient(${color} ${db.storage_pct * 3.6}deg, rgba(148,163,184,0.18) 0deg)`;
  }

  // --- Helpers --------------------------------------------------------------
  private tallyStatus(targets: FlatTarget[]): { ok: number; warn: number; crit: number } {
    const counts = { ok: 0, warn: 0, crit: 0 };
    for (const t of targets) {
      counts[t.status]++;
    }
    return counts;
  }

  private worstMetricText(t: { metrics: { label: string; percent: number; status: HealthStatus }[] }): string {
    const worst = [...t.metrics].sort((a, b) => rank(b.status) - rank(a.status))[0];
    return worst ? `${worst.label} ${worst.percent}%` : '';
  }
}

function rank(status: HealthStatus): number {
  return status === 'crit' ? 2 : status === 'warn' ? 1 : 0;
}
