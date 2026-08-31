import { Component } from '@angular/core';

import { DocsBrowserComponent } from '../docs-browser.component';

/**
 * Technical Guide screen (`/docs/technical-guide`, screen key `docs_technical`). Its own screen/component,
 * independent of the User Guide. Renders the shared {@link DocsBrowserComponent} scoped to the
 * `technical` audience — technical markdown docs + wiki links (design, internals, runbooks).
 */
@Component({
  selector: 'app-technical-guide',
  template: '<app-docs-browser audience="technical" />',
  imports: [DocsBrowserComponent]
})
export class TechnicalGuideComponent {}
