import { Component, inject, input } from '@angular/core';
import { Location } from '@angular/common';
import { RouterLink } from '@angular/router';

import { environment } from '../../../../environments/environment';

/**
 * Reusable, on-brand error screen (404 / 500 / …). Full-bleed, theme-aware, with a
 * decorative console backdrop and clear recovery actions — always a route back to Home,
 * plus a context action (Go back, or Try again for server errors). Driven by inputs so a
 * new error page is a one-line wrapper.
 */
@Component({
  selector: 'app-error-page',
  templateUrl: './error-page.component.html',
  styleUrls: ['./error-page.component.scss'],
  imports: [RouterLink]
})
export class ErrorPageComponent {
  private readonly location = inject(Location);

  /** Big glyph, e.g. "404". */
  readonly code = input.required<string>();
  /** Eyebrow above the code, e.g. "Error" / "Server error". */
  readonly eyebrow = input('Error');
  /** Headline, e.g. "Page not found". */
  readonly title = input.required<string>();
  /** Supporting sentence. */
  readonly message = input.required<string>();
  /** Accent tone — 'crit' (red) for server errors, else the brand accent. */
  readonly tone = input<'warn' | 'crit'>('warn');
  /** Show a "Try again" (reload) action + support line (for 5xx) instead of "Go back". */
  readonly reload = input(false);

  readonly supportEmail = environment.supportEmail;

  goBack(): void {
    this.location.back();
  }
  reloadPage(): void {
    window.location.reload();
  }
}
