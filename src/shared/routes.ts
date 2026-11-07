export type OptionsRouteId =
  | 'dashboard'
  | 'sync-control'
  | 'settings'
  | 'setup';

export interface OptionsRouteDefinition {
  id: OptionsRouteId;
  label: string;
  pageTitle: string;
  iconPlaceholderName: string;
  showInSidebar: boolean;
}

export const OPTIONS_ROUTES: readonly OptionsRouteDefinition[] = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    pageTitle: 'Dashboard | reMarkable OneNote Sync',
    iconPlaceholderName: 'Dashboard',
    showInSidebar: true,
  },
  {
    id: 'sync-control',
    label: 'Sync Control',
    pageTitle: 'Sync Control | reMarkable OneNote Sync',
    iconPlaceholderName: 'Sync Control',
    showInSidebar: true,
  },
  {
    id: 'settings',
    label: 'Settings',
    pageTitle: 'Settings | reMarkable OneNote Sync',
    iconPlaceholderName: 'Settings',
    showInSidebar: true,
  },
  {
    id: 'setup',
    label: 'Account Setup',
    pageTitle: 'Account Setup | reMarkable OneNote Sync',
    iconPlaceholderName: 'Account Setup',
    showInSidebar: false,
  },
] as const;

export const DEFAULT_OPTIONS_ROUTE: OptionsRouteId = 'dashboard';

const VALID_ROUTE_IDS = new Set<string>(OPTIONS_ROUTES.map((route) => route.id));

export function parseOptionsHash(hash: string): OptionsRouteId {
  const raw = hash.replace(/^#\/?/, '').trim().toLowerCase();
  if (raw === 'files' || raw === 'sync-status') {
    return 'sync-control';
  }
  if (VALID_ROUTE_IDS.has(raw)) {
    return raw as OptionsRouteId;
  }
  return DEFAULT_OPTIONS_ROUTE;
}

export function getRouteDefinition(id: OptionsRouteId): OptionsRouteDefinition {
  const match = OPTIONS_ROUTES.find((route) => route.id === id);
  return match ?? OPTIONS_ROUTES[0];
}
