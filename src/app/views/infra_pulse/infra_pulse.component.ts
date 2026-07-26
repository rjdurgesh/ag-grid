import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * Infrastructure Pulse shell. "Infrastructure Health" and "Service Console" are
 * two independent pages reached from the sidebar — this is just their outlet.
 */
@Component({
  selector: 'app-infra-pulse',
  template: '<router-outlet />',
  imports: [RouterOutlet]
})
export class InfraPulseComponent {}
