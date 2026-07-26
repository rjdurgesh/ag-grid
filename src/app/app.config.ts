import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { ApplicationConfig } from '@angular/core';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import {
  provideRouter,
  withEnabledBlockingInitialNavigation,
  withInMemoryScrolling,
  withRouterConfig
} from '@angular/router';
import { IconSetService } from '@coreui/icons-angular';
import { routes } from './app.routes';
import { authInterceptor } from './auth/auth.interceptor';
import { mockApiInterceptor } from './shared/mock-api.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes,
      withRouterConfig({
        onSameUrlNavigation: 'reload'
      }),
      withInMemoryScrolling({
        scrollPositionRestoration: 'top',
        anchorScrolling: 'enabled'
      }),
      withEnabledBlockingInitialNavigation()
      // NOTE: withViewTransitions() was removed. A stuck view transition
      // ("Transition was aborted") leaves a transform/contain containing block
      // on the document, which traps position:fixed overlays (the data modal)
      // inside the page content instead of covering the viewport.
      //
      // Clean (hash-less) URLs: withHashLocation() was removed so routes render as
      // /home, /log_analytics, etc. This needs `<base href="/">` (index.html) and a
      // server that serves index.html for unknown paths (SPA fallback). `ng serve`
      // does this in dev; for production configure your web server accordingly.
    ),
    // authInterceptor attaches the bearer token; mockApiInterceptor answers the
    // dummy endpoints. Remove mockApiInterceptor (or set USE_MOCK=false) for a real backend.
    provideHttpClient(withInterceptors([authInterceptor, mockApiInterceptor])),
    IconSetService,
    provideAnimationsAsync()
  ]
};

