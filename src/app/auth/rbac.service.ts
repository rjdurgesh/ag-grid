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
  denied_sections: [], denied_screens: [], is_ops_admin: false, can_sql: false, sql_scopes: []
};

/** Screens always resolvable (login/error routes only). Docs is NOT here anymore — both Docs screens
 *  are grant-driven now (a user with no docs grant sees no Docs at all; ADMIN sees both). */
const ALWAYS_VIEW = new Set<string>(['extras']);

/**
 * Central RBAC authority. Loads ONE resolved access snapshot (`POST /api/access/me`, assembled
 * server-side from `ols_users` + `ols_app_access`) and answers every gating question the UI asks:
 * screen view/write, config sub-screen (scope) + per-table access, Log Analytics server visibility,
 * and per-section allow/deny. See RBAC_DESIGN.md for the model.
 *
 * Model B (grants-only): the `ols_users` role (ADMIN/READ/SALT) is metadata, NOT authorization. Every
 * active user gets the default screens (Home, Log Analytics, Infra Health); everything else — including
 * full/"admin" access via a full-access wildcard grant — comes from `ols_app_access`.
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
    // A SCREEN/<screen>/*/DENY grant is ABSOLUTE — it hides the screen even for an ADMIN, the
    // full-access wildcard, an ops-admin or an ungated default. Checked before everything else.
    if ((s.denied_screens ?? []).includes(screen)) {
      return false;
    }
    // User Management is split into two tabs with DIFFERENT gates (see the component):
    //  • "User access" (grant/revoke) = an explicit SCREEN/user_management grant (the ADMIN "include
    //    User Management" toggle writes it) OR an ops-admin. The base ADMIN role no longer implies it.
    //  • "Manage access" (the ops-admin table) stays exclusive to `ols_ops_access` → `isOpsAdmin()`.
    if (screen === 'user_management') {
      return s.screens.includes('user_management') || this.isOpsAdmin();
    }
    // Log Analytics + Infrastructure Health are visible to EVERY active user (ungated — see
    // RBAC_DESIGN §2), unless explicitly denied above.
    if (screen === 'log_analytics' || screen === 'infra_health') {
      return true;
    }
    if (ALWAYS_VIEW.has(screen)) {
      return true;
    }
    // Model B (grants-only): every other screen is opt-in — visible only when a grant put it in
    // `screens` (a full-access `SCREEN/*/*` grant fills them all). The ols_users role never grants.
    return s.screens.includes(screen);
  }

  /** May the user see the Technical Guide? Grant-driven: ADMIN (all docs) or an explicit
   *  `SCREEN / docs_technical` grant. The server re-filters the catalogue too — this is the cosmetic
   *  hide (drives the tab), never the security boundary. */
  technicalDocsVisible(): boolean {
    return this.canView('docs_technical');
  }

  /** Is the user an ops-admin (may open User Management + hand out grants)? Gated solely by the
   *  `ols_ops_access` table — independent of ADMIN/READ/SALT. */
  isOpsAdmin(): boolean {
    const s = this.snapshot();
    return s.active && !!s.is_ops_admin;
  }

  /** May the user use S-Studio in a given config scope? Gated per-scope by `ols_ops_access`
   *  (`sql_scopes`), assigned only to full super admins. Falls back to the legacy global `can_sql`
   *  flag when `sql_scopes` is absent (older snapshot / dev mock), so nothing breaks in transition. */
  canSql(scope: string): boolean {
    const s = this.snapshot();
    if (!s.active) {
      return false;
    }
    if (s.sql_scopes !== undefined) {
      return s.sql_scopes.includes(scope);
    }
    return !!s.can_sql;   // back-compat: no per-scope info → the old global flag
  }

  /** Can the user take write actions on this screen? (OCC kill, Service start/stop.) */
  canWrite(screen: ScreenKey): boolean {
    const s = this.snapshot();
    if (!s.active) {
      return false;
    }
    return s.write_screens.includes(screen);
  }

  /** Any access at all? (Active AND at least one feature — a granted screen, User Management, or
   *  S-Studio in any scope.) False → No-Access page with the "contact OLS Team" message. */
  hasAnyAccess(): boolean {
    const s = this.snapshot();
    const anySql = (s.sql_scopes?.length ?? 0) > 0 || !!s.can_sql;
    return s.active && (s.screens.length > 0 || this.isOpsAdmin() || anySql);
  }

  /** First screen the user is allowed to open (for redirects). */
  firstAllowedRoute(): string | null {
    const screen = ALL_SCREENS.find((s) => this.canView(s));
    return screen ? SCREEN_ROUTES[screen] : null;
  }

  // --- Config Ops: scope (group/cib/retail) + per-table --------------------

  /** Is a Config Ops sub-screen (scope) visible? Strictly follows config grants, so a scope the user
   *  has no grant in (e.g. RETAIL) is never shown. S-Studio for a scope therefore needs a config
   *  grant in that scope (it lives inside the scope screen). */
  configScopeVisible(scope: string): boolean {
    const s = this.snapshot();
    if (!s.active) {
      return false;
    }
    if (s.config.all) {   // a full-access wildcard grant sets config.all
      return true;
    }
    return s.config.scopes.includes(scope);
  }

  /** Is the Regression tab granted for this scope? Driven by an `ols_app_access` grant
   *  (`config.regression`; a full-access wildcard fills all scopes). The DEV/STG-only gate is at the
   *  screen. Model B: no role shortcut. */
  regressionVisible(scope: string): boolean {
    const s = this.snapshot();
    if (!s.active) {
      return false;
    }
    return (s.config.regression ?? []).includes(scope);
  }

  /** Is the Reconciliation tab granted for this scope? Same model as {@link regressionVisible} but a
   *  separate grant (`config.reconciliation`) — Group gets it too. DEV/STG gate at screen. */
  reconciliationVisible(scope: string): boolean {
    const s = this.snapshot();
    if (!s.active) {
      return false;
    }
    return (s.config.reconciliation ?? []).includes(scope);
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
    if (s.config.all) {   // full-access wildcard → config.all + all_level
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
    if (s.config.all) {   // full-access wildcard → config.all + all_level
      return s.config.all_level === 'WRITE';
    }
    return (
      s.config.table_grants.some((g) => g.scope === scope && g.level === 'WRITE') ||
      s.config.category_grants.some((g) => g.scope === scope && g.level === 'WRITE')
    );
  }

  // --- Log Analytics servers -------------------------------------------------

  /** Log Analytics is ungated (Point 3) — every active user sees every server. */
  serverAllowed(_serverName: string): boolean {
    return this.snapshot().active;
  }

  // --- Infra Health apps + OCC databases -------------------------------------

  /** Infrastructure Health is ungated (Point 3) — every active user sees every app. */
  infraAppAllowed(_app: string): boolean {
    return this.snapshot().active;
  }

  /** Is a Service Console app's services visible to this user? (`denied_apps` subtracts.) */
  serviceAppAllowed(app: string): boolean {
    const s = this.snapshot();
    if (!s.active) {
      return false;
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

  /** Is a section within a screen allowed? (Allowed unless explicitly denied.) A deny with no `db`
   *  hides the section everywhere; a deny with a `db` hides it only on that OCC DB (pass the active
   *  `db` to honour per-DB section grants). */
  sectionAllowed(screen: string, key: string, db?: string): boolean {
    const s = this.snapshot();
    if (!s.active) {
      return false;
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

