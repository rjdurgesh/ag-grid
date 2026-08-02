import { Component, computed, effect, inject, signal } from '@angular/core';

import { ButtonDirective } from '@coreui/angular';

import { ValueModalService } from './value-modal.service';

/**
 * App-wide modal that shows (and, in edit mode, edits) the full content of a
 * CLOB/JSON/XML/BLOB cell, pretty-printed. Driven by {@link ValueModalService};
 * mounted once at app root.
 *
 * Deliberately NOT a CoreUI `c-modal`: nested inside the data-grid's own
 * `c-modal`, CoreUI's shared backdrop/dismiss machinery collapsed the underlying
 * modal whenever this one closed. This is a standalone fixed overlay layered
 * above everything, so closing it never touches another modal's state.
 */
@Component({
  selector: 'app-value-modal',
  templateUrl: './value-modal.component.html',
  styleUrls: ['./value-modal.component.scss'],
  imports: [ButtonDirective]
})
export class ValueModalComponent {
  private readonly svc = inject(ValueModalService);

  readonly payload = this.svc.payload;

  /** Working copy of the text while editing. */
  readonly draft = signal('');

  readonly editable = computed(() => this.payload()?.editable === true);

  readonly title = computed(() => {
    const p = this.payload();
    if (!p) {
      return '';
    }
    return `${p.type.toUpperCase()} · ${p.field}`;
  });

  readonly formatted = computed(() => {
    const p = this.payload();
    if (!p) {
      return '';
    }
    return formatValue(p.type, p.value);
  });

  constructor() {
    // Seed the textarea with the current (pretty-printed) value each time an
    // editable payload opens.
    effect(() => {
      const p = this.payload();
      if (p?.editable) {
        this.draft.set(formatValue(p.type, p.value));
      }
    });
  }

  onDraftInput(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }

  /** Commit the edited text back to the originating cell, then close. */
  save(): void {
    const p = this.payload();
    p?.onSave?.(this.draft());
    this.svc.close();
  }

  close(): void {
    this.svc.close();
  }

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.editable() ? this.draft() : this.formatted());
    } catch {
      /* clipboard unavailable — ignore */
    }
  }
}

/** Pretty-print a value according to its logical type. */
export function formatValue(type: string, value: unknown): string {
  const raw = value == null ? '' : String(value);
  switch (type) {
    case 'json':
      try {
        const obj = typeof value === 'string' ? JSON.parse(value) : value;
        return JSON.stringify(obj, null, 2);
      } catch {
        return raw;
      }
    case 'xml':
      return formatXml(raw);
    default:
      return raw;
  }
}

/** Lightweight XML indenter (no external dependency). */
function formatXml(xml: string): string {
  const withBreaks = xml.replace(/>\s*</g, '>\n<');
  let indent = 0;
  return withBreaks
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (/^<\/\w/.test(trimmed)) {
        indent = Math.max(indent - 1, 0);
      }
      const padded = '  '.repeat(indent) + trimmed;
      if (/^<\w[^>]*[^/]>$/.test(trimmed) && !/^<.*<\/.*>$/.test(trimmed) && !/\?>$/.test(trimmed)) {
        indent++;
      }
      return padded;
    })
    .join('\n');
}
