import { inject, Injectable } from '@angular/core';
import { forkJoin, Observable, of, throwError } from 'rxjs';
import { catchError, map, shareReplay, switchMap, timeout } from 'rxjs/operators';

import { ApiDataService } from '../../shared/api-data.service';
import { API, INFRA_APP_LABELS, InfraApp, apiEnv } from '../../shared/api-endpoints';
import { environment } from '../../../environments/environment';
import {
  AgentMetricsResponse,
  AppHealth,
  AppServices,
  HealthMetric,
  HealthTarget,
  MonitoredService,
  ServerHealthConfigResponse,
  ServerHealthRow,
  ServerServices,
  ServiceActionResponse,
  ServiceActionResult,
  ServiceStatusEntry,
  ServiceStatusResponse,
  ShareSpaceResponse,
  TargetOs,
  bytesToGb,
  parseSizeToGb,
  serviceCategory,
  serviceStateFrom,
  statusForPercent,
  worstStatus
} from '../../shared/infra-models';

/**
 * Data access for Infrastructure Pulse.
 *
 * **Health** (new contract) — every browser call is a POST under `/api/infra_health`:
 *  1. **One config call** (`POST /api/infra_health` `{app_env, username}`) → the
 *     server/share rows. Cached (shareReplay) so a page's four `health(app)` calls
 *     share one request.
 *  2. **One metrics call per server** (`POST /api/infra_health/metrics`) → the backend
 *     forms `http://{host}:{port}/system-metrics`, calls the agent, returns cpu/ram/disk.
 *     The dynamic agent URL never reaches the browser.
 *  3. **One share call per share** (`POST /api/infra_health/share`) → computed directly.
 *
 * **Service Console** shares the SAME `/api/infra_health` catalogue (filtered to SERVER rows
 * that have services), then fans out one `POST /api/service_console/service-manage` per server
 * for status, and one per start/stop/status action. The dynamic agent URL stays server-side.
 */
/**
 * Client-side ceiling for a single server/share/agent call. The backend already caps the
 * agent request (~8 s) and returns `reachable:false` on failure; this is defence in depth so
 * a network/proxy stall can't hold the whole panel's `forkJoin` open — it becomes a
 * `TimeoutError`, caught into one "unreachable" card/row.
 */
const HEALTH_CALL_TIMEOUT_MS = 15_000;

@Injectable({ providedIn: 'root' })
export class InfraDataService {
  private readonly api = inject(ApiDataService);

  private healthConfig$?: Observable<ServerHealthRow[]>;

  /** Force the next config access to re-fetch (shared by both Infra screens). Call at a full refresh. */
  reloadConfig(): void {
    this.healthConfig$ = undefined;
  }

  // ===========================================================================
  // Health (new /api/infra_health contract)
  // ===========================================================================

  /** The single health-config POST, shared by concurrent subscribers. */
  private healthConfigs(): Observable<ServerHealthRow[]> {
    if (!this.healthConfig$) {
      this.healthConfig$ = this.api
        .post<ServerHealthConfigResponse>(API.infra.healthConfig, {
          app_env: apiEnv(environment.appEnv),
          username: environment.username
        })
        .pipe(
          map((res) => res?.data ?? []),
          shareReplay(1)
        );
    }
    return this.healthConfig$;
  }

  private healthRowsForApp(app: InfraApp): Observable<ServerHealthRow[]> {
    return this.healthConfigs().pipe(
      map((rows) => rows.filter((r) => r.APP_NAME === app && r.IS_ACTIVE === 'Y'))
    );
  }

  health(app: InfraApp): Observable<AppHealth> {
    return this.healthRowsForApp(app).pipe(
      switchMap((rows) =>
        rows.length
          ? forkJoin(rows.map((r) => this.collectHealth(r))).pipe(map((targets) => assembleHealth(app, targets)))
          : of(emptyHealth(app))
      )
    );
  }

  targetHealth(app: InfraApp, targetId: string): Observable<HealthTarget> {
    return this.healthRowsForApp(app).pipe(
      switchMap((rows) => {
        const row = rows.find((r) => r.HOST_NAME === targetId);
        return row ? this.collectHealth(row) : throwError(() => new Error(`Unknown target ${targetId}`));
      })
    );
  }

