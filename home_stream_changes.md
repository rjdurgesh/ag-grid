# Home screen — rename + live metric stream (RAM / CPU)

Two related changes documented together:

1. **Rename the landing screen** `dashboard` → `home` (folder, routes, sidebar, RBAC).
2. **Live metric stream** — the header's real-time **RAM (and how to add CPU / more)** feed,
   delivered over **Server-Sent Events (SSE)**: one long-lived connection, Angular + backend.

> This is separate from `SIDEBAR_CHANGES.md`, which is the CoreUI sidebar CSS/collapse reference.

---
---

# PART 1 — Rename: `dashboard` → `home`

The old landing screen was `dashboard`; it became `home` so the word **"dashboard" is free for a
future graphs/analytics screen**. A "screen" is defined once in `src/app/auth/rbac.config.ts`
(`ScreenKey`) and every route, the sidebar filter, and the RBAC guard read from it — so a screen
rename always touches: the view folder, its `route.ts`, `app.routes.ts`, `_nav.ts`, and `rbac.config.ts`.

## 1. Required changes

### 1.1 View folder + files
| From | To |
|------|----|
| `src/app/views/dashboard/` | `src/app/views/home/` |
| `dashboard.component.ts` | `home.component.ts` |
| `dashboard.component.html` | `home.component.html` |
| `dashboard.component.scss` | `home.component.scss` |
| `dashboard/route.ts` | `home/route.ts` *(filename same, contents updated)* |

### 1.2 `src/app/views/home/home.component.ts`
- Class `DashboardComponent` → **`HomeComponent`**
- `selector: 'app-dashboard'` → **`'app-home'`**
- `templateUrl` / `styleUrls` → `./home.component.html` / `./home.component.scss`

### 1.3 `src/app/views/home/route.ts`
```ts
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./home.component').then((m) => m.HomeComponent), // was ./dashboard.component / DashboardComponent
    data: { title: 'Home' }                                                       // was 'Dashboard'
  }
];
```

### 1.4 `src/app/app.routes.ts`
```ts
{ path: '', redirectTo: 'home', pathMatch: 'full' }              // was redirectTo: 'dashboard'
// …inside the authenticated shell children:
{
  path: 'home',                                                  // was 'dashboard'
  canActivate: [rbacGuard],
  data: { screen: 'home' },                                      // was screen: 'dashboard'
  loadChildren: () => import('./views/home/route').then((m) => m.routes) // was ./views/dashboard/route
}
```

### 1.5 `src/app/layout/default-layout/_nav.ts` (sidebar item)
```ts
{ name: 'Home', url: '/home', iconComponent: { name: 'cil-home' } }  // was 'Dashboard' / '/dashboard'
```

### 1.6 `src/app/auth/rbac.config.ts` (screen registry)
- `ScreenKey` union: `'dashboard'` → **`'home'`**
- `ALL_SCREENS[]` and `SALT_SCREENS[]`: `'dashboard'` → **`'home'`**
- `SCREEN_ROUTES`: `home: '/home'` (and `docs: '/home'` default landing)
- `screenForNavUrl()`: `if (path.startsWith('/home')) return 'home';`

### 1.7 Post-login landing (`returnUrl`)
- `src/app/auth/auth.service.ts` → `signIn(returnUrl = '/home')`, `startSsoLogin(returnUrl = '/home')`
- `src/app/auth/sso-auth.service.ts` → `startLogin(returnUrl = '/home')`

## 2. After the rename
1. **Restart the dev server** — the `ols-dev` watcher can miss a renamed folder and `/home` will 404.
2. Verify: `/` → `/home`; sidebar "Home" active; cold sign-in lands on `/home`; old `/dashboard`
   URLs fall through to the `**` 404 (no redirect kept).

## 3. Deliberately NOT changed (leave these `dashboard` strings alone)
- **Product branding** "OLS Dashboard" — `app.component.ts` title, support-email text, comments.
- **`sso.config.ts` `clientId: 'ols-dashboard'`** — the OIDC client ID registered with the provider; changing it breaks SSO.
- **Legacy `/api/dashboard/*` namespace** — `api-endpoints.ts` `dashboard: {stats, activity, memoryTrend}`, `DashboardStat` (`models.ts`), `MOCK_DASHBOARD_STATS` (`mock-data.ts`), mock handlers. The old screen used these; the new Home does not. Optional cleanup, separate PR.
- **Layout selector `app-dashboard`** in `default-layout.component.ts` — cosmetic leftover; harmless.

