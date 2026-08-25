import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { delay, Observable, of, throwError } from 'rxjs';

import { ConfigScope } from './api-endpoints';
import { environment } from '../../environments/environment';
import { LoginResponse } from './models';
import {
  MOCK_ACTIVITY,
  MOCK_DASHBOARD_STATS,
  MOCK_LOG_SERVERS,
  MOCK_MEMORY_TREND,
  mockColumnRetrieve,
  mockConfigTables,
  mockDirEntries,
  mockFileContent,
  mockFileProperties,
  mockMemory,
  mockTableData,
  isLogPathAllowed
} from './mock-data';

/**
 * Intercepts the OLS dummy endpoints and answers them with {@link mock-data}.
 *
 * Remove this interceptor from app.config.ts (or set `USE_MOCK = false`) once a
 * real backend is wired to {@link API_BASE_URL}. Anything it doesn't recognise
 * is passed through untouched.
 */
export const mockApiInterceptor: HttpInterceptorFn = (req, next) => {
  // Only calls to our configured backend are candidates for mocking; leave the rest alone.
  if (!req.url.startsWith(environment.apiBaseUrl)) {
    return next(req);
  }

  const url = new URL(req.url);
  const path = url.pathname;

  // Per-screen mock resolution: match the LONGEST `apiMocks` prefix this path starts with and
  // use its flag; anything unlisted falls back to the global `useMock`. `false` → let the call
  // through to the REAL backend. This is what makes one screen live-testable while the rest
  // stay on mock data (and vice-versa) — flip a single entry in environment.ts, no code change.
  const match = Object.keys(environment.apiMocks)
    .filter((prefix) => path.startsWith(prefix))
    .sort((a, b) => b.length - a.length)[0];
  const mockThis = match ? environment.apiMocks[match] : environment.useMock;
  if (!mockThis) {
    return next(req);
  }

  // Dev aid: the mock answers requests INSIDE Angular, so they never become real
  // network requests and won't show in DevTools → Network. Log every mock call to
  // the Console so it's obvious the app IS hitting its APIs (each refresh /
  // refresh-button re-fires them). With a real backend (USE_MOCK = false) this
  // interceptor bails out above and the calls appear in the Network tab as usual.
  // eslint-disable-next-line no-console
  console.debug(`[mock-api] ${req.method} ${path}${url.search}`);

  // --- Auth -----------------------------------------------------------------
  if (path === '/api/auth/login' && req.method === 'POST') {
    const body = (req.body ?? {}) as { username?: string; password?: string };
    if (!body.username || !body.password) {
      return respondError(400, 'Username and password are required');
    }
    const res: LoginResponse = {
      token: `mock-jwt.${btoa(body.username)}.${Date.now()}`,
      user: {
        username: body.username,
        displayName: titleCase(body.username),
        email: `${body.username}@ols.local`,
        role: 'Ops Admin'
      }
    };
    return respond(res);
  }
  if (path === '/api/auth/logout') {
    return respond({ success: true });
  }
  if (path === '/api/auth/roles') {
    // New contract: POST { username } → single-entry { ACCESS: ROLE }. Mapped from
    // devRoles so flipping the dev flags still exercises each access level; `devRoles.label`
    // sets the ROLE value so you can test the technical-action gate (OMT-TECHNICAL/BOTH vs
    // OMT-FUNCTIONAL). Kill / start / stop need ADMIN + OMT-TECHNICAL or OMT-BOTH.
    const dr = environment.devRoles;
    const label = dr.label;
    if (dr.is_admin) {
      return respond({ ADMIN: label || 'OMT-BOTH' });
    }
    if (dr.is_read) {
      return respond({ READ: label || 'OMT-READ' });
    }
    if (dr.is_salt) {
      return respond({ SALT: label || 'OMT-SALT' });
    }
    return respond({ NONE: '' });
  }

  // RBAC access snapshot (POST /api/access/me) — built from devRoles so flipping the dev flags
  // exercises each role. Mirrors backend access_api.build_snapshot; grants below demonstrate every
  // feature (opt-in server, config category + per-table write, per-screen write, section deny).
  if (path === '/api/access/me') {
    return respond(mockAccessSnapshot());
  }

  // --- User Management (ops-admin) — in-memory dev store (see umStore below) ----------------
  if (path === '/api/access/admin/catalogue') {
    umSeed();
    return respond({ status: 'success', catalogue: mockCatalogue() });
  }
  if (path === '/api/access/admin/user') {
    umSeed();
    const uid = String(((req.body ?? {}) as { uid?: string }).uid ?? '').trim();
    const active = !!uid && !uid.toUpperCase().includes('GHOST');   // type GHOST* to demo the not-found path
    if (!active) {
      return respond({
        status: 'success', grants: [], snapshot: null,
        lookup: { exists: false, active: false, username: uid, message: umNoUser(uid) }
      });
    }
    return respond({
      status: 'success',
      lookup: { exists: true, active: true, username: uid, display_name: titleCase(uid), email: `${uid.toLowerCase()}@ols.local` },
      grants: umStore.grants.get(uid.toUpperCase()) ?? [], snapshot: null
    });
  }
  if (path === '/api/access/admin/grant') {
    const g = (req.body ?? {}) as UmGrant;
    return respond({ status: 'success', grants: umUpsertGrant(g) });
  }
  if (path === '/api/access/admin/grant/delete') {
    const g = (req.body ?? {}) as UmGrant;
    return respond({ status: 'success', deleted: 1, grants: umDeleteGrant(g) });
  }
  if (path === '/api/access/admin/ops') {
    umSeed();
    const b = (req.body ?? {}) as { action?: string; uid?: string };
    const action = String(b.action ?? '').toLowerCase();
    const uid = String(b.uid ?? '').trim();
    const key = uid.toUpperCase();
    if (action === 'add') {
      if (!uid || key.includes('GHOST')) {
        return respondError(422, umNoUser(uid || 'that'));
      }
      umStore.ops.set(key, true);
    } else if (action === 'disable' && umStore.ops.has(key)) {
      umStore.ops.set(key, false);
    } else if (action === 'enable' && umStore.ops.has(key)) {
      umStore.ops.set(key, true);
    } else if (action === 'remove') {
      umStore.ops.delete(key);
    }
    const ops_admins = [...umStore.ops.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([u, active]) => ({ username: u, is_active: active ? 'Y' : 'N' }));
    return respond({ status: 'success', ops_admins });
  }

  // --- System / dashboard ---------------------------------------------------
  if (path === '/api/system/memory') {
    return respond(mockMemory());
  }
  if (path === '/api/system/database') {
    return respond({ name: `OLSDB_${environment.appEnv}01` });
  }
  if (path === '/api/dashboard/stats') {
    return respond(MOCK_DASHBOARD_STATS);
  }
  if (path === '/api/dashboard/activity') {
    return respond(MOCK_ACTIVITY);
  }
  if (path === '/api/dashboard/memory-trend') {
    return respond(MOCK_MEMORY_TREND);
  }

  // --- Log Analytics --------------------------------------------------------
  // Only /servers is DB-backed; browsing POSTs the selected `base` (from /servers)
  // + `path` and reads the filesystem — the backend confirms `path` sits inside `base`.
  if (path === '/api/log/servers') {
    return respond(MOCK_LOG_SERVERS);
  }
  if (path === '/api/log/dir' && req.method === 'POST') {
    const body = (req.body ?? {}) as { base?: string; path?: string };
    const p = body.path ?? '';
    if (!isLogPathAllowed(body.base ?? null, p)) {
      return respondError(400, 'Path is outside the server base log directory');
    }
    return respond({ entries: mockDirEntries(body.base ?? '', p) });
  }
  if (path === '/api/log/file' && req.method === 'POST') {
    const body = (req.body ?? {}) as { base?: string; path?: string };
    const p = body.path ?? '';
    if (!isLogPathAllowed(body.base ?? null, p)) {
      return respondError(400, 'Path is outside the server base log directory');
    }
    // Mock files are small → always the 'full' shape. The real backend switches to
    // 'window' for large files (see log_analytics_api.get_file).
    const content = mockFileContent(p);
    return respond({ mode: 'full', content, total_size: content.length });
  }
  if (path === '/api/log/file-properties' && req.method === 'POST') {
    const body = (req.body ?? {}) as { base?: string; path?: string };
    const p = body.path ?? '';
    if (!isLogPathAllowed(body.base ?? null, p)) {
      return respondError(400, 'Path is outside the server base log directory');
    }
    return respond(mockFileProperties(p));
  }

  // --- Config Ops Console ---------------------------------------------------
  // Catalogue is a POST now: { app_env, username } in the body (username stays out
  // of the URL). The mock returns canned data regardless of the body.
  const tablesMatch = path.match(/^\/api\/config\/(cib|group|retail)\/tables$/);
  if (tablesMatch && req.method === 'POST') {
    return respond(mockConfigTables(tablesMatch[1] as ConfigScope));
  }
  // Column detail (down-arrow expand) — { cols, rows } for one table.
  const columnMatch = path.match(/^\/api\/config\/(cib|group|retail)\/columnretrieve$/);
  if (columnMatch && req.method === 'POST') {
    const body = (req.body ?? {}) as { table_name?: string };
    if (!body.table_name) {
      return respondError(400, 'table_name is required');
    }
    return respond(mockColumnRetrieve(body.table_name));
  }
  const rollMatch = path.match(/^\/api\/config\/(cib|group|retail)\/roll$/);
  if (rollMatch && req.method === 'POST') {
    const body = (req.body ?? {}) as { table_name?: string; from?: string; to?: string };
    if (!body.table_name || !body.from || !body.to) {
      return respondError(400, 'table_name, from and to are required');
    }
    // Same shape the real API returns: { status, message }. The UI shows `message`.
    return respond({
      status: 'success',
      message: `Successfully rolled data for table ${body.table_name}.`
    });
  }

  // Table content (eye) — { table_name, is_cobdt, start_date, end_date, date_range }.
  // Dates are honoured only when is_cobdt = Y (null otherwise).
  const retrieveMatch = path.match(/^\/api\/config\/(cib|group|retail)\/retrieve$/);
  if (retrieveMatch && req.method === 'POST') {
    const body = (req.body ?? {}) as {
      table_name?: string;
      is_cobdt?: string;
      start_date?: string | null;
      end_date?: string | null;
      date_range?: boolean;
    };
    if (!body.table_name) {
      return respondError(400, 'table_name is required');
    }
    const isCob = String(body.is_cobdt ?? '').toUpperCase() === 'Y';
    return respond(
      mockTableData(body.table_name, {
        start: isCob ? body.start_date ?? undefined : undefined,
        end: isCob ? body.end_date ?? undefined : undefined,
        range: !!body.date_range
      })
    );
  }

  // INSERT: /table/{name}/rows  → { inserted_by, columns, rows: [[...]] } → { inserted }
  const insertMatch = path.match(/^\/api\/config\/(cib|group|retail)\/table\/[^/]+\/rows$/);
  if (insertMatch && req.method === 'POST') {
    const body = (req.body ?? {}) as { rows?: unknown[]; inserted_by?: string };
    if (hasErrSentinel(body)) {
      return respondOraError();
    }
    return respond({ success: true, inserted: body.rows?.length ?? 0 });
  }
  // UPDATE: /table/{name}/update  → { updated_by, updates: [{ <rowid>: {col:val} }] } → { updated }
  const updateMatch = path.match(/^\/api\/config\/(cib|group|retail)\/table\/[^/]+\/update$/);
  if (updateMatch && req.method === 'POST') {
    const body = (req.body ?? {}) as { updates?: unknown[]; updated_by?: string };
    if (hasErrSentinel(body)) {
      return respondOraError();
    }
    return respond({ success: true, updated: body.updates?.length ?? 0 });
  }
  // DELETE: /table/{name}/delete  → { deleted_by, rowids: [...] } → { deleted }
  const deleteMatch = path.match(/^\/api\/config\/(cib|group|retail)\/table\/[^/]+\/delete$/);
  if (deleteMatch && req.method === 'POST') {
    const body = (req.body ?? {}) as { rowids?: unknown[]; deleted_by?: string };
    // A null/blank rowid can't identify a row → a real backend errors; surface it.
    if (hasErrSentinel(body) || (body.rowids ?? []).some((r) => r == null || r === '')) {
      return respondOraError();
    }
    return respond({ success: true, deleted: body.rowids?.length ?? 0 });
  }

  // Infrastructure Pulse (Infra Health + Service Console) is served by the real
  // FastAPI backend — see `apiMocks` (/api/infra_health, /api/service_console → false).

  // Unknown mock route.
  return respondError(404, `No mock handler for ${req.method} ${path}`);
};

