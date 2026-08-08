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

  /** Live memory usage for the header (polling fallback — see {@link memoryStream}). */
  memory(intervalMs = 5000): Observable<MemoryStats> {
    return this.poll<MemoryStats>(API.system.memory, intervalMs);
  }

  /**
   * Live memory as **Server-Sent Events** — ONE long-lived connection that streams
   * a snapshot every couple of seconds, instead of a request every N seconds. Keeps
   * the network tab clean (a single entry). Uses the native `EventSource`, which
   * bypasses HttpClient/the mock and always hits the real backend; it auto-reconnects
   * on a dropped connection and is closed when the caller unsubscribes.
   */
  memoryStream(): Observable<MemoryStats> {
    return this.sse<MemoryStats>(API.system.memoryStream);
  }

  /** Wrap a Server-Sent Events endpoint as an Observable of parsed messages. */
  private sse<T>(url: string): Observable<T> {
    return new Observable<T>((subscriber) => {
      const source = new EventSource(url);
      source.onmessage = (event) => {
        try {
          subscriber.next(JSON.parse(event.data) as T);
        } catch {
          /* ignore a malformed frame */
        }
      };
      // EventSource reconnects on its own; don't tear the stream down on a transient
      // error (e.g. the backend restarting) — let the browser retry.
      source.onerror = () => { /* keep-alive; browser handles retry */ };
      return () => source.close();
    });
  }
}
