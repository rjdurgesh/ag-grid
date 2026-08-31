import { inject, Injectable } from '@angular/core';
import { map, Observable } from 'rxjs';

import { ApiDataService } from '../../shared/api-data.service';
import { API, apiEnv } from '../../shared/api-endpoints';
import { environment } from '../../../environments/environment';
import { DocContent, DocEntry } from '../../shared/models';
import { USER_KEY } from '../../auth/sso-auth.service';

/**
 * Data access for the Documentation Center.
 *
 * {@link catalog} returns the wiki links + local `.md` docs the caller may see (technical docs are
 * filtered server-side by role — see docs_api.py). {@link content} returns ONE doc's raw markdown,
 * addressed by opaque `id`; the component renders + sanitizes it client-side ({@link DocsRenderService}).
 * `caller` is sent in the body (never the URL) so the username stays out of logs/query strings.
 */
@Injectable({ providedIn: 'root' })
export class DocsService {
  private readonly api = inject(ApiDataService);

  /** The RBAC-filtered catalogue for the signed-in user. */
  catalog(): Observable<DocEntry[]> {
    return this.api
      .post<{ status?: string; entries?: DocEntry[] }>(API.docs.catalog, {
        caller: this.caller(),
        app_env: apiEnv(environment.appEnv)
      })
      .pipe(map((r) => r?.entries ?? []));
  }

  /** Raw markdown of one local doc (RBAC re-checked server-side). */
  content(id: string): Observable<DocContent> {
    return this.api
      .post<{ status?: string; doc?: DocContent }>(API.docs.content, { caller: this.caller(), id })
      .pipe(map((r) => r?.doc ?? { id, title: '', markdown: '' }));
  }

  /** UID of the signed-in user (falls back to the demo user), matching RbacService. */
  private caller(): string {
    try {
      const raw = localStorage.getItem(USER_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { username?: string };
        if (parsed?.username) {
          return parsed.username;
        }
      }
    } catch {
      /* ignore malformed storage */
    }
    return environment.username;
  }
}