---
---

# PART 2 — Live metric stream (RAM now, CPU next)

The header shows **real host memory, live**, over a single **SSE** connection (not a poll every N
seconds). The backend pushes a `{free, used, total, unit, percent}` snapshot every 2s; Angular
consumes it with the native `EventSource` and renders a labelled progress bar. It appears on every
screen because it lives in the layout header.

> **Why SSE, not polling:** one persistent connection = one entry in the network tab, server-driven
> cadence, and `EventSource` auto-reconnects on drop. A polling fallback (`ArrowStreamService.memory()`)
> still exists if you ever need it.

## Files involved

| Side | File | Role |
|---|---|---|
| Backend | `backend/system_api.py` | `read_memory()` + `GET /api/system/memory` (one-shot) + `GET /api/system/memory/stream` (SSE) |
| Backend | `backend/app.py` | `app.include_router(system_router)` + CORS (`allow_origins=ALLOWED_ORIGINS`) |
| Angular | `src/app/shared/api-endpoints.ts` | `system.memory`, `system.memoryStream` URLs |
| Angular | `src/app/shared/models.ts` | `MemoryStats` contract |
| Angular | `src/app/shared/arrow-stream.service.ts` | `memoryStream()` — wraps `EventSource` as an Observable |
| Angular | `src/app/layout/default-layout/default-header/default-header.component.ts` | **where it goes on the header** — injects `ArrowStreamService`, `memory = toSignal(memoryStream())`, `memoryColor`; add `ProgressComponent` + `IconDirective` to the component's `imports` |
| Angular | `src/app/layout/default-layout/default-header/default-header.component.html` | the labelled progress-bar markup inside `<c-header>` |
| Angular | `src/scss/_ols.scss` | the `.ols-memory` / `__body` / `__label` / `__bar` / `__icon` / `__pct` styling for the header widget |

> **The header display itself = these three files** (`default-header.component.ts` + `.html` + `_ols.scss`).
> The `.ts`/`.html`/`api-endpoints`/`models`/`arrow-stream.service` above are the wiring; `_ols.scss` is the look.

## Data shape (the contract both sides agree on)
```ts
// models.ts
export interface MemoryStats {
  free: number; used: number; total: number;  // in GB
  unit: string;                                // "GB"
  percent: number;                             // 0–100
}
```

## Backend — `backend/system_api.py`
```python
router = APIRouter(prefix="/api/system", tags=["system"])
STREAM_INTERVAL_SECONDS = 2

def read_memory() -> dict:
    total, available = _mem_bytes()            # psutil → Windows GlobalMemoryStatusEx → /proc/meminfo
    used = max(total - available, 0)
    return {
        "free": round(available / _GB, 1),
        "used": round(used / _GB, 1),
        "total": round(total / _GB, 1),
        "unit": "GB",
        "percent": round(used / total * 100) if total else 0,
    }

@router.get("/memory")                          # one-shot snapshot
def memory() -> dict:
    return read_memory()

@router.get("/memory/stream")                   # Server-Sent Events
async def memory_stream(request: Request) -> StreamingResponse:
    async def event_gen():
        try:
            while True:
                if await request.is_disconnected():   # stop when the browser closes the tab
                    break
                yield f"data: {json.dumps(read_memory())}\n\n"   # SSE frame: 'data: <json>\n\n'
                await asyncio.sleep(STREAM_INTERVAL_SECONDS)
        finally:
            logger.info("memory stream: client disconnected")
    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",         # required for SSE
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",           # don't let a proxy buffer the stream
        },
    )
```
Registered in `backend/app.py`: `app.include_router(system_router)`.

## Angular

**`api-endpoints.ts`**
```ts
system: {
  memory:       `${API_BASE_URL}/api/system/memory`,
  memoryStream: `${API_BASE_URL}/api/system/memory/stream`,   // consumed via EventSource
  database:     `${API_BASE_URL}/api/system/database`,
},
```

**`arrow-stream.service.ts`** — the reusable SSE→Observable wrapper:
```ts
memoryStream(): Observable<MemoryStats> {
  return this.sse<MemoryStats>(API.system.memoryStream);
}

private sse<T>(url: string): Observable<T> {
  return new Observable<T>((subscriber) => {
    const source = new EventSource(url);
    source.onmessage = (e) => { try { subscriber.next(JSON.parse(e.data) as T); } catch {} };
    source.onerror   = () => { /* keep-alive: the browser auto-reconnects */ };
    return () => source.close();               // teardown on unsubscribe
  });
}
```

