import { Component, inject, signal } from '@angular/core';

import { ButtonDirective } from '@coreui/angular';

import { environment } from '../../../environments/environment';
import { ErrorReportService } from './error-report.service';

/**
 * Error popup for failed INSERT / UPDATE / DELETE (and any other API error).
 * Shows the FULL server message in a scrollable box with Email / Copy / OK /
 * Close. Deliberately a standalone fixed overlay (not a CoreUI modal) so it
 * layers cleanly above the data-grid modal — same approach as app-confirm.
 */
@Component({
  selector: 'app-error-report',
  templateUrl: './error-report.component.html',
  styleUrls: ['./error-report.component.scss'],
  imports: [ButtonDirective]
})
export class ErrorReportComponent {
  private readonly svc = inject(ErrorReportService);

  readonly report = this.svc.current;
  readonly copied = signal(false);

  close(): void {
    this.svc.close();
  }

  async copy(): Promise<void> {
    const r = this.report();
    if (!r) {
      return;
    }
    try {
      await navigator.clipboard.writeText(r.message);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  /** Open the user's mail client with a pre-formatted report to SUPPORT_EMAIL. */
  email(): void {
    const r = this.report();
    if (!r) {
      return;
    }
    const subject = `${r.userId}: Issue with OLS Operations Dashboard - ${reportDate(new Date())}`;
    // mailto bodies are plain text (no bold possible); the error is clearly
    // delimited on its own lines instead.
    const body = [
      'Dear Team,',
      '',
      `User ${r.userId} facing following error while using OLS Operations Dashboard,`,
      'Error:',
      r.message,
      '',
      'Regards,',
      'OLS Team',
    ].join('\r\n');
    const href = `mailto:${environment.supportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = href;
  }
}

/** e.g. 02-Aug-2026 */
function reportDate(d: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dd = String(d.getDate()).padStart(2, '0');
  return `${dd}-${months[d.getMonth()]}-${d.getFullYear()}`;
}
