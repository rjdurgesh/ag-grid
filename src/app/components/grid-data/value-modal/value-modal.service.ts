import { Injectable, signal } from '@angular/core';

import { CellDataType } from '../../../shared/models';

export interface ValueModalPayload {
  type: CellDataType;
  field: string;
  value: unknown;
}

/**
 * Shared, app-wide controller for the "full value" modal. A single
 * {@link ValueModalComponent} (mounted at app root) reacts to `payload`, so any
 * special cell renderer anywhere in the app can pop the full CLOB/JSON/XML/BLOB.
 */
@Injectable({ providedIn: 'root' })
export class ValueModalService {
  readonly payload = signal<ValueModalPayload | null>(null);

  open(payload: ValueModalPayload): void {
    this.payload.set(payload);
  }

  close(): void {
    this.payload.set(null);
  }
}