**`default-header.component.ts`** — this is the file that puts it on the header. Add the CoreUI
imports the markup needs, inject the service, expose the signal + colour:
```ts
import { toSignal } from '@angular/core/rxjs-interop';
import { ProgressComponent } from '@coreui/angular';          // for <c-progress>
import { IconDirective } from '@coreui/icons-angular';         // for the cIcon speedometer
import { ArrowStreamService } from '../../../shared/arrow-stream.service';

@Component({
  selector: 'app-default-header',
  templateUrl: './default-header.component.html',
  imports: [ /* …existing… */ ProgressComponent, IconDirective ],   // ← add these two
})
export class DefaultHeaderComponent extends HeaderComponent {
  readonly #arrowStream = inject(ArrowStreamService);
  readonly memory = toSignal(this.#arrowStream.memoryStream());
  readonly memoryColor = computed(() => {
    const p = this.memory()?.percent ?? 0;
    return p >= 85 ? 'danger' : p >= 70 ? 'warning' : 'success';
  });
}
```

**`default-header.component.html`** — labelled progress bar (falls back to `—` until the first frame):
```html
<div class="ols-memory d-none d-md-flex align-items-center ms-2">
  <svg cIcon name="cilSpeedometer" size="lg" class="ols-memory__icon me-2"></svg>
  @if (memory(); as m) {
    <div class="ols-memory__body">
      <div class="ols-memory__label">
        Memory Usage:
        <span>Free: <b>{{ m.free }}{{ m.unit }}</b></span>,
        <span>Used: <b>{{ m.used }}{{ m.unit }}</b></span>,
        <span>Total: <b>{{ m.total }}{{ m.unit }}</b></span>
        <span>({{ m.percent }}%)</span>
      </div>
      <c-progress class="ols-memory__bar" [value]="m.percent" thin [color]="memoryColor()" />
    </div>
  } @else {
    <span class="text-body-secondary small">Memory Usage: (Free: —, Used: —, Total: —) (—%)</span>
  }
</div>
```

## How to add **CPU** (and other metrics) to the same stream

The pattern generalises — extend the one snapshot object rather than opening a second stream.

**Backend (`system_api.py`):**
1. Add a reader (psutil is the simplest cross-platform source):
   ```python
   def read_cpu() -> dict:
       import psutil
       return {"cpu_percent": round(psutil.cpu_percent(interval=None)), "cpu_count": psutil.cpu_count()}
   ```
   > First `cpu_percent()` call returns 0.0; call it once at startup, or pass a small `interval`.
2. Merge into the streamed payload — e.g. rename `read_memory()` → `read_stats()` returning
   `{ **memory_fields, **read_cpu() }`, and have both `/memory` and `/memory/stream` return it
   (or add a broader `/api/system/stats` + `/stats/stream` and keep `/memory` for back-compat).

**Angular:**
1. `models.ts` — extend the contract:
   ```ts
   export interface SystemStats extends MemoryStats { cpu_percent: number; cpu_count: number; }
   ```
2. `arrow-stream.service.ts` — add `statsStream(): Observable<SystemStats>` pointing at the new URL
   (reuse the same private `sse<T>()`).
3. Header component + template — add a `cpu` display (mirror the memory block; a second
   `<c-progress>` + a `cpuColor` computed with the same 70/85 thresholds).

## Caveats (real gotchas)
- **`EventSource` cannot send custom headers** (no `Authorization`), and it **bypasses Angular's
  HttpClient + the mock interceptor** — it always hits the *real* backend. If the stream must be
  authenticated, use a cookie/session the browser sends automatically, or a short-lived token in the
  URL query (never a long-lived bearer in the URL).
- **CORS**: the SSE URL is a cross-origin GET in dev — it must be covered by `ALLOWED_ORIGINS` in
  `app.py` (it is).
- **Proxying in prod**: SSE must not be buffered. The `X-Accel-Buffering: no` header handles nginx;
  the in-house `ui_server.py` `/api` proxy (httpx) must **stream** the response, not read it to
  completion — otherwise the client sees nothing until the connection closes.
- **`psutil` optional**: `read_memory()` already falls back to Windows `GlobalMemoryStatusEx` /
  Linux `/proc/meminfo`. **CPU has no clean stdlib fallback**, so adding CPU effectively makes
  `psutil` a required dependency (`pip install psutil`) — note it in `requirements.txt`.
```
