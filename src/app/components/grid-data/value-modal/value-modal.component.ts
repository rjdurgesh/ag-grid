import { Component, computed, inject } from '@angular/core';

import {
  ButtonCloseDirective,
  ButtonDirective,
  ModalBodyComponent,
  ModalComponent,
  ModalFooterComponent,
  ModalHeaderComponent,
  ModalTitleDirective
} from '@coreui/angular';

import { ValueModalService } from './value-modal.service';

/**
 * App-wide modal that shows the full content of a CLOB/JSON/XML/BLOB cell,
 * pretty-printed. Driven by {@link ValueModalService}; mounted once at app root.
 */
@Component({
  selector: 'app-value-modal',
  templateUrl: './value-modal.component.html',
  imports: [
    ModalComponent,
    ModalHeaderComponent,
    ModalTitleDirective,
    ModalBodyComponent,
    ModalFooterComponent,
    ButtonDirective,
    ButtonCloseDirective
  ]
})
export class ValueModalComponent {
  private readonly svc = inject(ValueModalService);

  readonly payload = this.svc.payload;

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

  onVisibleChange(open: boolean): void {
    if (!open) {
      this.svc.close();
    }
  }

  close(): void {
    this.svc.close();
  }

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.formatted());
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
