import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * Config Ops Console shell. GROUP / CIB / RETAIL are three independent pages
 * (separate datasets) reached from the sidebar — this is just their outlet.
 */
@Component({
  selector: 'app-config-ops-console',
  template: '<router-outlet />',
  imports: [RouterOutlet]
})
export class ConfigOpsConsoleComponent {}
