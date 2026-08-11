import { Component, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';

import { environment } from '../../environments/environment';

/**
 * Utility route `/swagger/docs`. Redirects the CURRENT tab straight to the backend's
 * Swagger UI (`{apiBaseUrl}/docs`) — no intermediate prompt. A minimal fallback card
 * shows only if the redirect somehow doesn't fire (e.g. blocked), so the user can click
 * through. The docs URL is derived from `environment.apiBaseUrl`, so it follows whatever
 * backend the app is pointed at — no hardcoded host.
 *
 * Swagger UI is served by FastAPI itself; it lists the real backend routes and lets you
 * exercise each GET/POST with "Try it out".
 */
@Component({
  selector: 'app-swagger-docs',
  templateUrl: './swagger-docs.component.html',
  styleUrls: ['./swagger-docs.component.scss'],
  imports: [RouterLink]
})
export class SwaggerDocsComponent implements OnInit {
  /** FastAPI Swagger UI on the configured backend. */
  readonly docsUrl = `${environment.apiBaseUrl}/docs`;

  ngOnInit(): void {
    // Open Swagger directly in the same tab. `replace` keeps /swagger/docs out of
    // history, so Back returns to the app instead of re-triggering the redirect.
    window.location.replace(this.docsUrl);
  }
}