/**
 * Wrap a body in a 200 response with a realistic latency so loading states are
 * exercised the way they will be against the real (multi-second) backend.
 * Lower `MOCK_LATENCY_MS` for snappier local demos.
 */
const MOCK_LATENCY_MS = 900;

function respond<T>(body: T): Observable<HttpResponse<T>> {
  return of(new HttpResponse({ status: 200, body })).pipe(
    delay(MOCK_LATENCY_MS + Math.random() * 500)
  );
}

function respondError(status: number, message: string): Observable<never> {
  return throwError(
    () => new HttpErrorResponse({ status, statusText: message, error: { message } })
  ).pipe(delay(200)) as Observable<never>;
}

/**
 * Simulate a backend DB failure with the real `{ details }` shape (as the Oracle
 * backend returns), multi-line so the error popup's scroller is exercised.
 */
function respondOraError(): Observable<never> {
  const details =
    'ORA-20999: unique constraint (OLS.PK_CONFIG) violated\n' +
    'ORA-06512: at "OLS.PKG_CONFIG_OPS", line 142\n' +
    'ORA-06512: at "OLS.PKG_CONFIG_OPS", line 87\n' +
    'ORA-06512: at line 1';
  return throwError(
    () => new HttpErrorResponse({ status: 400, statusText: 'Bad Request', error: { details } })
  ).pipe(delay(400)) as Observable<never>;
}

