import { inject, Injectable } from '@angular/core';
import { Observable, switchMap, timer } from 'rxjs';

import { ApiDataService } from './api-data.service';
import { API } from './api-endpoints';
import { MemoryStats } from './models';

/**
 * Turns a polling endpoint into a live stream.
 *
 * Named per the architecture doc (`arrow-stream.service.ts`) — a reusable place
 * for "live feed" concerns. Today it polls REST endpoints on an interval; the
 * public API (`poll` / `memory`) can later be swapped for SSE/WebSocket/Arrow
 * Flight without touching callers.
 */
@Injectable({ providedIn: 'root' })
export class ArrowStreamService {
  private readonly api = inject(ApiDataService);

  /** Emit the latest value of `url` immediately, then every `intervalMs`. */
  poll<T>(url: string, intervalMs = 5000): Observable<T> {
    return timer(0, intervalMs).pipe(switchMap(() => this.api.get<T>(url)));
  }

  /** Live memory usage for the header. */
  memory(intervalMs = 5000): Observable<MemoryStats> {
    return this.poll<MemoryStats>(API.system.memory, intervalMs);
  }
}
