import { computed, inject, Injectable, signal } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map, shareReplay, tap } from 'rxjs/operators';

import { ApiDataService } from '../shared/api-data.service';
import { API, apiEnv } from '../shared/api-endpoints';
import { environment } from '../../environments/environment';
import { AccessSnapshot, UserRoles } from '../shared/models';
import { USER_KEY } from './sso-auth.service';
import { ALL_SCREENS, SCREEN_ROUTES, ScreenKey } from './rbac.config';

/** Effective access level of a config table for a user. */
export type TableAccess = 'none' | 'read' | 'write';

const EMPTY: AccessSnapshot = {
  active: false, username: '', display_name: '', email: '', role: 'NONE', app_env: '',
  screens: [], write_screens: [],
  config: { scopes: [], all: false, all_level: 'READ', category_grants: [], table_grants: [] },
  servers: [], all_servers: false, denied_servers: [],
  infra: { all_apps: false, apps: [], denied_apps: [] },
  service: { all_apps: false, apps: [], denied_apps: [] },
  oracle: { all_dbs: false, all_level: 'READ', dbs: {}, denied_dbs: [] },
  denied_sections: [], is_ops_admin: false, can_sql: false
};

/** Screens always resolvable (external help + login/error routes). Home is NOT here — it's opt-in
 *  now, visible only when the user has at least one granted feature. */
const ALWAYS_VIEW = new Set<string>(['docs', 'extras']);

/**
 * Central RBAC authority. Loads ONE resolved access snapshot (`POST /api/access/me`, assembled
 * server-side from `ols_users` + `ols_app_access`) and answers every gating question the UI asks:
 * screen view/write, config sub-screen (scope) + per-table access, Log Analytics server visibility,
 * and per-section allow/deny. See RBAC_DESIGN.md for the model.
 *
 * Rules: ADMIN → everything. READ → all screens read; servers/config tables opt-in via grants;
 * write only where granted. SALT → Config-Ops-only persona (Home + granted config scopes).
 * Fails **closed** — a failed/empty load means no access.
 */
@Injectable({ providedIn: 'root' })
export class RbacService {
  private readonly api = inject(ApiDataService);

  /** The resolved snapshot (the single source of truth). */
  readonly snapshot = signal<AccessSnapshot>(EMPTY);

  /** Back-compat role flags derived from the snapshot role. */
  readonly roles = computed<UserRoles>(() => {
    const r = this.snapshot().role;
    return { is_admin: r === 'ADMIN', is_read: r === 'READ', is_salt: r === 'SALT' };
  });
  /** Access level ("ADMIN" / "READ" / "SALT") for the profile card. */
  readonly access = computed(() => (this.snapshot().active ? this.snapshot().role : ''));
  /** Combined label for the profile card. */
  readonly roleLabel = computed(() => this.access());

  private snap$?: Observable<AccessSnapshot>;

  /** Fetch the access snapshot once (cached). Call before the first guard/nav evaluation. */
  ensureLoaded(): Observable<AccessSnapshot> {
    if (!this.snap$) {
      this.snap$ = this.api
        .post<AccessSnapshot>(API.access.me, {
          username: this.currentUsername(),
          app_env: apiEnv(environment.appEnv)
        })
        .pipe(
          map((s) => s ?? EMPTY),
          catchError(() => of(EMPTY)),        // fail closed → no access
          tap((s) => this.snapshot.set(s)),
          shareReplay(1)
        );
    }
    return this.snap$;
  }

  /** Drop the cached snapshot (on logout). */
  reset(): void {
    this.snap$ = undefined;
    this.snapshot.set(EMPTY);
  }

  // --- Screen tier -----------------------------------------------------------

  /** Can the user see this screen? */
  canView(screen: ScreenKey): boolean {
    const s = this.snapshot();
    if (!s.active) {
      return false;
    }
    // User Management has its OWN super-exclusive gate (`ols_ops_access`) — it is NOT part of the
    // normal opt-in set, and even an ADMIN cannot see it unless listed. Check it before anything else.
    if (screen === 'user_management') {
      return this.isOpsAdmin();
    }
    if (ALWAYS_VIEW.has(screen)) {
      return true;
    }
    if (s.role === 'ADMIN') {
      return true;
    }
    return s.screens.includes(screen);
  }

