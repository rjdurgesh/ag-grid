import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { delay, Observable, of, throwError } from 'rxjs';

import { API_BASE_URL, APP_ENV, ApiEnv, ConfigScope, DEV_ROLES, USE_MOCK } from './api-endpoints';
import { LoginResponse } from './models';
import {
  AgentActionPayload,
  AgentCollectPayload,
  MOCK_ACTIVITY,
  MOCK_DASHBOARD_STATS,
  MOCK_LOG_SERVERS,
  MOCK_MEMORY_TREND,
  mockAgentAction,
  mockAgentCollect,
  mockColumnRetrieve,
  mockConfigTables,
  mockDirEntries,
  mockFileContent,
  mockFileProperties,
  mockInfraConfig,
  mockLogFiles,
  mockMemory,
  mockShareSpace,
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
  if (!USE_MOCK || !req.url.startsWith(API_BASE_URL)) {
    return next(req);
  }

  const url = new URL(req.url);
  const path = url.pathname;
  const q = url.searchParams;

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
    return respond({ ...DEV_ROLES });
  }

  // --- System / dashboard ---------------------------------------------------
  if (path === '/api/system/memory') {
    return respond(mockMemory());
  }
  if (path === '/api/system/database') {
    return respond({ name: `OLSDB_${APP_ENV}01` });
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
  if (path === '/api/log/servers') {
    return respond(MOCK_LOG_SERVERS);
  }
  if (path === '/api/log/files') {
    return respond(mockLogFiles(q.get('server') ?? ''));
  }
  if (path === '/api/log/dir') {
    const p = q.get('path') ?? '';
    if (!isLogPathAllowed(q.get('server'), p)) {
      return respondError(400, 'Path is outside the server base log directories');
    }
    return respond({ entries: mockDirEntries(q.get('server') ?? '', p) });
  }
  if (path === '/api/log/file') {
    const p = q.get('path') ?? '';
    if (!isLogPathAllowed(q.get('server'), p)) {
      return respondError(400, 'Path is outside the server base log directories');
    }
    return respond({ content: mockFileContent(p) });
  }
  if (path === '/api/log/file-properties') {
    const p = q.get('path') ?? '';
    if (!isLogPathAllowed(q.get('server'), p)) {
      return respondError(400, 'Path is outside the server base log directories');
    }
    return respond(mockFileProperties(p));
  }

  // --- Config Ops Console ---------------------------------------------------
  const tablesMatch = path.match(/^\/api\/config\/(cib|group|retail)\/tables$/);
  if (tablesMatch) {
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
    return respond({
      success: true,
      table_name: body.table_name,
      from: body.from,
      to: body.to,
      rolledRows: 40 + (body.table_name.length * 7) % 400,
      message: `Rolled ${body.table_name} from ${body.from} to ${body.to}.`
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
    return respond({ success: true, inserted: body.rows?.length ?? 0 });
  }
  // UPDATE: /table/{name}/update  → { updated_by, updates: [{rowid, values}] } → { updated }
  const updateMatch = path.match(/^\/api\/config\/(cib|group|retail)\/table\/[^/]+\/update$/);
  if (updateMatch && req.method === 'POST') {
    const body = (req.body ?? {}) as { updates?: unknown[]; updated_by?: string };
    return respond({ success: true, updated: body.updates?.length ?? 0 });
  }
  // DELETE: /table/{name}/delete  → { deleted_by, rowids: [...] } → { deleted }
  const deleteMatch = path.match(/^\/api\/config\/(cib|group|retail)\/table\/[^/]+\/delete$/);
  if (deleteMatch && req.method === 'POST') {
    const body = (req.body ?? {}) as { rowids?: unknown[]; deleted_by?: string };
    return respond({ success: true, deleted: body.rowids?.length ?? 0 });
  }

  // --- Infrastructure Pulse -------------------------------------------------
  // Config table (health_Server_Details) for the running environment.
  if (path === '/api/infra/config') {
    return respond(mockInfraConfig((q.get('env') as ApiEnv) ?? 'DEV'));
  }
  // Agent collect — live disk / infra / service readings for one server.
  if (path === '/api/infra/agent/collect' && req.method === 'POST') {
    const body = (req.body ?? {}) as Partial<AgentCollectPayload>;
    if (!body.hostname || !body.host_platform) {
      return respondError(400, 'hostname and host_platform are required');
    }
    return respond(mockAgentCollect(body as AgentCollectPayload));
  }
  // Agent action — start / stop a service.
  if (path === '/api/infra/agent/action' && req.method === 'POST') {
    const body = (req.body ?? {}) as Partial<AgentActionPayload>;
    if (!body.hostname || !body.service || !body.action) {
      return respondError(400, 'hostname, service and action are required');
    }
    return respond(mockAgentAction(body as AgentActionPayload));
  }
  // Share drive free space (no agent).
  if (path === '/api/infra/share') {
    return respond(mockShareSpace(q.get('name') ?? ''));
  }

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

function titleCase(value: string): string {
  return value.replace(/(^|[._-])(\w)/g, (_, sep, ch) => (sep ? ' ' : '') + ch.toUpperCase()).trim();
}
