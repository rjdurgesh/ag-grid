import { Component, input } from '@angular/core';

/**
 * OSHIVA — the animated robot mascot (a pure-CSS robot: bobbing body, blinking eyes, pulsing antenna).
 * Reusable at any size; `busy` makes the antenna glow amber and quickens the bob while the agent thinks.
 * Authored at 34px and scaled via `--sz`. Fully static under `prefers-reduced-motion` (office default).
 * Adapted from the standalone chat_bot widget reference.
 */
@Component({
  selector: 'app-oshiva-robot',
  standalone: true,
  host: {
    '[style.width.px]': 'size()',
    '[style.height.px]': 'size()',
    '[style.--sz]': 'size()'
  },
  template: `
    <span class="rb" [class.is-busy]="busy()" aria-hidden="true">
      <span class="antenna"><span class="bulb"></span></span>
      <span class="head">
        <span class="ear l"></span><span class="ear r"></span>
        <span class="face">
          <span class="eye l"><span class="pupil"></span></span>
          <span class="eye r"><span class="pupil"></span></span>
          <span class="mouth"></span>
        </span>
      </span>
    </span>`,
  styleUrls: ['./oshiva-robot.component.scss']
})
export class OshivaRobotComponent {
  /** Rendered size in px (the robot is authored at 34px and scaled to fit). */
  readonly size = input(34);
  /** Thinking state — amber antenna + quicker bob. */
  readonly busy = input(false);
}
