import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

/**
 * Thin, reusable wrapper around {@link HttpClient}.
 *
 * Feature services inject this instead of HttpClient directly, so every call
 * shares the same typing/ergonomics and future cross-cutting concerns (retry,
 * base URL rewriting, etc.) can be added in one place.
 */
@Injectable({ providedIn: 'root' })
export class ApiDataService {
  private readonly http = inject(HttpClient);

  get<T>(url: string, params?: Record<string, string | number | boolean>): Observable<T> {
    return this.http.get<T>(url, { params: this.toParams(params) });
  }

  post<T>(url: string, body: unknown): Observable<T> {
    return this.http.post<T>(url, body);
  }

  put<T>(url: string, body: unknown): Observable<T> {
    return this.http.put<T>(url, body);
  }

  delete<T>(url: string, params?: Record<string, string | number | boolean>): Observable<T> {
    return this.http.delete<T>(url, { params: this.toParams(params) });
  }

  private toParams(params?: Record<string, string | number | boolean>): HttpParams | undefined {
    if (!params) {
      return undefined;
    }
    let httpParams = new HttpParams();
    for (const [key, value] of Object.entries(params)) {
      httpParams = httpParams.set(key, String(value));
    }
    return httpParams;
  }
}
