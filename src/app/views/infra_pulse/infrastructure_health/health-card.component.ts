import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { environment } from '../../../../environments/environment';
import { formatDateTime } from '../../../shared/date-utils';
import { HealthMetric, HealthStatus, HealthTarget, HEALTH_THRESHOLDS } from '../../../shared/infra-models';

/**
 * A single server / share monitoring card (the `space.jpg` tile): OS icon,
 * hostname, per-metric bars with threshold ticks, and two header controls —
 * refresh (re-fetch just this server) and info (show its details). Overall
 * colour comes from the target's worst metric.
 *
 * OnPush so a page with many cards only re-renders the card whose `target` input
 * actually changed — not all of them on every global tick (e.g. the header's live
 * memory feed ticks every few seconds).
 */
@Component({
  selector: 'app-health-card',
  templateUrl: './health-card.component.html',
  styleUrls: ['./health-card.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class HealthCardComponent {
  readonly target = input.required<HealthTarget>();
  /** App label shown on the card when the page is grouped by status. */
  readonly appLabel = input('');
  readonly showApp = input(false);
  /** Spins the card's refresh icon while its single-server fetch is in flight. */
  readonly refreshing = input(false);

  readonly refresh = output<void>();
  readonly info = output<void>();

  readonly warnAt = HEALTH_THRESHOLDS.warn;
  readonly critAt = HEALTH_THRESHOLDS.crit;

  /** Support contact shown on an unreachable card — sourced from environment. */
  readonly supportEmail = environment.supportEmail;

  osLabel(): string {
    const os = this.target().os;
    return os === 'windows' ? 'WINDOWS' : os === 'linux' ? 'LINUX' : 'ShareDrive';
  }

  metricValue(metric: HealthMetric): string {
    if (metric.unit === '%') {
      return `${metric.percent}%`;
    }
    return `${metric.used.toFixed(2)} ${metric.unit} / ${metric.total.toFixed(2)} ${metric.unit} = ${metric.percent}%`;
  }

  statusText(status: HealthStatus): string {
    return status === 'crit' ? 'Critical' : status === 'warn' ? 'Warning' : 'Healthy';
  }

  readonly formatDateTime = formatDateTime;
  trackMetric = (_: number, metric: HealthMetric): string => metric.label;
}
