import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, from, switchMap, throwError } from 'rxjs';

import { AuthService } from './auth.service';

/** Marks a request that has already been retried once after a silent renew, so a second 401
 *  can't loop. Stripped from the outgoing request (it's an internal flag). */
const RETRY_HEADER = 'X-Auth-Retry';

/**
 * Attaches the bearer token to every request, and — under SSO — recovers from an expired token
 * WITHOUT leaving the page: a 401 triggers a single silent refresh-token renewal, then the original
 * request is retried transparently. Only if the refresh itself fails (the session is genuinely gone)
 * does the user go to /login. The proactive timer (SsoAuthService.scheduleRenew) usually renews
 * before expiry; this is the safety net for when it doesn't (e.g. the machine was asleep).
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const token = auth.token;
  const authed = token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req;

  return next(authed).pipe(
    catchError((err: unknown) => {
      // Only attempt silent re-auth for a 401, under SSO, and at most once per request.
      if (!(err instanceof HttpErrorResponse) || err.status !== 401
          || !auth.ssoEnabled || req.headers.has(RETRY_HEADER)) {
        return throwError(() => err);
      }
      return from(auth.tryRenew()).pipe(
        switchMap((ok) => {
          if (!ok) {
            router.navigate(['/login']);           // refresh gone → genuine re-login needed
            return throwError(() => err);
          }
          const fresh = auth.token;                // retry the SAME request on the SAME page
          const retried = req.clone({
            setHeaders: { Authorization: `Bearer ${fresh}`, [RETRY_HEADER]: '1' }
          });
          return next(retried);
        })
      );
    })
  );
};
