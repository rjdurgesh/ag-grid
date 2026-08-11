/** Data-model contracts for Infrastructure Pulse (health + services). */

import { InfraApp } from './api-endpoints';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * A monitored service (name + optional start/stop script) parsed from a config row's
 * `MONITORING_CONFIG.services` (see {@link ServerHealthRow}). Services arrive as an array
 * of single-key objects (`[{"apache":"/x.sh"}]`, or `{"WinSvc": null}` for a script-less
 * Windows service).
 */
export interface MonitoredService {
  name: string;
  /** Action script the agent runs to start/stop it (null → agent manages by name, e.g. Windows). */
  script: string | null;
}

/** Free space of a share drive (computed directly, no agent). */
export interface ShareSpaceResponse {
  used: number;
  total: number;
  unit: string;
  /** False when the share path could not be reached/read. */
  reachable?: boolean;
}

// ---------------------------------------------------------------------------
// Infrastructure Health — new contract (POST /api/infra_health*)
// ---------------------------------------------------------------------------

/**
 * One row of the health config catalogue (`POST /api/infra_health` → `data[]`).
 * Field names are the DB's UPPERCASE columns; `MONITORING_CONFIG` is a real object
 * (not a CLOB string). Shares have `MONITORING_CONFIG: null`.
 */
export interface ServerHealthRow {
  APP_ENV: string;
  RESOURCE_CATEGORY: 'SERVER' | 'SHARE_DRIVE';
  HOST_PLATFORM: 'WINDOWS' | 'LINUX' | 'SHARE_DRIVE';
  HOST_NAME: string;
  HOST_ADDRESS: string;
  AGENT_LISTEN_PORT: number;
  APP_NAME: InfraApp;
  MONITORING_CONFIG: { infra?: string[]; disk?: string[]; services?: Record<string, string | null>[] } | null;
  IS_ACTIVE: 'Y' | 'N';
  COMMENTS: string;
  LAST_UPDATED_BY?: string;
  LAST_UPDATED_ON?: string;
}

/** Envelope of the config call. */
export interface ServerHealthConfigResponse {
  status: string;
  data: ServerHealthRow[];
}

/** One disk/mount entry in the agent's `/system-metrics` response (values are strings like "79.35 GB"). */
export interface AgentDiskEntry {
  drive: string;
  used: string;
  free: string;
  total: string;
  percent: number;
}

/**
 * Response from a server agent's `/system-metrics` (via `POST /api/infra_health/metrics`).
 * RAM is in **bytes** (+ `percent`); disk values are **strings with units**, keyed by
 * drive. OS-specific extras (buffers/cached/…) are ignored — only total/used/percent used.
 */
export interface AgentMetricsResponse {
  HOST_NAME?: string;
  AGENT_LISTEN_PORT?: number;
  /** False when the agent could not be reached (down / timed out). */
  reachable?: boolean;
  os?: string;
  cpu_percent?: number;
  load_avg?: number[];
  ram?: { total?: number; used?: number; available?: number; free?: number; percent?: number };
  disk_storage?: Record<string, AgentDiskEntry>;
}

/** Bytes → GB (2 dp). */
export function bytesToGb(bytes: number): number {
  return +(bytes / 1024 ** 3).toFixed(2);
}

/** Parse a size string like "79.35 GB" → GB number (handles B/KB/MB/GB/TB). */
export function parseSizeToGb(value: string | number | null | undefined): number {
  if (typeof value === 'number') {
    return value;
  }
  if (!value) {
    return 0;
  }
  const m = /([\d.]+)\s*([KMGT]?B)?/i.exec(value.trim());
  if (!m) {
    return 0;
  }
  const n = parseFloat(m[1]);
  const toGb: Record<string, number> = { B: 1 / 1024 ** 3, KB: 1 / 1024 ** 2, MB: 1 / 1024, GB: 1, TB: 1024 };
  return +(n * (toGb[(m[2] || 'GB').toUpperCase()] ?? 1)).toFixed(2);
}

/** Traffic-light status shared by health targets and their individual metrics. */
export type HealthStatus = 'ok' | 'warn' | 'crit';

/** Operating system / target family — drives the icon on a card. */
export type TargetOs = 'windows' | 'linux' | 'share';

/**
 * Percent thresholds at which a monitored value turns amber / red.
 * A real backend can override these per target later.
 */
export const HEALTH_THRESHOLDS = { warn: 75, crit: 90 } as const;

/** Map a 0–100 utilisation percent to a traffic-light status. */
export function statusForPercent(percent: number): HealthStatus {
  if (percent >= HEALTH_THRESHOLDS.crit) {
    return 'crit';
  }
  if (percent >= HEALTH_THRESHOLDS.warn) {
    return 'warn';
  }
  return 'ok';
}

/** Worst (most severe) status in a list — used for a card's overall state. */
export function worstStatus(statuses: HealthStatus[]): HealthStatus {
  if (statuses.includes('crit')) {
    return 'crit';
  }
  if (statuses.includes('warn')) {
    return 'warn';
  }
  return 'ok';
}