  /** Is the user an ops-admin (may open User Management + hand out grants)? Gated solely by the
   *  `ols_ops_access` table — independent of ADMIN/READ/SALT. */
  isOpsAdmin(): boolean {
    const s = this.snapshot();
    return s.active && !!s.is_ops_admin;
  }

  /** May the user use S-Studio (the Config Ops SQL console)? Gated by `ols_ops_access.can_sql`,
   *  assigned specifically per user — even other ops-admins are false unless granted. */
  canSql(): boolean {
    const s = this.snapshot();
    return s.active && !!s.can_sql;
  }

  /** Can the user take write actions on this screen? (OCC kill, Service start/stop.) */
  canWrite(screen: ScreenKey): boolean {
    const s = this.snapshot();
    if (!s.active) {
      return false;
    }
    if (s.role === 'ADMIN') {
      return true;
    }
    return s.write_screens.includes(screen);
  }

  /** Any access at all? (Active AND at least one granted screen.) False → No-Access page with the
   *  "contact OLS Team" message. Opt-in: a valid login with no features assigned lands here. */
  hasAnyAccess(): boolean {
    const s = this.snapshot();
    return s.active && s.screens.length > 0;
  }

  /** First screen the user is allowed to open (for redirects). */
  firstAllowedRoute(): string | null {
    const screen = ALL_SCREENS.find((s) => this.canView(s));
    return screen ? SCREEN_ROUTES[screen] : null;
  }

  // --- Config Ops: scope (group/cib/retail) + per-table --------------------

  /** Is a Config Ops sub-screen (scope) visible? */
  configScopeVisible(scope: string): boolean {
    const s = this.snapshot();
    if (!s.active) {
      return false;
    }
    if (s.role === 'ADMIN' || s.config.all) {
      return true;
    }
    return s.config.scopes.includes(scope);
  }

  /**
   * Effective access to one config table — resolves per-table grants (which WIN, incl. DENY) over
   * category grants. `tableCategory` (OMT-TECHNICAL / OMT-FUNCTIONAL / OMT-BOTH) matches category
   * grants: granting OMT-BOTH = all; OMT-TECHNICAL/FUNCTIONAL also include OMT-BOTH tables.
   */
  configTableAccess(scope: string, tableName: string, tableCategory?: string): TableAccess {
    const s = this.snapshot();
    if (!s.active) {
      return 'none';
    }
    if (s.role === 'ADMIN') {
      return 'write';
    }
    if (s.config.all) {
      return s.config.all_level === 'WRITE' ? 'write' : 'read';
    }
    const name = (tableName || '').toLowerCase();
    // Per-table override wins (including DENY).
    const t = s.config.table_grants.find((g) => g.scope === scope && (g.table || '').toLowerCase() === name);
    if (t) {
      return t.level === 'DENY' ? 'none' : t.level === 'WRITE' ? 'write' : 'read';
    }
    // Category grants.
    const cat = (tableCategory || '').toUpperCase();
    let level: TableAccess = 'none';
    for (const c of s.config.category_grants) {
      if (c.scope !== scope || !categoryMatches(c.category, cat)) {
        continue;
      }
      if (c.level === 'DENY') {
        return 'none';
      }
      level = c.level === 'WRITE' ? 'write' : level === 'write' ? 'write' : 'read';
    }
    return level;
  }

  /** Convenience: is a config table writable? */
  canWriteTable(scope: string, tableName: string, tableCategory?: string): boolean {
    return this.configTableAccess(scope, tableName, tableCategory) === 'write';
  }

  /** Does the user have write on ANY table in this scope? (Gates scope-level / catalogue controls;
   *  the per-table modal buttons still use {@link canWriteTable}.) */
  configScopeWritable(scope: string): boolean {
    const s = this.snapshot();
    if (!s.active) {
      return false;
    }
    if (s.role === 'ADMIN') {
      return true;
    }
    if (s.config.all) {
      return s.config.all_level === 'WRITE';
    }
    return (
      s.config.table_grants.some((g) => g.scope === scope && g.level === 'WRITE') ||
      s.config.category_grants.some((g) => g.scope === scope && g.level === 'WRITE')
    );
  }

  // --- Log Analytics servers -------------------------------------------------