  private collectHealth(row: ServerHealthRow): Observable<HealthTarget> {
    // Each server/share is independently error-handled: an unreachable agent (or a
    // hard HTTP error) yields a single "unreachable" card, so one dead server never
    // fails the whole panel.
    if (row.RESOURCE_CATEGORY === 'SHARE_DRIVE') {
      return this.api
        .post<ShareSpaceResponse>(API.infra.healthShare, { host_address: row.HOST_ADDRESS, app_name: row.APP_NAME })
        .pipe(
          timeout(HEALTH_CALL_TIMEOUT_MS),
          map((res) => (res?.reachable === false ? unreachableTarget(row) : shareTarget(row, res))),
          catchError(() => of(unreachableTarget(row)))
        );
    }
    return this.api
      .post<AgentMetricsResponse>(API.infra.healthMetrics, {
        host_name: row.HOST_NAME,
        agent_listen_port: row.AGENT_LISTEN_PORT,
        host_platform: row.HOST_PLATFORM,
        monitoring_config: row.MONITORING_CONFIG
      })
      .pipe(
        timeout(HEALTH_CALL_TIMEOUT_MS),
        map((res) => (res?.reachable === false ? unreachableTarget(row) : serverTarget(row, res))),
        catchError(() => of(unreachableTarget(row)))
      );
  }

  // ===========================================================================
  // Service Console (new contract — shares the /api/infra_health catalogue)
  // ===========================================================================

  /** SERVER rows for `app` that are active AND have at least one configured service. */
  private serviceRowsForApp(app: InfraApp): Observable<ServerHealthRow[]> {
    return this.healthConfigs().pipe(
      map((rows) =>
        rows.filter(
          (r) =>
            r.APP_NAME === app &&
            r.IS_ACTIVE === 'Y' &&
            r.RESOURCE_CATEGORY === 'SERVER' &&
            servicesOf(r).length > 0
        )
      )
    );
  }

  services(app: InfraApp): Observable<AppServices> {
    return this.serviceRowsForApp(app).pipe(
      switchMap((rows) =>
        rows.length
          ? forkJoin(rows.map((r) => this.collectServiceStatus(r))).pipe(map((servers) => assembleServices(app, servers)))
          : of(emptyServices(app))
      )
    );
  }

  serverServices(app: InfraApp, serverId: string): Observable<ServerServices> {
    return this.serviceRowsForApp(app).pipe(
      switchMap((rows) => {
        const row = rows.find((r) => r.HOST_NAME === serverId);
        return row ? this.collectServiceStatus(row) : throwError(() => new Error(`Unknown server ${serverId}`));
      })
    );
  }

  /** Bulk status for one server. A dead/slow agent → one "Unreachable" server, not a panel error. */
  private collectServiceStatus(row: ServerHealthRow): Observable<ServerServices> {
    const cfg = servicesOf(row);
    return this.api
      .post<ServiceStatusResponse>(API.infra.serviceManage, {
        host_name: row.HOST_NAME,
        agent_listen_port: row.AGENT_LISTEN_PORT,
        host_platform: row.HOST_PLATFORM,
        services: cfg.map((s) => s.name)
      })
      .pipe(
        timeout(HEALTH_CALL_TIMEOUT_MS),
        map((res) => (res?.['reachable'] === false ? unreachableServer(row, cfg) : serverServicesFrom(row, cfg, res))),
        catchError(() => of(unreachableServer(row, cfg)))
      );
  }

