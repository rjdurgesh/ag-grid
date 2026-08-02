import { Injectable, signal } from '@angular/core';

/** A failed operation to surface in the error popup. */
export interface ErrorReport {
  /** Popup title, e.g. "Insert failed". */
  title: string;
  /** The full error message from the API (may span many lines). */
  message: string;
  /** Acting user id — included in the emailed report + its subject line. */
  userId: string;
}

/**
 * App-wide error popup controller. A single {@link ErrorReportComponent} (mounted
 * at app root) reacts to `current`, so any feature can surface an API error with
 * the full message + Email / Copy actions.
 */
@Injectable({ providedIn: 'root' })
export class ErrorReportService {
  readonly current = signal<ErrorReport | null>(null);

  show(report: ErrorReport): void {
    this.current.set(report);
  }

  close(): void {
    this.current.set(null);
  }
}
