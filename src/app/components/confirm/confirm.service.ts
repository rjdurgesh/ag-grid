import { Injectable, signal } from '@angular/core';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Colours the confirm button — use 'danger' for destructive actions. */
  tone?: 'primary' | 'danger' | 'success';
  /** 'confirm' shows Confirm + Cancel; 'notice' shows a single OK (result popup). */
  mode?: 'confirm' | 'notice';
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

/**
 * App-wide confirmation + notice prompt.
 *
 * `ask()` returns a promise that resolves true only when the user confirms, so
 * no mutating action (edit, delete, insert, save) can fire from a stray click.
 * `notify()` shows a single-button result popup (success or error) after an
 * action completes.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly pending = signal<PendingConfirm | null>(null);

  ask(request: ConfirmRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pending.set({ mode: 'confirm', ...request, resolve });
    });
  }

  /** Result popup with a single OK button (e.g. "2 rows updated successfully"). */
  notify(request: Omit<ConfirmRequest, 'mode' | 'cancelLabel'>): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pending.set({ ...request, mode: 'notice', confirmLabel: request.confirmLabel ?? 'OK', resolve });
    });
  }

  accept(): void {
    const current = this.pending();
    this.pending.set(null);
    current?.resolve(true);
  }

  dismiss(): void {
    const current = this.pending();
    this.pending.set(null);
    current?.resolve(false);
  }
}