  serviceAction(
    app: InfraApp,
    serverId: string,
    serviceId: string,
    action: 'start' | 'stop' | 'status'
  ): Observable<ServiceActionResult> {
    return this.serviceRowsForApp(app).pipe(
      switchMap((rows) => {
        const row = rows.find((r) => r.HOST_NAME === serverId);
        if (!row) {
          return throwError(() => new Error(`Unknown server ${serverId}`));
        }
        // Identify the service by its script (Linux) or, when there is none (Windows), its name.
        const svc = servicesOf(row).find((s) => s.name === serviceId);
        const serviceRef = svc?.script ?? serviceId;
        return this.api
          .post<ServiceActionResponse>(API.infra.serviceManage, {
            host_name: row.HOST_NAME,
            agent_listen_port: row.AGENT_LISTEN_PORT,
            host_platform: row.HOST_PLATFORM,
            service: serviceRef,
            action
          })
          .pipe(
            timeout(HEALTH_CALL_TIMEOUT_MS),
            map((res) => ({ success: !!res?.success, message: res?.message ?? '', serverId, serviceId }))
          );
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Health mapping: new config row + agent /system-metrics → UI view models
// ---------------------------------------------------------------------------

function osOfHealth(row: ServerHealthRow): TargetOs {
  return row.HOST_PLATFORM === 'WINDOWS' ? 'windows' : row.HOST_PLATFORM === 'LINUX' ? 'linux' : 'share';
}

/** A metric using the agent-supplied `percent` for the bar (not recomputed). */
function metricPct(label: string, used: number, total: number, unit: string, percent: number): HealthMetric {
  const pct = +(+percent || 0).toFixed(1);
  return { label, used: +used.toFixed(2), total: +total.toFixed(2), unit, percent: pct, status: statusForPercent(pct) };
}

function serverTarget(row: ServerHealthRow, res: AgentMetricsResponse): HealthTarget {
  const metrics: HealthMetric[] = [];
  if (res.cpu_percent != null) {
    metrics.push(metricPct('CPU', res.cpu_percent, 100, '%', res.cpu_percent));
  }
  if (res.ram && res.ram.total != null) {
    const totalGb = bytesToGb(res.ram.total);
    const usedGb = bytesToGb(res.ram.used ?? res.ram.total - (res.ram.available ?? res.ram.free ?? 0));
    const pct = res.ram.percent ?? (totalGb ? (usedGb / totalGb) * 100 : 0);
    metrics.push(metricPct('RAM', usedGb, totalGb, 'GB', pct));
  }
  for (const [key, disk] of Object.entries(res.disk_storage ?? {})) {
    metrics.push(metricPct(disk.drive || key, parseSizeToGb(disk.used), parseSizeToGb(disk.total), 'GB', disk.percent));
  }
  return {
    id: row.HOST_NAME,
    name: row.HOST_NAME,
    kind: 'server',
    os: osOfHealth(row),
    host: row.HOST_ADDRESS,
    environment: row.APP_ENV,
    note: row.COMMENTS,
    metrics,
    lastUpdated: new Date().toISOString(),
    status: metrics.length ? worstStatus(metrics.map((m) => m.status)) : 'ok'
  };
}

function shareTarget(row: ServerHealthRow, res: ShareSpaceResponse): HealthTarget {
  const percent = res.total > 0 ? (res.used / res.total) * 100 : 0;
  const storage = metricPct('Storage', res.used, res.total, res.unit, percent);
  return {
    id: row.HOST_NAME,
    name: row.HOST_NAME,
    kind: 'share',
    os: 'share',
    path: row.HOST_ADDRESS,
    host: row.HOST_ADDRESS,
    environment: row.APP_ENV,
    note: row.COMMENTS,
    metrics: [storage],
    lastUpdated: new Date().toISOString(),
    status: storage.status
  };
}

/** Card order within a panel: all Windows, then all Linux, then share drives. */
const OS_RANK: Record<TargetOs, number> = { windows: 0, linux: 1, share: 2 };

/** A card for a server/share whose agent (or share path) couldn't be reached. */
function unreachableTarget(row: ServerHealthRow): HealthTarget {
  return {
    id: row.HOST_NAME,
    name: row.HOST_NAME,
    kind: row.RESOURCE_CATEGORY === 'SHARE_DRIVE' ? 'share' : 'server',
    os: osOfHealth(row),
    host: row.HOST_ADDRESS,
    environment: row.APP_ENV,
    note: row.COMMENTS,
    metrics: [],
    lastUpdated: new Date().toISOString(),
    status: 'crit',
    unreachable: true
  };
}

function assembleHealth(app: InfraApp, targets: HealthTarget[]): AppHealth {
  // Group by OS (Windows → Linux → Share), then by name — never a random mix.
  const ordered = [...targets].sort(
    (a, b) => OS_RANK[a.os] - OS_RANK[b.os] || a.name.localeCompare(b.name)
  );
  const counts = { ok: 0, warn: 0, crit: 0 };
  for (const t of ordered) {
    counts[t.status]++;
  }
  return { app, label: INFRA_APP_LABELS[app], generatedAt: new Date().toISOString(), counts, targets: ordered };
}

function emptyHealth(app: InfraApp): AppHealth {
  return {
    app,
    label: INFRA_APP_LABELS[app],
    generatedAt: new Date().toISOString(),
    counts: { ok: 0, warn: 0, crit: 0 },
    targets: []
  };
}

// ---------------------------------------------------------------------------
// Service Console mapping (new config row + agent /service-manage)
// ---------------------------------------------------------------------------

/**
 * Flatten `MONITORING_CONFIG.services` (array of `{ name: script }` objects) into
 * `{ name, script }[]`. A `"null"` (string) or null script means the agent manages the
 * service by name (e.g. a Windows service).
 */
function servicesOf(row: ServerHealthRow): MonitoredService[] {
  const list = row.MONITORING_CONFIG?.services ?? [];
  return list.flatMap((obj) =>
    Object.entries(obj).map(([name, script]) => ({
      name,
      script: script && script !== 'null' ? script : null
    }))
  );
}

/** Info fields shared by the reachable + unreachable mappers (shown in the info dialog). */
function serverInfoOf(row: ServerHealthRow): Pick<ServerServices, 'serverId' | 'serverName' | 'os' | 'host' | 'environment' | 'note'> {
  return {
    serverId: row.HOST_NAME,
    serverName: row.HOST_NAME,
    os: osOfHealth(row),
    host: row.HOST_ADDRESS,
    environment: row.APP_ENV,
    note: row.COMMENTS
  };
}

/** Map a bulk-status agent response onto the server's configured services. */
function serverServicesFrom(row: ServerHealthRow, cfg: MonitoredService[], res: ServiceStatusResponse): ServerServices {
  const now = new Date().toISOString();
  return {
    ...serverInfoOf(row),
    services: cfg.map((s) => {
      // A service missing from the response reads "Unknown" — only THAT service is
      // affected, never the whole server (which only goes red when the agent is down).
      const entry = res?.[s.name];
      const status = entry && typeof entry === 'object' ? (entry as ServiceStatusEntry).status : undefined;
      return { id: s.name, name: s.name, state: serviceStateFrom(status), lastHeartbeat: now };
    })
  };
}

/** A server whose agent couldn't be reached — its row shows a red "Unreachable" state. */
function unreachableServer(row: ServerHealthRow, cfg: MonitoredService[]): ServerServices {
  const now = new Date().toISOString();
  return {
    ...serverInfoOf(row),
    unreachable: true,
    services: cfg.map((s) => ({ id: s.name, name: s.name, state: serviceStateFrom(undefined), lastHeartbeat: now }))
  };
}

function assembleServices(app: InfraApp, servers: ServerServices[]): AppServices {
  // Order servers Windows → Linux → Share (then name), matching Infra Health.
  const ordered = [...servers].sort(
    (a, b) => OS_RANK[a.os] - OS_RANK[b.os] || a.serverName.localeCompare(b.serverName)
  );
  let running = 0;
  let down = 0;
  let unaccessible = 0;
  for (const server of ordered) {
    for (const svc of server.services) {
      const cat = serviceCategory(svc.state);
      cat === 'up' ? running++ : cat === 'unaccessible' ? unaccessible++ : down++;
    }
  }
  return {
    app,
    label: INFRA_APP_LABELS[app],
    generatedAt: new Date().toISOString(),
    counts: { running, down, unaccessible },
    servers: ordered
  };
}

function emptyServices(app: InfraApp): AppServices {
  return {
    app,
    label: INFRA_APP_LABELS[app],
    generatedAt: new Date().toISOString(),
    counts: { running: 0, down: 0, unaccessible: 0 },
    servers: []
  };
}
