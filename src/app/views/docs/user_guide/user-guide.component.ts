import { Component } from '@angular/core';

import { DocsBrowserComponent } from '../docs-browser.component';

/**
 * User Guide screen (`/docs/user-guide`, screen key `docs`). Its own screen/component so it can evolve
 * independently of the Technical Guide (e.g. gain its own sub-tabs later). Renders the shared
 * {@link DocsBrowserComponent} scoped to the `user` audience — user-facing markdown docs + wiki links.
 */
@Component({
  selector: 'app-user-guide',
  template: '<app-docs-browser audience="user" />',
  imports: [DocsBrowserComponent]
})
export class UserGuideComponent {}