/** DEV test hook: a submitted value of "ERR" (any case) triggers {@link respondOraError}. */
function hasErrSentinel(body: unknown): boolean {
  try {
    return JSON.stringify(body ?? '').toUpperCase().includes('"ERR"');
  } catch {
    return false;
  }
}

function titleCase(value: string): string {
  return value.replace(/(^|[._-])(\w)/g, (_, sep, ch) => (sep ? ' ' : '') + ch.toUpperCase()).trim();
}

/**
 * Dev access snapshot for `POST /api/access/me`, built from `environment.devRoles` so toggling the
 * dev flags exercises ADMIN / READ / SALT. Shape matches backend `access_api.build_snapshot`.
 * The READ grants below intentionally show off every gate (opt-in server, config category + a
 * per-table WRITE, per-screen WRITE, and a denied section) so the whole system is demoable in dev.
 */
function mockAccessSnapshot(): Record<string, unknown> {
  const dr = environment.devRoles;
  const role = dr.is_admin ? 'ADMIN' : dr.is_read ? 'READ' : dr.is_salt ? 'SALT' : 'NONE';
  const base = {
    status: 'success', active: role !== 'NONE', username: environment.username,
    display_name: titleCase(environment.username), email: `${environment.username.toLowerCase()}@example.com`,
    role, app_env: environment.appEnv,
    // Ops-admin gate (ols_ops_access) is INDEPENDENT of role; in dev the ADMIN role stands in for it.
    is_ops_admin: role === 'ADMIN'
  };
  const noInfra = { all_apps: false, apps: [] as string[], denied_apps: [] as string[] };
  const noSvc = { all_apps: false, apps: [] as string[], denied_apps: [] as string[] };
  const noOracle = { all_dbs: false, all_level: 'READ', dbs: {} as Record<string, string>, denied_dbs: [] as string[] };
  if (role === 'ADMIN') {
    return {
      ...base,
      screens: ['home', 'log_analytics', 'config_ops_console', 'infra_health', 'service_console', 'oracle_command_center'],
      write_screens: ['service_console', 'oracle_command_center'],
      config: { scopes: ['group', 'cib', 'retail'], all: true, all_level: 'WRITE', category_grants: [], table_grants: [] },
      servers: ['*'], all_servers: true, denied_servers: [],
      infra: { all_apps: true, apps: [], denied_apps: [] }, service: { all_apps: true, apps: [], denied_apps: [] },
      oracle: { all_dbs: true, all_level: 'WRITE', dbs: {}, denied_dbs: [] },
      denied_sections: []
    };
  }
  if (role === 'SALT') {
    return {
      ...base,
      screens: ['home', 'config_ops_console'], write_screens: [],
      config: {
        scopes: ['cib'], all: false, all_level: 'READ', category_grants: [],
        table_grants: [
          { scope: 'cib', table: 'CIB_LIMIT_CONFIG', level: 'READ' },
          { scope: 'cib', table: 'CIB_FX_RATES', level: 'READ' }
        ]
      },
      servers: [], all_servers: false, denied_servers: [], infra: noInfra, service: noSvc, oracle: noOracle, denied_sections: []
    };
  }
  if (role === 'NONE') {
    return {
      ...base, screens: [], write_screens: [],
      config: { scopes: [], all: false, all_level: 'READ', category_grants: [], table_grants: [] },
      servers: [], all_servers: false, denied_servers: [], infra: noInfra, service: noSvc, oracle: noOracle, denied_sections: []
    };
  }
  // READ (default demo) — OPT-IN + per-app/per-DB: Log Analytics (a server), Config Ops (Group),
  // Service Console (write, only OLS_GROUP+OLS_CIB apps), Infra Health only OLS_GROUP, and the OCC
  // with WRITE on GROUP + READ on CIB BATCH; SQL Intelligence denied. Home shows (has features).
  return {
    ...base,
    screens: ['home', 'log_analytics', 'config_ops_console', 'infra_health', 'service_console', 'oracle_command_center'],
    write_screens: ['service_console'],
    config: {
      scopes: ['group'], all: false, all_level: 'READ',
      category_grants: [{ scope: 'group', category: 'OMT-FUNCTIONAL', level: 'READ' }],
      table_grants: [{ scope: 'group', table: 'GRP_COST_CENTER', level: 'WRITE' }]
    },
    servers: ['eurv15'], all_servers: false, denied_servers: [],
    infra: { all_apps: false, apps: ['OLS_GROUP'], denied_apps: [] },
    service: { all_apps: false, apps: ['OLS_GROUP', 'OLS_CIB'], denied_apps: [] },
    oracle: { all_dbs: false, all_level: 'READ', dbs: { group: 'WRITE', cib_batch: 'READ' }, denied_dbs: [] },
    denied_sections: [
      { screen: 'oracle_command_center', key: 'sql_intelligence' },              // hidden on every DB
      { screen: 'oracle_command_center', key: 'idxhealth', db: 'cib_batch' }      // hidden only on CIB BATCH
    ]
  };
}

