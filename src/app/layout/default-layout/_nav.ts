import { INavData } from '@coreui/angular';

export const navItems: INavData[] = [
  {
    name: 'Home',
    url: '/home',
    iconComponent: { name: 'cil-home' }
  },
  {
    title: true,
    name: 'Tools'
  },
  {
    name: 'Log Analytics Hub',
    url: '/log_analytics',
    iconComponent: { name: 'cil-notes' }
  },
  {
    name: 'Config Ops Console',
    url: '/config_ops_console',
    iconComponent: { name: 'cil-spreadsheet' },
    children: [
      {
        name: 'OLS GROUP',
        url: '/config_ops_console/group',
        iconComponent: { name: 'cil-share-boxed' }
      },
      {
        name: 'OLS CIB',
        url: '/config_ops_console/cib',
        iconComponent: { name: 'cil-share-boxed' }
      },
      {
        name: 'OLS RETAIL',
        url: '/config_ops_console/retail',
        iconComponent: { name: 'cil-share-boxed' }
      }
    ]
  },
  {
    name: 'Infrastructure Pulse',
    url: '/infra_pulse',
    iconComponent: { name: 'cil-magnifying-glass' },
    children: [
      {
        name: 'Infrastructure Health',
        url: '/infra_pulse/infrastructure_health',
        iconComponent: { name: 'cil-chart-line' }
      },
      {
        name: 'Service Console',
        url: '/infra_pulse/service_console',
        iconComponent: { name: 'cil-terminal' }
      }
    ]
  },
  {
    name: 'Oracle Command Center',
    url: '/oracle_command_center',
    iconComponent: { name: 'cil-layers' }
  },
  {
    // Only rendered for ops-admins (ols_ops_access) — the nav filter drops the whole group
    // when its single item is not viewable. Deliberately separate from the Tools group above.
    title: true,
    name: 'Administration'
  },
  {
    name: 'User Management',
    url: '/user_management',
    iconComponent: { name: 'cil-people' }
  },
  {
    title: true,
    name: 'Documentation',
    class: 'mt-auto'
  },
  {
    name: 'Docs',
    url: '/docs',
    iconComponent: { name: 'cil-description' },
    children: [
      {
        name: 'User Guide',
        url: '/docs/user-guide',
        iconComponent: { name: 'cil-bookmark' }
      },
      {
        // Auto-hidden for non-technical users by the nav filter (screen key `docs_technical`).
        name: 'Technical Guide',
        url: '/docs/technical-guide',
        iconComponent: { name: 'cil-code' }
      }
    ]
  }
];
