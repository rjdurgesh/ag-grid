import { Injectable, signal } from '@angular/core';

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Colours the confirm button — use 'danger' for destructive actions. */
  tone?: 'primary' | 'danger' | 'success';
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

/**
 * App-wide confirmation prompt.
 *
 * `ask()` returns a promise that resolves true only when the user confirms, so
 * no mutating action (edit, delete, insert, save) can fire from a stray click.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  readonly pending = signal<PendingConfirm | null>(null);

  ask(request: ConfirmRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pending.set({ ...request, resolve });
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
