import { Component, input } from '@angular/core';

export type LoaderVariant = 'spinner' | 'skeleton' | 'bar';
export type LoaderSize = 'sm' | 'md' | 'lg';

/**
 * Reusable OLS loading indicator.
 *
 * Variants:
 *  - `spinner`  : counter-rotating gradient rings with a pulsing core
 *  - `skeleton` : shimmering placeholder rows (best while a table/list loads)
 *  - `bar`      : slim indeterminate progress sweep
 *
 * Set `overlay` to float it above the host panel with a blurred backdrop.
 */
@Component({
  selector: 'app-loader',
  templateUrl: './loader.component.html',
  styleUrls: ['./loader.component.scss'],
  host: {
    '[class.ols-loader-host--overlay]': 'overlay()'
  }
})
export class LoaderComponent {
  readonly variant = input<LoaderVariant>('spinner');
  readonly size = input<LoaderSize>('md');
  readonly overlay = input(false);
  readonly message = input('');
  /** Number of shimmer rows for the skeleton variant. */
  readonly rows = input(6);

  get skeletonRows(): number[] {
    return Array.from({ length: this.rows() }, (_, i) => i);
  }
}
