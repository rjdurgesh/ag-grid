import { Component, OnDestroy, OnInit, WritableSignal, computed, inject, signal } from '@angular/core';

import { CanWriteDirective } from '../../../auth/can-write.directive';
import { ConfirmService } from '../../../components/confirm/confirm.service';
import { LoaderComponent } from '../../../components/loader/loader.component';
import { environment } from '../../../../environments/environment';
import { INFRA_APPS, INFRA_APP_LABELS, InfraApp } from '../../../shared/api-endpoints';
import { formatDateTime, timeAgo } from '../../../shared/date-utils';
import {
  AppServices,
  ServerServices,
  ServiceCategory,
  ServiceInfo,
  ServiceState,
  TargetOs,
  serviceCategory
} from '../../../shared/infra-models';
import { InfraDataService } from '../infra-data.service';

type ViewMode = 'app' | 'status';

/** One collapsible application section. */
interface ServicePanel {
  app: InfraApp;
  label: string;
  data: WritableSignal<AppServices | null>;
  loading: WritableSignal<boolean>;
  error: WritableSignal<boolean>;
  expanded: WritableSignal<boolean>;
  /** serverIds whose service table is expanded. */
  expandedServers: WritableSignal<Set<string>>;
}

/** One collapsible status section (By Status view). */
interface StatusGroup {
  category: ServiceCategory;
  label: string;
  expanded: WritableSignal<boolean>;
}

/** A service plus its app + server context (status view + actions). */
interface AggService {
  app: InfraApp;
  appLabel: string;
  server: ServerServices;
  service: ServiceInfo;
}

const REFRESH_INTERVALS = [5, 10, 15, 30] as const;

/** Server order: Windows → Linux → Share, matching Infra Health (By App + By Status). */
const OS_RANK: Record<TargetOs, number> = { windows: 0, linux: 1, share: 2 };

/**
 * Service Console. Two groupings:
 *  - By Application: App → collapsible Server bars → services table.
 *  - By Status: Stopped / Unaccessible / Running sections, each with a total
 *    count and a flat list of matching services across all apps.
 *
 * A server-hostname search, Collapse-All, and an auto-refresh interval (default
 * 30 min) sit in the toolbar. Anything not Running is red (Unknown = grey).
 */
@Component({
  selector: 'app-service-console',
  templateUrl: './service_console.component.html',
  styleUrls: ['./service_console.component.scss'],
  imports: [LoaderComponent, CanWriteDirective]
})
export class ServiceConsoleComponent implements OnInit, OnDestroy {
  private readonly infra = inject(InfraDataService);
  private readonly confirm = inject(ConfirmService);

  readonly view = signal<ViewMode>('app');
  readonly intervals = REFRESH_INTERVALS;
  readonly refreshEveryMin = signal(30);
  private timer: ReturnType<typeof setInterval> | undefined;

  /** Server-hostname search. */
  readonly query = signal('');

  readonly panels: ServicePanel[] = INFRA_APPS.map((app) => ({
    app,
    label: INFRA_APP_LABELS[app],
    data: signal<AppServices | null>(null),
    loading: signal(false),
    error: signal(false),
    expanded: signal(true),
    expandedServers: signal(new Set<string>())
  }));

  readonly statusGroups: StatusGroup[] = [
    { category: 'down', label: 'Stopped', expanded: signal(true) },
    { category: 'unaccessible', label: 'Unaccessible', expanded: signal(true) },
    { category: 'up', label: 'Running', expanded: signal(true) }
  ];

  /** Global in-flight sets shared by both views. */
  private readonly pendingServices = signal(new Set<string>());
  private readonly refreshingServers = signal(new Set<string>());

  /** Support contact shown on an unreachable server. */
  readonly supportEmail = environment.supportEmail;

  /** Transient result banner after a start/stop. */
  readonly toast = signal<{ ok: boolean; text: string } | null>(null);
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  /** Server shown in the info dialog (null = closed). */
  readonly infoServer = signal<{ appLabel: string; server: ServerServices } | null>(null);

  readonly anyExpanded = computed(() => this.panels.some((p) => p.expanded()));

  ngOnInit(): void {
    this.refreshAll();
    this.armTimer();
  }

