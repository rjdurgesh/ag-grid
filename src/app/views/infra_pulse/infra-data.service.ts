import { inject, Injectable } from '@angular/core';
import { forkJoin, Observable, of, throwError } from 'rxjs';
import { map, shareReplay, switchMap } from 'rxjs/operators';

import { ApiDataService } from '../../shared/api-data.service';
import { API, APP_ENV, INFRA_APP_LABELS, InfraApp } from '../../shared/api-endpoints';
import {
  AgentCollectResponse,
  AppHealth,
  AppServices,
  HealthMetric,
  HealthServerConfigRow,
  HealthTarget,
  ServerServices,
  ServiceActionResult,
  ServiceState,
  ShareSpaceResponse,
  TargetOs,
  parseMonitorConfig,
  serviceCategory,
  statusForPercent,
  worstStatus
} from '../../shared/infra-models';

/**
 * Data access for Infrastructure Pulse.
 *
 * Flow (mirrors the real system):
 *  1. **One config call** per page refresh → rows from `health_Server_Details`
 *     for {@link APP_ENV} (which servers/shares to monitor + each server's
 *     `monitor_config`).
 *  2. **One agent call per server** (fan-out) with that server's config → live
 *     disk / infra / service readings. Share drives skip the agent (computed).
 *
 * The config fetch is cached (shareReplay) so the four concurrent `health(app)` /
 * `services(app)` calls a page makes on refresh share a single HTTP request —
 * exactly "1 config call + N agent calls". Call {@link reloadConfig} at the start
 * of a full refresh to force a fresh config fetch.
 *
 * To use a real backend: point the endpoints in `api-endpoints.ts` at your API
 * (config → `health_Server_Details`, agentCollect/agentAction → the on-server
 * agent, shareSpace → your share calculation) and set `USE_MOCK = false`.
 */
@Injectable({ providedIn: 'root' })
export class InfraDataService {
  private readonly api = inject(ApiDataService);

  private config$?: Observable<HealthServerConfigRow[]>;

  /** Force the next config access to re-fetch. Call at the start of a full refresh. */
  reloadConfig(): void {
    this.config$ = undefined;
  }

  /** The single config API call, shared by concurrent subscribers. */
  serverConfigs(): Observable<HealthServerConfigRow[]> {
    if (!this.config$) {
      this.config$ = this.api
        .get<HealthServerConfigRow[]>(API.infra.config(APP_ENV))
        .pipe(shareReplay(1));
    }
    return this.config$;
  }

  private rowsForApp(app: InfraApp): Observable<HealthServerConfigRow[]> {
    return this.serverConfigs().pipe(
      map((rows) => rows.filter((r) => r.app_name === app && r.is_active === 'Y'))
    );
  }

  // --- Health ---------------------------------------------------------------
  health(app: InfraApp): Observable<AppHealth> {
    return this.rowsForApp(app).pipe(
      switchMap((rows) =>
        rows.length
          ? forkJoin(rows.map((r) => this.collectHealth(r))).pipe(map((targets) => assembleHealth(app, targets)))
          : of(emptyHealth(app))
      )
    );
  }

  targetHealth(app: InfraApp, targetId: string): Observable<HealthTarget> {
    return this.rowsForApp(app).pipe(
      switchMap((rows) => {
        const row = rows.find((r) => r.hostname === targetId);
        return row ? this.collectHealth(row) : throwError(() => new Error(`Unknown target ${targetId}`));
      })
    );
  }

  private collectHealth(row: HealthServerConfigRow): Observable<HealthTarget> {
    if (row.resource_category === 'share_drive') {
      return this.api
        .get<ShareSpaceResponse>(API.infra.shareSpace(row.app_name, row.hostname))
        .pipe(map((res) => shareTarget(row, res)));
    }
    return this.api
      .post<AgentCollectResponse>(API.infra.agentCollect, agentPayload(row))
      .pipe(map((res) => serverTarget(row, res)));
  }

  // --- Services -------------------------------------------------------------
  services(app: InfraApp): Observable<AppServices> {
    return this.rowsForApp(app).pipe(
      switchMap((rows) => {
        // Only servers that actually have services configured are shown here.
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
// Mapping helpers: config row + agent/share reading → UI view models
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

/** Windows disks show as `C:\`; Linux mounts as `/apps` etc. */
function diskLabel(platform: string, name: string): string {
  if (platform === 'WINDOW') {
    return `${name.toUpperCase()}:\\`;
  }
  return name.startsWith('/') ? name : `/${name}`;
}

function metric(label: string, used: number, total: number, unit: string): HealthMetric {
  const percent = unit === '%' ? +used.toFixed(1) : total > 0 ? +((used / total) * 100).toFixed(1) : 0;
  return { label, used: +used.toFixed(2), total, unit, percent, status: statusForPercent(percent) };
}

function serverTarget(row: HealthServerConfigRow, res: AgentCollectResponse): HealthTarget {
  const metrics: HealthMetric[] = [];
  if (res.cpu != null) {
    metrics.push(metric('CPU', res.cpu, 100, '%'));
  }
  if (res.ram) {
    metrics.push(metric('RAM', res.ram.used, res.ram.total, 'GB'));
  }
  for (const disk of res.disks) {
    metrics.push(metric(diskLabel(row.host_platform, disk.name), disk.used, disk.total, disk.unit));
  }
  return {
    id: row.hostname,
    name: row.hostname,
    kind: 'server',
    os: osOf(row),
    host: row.host_address,
    environment: row.app_env,
    note: row.comments,
    metrics,
    lastUpdated: new Date().toISOString(),
    status: metrics.length ? worstStatus(metrics.map((m) => m.status)) : 'ok'
  };
}

function shareTarget(row: HealthServerConfigRow, res: ShareSpaceResponse): HealthTarget {
  const storage = metric('Storage', res.used, res.total, res.unit);
  return {
    id: row.hostname,
    name: row.hostname,
    kind: 'share',
    os: 'share',
    path: row.host_address,
    host: row.host_address,
    environment: row.app_env,
    note: row.comments,
    metrics: [storage],
    lastUpdated: new Date().toISOString(),
    status: storage.status
  };
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

function assembleHealth(app: InfraApp, targets: HealthTarget[]): AppHealth {
  const counts = { ok: 0, warn: 0, crit: 0 };
  for (const t of targets) {
    counts[t.status]++;
  }
  return { app, label: INFRA_APP_LABELS[app], generatedAt: new Date().toISOString(), counts, targets };
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
