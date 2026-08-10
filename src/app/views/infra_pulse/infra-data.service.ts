import { inject, Injectable } from '@angular/core';
import { forkJoin, Observable, of, throwError } from 'rxjs';
import { map, shareReplay, switchMap } from 'rxjs/operators';

import { ApiDataService } from '../../shared/api-data.service';
import { API, INFRA_APP_LABELS, InfraApp, apiEnv } from '../../shared/api-endpoints';
import { environment } from '../../../environments/environment';
import {
  AgentCollectResponse,
  AgentMetricsResponse,
  AppHealth,
  AppServices,
  HealthMetric,
  HealthServerConfigRow,
  HealthTarget,
  ServerHealthConfigResponse,
  ServerHealthRow,
  ServerServices,
  ServiceActionResult,
  ServiceState,
  ShareSpaceResponse,
  TargetOs,
  bytesToGb,
  parseMonitorConfig,
  parseSizeToGb,
  serviceCategory,
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
 * **Service Console** still uses the older `/api/infra/*` flow (config + agent collect +
 * agent action); it moves to the new contract when that screen is wired for real.
 */
@Injectable({ providedIn: 'root' })
export class InfraDataService {
  private readonly api = inject(ApiDataService);

  private healthConfig$?: Observable<ServerHealthRow[]>;
  private config$?: Observable<HealthServerConfigRow[]>;

  /** Force the next config access to re-fetch (health + services). Call at a full refresh. */
  reloadConfig(): void {
    this.healthConfig$ = undefined;
    this.config$ = undefined;
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
    if (row.RESOURCE_CATEGORY === 'SHARE_DRIVE') {
      return this.api
        .post<ShareSpaceResponse>(API.infra.healthShare, { host_address: row.HOST_ADDRESS, app_name: row.APP_NAME })
        .pipe(map((res) => shareTarget(row, res)));
    }
    return this.api
      .post<AgentMetricsResponse>(API.infra.healthMetrics, {
        host_name: row.HOST_NAME,
        agent_listen_port: row.AGENT_LISTEN_PORT,
        host_platform: row.HOST_PLATFORM,
        monitoring_config: row.MONITORING_CONFIG
      })
      .pipe(map((res) => serverTarget(row, res)));
  }

  // ===========================================================================
  // Service Console (unchanged — older /api/infra/* flow)
  // ===========================================================================

  private serverConfigs(): Observable<HealthServerConfigRow[]> {
    if (!this.config$) {
      this.config$ = this.api
        .get<HealthServerConfigRow[]>(API.infra.config(environment.appEnv))
        .pipe(shareReplay(1));
    }
    return this.config$;
  }

  private rowsForApp(app: InfraApp): Observable<HealthServerConfigRow[]> {
    return this.serverConfigs().pipe(
      map((rows) => rows.filter((r) => r.app_name === app && r.is_active === 'Y'))
    );
  }

  services(app: InfraApp): Observable<AppServices> {
    return this.rowsForApp(app).pipe(
      switchMap((rows) => {
        const serverRows = rows.filter(
          (r) => r.resource_category === 'SERVER' && parseMonitorConfig(r.monitor_config).services.length > 0
        );
        return serverRows.length
          ? forkJoin(serverRows.map((r) => this.collectServices(r))).pipe(map((servers) => assembleServices(app, servers)))
          : of(emptyServices(app));
      })
    );
  }

  serverServices(app: InfraApp, serverId: string): Observable<ServerServices> {
    return this.rowsForApp(app).pipe(
      switchMap((rows) => {
        const row = rows.find((r) => r.hostname === serverId);
        return row ? this.collectServices(row) : throwError(() => new Error(`Unknown server ${serverId}`));
      })
    );
  }

  private collectServices(row: HealthServerConfigRow): Observable<ServerServices> {
    return this.api
      .post<AgentCollectResponse>(API.infra.agentCollect, agentPayload(row))
      .pipe(map((res) => serverServices(row, res)));
  }

  serviceAction(
    app: InfraApp,
    serverId: string,
    serviceId: string,
    action: 'start' | 'stop'
  ): Observable<ServiceActionResult> {
    return this.rowsForApp(app).pipe(
      switchMap((rows) => {
        const row = rows.find((r) => r.hostname === serverId);
        if (!row) {
          return throwError(() => new Error(`Unknown server ${serverId}`));
        }
        const svc = parseMonitorConfig(row.monitor_config).services.find((s) => s.name === serviceId);
        return this.api
          .post<{ service: string; state: ServiceState; lastHeartbeat: string }>(API.infra.agentAction, {
            hostname: row.hostname,
            host_address: row.host_address,
            agent_listen_port: row.agent_listen_port,
            service: serviceId,
            script: svc?.script ?? null,
            action
          })
          .pipe(
            map((res) => ({ success: true, serverId, serviceId, state: res.state, lastHeartbeat: res.lastHeartbeat }))
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
// Service Console mapping (unchanged — older config row + agent collect)
// ---------------------------------------------------------------------------

/** Payload sent to a server's agent (targets host_address:agent_listen_port in prod). */
function agentPayload(row: HealthServerConfigRow): Record<string, unknown> {
  return {
    hostname: row.hostname,
    host_platform: row.host_platform,
    host_address: row.host_address,
    agent_listen_port: row.agent_listen_port,
    monitor_config: row.monitor_config
  };
}

function osOf(row: HealthServerConfigRow): TargetOs {
  return row.host_platform === 'WINDOW' ? 'windows' : row.host_platform === 'LINUX' ? 'linux' : 'share';
}

function serverServices(row: HealthServerConfigRow, res: AgentCollectResponse): ServerServices {
  return {
    serverId: row.hostname,
    serverName: row.hostname,
    os: osOf(row),
    services: res.services.map((s) => ({
      id: s.name,
      name: s.name,
      state: s.state,
      lastHeartbeat: s.lastHeartbeat
    }))
  };
}

function assembleServices(app: InfraApp, servers: ServerServices[]): AppServices {
  let running = 0;
  let down = 0;
  let unaccessible = 0;
  for (const server of servers) {
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
    servers
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
