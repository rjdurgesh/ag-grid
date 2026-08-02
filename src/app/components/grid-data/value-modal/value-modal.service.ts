import { Injectable, signal } from '@angular/core';

import { CellDataType } from '../../../shared/models';

export interface ValueModalPayload {
  type: CellDataType;
  field: string;
  value: unknown;
  /** When true the modal shows an editable textarea with Save / Cancel. */
  editable?: boolean;
  /** Called with the new text when the user saves an editable value. */
  onSave?: (newValue: string) => void;
}

/**
 * Shared, app-wide controller for the "full value" modal. A single
 * {@link ValueModalComponent} (mounted at app root) reacts to `payload`, so any
 * special cell renderer anywhere in the app can pop the full CLOB/JSON/XML/BLOB
 * — read-only for a saved row, or editable while the row is being edited.
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