/**
 * A single monitored value on a target: CPU, RAM, a disk/mount, or share space.
 * `used`/`total` share the same `unit`; `percent` is precomputed for the bar.
 */
export interface HealthMetric {
  /** e.g. 'CPU', 'RAM', 'C:\\', '/', 'Storage'. */
  label: string;
  used: number;
  total: number;
  /** '%' for CPU (used === percent), otherwise 'GB' / 'TB'. */
  unit: string;
  percent: number;
  status: HealthStatus;
}

/** A monitored server or share path within an application. */
export interface HealthTarget {
  id: string;
  /** Hostname (server) or share name (share). */
  name: string;
  kind: 'server' | 'share';
  os: TargetOs;
  /** UNC / filesystem path — mainly meaningful for shares. */
  path?: string;
  /** IP / FQDN, shown in the info dialog. */
  host?: string;
  /** Deployment environment, e.g. "Production". */
  environment?: string;
  /** Short human description of the server's role, shown in the info dialog. */
  note?: string;
  metrics: HealthMetric[];
  lastUpdated: string;
  /** Worst of {@link metrics} — the card's overall colour. */
  status: HealthStatus;
  /** True when the agent/share couldn't be reached — card shows a red "unreachable" state. */
  unreachable?: boolean;
}

/** Health payload for one application (returned by API.infra.health). */
export interface AppHealth {
  app: InfraApp;
  label: string;
  generatedAt: string;
  counts: { ok: number; warn: number; crit: number };
  targets: HealthTarget[];
}

// ---------------------------------------------------------------------------
// Service Console
// ---------------------------------------------------------------------------

/** Runtime state of a monitored service. Anything but 'Running' is treated as down. */
export type ServiceState = 'Running' | 'Stopped' | 'Starting' | 'Stopping' | 'Faulted' | 'Unknown';

/**
 * Traffic bucket for a service:
 *  - `up`           : Running (green)
 *  - `unaccessible` : Unknown — status could not be determined (grey)
 *  - `down`         : everything else — Stopped / Faulted / … (red)
 */
export type ServiceCategory = 'up' | 'down' | 'unaccessible';

export function serviceCategory(state: ServiceState): ServiceCategory {
  if (state === 'Running') {
    return 'up';
  }
  if (state === 'Unknown') {
    return 'unaccessible';
  }
  return 'down';
}

/** True when a service is healthy (Running). */
export function isServiceUp(state: ServiceState): boolean {
  return state === 'Running';
}

/** Map an agent-reported status string (e.g. "Running"/"Stopped") to a {@link ServiceState}. */
export function serviceStateFrom(status: string | null | undefined): ServiceState {
  switch ((status ?? '').trim().toLowerCase()) {
    case 'running':
      return 'Running';
    case 'stopped':
      return 'Stopped';
    case 'starting':
      return 'Starting';
    case 'stopping':
      return 'Stopping';
    case 'faulted':
    case 'failed':
      return 'Faulted';
    default:
      return 'Unknown';
  }
}

// --- Service Console agent responses (POST /api/service_console/service-manage) ---

/** One service's status in the bulk-status response. */
export interface ServiceStatusEntry {
  service: string;
  status: string;
}

/**
 * Bulk status response: `HOST_NAME` + `reachable` plus one entry per service name
 * (`{ service, status }`). Keyed dynamically by service name, so look entries up by the
 * names you asked for. `reachable: false` → the agent could not be reached.
 */
export type ServiceStatusResponse = Record<string, ServiceStatusEntry | string | boolean | null | undefined>;

/** Result of a start/stop/status action on one service. */
export interface ServiceActionResponse {
  action?: string;
  service?: string;
  message?: string;
  success?: boolean;
  /** False when the agent could not be reached. */
  reachable?: boolean;
}

/** A single configured service on a server. */
export interface ServiceInfo {
  id: string;
  name: string;
  /** Friendly label; falls back to `name` when absent. */
  displayName?: string;
  state: ServiceState;
  /** ISO timestamp of the last heartbeat check. */
  lastHeartbeat: string;
}

/** The services configured on one server. */
export interface ServerServices {
  serverId: string;
  serverName: string;
  os: TargetOs;
  services: ServiceInfo[];
  /** True when the server's agent couldn't be reached — the row shows a red "Unreachable" state. */
  unreachable?: boolean;
  /** IP / FQDN — shown in the server info dialog. */
  host?: string;
  /** Deployment environment (APP_ENV) — shown in the info dialog. */
  environment?: string;
  /** Free-text comments from the config row — shown in the info dialog. */
  note?: string;
}

/** Service payload for one application (returned by API.infra.services). */
export interface AppServices {
  app: InfraApp;
  label: string;
  generatedAt: string;
  counts: { running: number; down: number; unaccessible: number };
  servers: ServerServices[];
}

/** Outcome of a start/stop action (the new state is fetched separately afterwards). */
export interface ServiceActionResult {
  success: boolean;
  /** Message from the agent, shown as a toast. */
  message: string;
  serverId: string;
  serviceId: string;
}
