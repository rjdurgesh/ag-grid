import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { delay, Observable, of, throwError } from 'rxjs';

import { ConfigScope } from './api-endpoints';
import { environment } from '../../environments/environment';
import { DocEntry, LoginResponse } from './models';
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
  // Resolve the request path whether the URL is ABSOLUTE (local dev: http://localhost:8000/api/…)
  // or RELATIVE (deployed: /api/… same-origin, proxied by ui_server). Only /api/* calls are ever
  // candidates for mocking; everything else passes straight through.
  const origin = (typeof window !== 'undefined' && window.location) ? window.location.origin : 'http://localhost';
  let url: URL;
  try {
    url = new URL(req.url, origin);
  } catch {
    return next(req);
  }
  const path = url.pathname;
  if (!path.startsWith('/api/')) {
    return next(req);
  }

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
  // Dev aid: every per-table Config Ops call carries `db_source` (the catalogue row's physical DB) so
  // the backend routes to the right batch/reporting DB — log it so routing is visible while developing.
  if (path.startsWith('/api/config/')) {
    const ds = (req.body as { db_source?: string } | null)?.db_source;
    if (ds !== undefined) {
      // eslint-disable-next-line no-console
      console.debug(`[mock-api]   ↳ db_source = ${ds || '(empty)'}`);
    }
  }

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
    const rec = umStore.ops.get(key);
    if (action === 'add') {
      if (!uid || key.includes('GHOST')) {
        return respondError(422, umNoUser(uid || 'that'));
      }
      umStore.ops.set(key, { active: true, users: true, sql: rec?.sql ?? false });
    } else if (action === 'remove') {
      umStore.ops.delete(key);
    } else if (rec) {
      if (action === 'disable') { rec.active = false; }
      else if (action === 'enable') { rec.active = true; }
      else if (action === 'users_on') { rec.users = true; }
      else if (action === 'users_off') { rec.users = false; }
      else if (action === 'sql_on') { rec.sql = true; }
      else if (action === 'sql_off') { rec.sql = false; }
    }
    const ops_admins = [...umStore.ops.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([u, v]) => ({ username: u, is_active: v.active ? 'Y' : 'N', can_users: v.users ? 'Y' : 'N', can_sql: v.sql ? 'Y' : 'N' }));
    return respond({ status: 'success', ops_admins });
  }

  // --- S-Studio (Config Ops SQL console) ---------------------------------------------------
  if (path === '/api/sql_studio/databases') {
    const scope = String(((req.body ?? {}) as { scope?: string }).scope ?? '').toLowerCase();
    return respond({ status: 'success', databases: mockSqlDatabases(scope) });
  }
  if (path === '/api/sql_studio/execute') {
    const body = (req.body ?? {}) as { sql?: string };
    return respond({ status: 'success', result: mockSqlExecute(body.sql ?? '') });
  }

  // --- Regression (CIB, DEV/STG) — in-memory run so gating/force work in dev ----------------
  if (path.startsWith('/api/regression/')) {
    return respond(mockRegression(path, (req.body ?? {}) as Record<string, unknown>));
  }

  // --- Documentation Center -------------------------------------------------
  // Catalogue is RBAC-filtered by audience (technical docs only for ADMIN / ops-admin / S-Studio);
  // content is re-checked the same way (UI hiding is never the boundary — mirrors docs_api.py).
  if (path === '/api/docs/catalog') {
    return respond({ status: 'success', entries: mockDocsCatalog() });
  }
  if (path === '/api/docs/content') {
    const id = String(((req.body ?? {}) as { id?: string }).id ?? '');
    const doc = mockDocContent(id);
    if (!doc) {
      return respondError(404, `Document '${id}' not found or not permitted.`);
    }
    return respond({ status: 'success', doc });
  }

  // --- System / dashboard ---------------------------------------------------
  if (path === '/api/system/memory') {
    return respond(mockMemory());
  }
  if (path === '/api/system/database') {
    return respond({ name: `OLSDB_${environment.appEnv}01` });
  }
  if (path === '/api/system/version') {
    return respond({ version: '1.0.0' });
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
    const body = (req.body ?? {}) as { table_name?: string; source_date?: string; target_dates?: string[] };
    if (!body.table_name || !body.source_date || !(body.target_dates?.length)) {
      return respondError(400, 'table_name, source_date and target_dates are required');
    }
    // Structured per-date result: { source_date, source_count, targets:[{date,status,count,error?}] }.
    // Demos: a target > 2026-08-31 is "skipped" with a multi-line DB error; a date ending -27 rolls
    // DOUBLE rows and one ending -29 rolls ZERO — both success-with-wrong-count (the ⚠ mismatch path);
    // everything else matches the source. Mirrors the proc's per-date OUT lists (errmsg/rows/src_rows).
    const SRC = 100;
    const targets = body.target_dates.map((d) => {
      if (d > '2026-08-31') {
        return { date: d, status: 'failed', count: null,
          error: `ORA-14400: inserted partition key does not map to any partition (no partition for ${d})\n`
            + `ORA-06512: at "OLS_UTIL.ROLL_STATIC_DATA", line 42\n`
            + `ORA-06512: at "OLS_ROLL.ROLLTABLE", line 118\n`
            + `ORA-06512: at line 1` };
      }
      const count = d.endsWith('-27') ? SRC * 2 : d.endsWith('-29') ? 0 : SRC;
      return { date: d, status: 'success', count };
    });
    return respond({ status: 'success', source_date: body.source_date, source_count: SRC, targets });
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
  // UPLOAD & LOAD: /table/{name}/upload → { caller, mode, delimiter, original_filename, file_content }
  const uploadMatch = path.match(/^\/api\/config\/(cib|group|retail)\/table\/([^/]+)\/upload$/);
  if (uploadMatch && req.method === 'POST') {
    const body = (req.body ?? {}) as { mode?: string; file_content?: string };
    const lines = String(body.file_content ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
    const dataRows = Math.max(0, lines.length - 1);
    // dev trigger: a cell containing DBERROR exercises the DB-error path (e.g. a missing partition)
    if (/DBERROR/i.test(String(body.file_content ?? ''))) {
      return respondError(500, 'ORA-14400: inserted partition key does not map to any partition\nORA-06512: at line 1 — the partition/subpartition for COB_DT does not exist (create it, then retry).');
    }
    // dev trigger: a cell containing REJECTME exercises the server-rejected path
    if (/REJECTME/i.test(String(body.file_content ?? ''))) {
      return respond({ status: 'rejected', rows_rejected: 2,
        rejects: [{ row: 1, column: 'AMOUNT', reason: 'not a number' }, { row: 4, column: 'COB_DT', reason: 'expected date YYYY-MM-DD' }] });
    }
    // detect-and-report demo: pretend partitions exist up to 2026-08-31; a later COB date → partition missing
    const fileDates = (String(body.file_content ?? '').match(/\d{4}-\d{2}-\d{2}/g) || []).sort();
    const maxDate = fileDates[fileDates.length - 1];
    if (maxDate && maxDate > '2026-08-31') {
      return respondError(409, `The partition for ${maxDate} does not exist on this table (partitions cover up to 2026-08-31). Ask the DBA / OLS dev team to create the partition/subpartition, then retry.`);
    }
    return respond({ status: 'success', result: {
      load_id: Math.floor(1000 + Math.random() * 9000), mode: body.mode ?? 'append',
      rows_loaded: dataRows, rows_deleted: body.mode === 'replace' ? 4 : 0, rows_rejected: 0,
      cob_dt: null, archived: '(dev mock — no NAS write)' } });
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
// --- Dev access scenarios (on-screen validation of each access type) --------------------------
// Set the scenario without a rebuild:  localStorage.setItem('ols.devScenario','defaults_only'); location.reload();
// Clear it:                            localStorage.removeItem('ols.devScenario'); location.reload();
// Or set environment.devScenario. Each returns a full snapshot faithful to the RBAC model so you can
// eyeball exactly which screens/tabs/sections a given kind of user sees.

function currentScenario(): string {
  try {
    const ls = localStorage.getItem('ols.devScenario');
    if (ls) { return ls; }
  } catch { /* ignore */ }
  return environment.devScenario || '';
}

/** A blank ACTIVE snapshot: the two ungated defaults (Log Analytics + Infra Health) and nothing else.
 *  Scenarios spread overrides on top. */
function baseActive(over: Record<string, unknown>): Record<string, unknown> {
  const u = environment.username;
  return {
    status: 'success', active: true, username: u,
    display_name: titleCase(u), email: `${u.toLowerCase()}@example.com`,
    role: 'READ', app_env: environment.appEnv, is_ops_admin: false, can_sql: false,
    screens: ['home', 'log_analytics', 'infra_health'],
    write_screens: [] as string[],
    config: { scopes: [] as string[], all: false, all_level: 'READ', category_grants: [], table_grants: [], regression: [] as string[] },
    servers: [] as string[], all_servers: true, denied_servers: [],
    infra: { all_apps: true, apps: [], denied_apps: [] },
    service: { all_apps: false, apps: [] as string[], denied_apps: [] },
    oracle: { all_dbs: false, all_level: 'READ', dbs: {} as Record<string, string>, denied_dbs: [] },
    denied_sections: [],
    ...over
  };
}

const DEV_SCENARIOS: Record<string, () => Record<string, unknown>> = {
  // Full access (like ADMIN + ops-admin + S-Studio).
  admin: () => baseActive({
    role: 'ADMIN', is_ops_admin: true, can_sql: true,
    screens: ['home', 'log_analytics', 'config_ops_console', 'infra_health', 'service_console', 'oracle_command_center'],
    write_screens: ['service_console', 'oracle_command_center'],
    config: { scopes: ['group', 'cib', 'retail'], all: true, all_level: 'WRITE', category_grants: [], table_grants: [] },
    service: { all_apps: true, apps: [], denied_apps: [] },
    oracle: { all_dbs: true, all_level: 'WRITE', dbs: {}, denied_dbs: [] }
  }),
  // Active OLS user, NO features assigned → sees ONLY the two defaults (+ Home). Nothing else.
  defaults_only: () => baseActive({}),
  // Not an active OLS user (gate 1 fail) → the "you don't have access" No-Access page.
  not_provisioned: () => ({
    status: 'success', active: false, username: environment.username,
    display_name: titleCase(environment.username), email: `${environment.username.toLowerCase()}@example.com`,
    role: 'NONE', app_env: environment.appEnv, is_ops_admin: false, can_sql: false,
    screens: [], write_screens: [],
    config: { scopes: [], all: false, all_level: 'READ', category_grants: [], table_grants: [] },
    servers: [], all_servers: false, denied_servers: [],
    infra: { all_apps: false, apps: [], denied_apps: [] }, service: { all_apps: false, apps: [], denied_apps: [] },
    oracle: { all_dbs: false, all_level: 'READ', dbs: {}, denied_dbs: [] }, denied_sections: []
  }),
  // Config Ops on GROUP + CIB only (RETAIL must stay hidden), write.
  config_group_cib: () => baseActive({
    screens: ['home', 'log_analytics', 'infra_health', 'config_ops_console'],
    config: {
      scopes: ['group', 'cib'], all: false, all_level: 'WRITE',
      category_grants: [
        { scope: 'group', category: 'OMT-BOTH', level: 'WRITE' },
        { scope: 'cib', category: 'OMT-BOTH', level: 'WRITE' }
      ],
      table_grants: []
    }
  }),
  // Oracle Command Center — only the GROUP database tab, with write (kill/apply).
  occ_group_write: () => baseActive({
    screens: ['home', 'log_analytics', 'infra_health', 'oracle_command_center'],
    write_screens: ['oracle_command_center'],
    oracle: { all_dbs: false, all_level: 'READ', dbs: { group: 'WRITE' }, denied_dbs: [] }
  }),
  // Service Console (start/stop) on OLS_GROUP + OLS_CIB apps only.
  service_console: () => baseActive({
    screens: ['home', 'log_analytics', 'infra_health', 'service_console'],
    write_screens: ['service_console'],
    service: { all_apps: false, apps: ['OLS_GROUP', 'OLS_CIB'], denied_apps: [] }
  }),
  // Ops-admin (User Management) with NO other features — validates the Administration group appears.
  ops_admin: () => baseActive({ is_ops_admin: true }),
  // S-Studio operator WITHOUT super-admin: can_sql only (is_ops_admin false → NO User Management),
  // plus config GROUP/CIB (S-Studio lives inside the scope screen, so it needs a config grant to reach).
  sql_studio: () => baseActive({
    is_ops_admin: false, can_sql: true,
    screens: ['home', 'log_analytics', 'infra_health', 'config_ops_console'],
    config: {
      scopes: ['group', 'cib'], all: false, all_level: 'WRITE',
      category_grants: [
        { scope: 'group', category: 'OMT-BOTH', level: 'WRITE' },
        { scope: 'cib', category: 'OMT-BOTH', level: 'WRITE' }
      ],
      table_grants: [],
      // Regression granted on CIB only (via ols_app_access) — so CIB shows the Regression tab but GROUP
      // does not, even though both scopes' config is granted. (config_group_cib grants neither.)
      regression: ['cib']
    }
  }),
  // Config Ops on ONE scope only, no S-Studio, no Regression — "<scope> only, everything else hidden".
  config_cib_only: () => baseActive({
    screens: ['home', 'log_analytics', 'infra_health', 'config_ops_console'],
    config: {
      scopes: ['cib'], all: false, all_level: 'WRITE',
      category_grants: [{ scope: 'cib', category: 'OMT-BOTH', level: 'WRITE' }],
      table_grants: [], regression: []
    }
  }),
  config_group_only: () => baseActive({
    screens: ['home', 'log_analytics', 'infra_health', 'config_ops_console'],
    config: {
      scopes: ['group'], all: false, all_level: 'WRITE',
      category_grants: [{ scope: 'group', category: 'OMT-BOTH', level: 'WRITE' }],
      table_grants: [], regression: []
    }
  }),
  config_retail_only: () => baseActive({
    screens: ['home', 'log_analytics', 'infra_health', 'config_ops_console'],
    config: {
      scopes: ['retail'], all: false, all_level: 'WRITE',
      category_grants: [{ scope: 'retail', category: 'OMT-BOTH', level: 'WRITE' }],
      table_grants: [], regression: []
    }
  }),
  // Config Ops READ-ONLY on one scope (category READ) — proves NO add/edit/delete/duplicate/upload/roll
  // buttons (view + Export only). One per scope.
  config_cib_readonly: () => baseActive({
    screens: ['home', 'log_analytics', 'infra_health', 'config_ops_console'],
    config: {
      scopes: ['cib'], all: false, all_level: 'READ',
      category_grants: [{ scope: 'cib', category: 'OMT-BOTH', level: 'READ' }],
      table_grants: [], regression: []
    }
  }),
  config_group_readonly: () => baseActive({
    screens: ['home', 'log_analytics', 'infra_health', 'config_ops_console'],
    config: {
      scopes: ['group'], all: false, all_level: 'READ',
      category_grants: [{ scope: 'group', category: 'OMT-BOTH', level: 'READ' }],
      table_grants: [], regression: []
    }
  }),
  config_retail_readonly: () => baseActive({
    screens: ['home', 'log_analytics', 'infra_health', 'config_ops_console'],
    config: {
      scopes: ['retail'], all: false, all_level: 'READ',
      category_grants: [{ scope: 'retail', category: 'OMT-BOTH', level: 'READ' }],
      table_grants: [], regression: []
    }
  }),
  // Docs: only the User Guide granted (SCREEN/docs) — the Technical Guide tab + nav item stay hidden.
  docs_user_only: () => baseActive({ screens: ['home', 'log_analytics', 'infra_health', 'docs'] }),
  // Docs: only the Technical Guide granted (SCREEN/docs_technical) — the User Guide is hidden; /docs
  // lands straight on the Technical Guide.
  docs_technical_only: () => baseActive({ screens: ['home', 'log_analytics', 'infra_health', 'docs_technical'] })
  // (No docs grant at all → the whole Docs group is hidden — see the `defaults_only` scenario.)
};

function mockAccessSnapshot(): Record<string, unknown> {
  // Dev scenario override (for on-screen validation of each access type). Wins over devRoles.
  const scenario = currentScenario();
  if (scenario && DEV_SCENARIOS[scenario]) {
    return DEV_SCENARIOS[scenario]();
  }
  const dr = environment.devRoles;
  const role = dr.is_admin ? 'ADMIN' : dr.is_read ? 'READ' : dr.is_salt ? 'SALT' : 'NONE';
  const base = {
    status: 'success', active: role !== 'NONE', username: environment.username,
    display_name: titleCase(environment.username), email: `${environment.username.toLowerCase()}@example.com`,
    role, app_env: environment.appEnv,
    // Ops-admin gate (ols_ops_access) is INDEPENDENT of role; in dev the ADMIN role stands in for it.
    // can_sql (S-Studio) is a per-user flag on the same table — ADMIN role stands in for it in dev.
    is_ops_admin: role === 'ADMIN',
    can_sql: role === 'ADMIN'
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
  // Log Analytics + Infra Health are ungated defaults for every active user (Point 3).
  const allInfra = { all_apps: true, apps: [] as string[], denied_apps: [] as string[] };
  if (role === 'SALT') {
    return {
      ...base,
      screens: ['home', 'log_analytics', 'infra_health', 'config_ops_console'], write_screens: [],
      config: {
        scopes: ['cib'], all: false, all_level: 'READ', category_grants: [],
        table_grants: [
          { scope: 'cib', table: 'CIB_LIMIT_CONFIG', level: 'READ' },
          { scope: 'cib', table: 'CIB_FX_RATES', level: 'READ' }
        ]
      },
      servers: [], all_servers: true, denied_servers: [], infra: allInfra, service: noSvc, oracle: noOracle, denied_sections: []
    };
  }
  if (role === 'NONE') {
    return {
      ...base, screens: [], write_screens: [],
      config: { scopes: [], all: false, all_level: 'READ', category_grants: [], table_grants: [] },
      servers: [], all_servers: false, denied_servers: [], infra: noInfra, service: noSvc, oracle: noOracle, denied_sections: []
    };
  }
  // READ (default demo): Log Analytics + Infra Health are ungated defaults (Point 3); Config Ops
  // (Group + CIB opt-in — RETAIL stays hidden), Service Console (write, OLS_GROUP+OLS_CIB apps), OCC
  // WRITE on GROUP + READ on CIB BATCH; SQL Intelligence denied.
  return {
    ...base,
    screens: ['home', 'log_analytics', 'config_ops_console', 'infra_health', 'service_console', 'oracle_command_center', 'docs', 'docs_technical'],
    write_screens: ['service_console'],
    config: {
      scopes: ['group', 'cib'], all: false, all_level: 'READ',
      category_grants: [
        { scope: 'group', category: 'OMT-FUNCTIONAL', level: 'READ' },
        { scope: 'cib', category: 'OMT-BOTH', level: 'WRITE' }
      ],
      table_grants: [{ scope: 'group', table: 'GRP_COST_CENTER', level: 'WRITE' }]
    },
    servers: [], all_servers: true, denied_servers: [],
    infra: allInfra,
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
interface UmOps { active: boolean; users: boolean; sql: boolean; }
const umStore = { grants: new Map<string, UmGrant[]>(), ops: new Map<string, UmOps>() };
let umSeeded = false;

function umSeed(): void {
  if (umSeeded) {
    return;
  }
  umSeeded = true;
  umStore.ops.set(environment.username.toUpperCase(), { active: true, users: true, sql: true });
  umStore.ops.set('DBAUSER', { active: true, users: true, sql: false });
  umStore.ops.set('SQLONLY', { active: true, users: false, sql: true });   // S-Studio, NOT super-admin
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

// --- S-Studio dev mocks (mirror sql_studio_api._dummy_execute) --------------------------------

function mockSqlDatabases(scope: string): { key: string; label: string }[] {
  const all = [
    { key: 'group', label: 'OLS GROUP' },
    { key: 'cib_batch', label: 'OLS CIB Batch' },
    { key: 'cib_reporting', label: 'OLS CIB Reporting' },
    { key: 'retail_batch', label: 'OLS RETAIL Batch' },
    { key: 'retail_reporting', label: 'OLS RETAIL Reporting' }
  ];
  return all.filter((d) => d.key === scope || d.key.startsWith(scope + '_'));
}

function mockSqlExecute(sql: string): Record<string, unknown> {
  const text = (sql || '').trim().replace(/\/\s*$/, '').trim();
  if (!text) {
    return { kind: 'error', error: 'No SQL to run.' };
  }
  const head = text.toUpperCase().replace(/^\s+/, '');
  if (head.includes('ERR')) {                          // dev hook: exercise the error panel
    return { kind: 'error', error: 'ORA-00942: table or view does not exist' };
  }
  if (head.startsWith('BEGIN') || head.startsWith('DECLARE')) {
    return { kind: 'exec', message: 'PL/SQL procedure successfully completed.', statements: 1 };
  }
  const createMatch = head.match(/^CREATE\s+(?:OR\s+REPLACE\s+)?(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?(PACKAGE\s+BODY|PACKAGE|PROCEDURE|FUNCTION|TRIGGER|TYPE\s+BODY|TYPE)\b/);
  if (createMatch) {
    const t = createMatch[1];
    const obj = t.charAt(0) + t.slice(1).toLowerCase();
    return { kind: 'exec', message: `${obj} created.`, statements: 1 };
  }
  const stmts = text.split(';').map((s) => s.trim()).filter(Boolean);
  const last = stmts[stmts.length - 1] || text;
  if (last.toUpperCase().startsWith('SELECT')) {
    return {
      kind: 'select',
      columns: ['ID', 'NAME', 'STATUS', 'CREATED'],
      rows: [
        [1, 'ALPHA', 'ACTIVE', '2026-08-25 09:14:02'],
        [2, 'BRAVO', 'ACTIVE', '2026-08-24 21:03:55'],
        [3, 'CHARLIE', 'DISABLED', '2026-08-20 11:47:10']
      ],
      row_count: 3, truncated: false, statements: stmts.length
    };
  }
  const verb = last.split(/\s+/)[0].toUpperCase();
  const dml: Record<string, string> = { INSERT: 'inserted', UPDATE: 'updated', DELETE: 'deleted', MERGE: 'merged' };
  let message: string;
  if (dml[verb]) {
    message = `1 row ${dml[verb]}.`;
  } else if (verb === 'COMMIT') {
    message = 'Commit complete.';
  } else if (verb === 'ROLLBACK') {
    message = 'Rollback complete.';
  } else {
    message = `${verb.charAt(0)}${verb.slice(1).toLowerCase()} succeeded.`;
  }
  return { kind: 'exec', message, rows_affected: dml[verb] ? 1 : null, statements: stmts.length };
}

// --- Regression dev engine (in-memory run + step state, PER SCOPE) ------------------------------
// Each config scope (cib / retail / …) is a SEPARATE application with its own regression process, so
// the mock keeps a separate store + localStorage entry per scope. The active scope for a request comes
// from body.scope (set by each scope's service); the helpers operate on the current scope's store.

interface RegStep { status: string; forced_by?: string; task_completion_time?: number; start_time?: string; end_time?: string; performed_by?: string; stale?: boolean; age_seconds?: number; }
interface RegStoreT { run: Record<string, unknown> | null; steps: Record<string, RegStep>; activity: Record<string, unknown>[]; nextLog: number; }
const regStores: Record<string, RegStoreT> = {};
const regLastBranches: Record<string, string> = {};
let curScope = 'cib';
// One-time cleanup: drop the legacy pre-scope store key (replaced by per-scope ols.reg.store.<scope>).
try { localStorage.removeItem('ols.reg.store'); } catch { /* ignore */ }

function regNow(): string { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
function regKey(scope: string): string { return `ols.reg.store.${scope}`; }
function lastBranch(): string { return regLastBranches[curScope] ?? 'release/20260828'; }

// Persist each scope's dev run across reloads (mirrors the run living in Oracle; "resume after refresh").
function loadRegStore(scope: string): RegStoreT {
  try {
    const raw = localStorage.getItem(regKey(scope));
    if (raw) {
      const d = JSON.parse(raw) as { run: Record<string, unknown> | null; steps: Record<string, RegStep>; activity: Record<string, unknown>[]; nextLog: number; lastBranch?: string };
      if (d.lastBranch) { regLastBranches[scope] = d.lastBranch; }
      return { run: d.run ?? null, steps: d.steps ?? {}, activity: d.activity ?? [], nextLog: d.nextLog ?? 1 };
    }
  } catch { /* ignore */ }
  return { run: null, steps: {}, activity: [], nextLog: 1 };
}
/** The current scope's store (lazily loaded). */
function store(): RegStoreT {
  if (!regStores[curScope]) { regStores[curScope] = loadRegStore(curScope); }
  return regStores[curScope];
}
function regSave(): void {
  const s = regStores[curScope]; if (!s) { return; }
  try { localStorage.setItem(regKey(curScope), JSON.stringify({ run: s.run, steps: s.steps, activity: s.activity, nextLog: s.nextLog, lastBranch: regLastBranches[curScope] })); } catch { /* ignore */ }
}

function regLog(step_key: string, action: string, status: string, extra: Record<string, unknown> = {}): void {
  const s = store();
  s.activity.unshift({
    log_id: s.nextLog++, run_id: (s.run?.['run_id'] ?? 1), load_dt: regNow().slice(0, 10),
    step_key, action, status, performed_by: environment.username, start_time: regNow(), end_time: regNow(),
    task_completion_time: 0, forced_by: null, comments: null, ...extra
  });
  regSave();
}

function regSetStep(key: string, status: string, forced_by?: string, details?: string): void {
  // simulate a realistic elapsed time so the per-step "Run time" line has a value in dev
  const secs = status === 'in_progress' ? 0 : 1 + Math.floor(Math.random() * 6);
  const now = regNow();
  const cur = store();
  cur.steps[key] = { status, forced_by, task_completion_time: secs, start_time: now, end_time: now, performed_by: environment.username };
  regLog(key, forced_by ? 'forced' : status, status, { forced_by: forced_by ?? null, comments: details ?? null, task_completion_time: secs });
}

function mockRegression(path: string, body: Record<string, unknown>): Record<string, unknown> {
  curScope = String(body['scope'] ?? 'cib');   // route to this scope's separate run/activity store
  const rs = store();
  const dbs = String(body['dbs'] ?? '');
  const scripts = (body['scripts'] as string[]) ?? [];
  switch (path) {
    case '/api/regression/run/current': {
      const active = rs.run && rs.run['status'] === 'in_progress';
      if (active) {
        const staleSecs = 30 * 60;
        for (const k of Object.keys(rs.steps)) {
          const s = rs.steps[k];
          if (s.status === 'in_progress' && s.start_time) {
            // regNow() emits a UTC timestamp — parse it back as UTC (append 'Z') to age it correctly.
            s.age_seconds = Math.floor((Date.now() - new Date(String(s.start_time).replace(' ', 'T') + 'Z').getTime()) / 1000);
            s.stale = s.age_seconds > staleSecs;
          } else { s.stale = false; }
        }
      }
      return { status: 'success', run: active ? rs.run : null, steps: active ? rs.steps : {} };
    }
    case '/api/regression/step/unlock': {
      const key = String(body['step_key'] ?? '');
      rs.steps[key] = { status: 'error', task_completion_time: 0, start_time: regNow(), end_time: regNow(), performed_by: environment.username };
      regLog(key, 'unlock', 'error', { comments: `Stuck in-progress step cleared by ${environment.username}` });
      return { status: 'success', run: rs.run, steps: rs.steps };
    }
    case '/api/regression/run/complete': {
      const st = String(body['status'] ?? 'complete');
      const abandoned = st === 'abandoned';
      regLog('run', abandoned ? 'abandoned' : 'complete', st, { comments: abandoned ? 'Regression run abandoned' : 'Regression run completed' });
      if (rs.run) { rs.run['status'] = st; rs.run['end_time'] = regNow(); }
      regSave();
      return { status: 'success', run: null, steps: {} };
    }
    case '/api/regression/run/start':
      rs.run = { run_id: 1, app_env: environment.appEnv, status: 'in_progress', started_by: environment.username, start_time: regNow() };
      rs.steps = {}; rs.activity = []; rs.nextLog = 1;
      regLog('run', 'start', 'in_progress');
      return { status: 'success', run: rs.run, steps: rs.steps };
    case '/api/regression/step/mark': {
      const key = String(body['step_key'] ?? ''); const st = String(body['status'] ?? 'complete');
      regSetStep(key, st, body['forced'] ? environment.username : undefined, String(body['details'] ?? ''));
      return { status: 'success', run: rs.run, steps: rs.steps };
    }
    case '/api/regression/refresh-db': {
      const rdbs = (body['dbs'] as string[]) ?? [];
      regSetStep('refresh_db', 'complete', undefined, `Refresh API (dummy) called for: ${rdbs.join(', ') || '(none)'}`);
      return { status: 'success', result: { status: 'complete', message: `Refresh triggered for ${rdbs.length} database(s) (dummy).`, details: `DB(s): ${rdbs.join(', ')}` } };
    }
    case '/api/regression/git/branches':
      return { status: 'success', branches: ['release/20260828', 'release/20260815'] };
    case '/api/regression/git/pull':
      regLastBranches[curScope] = String(body['branch'] ?? lastBranch());
      regSave();
      return { status: 'success', scripts: ['apply/CHG_20260828.sql', 'apply/CHG_20260828_MISC1.sql', 'apply/CHG_20260828_MISC2.sql', 'reset/reset_batches.sql', 'trigger/trigger_all.sql', 'trigger/trigger_CB.sql'] };
    case '/api/regression/git/scripts':
      return { status: 'success', scripts: ['apply/CHG_20260828.sql', 'apply/CHG_20260828_MISC1.sql', 'apply/CHG_20260828_MISC2.sql', 'reset/reset_batches.sql', 'trigger/trigger_all.sql', 'trigger/trigger_CB.sql'] };
    case '/api/regression/git/tree':
      return { status: 'success', workdir: 'D:/ols/regression/work', branch: lastBranch(), files: [
        'apply/CHG_20260828.sql', 'apply/CHG_20260828_MISC1.sql', 'apply/CHG_20260828_MISC2.sql',
        'db/package/lam/abc.pck', 'db/package/lam/xyz.pck', 'db/package/cb/cb_valuation.pck',
        'db/procedure/lam/load_positions.prc', 'reset/reset_batches.sql',
        'trigger/trigger_all.sql', 'trigger/trigger_CB.sql', 'README.md'] };
    case '/api/regression/git/file': {
      const p = String(body['path'] ?? '');
      const content = p.endsWith('.pck')
        ? `-- ${p}\nCREATE OR REPLACE PACKAGE BODY ${p.split('/').pop()?.replace('.pck', '')} AS\n  PROCEDURE run IS\n  BEGIN\n    NULL;\n  END run;\nEND;\n/`
        : p.endsWith('.sql')
          ? `-- ${p}\nSET DEFINE OFF\n@../db/package/lam/abc.pck\n@../db/package/lam/xyz.pck\nUPDATE ols_batch SET status_id = 2;\nCOMMIT;\n`
          : `Contents of ${p}`;
      return { status: 'success', path: p, content };
    }
    case '/api/regression/run-sql': {
      const stepKey = String(body['step_key'] ?? 'apply_db');
      const dbList = (body['dbs'] as string[]) ?? [];
      const results = scripts.flatMap((s) => dbList.map((d) => {
        const status = s.toUpperCase().includes('ERR') ? 'error' : 'complete';
        return { script: s, db: d, status, log_file: `D:/ols/regression/logs/dummy/${s.split('/').pop()}__${d}.log`,
                 tail: `Connected to ${d}.\n@${s}\n${status === 'error' ? 'ORA-00942: table or view does not exist' : 'PL/SQL procedure successfully completed.'}\nSpool off.` };
      }));
      const stepStatus = results.some((r) => r.status !== 'complete') ? 'error' : 'complete';
      results.forEach((r) => regLog(stepKey, 'run_sql', r.status, { details: `${r.script} on ${r.db} -> ${r.status}` }));
      regSetStep(stepKey, stepStatus, undefined, `${scripts.length} script(s) x ${dbList.length} db(s)`);
      void dbs;
      return { status: 'success', results, step_status: stepStatus };
    }
    case '/api/regression/log/read':
      return { status: 'success', content: `Dummy sqlplus log for ${body['log_file']}\nConnected.\nPL/SQL procedure successfully completed.\nSpool off.` };
    case '/api/regression/file-copy/manifest':
      return { status: 'success', items: [
        { source: '\\\\eur17\\d$\\release\\cib\\app.config', destination: '\\\\eur34\\e$\\apps\\cib\\app.config' },
        { source: '\\\\eur17\\d$\\release\\cib\\bootstrap.properties', destination: '\\\\eur34\\e$\\apps\\cib\\bootstrap.properties' },
        { source: '\\\\eur17\\d$\\release\\cib\\scripts\\*', destination: '\\\\eur34\\e$\\apps\\cib\\scripts' },
        { source: '\\\\eur17\\d$\\release\\cib\\reports\\*', destination: '\\\\eur34\\e$\\apps\\cib\\reports' },
        { source: '\\\\eur17\\d$\\release\\cib\\missing\\legacy.dll', destination: '\\\\eur34\\e$\\apps\\cib\\legacy.dll' }
      ] };
    case '/api/regression/file-copy/run': {
      const items = (body['items'] as { source: string; destination: string }[]) ?? [];
      const results = items.map((i) => {
        const folder = i.source.trim().endsWith('*');
        // demo: a FOLDER that fails partway → the whole item is errored, whole folder re-copied on re-run
        if (folder && /reports|partial/i.test(i.source)) {
          return { source: i.source, destination: i.destination, ok: false, kind: 'folder', count: 450,
            error: `Folder copy FAILED after 450 file(s) — the WHOLE folder must be re-copied (re-run the step). Failed on ${i.destination}\\report_0451.dat: ERROR 112 (0x70): There is not enough space on the disk.` };
        }
        // demo: a source under a "missing"/"fail" path reports a real failure with details
        if (/missing|fail/i.test(i.source)) {
          return { source: i.source, destination: i.destination, ok: false,
            error: 'ERROR 5 (0x5): The system cannot find the path specified.\n  robocopy exit code 8 — source path is unavailable.' };
        }
        const names = folder
          ? ['app.config', 'bootstrap.properties', 'log4j2.xml', 'scripts\\run.bat', 'scripts\\stop.bat', 'lib\\core.jar', 'lib\\util.jar']
          : [i.destination.split('\\').pop() ?? 'file'];
        const files = folder ? names.map((n) => `${i.destination}\\${n}`) : [i.destination];
        return { source: i.source, destination: i.destination, ok: true, count: files.length, kind: folder ? 'folder' : 'file', files };
      });
      const fails = results.filter((r) => !r.ok).length;
      const copied = results.reduce((n, r) => n + (r.ok ? (r.count ?? 0) : 0), 0);
      const detail = `${copied} file(s) across ${results.length - fails} item(s)` + (fails ? `; ${fails} item(s) FAILED` : '') + '\n'
        + results.map((r) => r.ok
            ? `OK   ${r.source} -> ${r.destination} (${r.count})\n${(r.files ?? []).map((f) => '       ' + f).join('\n')}`
            : `FAIL ${r.source} -> ${r.destination}: ${r.error}`).join('\n');
      regSetStep('file_copy', fails ? 'error' : 'complete', undefined, detail);
      return { status: 'success', results };
    }
    case '/api/regression/batch-monitor':
      return { status: 'success', columns: ['BUSINESS_LINE', 'BATCH', 'STATUS_ID', 'STARTED', 'FINISHED'],
        rows: [['CB', 'CB_LOAD', 2, '2026-08-28 09:00', '2026-08-28 09:12'],
               ['CB', 'CB_VALUATION', 1, '2026-08-28 09:12', null],
               ['ALMT', 'ALMT_ETL', 2, '2026-08-28 08:40', '2026-08-28 09:05'],
               ['GECD', 'GECD_FEED', 2, '2026-08-28 08:20', '2026-08-28 08:44'],
               ['FI', 'FI_POST', 3, '2026-08-28 08:30', '2026-08-28 08:31']] };
    case '/api/regression/activity':
      return { status: 'success', rows: rs.activity };
    default:
      return { status: 'success' };
  }
}

function mockCatalogue(): Record<string, unknown> {
  return {
    screens: [
      { key: 'service_console', label: 'Service Console', write_capable: true },
      { key: 'oracle_command_center', label: 'Oracle Command Center', write_capable: true },
      { key: 'docs', label: 'Docs — User Guide', write_capable: false },
      { key: 'docs_technical', label: 'Docs — Technical Guide', write_capable: false }
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

// --- Documentation Center dev mocks -----------------------------------------------------------
// Canned catalogue: local markdown docs (with content, to exercise the renderer) + external wiki
// links. `audience` drives BOTH grouping and RBAC — technical docs are only returned to a technical
// user (ADMIN / ops-admin / S-Studio). Mirrors docs_api.py (auto-discovered md + config wikis).

interface MockMd { title: string; audience: 'user' | 'technical'; description: string; tags: string[]; updated: string; markdown: string; }

const DOCS_MD: Record<string, MockMd> = {
  'getting-started': {
    title: 'Getting Started', audience: 'user', updated: '2026-08-24',
    description: 'A quick tour of the OLS Dashboard and how to find your tools.',
    tags: ['intro', 'overview'],
    markdown: [
      '# Getting Started',
      '',
      'Welcome to the **OLS Dashboard** — your single console for operations across the estate.',
      '',
      '## What you can do',
      '',
      '- Monitor infrastructure and services from **Home**',
      '- Browse logs in the **Log Analytics Hub**',
      '- Edit configuration in the **Config Ops Console**',
      '  - Upload CSVs and roll COB dates',
      '  - Review every change before it applies',
      '- Investigate databases in the **Oracle Command Center**',
      '',
      '## Signing in',
      '',
      'Use your corporate SSO. Your access is resolved from your role — you only ever see the tools you are granted.',
      '',
      '> Tip: if a screen looks missing, you probably need a grant. Reach out to the OLS Team.',
      '',
      '## Finding things',
      '',
      'Most grids support inline `filter` and `sort`. Use the search box on this page to find any document by title or tag.',
      '',
      '| Area | Where to look |',
      '| --- | --- |',
      '| Logs | Log Analytics Hub |',
      '| Config | Config Ops Console |',
      '| Databases | Oracle Command Center |',
      ''
    ].join('\n')
  },
  'config-ops-guide': {
    title: 'Using the Config Ops Console', audience: 'user', updated: '2026-08-27',
    description: 'Edit tables, upload CSVs and roll COB dates safely.',
    tags: ['config', 'how-to', 'upload'],
    markdown: [
      '# Using the Config Ops Console',
      '',
      'The Config Ops Console lets you view and edit configuration tables for each OLS application.',
      '',
      '## Editing a table',
      '',
      '1. Pick your application scope (GROUP / CIB / RETAIL).',
      '2. Open a table with the *eye* icon to view its rows.',
      '3. Use **Add**, **Edit** or **Delete** — buttons only appear where you have write access.',
      '',
      '## Uploading a CSV',
      '',
      'Choose **Upload Data**, pick *Append* or *Replace*, and review the parsed rows before loading.',
      '',
      '- **Append** inserts new rows only.',
      '- **Replace** clears the table (or just the COB date) then inserts.',
      '',
      '> Nothing is written until you confirm — you always see a preview first.',
      ''
    ].join('\n')
  },
  'architecture-overview': {
    title: 'Architecture Overview', audience: 'technical', updated: '2026-08-29',
    description: 'How the UI, API and data layers fit together.',
    tags: ['architecture', 'internals'],
    markdown: [
      '# Architecture Overview',
      '',
      'The dashboard is an **Angular 22** (standalone, signals, zoneless) front end backed by a **FastAPI** service.',
      '',
      '## Layers',
      '',
      '1. **UI** — served same-origin; detects its environment from the hostname.',
      '2. **API** — FastAPI routers under `/api/*`.',
      '3. **Data** — all SQL lives in `database.py`; routers only shape the contract.',
      '',
      '## Environment detection',
      '',
      'One build runs in DEV / STG / PROD; the browser resolves the environment at runtime:',
      '',
      '```ts',
      'const HOST = window.location.hostname;',
      'const env = detectEnv(HOST);   // DEV | STG | LIVE',
      '```',
      '',
      '## Access model',
      '',
      'Access is resolved into one snapshot (`/api/access/me`) and **every write is re-checked server-side**.',
      '',
      '> UI hiding is *never* the security boundary.',
      ''
    ].join('\n')
  },
  'regression-runbook': {
    title: 'Regression Runbook', audience: 'technical', updated: '2026-08-28',
    description: 'The gated pre-release regression workflow, step by step.',
    tags: ['regression', 'runbook', 'release'],
    markdown: [
      '# Regression Runbook',
      '',
      'Run before a production deployment (DEV/STG only). Each step is gated, logged and force-markable.',
      '',
      '## Workflow',
      '',
      '1. **Refresh DB** — restore the target from the source.',
      '2. **Apply DB changes** — pull the `release/*` branch and run each `CHG_*.sql`.',
      '3. **File copy** — copy the developer manifest (source → destination).',
      '4. **Reset batches** — run the reset script.',
      '5. **Trigger batches** — kick off per business line.',
      '',
      'A step unlocks only when the previous one is `complete` or `forced`.',
      '',
      '```sql',
      '-- example reset invoked by the engine',
      'UPDATE ols_batch SET status_id = 2;',
      'COMMIT;',
      '```',
      '',
      '> Force-completing a step is logged with your name — use it only when you understand why the step failed.',
      ''
    ].join('\n')
  }
};

const DOCS_WIKIS: DocEntry[] = [
  { id: 'wiki-onboarding', type: 'wiki', audience: 'user', title: 'Team Onboarding (Wiki)',
    description: 'Joiners: accounts, access requests and first-week checklist.',
    url: 'https://coreui.io/angular/docs/', tags: ['onboarding'], updated: '2026-07-30' },
  { id: 'wiki-batch-runbook', type: 'wiki', audience: 'user', title: 'Batch Recovery Runbook (Wiki)',
    description: 'Step-by-step recovery when an overnight batch fails.',
    url: 'https://coreui.io/angular/docs/', tags: ['runbook', 'batch'], updated: '2026-08-12' },
  { id: 'wiki-db-standards', type: 'wiki', audience: 'technical', title: 'Database Standards (Wiki)',
    description: 'Naming, partitioning and change-control standards for the DBs.',
    url: 'https://coreui.io/angular/docs/', tags: ['database', 'standards'], updated: '2026-08-05' }
];

/** Grant-driven docs access from the current dev snapshot: ADMIN → both guides; otherwise the
 *  SCREEN grants `docs` (User Guide) / `docs_technical` (Technical Guide) appear in `screens`. No grant
 *  → neither (Docs hidden). Mirrors docs_api._docs_access; switching dev scenario changes the result. */
function docsAllowed(): { user: boolean; technical: boolean } {
  const s = mockAccessSnapshot() as Record<string, unknown>;
  if (!s['active']) { return { user: false, technical: false }; }
  if (String(s['role'] ?? '') === 'ADMIN') { return { user: true, technical: true }; }
  const screens = (s['screens'] as string[]) ?? [];
  return { user: screens.includes('docs'), technical: screens.includes('docs_technical') };
}

function mockDocsCatalog(): DocEntry[] {
  const can = docsAllowed();
  const md: DocEntry[] = Object.entries(DOCS_MD).map(([id, d]) => ({
    id, title: d.title, description: d.description, type: 'markdown',
    audience: d.audience, tags: d.tags, updated: d.updated, file: `${id}.md`
  }));
  return [...md, ...DOCS_WIKIS].filter((e) =>
    (e.audience === 'user' && can.user) || (e.audience === 'technical' && can.technical));
}

function mockDocContent(id: string): { id: string; title: string; markdown: string; updated: string } | null {
  const d = DOCS_MD[id];
  if (!d) {
    return null;
  }
  const can = docsAllowed();
  if ((d.audience === 'technical' && !can.technical) || (d.audience === 'user' && !can.user)) {
    return null;   // RBAC re-check on content (not just catalogue)
  }
  return { id, title: d.title, markdown: d.markdown, updated: d.updated };
}