// --- User Management dev store ----------------------------------------------------------------
// A tiny in-memory store so the ops-admin screen is fully interactive in dev (grant/revoke, manage
// ops-admins) without a backend. Seeded once; type a UID containing "GHOST" to exercise the
// "not an OLS user" path. Mirrors the /api/access/admin/* contract in access_api.py.

interface UmGrant {
  username: string; resource_type: string; resource_scope: string;
  resource_key: string; access_level: string; app_env: string;
}
const umNoUser = (uid: string) =>
  `The ${uid} user does not exist in OLS. Please submit the appropriate provisioning request before proceeding.`;
const umStore = { grants: new Map<string, UmGrant[]>(), ops: new Map<string, boolean>() };
let umSeeded = false;

function umSeed(): void {
  if (umSeeded) {
    return;
  }
  umSeeded = true;
  umStore.ops.set(environment.username.toUpperCase(), true);
  umStore.ops.set('DBAUSER', true);
  umStore.grants.set('JDOE', [
    { username: 'JDOE', resource_type: 'SERVER', resource_scope: 'log_analytics', resource_key: 'eur17', access_level: 'READ', app_env: 'PROD' },
    { username: 'JDOE', resource_type: 'APP', resource_scope: 'infra_health', resource_key: 'OLS_GROUP', access_level: 'READ', app_env: 'PROD' },
    { username: 'JDOE', resource_type: 'DB', resource_scope: 'oracle_command_center', resource_key: 'group', access_level: 'WRITE', app_env: 'PROD' },
    { username: 'JDOE', resource_type: 'SECTION', resource_scope: 'oracle_command_center', resource_key: 'sql_intelligence', access_level: 'DENY', app_env: 'PROD' }
  ]);
}

