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
    title: true,
    name: 'Extras'
  },
  {
    name: 'Pages',
    url: '/login',
    iconComponent: { name: 'cil-star' },
    children: [
      {
        name: 'Login',
        url: '/login',
        icon: 'nav-icon-bullet'
      },
      {
        name: 'Error 404',
        url: '/404',
        icon: 'nav-icon-bullet'
      },
      {
        name: 'Error 500',
        url: '/500',
        icon: 'nav-icon-bullet'
      }
    ]
  },
  {
    title: true,
    name: 'Documentation',
    class: 'mt-auto'
  },
  {
    name: 'Docs',
    url: 'https://coreui.io/angular/docs/',
    iconComponent: { name: 'cil-description' },
    attributes: { target: '_blank' }
  }
];
