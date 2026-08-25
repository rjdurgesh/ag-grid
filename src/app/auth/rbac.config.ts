/**
 * RBAC screen registry. Every gate-able page/tab is a "screen key". Adding a new
 * screen later is a one-line change here (plus `data.screen` on its route and a
 * nav entry) — the guard, nav filter and directives all read from this.
 */
export type ScreenKey =
  | 'home'
  | 'log_analytics'
  | 'config_ops_console'
  | 'infra_health'
  | 'service_console'
  | 'oracle_command_center'
  | 'user_management'
  | 'extras'
  | 'docs';

/** All screens (admin / read see every one of these). Note: `user_management` is NOT a normal
 *  opt-in screen — it is gated by the separate `ols_ops_access` table (see RbacService.canView). */
export const ALL_SCREENS: ScreenKey[] = [
  'home',
  'log_analytics',
  'config_ops_console',
  'infra_health',
  'service_console',
  'oracle_command_center',
  'user_management',
  'extras',
  'docs'
];

/** Screens an `is_salt` user may see (and act on). Edit to taste. */
export const SALT_SCREENS: ScreenKey[] = ['home', 'config_ops_console'];

/** Default landing route for each screen (used to redirect to the first allowed one). */
export const SCREEN_ROUTES: Record<ScreenKey, string> = {
  home: '/home',
  log_analytics: '/log_analytics',
  config_ops_console: '/config_ops_console',
  infra_health: '/infra_pulse/infrastructure_health',
  service_console: '/infra_pulse/service_console',
  oracle_command_center: '/oracle_command_center',
  user_management: '/user_management',
  extras: '/login',
  docs: '/home'
};

/** Maps a sidebar nav item URL to its screen key, so the nav can be filtered. */
export function screenForNavUrl(url: string | undefined | any[]): ScreenKey | null {
  const path = Array.isArray(url) ? url.join('/') : (url ?? '');
  if (path.startsWith('/home')) return 'home';
  if (path.startsWith('/log_analytics')) return 'log_analytics';
  if (path.startsWith('/config_ops_console')) return 'config_ops_console';
  if (path.startsWith('/infra_pulse/infrastructure_health')) return 'infra_health';
  if (path.startsWith('/infra_pulse/service_console')) return 'service_console';
  if (path.startsWith('/infra_pulse')) return 'infra_health'; // group parent → visible if health is
  if (path.startsWith('/oracle_command_center')) return 'oracle_command_center';
  if (path.startsWith('/user_management')) return 'user_management';
  if (path.startsWith('/login') || path.startsWith('/404') || path.startsWith('/500')) return 'extras';
  if (path.startsWith('http')) return 'docs';
  return null;
}