  ngOnDestroy(): void {
    this.clearTimer();
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
    }
  }

  // --- Toolbar --------------------------------------------------------------
  setView(view: ViewMode): void {
    this.view.set(view);
  }

  onQuery(value: string): void {
    this.query.set(value);
  }

  clearQuery(): void {
    this.query.set('');
  }

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

  toggleCollapseAll(): void {
    const collapse = this.anyExpanded();
    this.panels.forEach((panel) => {
      panel.expanded.set(!collapse);
      if (collapse) {
        panel.expandedServers.set(new Set());
      }
    });
  }

  // --- App level ------------------------------------------------------------
  refreshAll(): void {
    // One config fetch shared by all four apps, then agent fan-out per server.
    this.infra.reloadConfig();
    this.panels.forEach((panel) => this.refresh(panel));
  }

  refresh(panel: ServicePanel): void {
    panel.loading.set(true);
    panel.error.set(false);
    this.infra.services(panel.app).subscribe({
      next: (data) => {
        panel.data.set(data);
        panel.loading.set(false);
      },
      error: () => {
        panel.error.set(true);
        panel.loading.set(false);
      }
    });
  }

  toggle(panel: ServicePanel): void {
    panel.expanded.update((v) => !v);
  }

  count(panel: ServicePanel, key: 'running' | 'down' | 'unaccessible'): number {
    return panel.data()?.counts[key] ?? 0;
  }

  /**
   * Aggregate colour for a panel's left rail (matches Infra Health):
   * any stopped service OR any unreachable server → 'down' (red), else any unaccessible
   * → 'unaccessible' (amber), else 'up' (green).
   */
  panelStatus(panel: ServicePanel): ServiceCategory {
    const data = panel.data();
    if (!data) {
      return 'up';
    }
    const anyUnreachable = data.servers.some((s) => s.unreachable);
    if (data.counts.down > 0 || anyUnreachable) {
      return 'down';
    }
    return data.counts.unaccessible > 0 ? 'unaccessible' : 'up';
  }

  serverCount(panel: ServicePanel): number {
    return panel.data()?.servers.length ?? 0;
  }

  filteredServers(panel: ServicePanel): ServerServices[] {
    const data = panel.data();
    if (!data) {
      return [];
    }
    const q = this.query().trim().toLowerCase();
    return q ? data.servers.filter((s) => s.serverName.toLowerCase().includes(q)) : data.servers;
  }

  // --- Server level ---------------------------------------------------------
  toggleServer(panel: ServicePanel, serverId: string): void {
    const next = new Set(panel.expandedServers());
    next.has(serverId) ? next.delete(serverId) : next.add(serverId);
    panel.expandedServers.set(next);
  }

  isServerExpanded(panel: ServicePanel, serverId: string): boolean {
    return panel.expandedServers().has(serverId);
  }

  refreshServer(panel: ServicePanel, server: ServerServices): void {
    this.markServer(server.serverId, true);
    this.infra.serverServices(panel.app, server.serverId).subscribe({
      next: (fresh) => {
        this.patchServer(panel.app, fresh);
        this.markServer(server.serverId, false);
      },
      error: () => this.markServer(server.serverId, false)
    });
  }

  isServerRefreshing(serverId: string): boolean {
    return this.refreshingServers().has(serverId);
  }

  serverDown(server: ServerServices): number {
    return server.services.filter((s) => serviceCategory(s.state) === 'down').length;
  }

  serverUnaccessible(server: ServerServices): number {
    return server.services.filter((s) => serviceCategory(s.state) === 'unaccessible').length;
  }

  // --- Service level --------------------------------------------------------
  category(state: ServiceState): ServiceCategory {
    return serviceCategory(state);
  }

  isUp(service: ServiceInfo): boolean {
    return service.state === 'Running';
  }

  isPending(service: ServiceInfo): boolean {
    return this.pendingServices().has(service.id);
  }

  async start(app: InfraApp, server: ServerServices, service: ServiceInfo): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Start service',
      message: `Start "${service.name}" on ${server.serverName}?`,
      confirmLabel: 'Start',
      tone: 'primary'
    });
    if (ok) {
      this.runAction(app, server, service, 'start');
    }
  }

  async stop(app: InfraApp, server: ServerServices, service: ServiceInfo): Promise<void> {
    const ok = await this.confirm.ask({
      title: 'Stop service',
      message: `Stop "${service.name}" on ${server.serverName}? Dependent processes may be affected.`,
      confirmLabel: 'Stop',
      tone: 'danger'
    });
    if (ok) {
      this.runAction(app, server, service, 'stop');
    }
  }

  private runAction(
    app: InfraApp,
    server: ServerServices,
    service: ServiceInfo,
    action: 'start' | 'stop'
  ): void {
    // Optimistic transitional state while the agent works.
    this.patchService(app, server.serverId, service.id, {
      state: action === 'start' ? 'Starting' : 'Stopping'
    });
    this.markService(service.id, true);

    this.infra.serviceAction(app, server.serverId, service.id, action).subscribe({
      next: (res) => {
        const verb = action === 'start' ? 'Starting' : 'Stopping';
        if (res.success) {
          // Show the SERVICE NAME, never the underlying script path.
          this.notify(true, `${verb} ${service.name} service…`);
        } else {
          // Action reached the agent but failed — surface the reason so the user knows.
          this.notify(false, res.message ? `${service.name}: ${res.message}` : `Could not ${action} ${service.name} service.`);
        }
        // The action reply only says success/message — re-fetch this server's live status
        // so the badges reflect the real, settled state.
        this.infra.serverServices(app, server.serverId).subscribe({
          next: (fresh) => {
            this.patchServer(app, fresh);
            this.markService(service.id, false);
          },
          error: () => this.markService(service.id, false)
        });
      },
      error: () => {
        this.notify(false, `Could not ${action} "${service.name}" on ${server.serverName}.`);
        this.patchService(app, server.serverId, service.id, {
          state: action === 'start' ? 'Stopped' : 'Running'
        });
        this.recount(app);
        this.markService(service.id, false);
      }
    });
  }

  /** Show a transient success/failure banner (auto-dismisses). */
  private notify(ok: boolean, text: string): void {
    this.toast.set({ ok, text });
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
    }
    this.toastTimer = setTimeout(() => this.toast.set(null), 4500);
  }

  dismissToast(): void {
    this.toast.set(null);
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
    }
  }

  // --- Server info dialog ---------------------------------------------------
  openServerInfo(appLabel: string, server: ServerServices): void {
    this.infoServer.set({ appLabel, server });
  }

  closeServerInfo(): void {
    this.infoServer.set(null);
  }

  // --- By Status ------------------------------------------------------------
  toggleStatus(group: StatusGroup): void {
    group.expanded.update((v) => !v);
  }

  statusServices(category: ServiceCategory): AggService[] {
    const q = this.query().trim().toLowerCase();
    const out: AggService[] = [];
    for (const panel of this.panels) {
      const data = panel.data();
      if (!data) {
        continue;
      }
      for (const server of data.servers) {
        if (q && !server.serverName.toLowerCase().includes(q)) {
          continue;
        }
        for (const service of server.services) {
          if (serviceCategory(service.state) === category) {
            out.push({ app: panel.app, appLabel: panel.label, server, service });
          }
        }
      }
    }
    // Group by server OS (Windows → Linux → Share), then server, then service name.
    out.sort(
      (a, b) =>
        OS_RANK[a.server.os] - OS_RANK[b.server.os] ||
        a.server.serverName.localeCompare(b.server.serverName) ||
        a.service.name.localeCompare(b.service.name)
    );
    return out;
  }

  statusCount(category: ServiceCategory): number {
    return this.statusServices(category).length;
  }

  // --- Mutations ------------------------------------------------------------
  private patchService(
    app: InfraApp,
    serverId: string,
    serviceId: string,
    patch: Partial<Pick<ServiceInfo, 'state' | 'lastHeartbeat'>>
  ): void {
    const panel = this.panels.find((p) => p.app === app);
    const data = panel?.data();
    if (!panel || !data) {
      return;
    }
    panel.data.set({
      ...data,
      servers: data.servers.map((s) =>
        s.serverId !== serverId
          ? s
          : { ...s, services: s.services.map((v) => (v.id === serviceId ? { ...v, ...patch } : v)) }
      )
    });
  }

  private patchServer(app: InfraApp, updated: ServerServices): void {
    const panel = this.panels.find((p) => p.app === app);
    const data = panel?.data();
    if (!panel || !data) {
      return;
    }
    panel.data.set({
      ...data,
      servers: data.servers.map((s) => (s.serverId === updated.serverId ? updated : s))
    });
    this.recount(app);
  }

  private recount(app: InfraApp): void {
    const panel = this.panels.find((p) => p.app === app);
    const data = panel?.data();
    if (!panel || !data) {
      return;
    }
    let running = 0;
    let down = 0;
    let unaccessible = 0;
    for (const server of data.servers) {
      for (const svc of server.services) {
        const cat = serviceCategory(svc.state);
        cat === 'up' ? running++ : cat === 'unaccessible' ? unaccessible++ : down++;
      }
    }
    panel.data.set({ ...data, counts: { running, down, unaccessible } });
  }

  private markService(serviceId: string, on: boolean): void {
    const next = new Set(this.pendingServices());
    on ? next.add(serviceId) : next.delete(serviceId);
    this.pendingServices.set(next);
  }

  private markServer(serverId: string, on: boolean): void {
    const next = new Set(this.refreshingServers());
    on ? next.add(serverId) : next.delete(serverId);
    this.refreshingServers.set(next);
  }

  // --- Helpers --------------------------------------------------------------
  osLabel(server: ServerServices): string {
    return server.os === 'windows' ? 'WINDOWS' : server.os === 'linux' ? 'LINUX' : 'HOST';
  }

  stateText(state: ServiceState): string {
    return state;
  }

  readonly formatDateTime = formatDateTime;
  readonly timeAgo = timeAgo;

  trackPanel = (_: number, panel: ServicePanel): string => panel.app;
  trackServer = (_: number, server: ServerServices): string => server.serverId;
  trackService = (_: number, service: ServiceInfo): string => service.id;
  trackStatus = (_: number, group: StatusGroup): string => group.category;
  trackAgg = (_: number, item: AggService): string => `${item.app}:${item.service.id}`;
}
