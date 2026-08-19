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