  /** Is a Log Analytics server visible to this user? A `denied_servers` entry wins over an
   *  `all_servers` grant, so "all servers EXCEPT this one" is expressible. */
  serverAllowed(serverName: string): boolean {
    const s = this.snapshot();
    if (!s.active) {
      return false;
    }
    if (s.role === 'ADMIN') {
      return true;
    }
    if ((s.denied_servers ?? []).includes(serverName)) {
      return false;
    }
    if (s.all_servers) {
      return true;
    }
    return s.servers.includes(serverName);
  }

  // --- Infra Health apps + OCC databases -------------------------------------

  /** Is an Infrastructure Health app (OLS_GROUP / OLS_CIB / …) visible to this user? A
   *  `denied_apps` entry wins over an `all_apps` grant ("all apps EXCEPT this one"). */
  infraAppAllowed(app: string): boolean {
    const s = this.snapshot();
    if (!s.active) {
      return false;
    }
    if (s.role === 'ADMIN') {
      return true;
    }
    const a = (app || '').toUpperCase();
    if ((s.infra.denied_apps ?? []).includes(a)) {
      return false;
    }
    return s.infra.all_apps || s.infra.apps.includes(a);
  }

  /** Is a Service Console app's services visible to this user? (`denied_apps` subtracts.) */
  serviceAppAllowed(app: string): boolean {
    const s = this.snapshot();
    if (!s.active) {
      return false;
    }
    if (s.role === 'ADMIN') {
      return true;
    }
    const a = (app || '').toUpperCase();
    if ((s.service.denied_apps ?? []).includes(a)) {
      return false;
    }
    return s.service.all_apps || s.service.apps.includes(a);
  }

  /** Is an OCC database (tab) visible to this user? (`denied_dbs` subtracts from an all-DBs grant.) */
  dbAllowed(db: string): boolean {
    const s = this.snapshot();
    if (!s.active) {
      return false;
    }
    if (s.role === 'ADMIN') {
      return true;
    }
    const k = (db || '').toLowerCase();
    if ((s.oracle.denied_dbs ?? []).includes(k)) {
      return false;
    }
    return s.oracle.all_dbs || k in s.oracle.dbs;
  }

  /** May the user WRITE (kill / apply-fix) on this OCC database? (A denied DB is never writable.) */
  dbWritable(db: string): boolean {
    const s = this.snapshot();
    if (!s.active) {
      return false;
    }
    if (s.role === 'ADMIN') {
      return true;
    }
    const k = (db || '').toLowerCase();
    if ((s.oracle.denied_dbs ?? []).includes(k)) {
      return false;
    }
    if (s.oracle.all_dbs) {
      return s.oracle.all_level === 'WRITE';
    }
    return s.oracle.dbs[k] === 'WRITE';
  }

  // --- Sections (e.g. hide OCC SQL Intelligence) -----------------------------

  /** Is a section within a screen allowed? (ADMIN always; others unless explicitly denied.) A deny
   *  with no `db` hides the section everywhere; a deny with a `db` hides it only on that OCC DB
   *  (pass the active `db` to honour per-DB section grants). */
  sectionAllowed(screen: string, key: string, db?: string): boolean {
    const s = this.snapshot();
    if (!s.active) {
      return false;
    }
    if (s.role === 'ADMIN') {
      return true;
    }
    const cur = (db || '').toLowerCase();
    return !s.denied_sections.some((d) =>
      d.screen === screen && d.key === key && (!d.db || d.db.toLowerCase() === cur));
  }

  /** UID of the signed-in user for the access payload (falls back to the demo user). */
  private currentUsername(): string {
    try {
      const raw = localStorage.getItem(USER_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { username?: string };
        if (parsed?.username) {
          return parsed.username;
        }
      }
    } catch {
      /* ignore malformed storage */
    }
    return environment.username;
  }
}

/** Does a category GRANT cover a table's category? OMT-BOTH grant = all; TECHNICAL/FUNCTIONAL also cover BOTH tables. */
function categoryMatches(grantCategory: string, tableCategory: string): boolean {
  const g = (grantCategory || '').toUpperCase();
  const t = (tableCategory || '').toUpperCase();
  if (g === 'OMT-BOTH' || g === '*') {
    return true;
  }
  if (g === 'OMT-TECHNICAL') {
    return t === 'OMT-TECHNICAL' || t === 'OMT-BOTH';
  }
  if (g === 'OMT-FUNCTIONAL') {
    return t === 'OMT-FUNCTIONAL' || t === 'OMT-BOTH';
  }
  return g === t;
}