function umKeyEq(a: UmGrant, b: UmGrant): boolean {
  return a.resource_type === b.resource_type && a.resource_scope === b.resource_scope &&
    (a.resource_key || '').toUpperCase() === (b.resource_key || '').toUpperCase() && a.app_env === b.app_env;
}

function umUpsertGrant(g: UmGrant): UmGrant[] {
  umSeed();
  const k = (g.username || '').toUpperCase();
  const list = umStore.grants.get(k) ?? [];
  const idx = list.findIndex((x) => umKeyEq(x, g));
  if (idx >= 0) {
    list[idx] = g;
  } else {
    list.push(g);
  }
  umStore.grants.set(k, list);
  return list;
}

function umDeleteGrant(g: UmGrant): UmGrant[] {
  const k = (g.username || '').toUpperCase();
  const list = (umStore.grants.get(k) ?? []).filter((x) => !umKeyEq(x, g));
  umStore.grants.set(k, list);
  return list;
}

function mockCatalogue(): Record<string, unknown> {
  return {
    screens: [
      { key: 'log_analytics', label: 'Log Analytics', write_capable: false },
      { key: 'infra_health', label: 'Infrastructure Health', write_capable: false },
      { key: 'service_console', label: 'Service Console', write_capable: true },
      { key: 'oracle_command_center', label: 'Oracle Command Center', write_capable: true }
    ],
    config: {
      scopes: [{ key: 'group', label: 'OLS GROUP' }, { key: 'cib', label: 'OLS CIB' }, { key: 'retail', label: 'OLS RETAIL' }],
      categories: [
        { key: 'OMT-FUNCTIONAL', label: 'Functional tables' },
        { key: 'OMT-TECHNICAL', label: 'Technical tables' },
        { key: 'OMT-BOTH', label: 'All tables (both)' }
      ],
      tables: []
    },
    servers: ['eur17', 'eur34', 'eurv15', 'eurv145'],
    apps: [
      { key: 'OLS_GROUP', label: 'OLS GROUP' }, { key: 'OLS_CIB', label: 'OLS CIB' },
      { key: 'OLS_RETAIL', label: 'OLS RETAIL' }, { key: 'POSEIDON', label: 'POSEIDON' }
    ],
    databases: [
      { key: 'group', label: 'OLS GROUP' }, { key: 'cib_batch', label: 'OLS CIB Batch' },
      { key: 'cib_reporting', label: 'OLS CIB Reporting' }, { key: 'retail_batch', label: 'OLS RETAIL Batch' },
      { key: 'retail_reporting', label: 'OLS RETAIL Reporting' }
    ],
    sections: [
      { key: 'space', label: 'Database Storage' }, { key: 'top', label: 'Top Table Storage' },
      { key: 'topidx', label: 'Top Index Storage' }, { key: 'idxhealth', label: 'Index Health' },
      { key: 'locks', label: 'Critical Locks' }, { key: 'blocking', label: 'Blocking Sessions' },
      { key: 'temp', label: 'Temp Tablespace' }, { key: 'sessions', label: 'Sessions Detail' },
      { key: 'sql_intelligence', label: 'SQL Intelligence' }
    ],
    app_envs: ['PROD', 'STG', 'DEV', '*']
  };
}
