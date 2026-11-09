import type { OptionsRouteId } from '../../shared/routes';

export interface TourStepDefinition {
  id: string;
  route: OptionsRouteId;
  /**
   * The value of the `data-tour` attribute on the DOM element to highlight.
   * If null, the step is rendered as a centered modal.
   */
  target: string | null;
  title: string;
  description: string;
  preferredPlacement?: 'top' | 'bottom' | 'left' | 'right' | 'center';
  primaryButtonLabel?: string;
  emphasis?: boolean;
  interactiveHint?: string;
}

export const TOUR_STEPS: readonly TourStepDefinition[] = [
  {
    id: 'welcome',
    route: 'dashboard',
    target: null,
    preferredPlacement: 'center',
    title: 'Welcome to reMarkable OneNote Sync',
    description:
      'This interactive tour will guide you through setting up your accounts, monitoring sync status, and choosing which notebooks automatically sync to OneNote. You are currently in an interactive Demo Mode where you can test buttons and features safely without affecting your real data.',
    primaryButtonLabel: 'Start Tour',
  },
  {
    id: 'setup-overview',
    route: 'setup',
    target: 'setup-header',
    preferredPlacement: 'bottom',
    title: 'Account Setup Overview',
    description:
      'Connecting accounts is the first step. The extension securely pairs with reMarkable Cloud to read your notebooks, and connects to Microsoft OneNote via Microsoft Graph to upload your notes into native notebook sections.',
  },
  {
    id: 'setup-remarkable',
    route: 'setup',
    target: 'setup-remarkable-section',
    preferredPlacement: 'bottom',
    title: '1. reMarkable Cloud Pairing',
    description:
      'To connect your reMarkable, visit my.remarkable.com/device/browser/connect to generate an 8-character code, then enter it here. In this demo, you can enter any code or click "Pair reMarkable" to simulate pairing!',
    interactiveHint: 'Try typing a code and clicking "Pair reMarkable" to test the flow.',
  },
  {
    id: 'setup-microsoft',
    route: 'setup',
    target: 'setup-microsoft-section',
    preferredPlacement: 'bottom',
    title: '2. Microsoft OneNote Account',
    description:
      'Click "Sign in with Microsoft" to connect your Microsoft account (personal, school, or work). OAuth refresh tokens are stored safely in your local browser and automatically refreshed for autonomous background syncing.',
    interactiveHint: 'Try clicking "Sign in with Microsoft" to simulate connecting.',
  },
  {
    id: 'dashboard-overview',
    route: 'dashboard',
    target: 'dashboard-overview-cards',
    preferredPlacement: 'bottom',
    title: 'Dashboard: Status Overview',
    description:
      'The Dashboard is your command center. These three status panels monitor your background engine state (Idle, Converting, or Uploading), your paired reMarkable and Microsoft accounts, and the total count of successfully synchronized pages.',
  },
  {
    id: 'dashboard-sync-now',
    route: 'dashboard',
    target: 'dashboard-sync-now-btn',
    preferredPlacement: 'bottom',
    title: 'Immediate Sync on Demand',
    description:
      'Whenever you finish writing on your reMarkable tablet and want your notes in OneNote immediately without waiting for the scheduled background sync, click "Sync Now". Click it now to watch the demo update in real time!',
    interactiveHint: 'Click "Sync Now" to trigger a simulated synchronization cycle.',
  },
  {
    id: 'dashboard-resize-divider',
    route: 'dashboard',
    target: 'container-resize-divider',
    preferredPlacement: 'left',
    title: 'Resizable Container Divider',
    description:
      'Notice the subtle vertical dividers on the left and right edges of the main area. You can hover and drag either divider horizontally to resize the dashboard layout to fit your screen, or double-click to reset back to default.',
    interactiveHint: 'Hover over or drag the vertical divider handle to resize the container.',
  },
  {
    id: 'dashboard-activity',
    route: 'dashboard',
    target: 'dashboard-activity-section',
    preferredPlacement: 'top',
    title: '30-Day Activity & Page Links',
    description:
      'Every synchronized page from the last 30 days is recorded here. Filter by Uploaded, Active, or Failed, and search by notebook title. The "Open in OneNote" link opens that specific note directly in OneNote on the web.',
  },
  {
    id: 'sync-control-load',
    route: 'sync-control',
    target: 'sync-control-load-btn',
    preferredPlacement: 'bottom',
    title: 'Loading Cloud Folders',
    description:
      'Cloud notebooks and folders do not appear automatically when opening Sync Control for the first time. Click "Load Folders" to query reMarkable Cloud and retrieve your latest notebooks and folder structure.',
    interactiveHint: 'Click "Load Folders" to fetch or refresh your notebooks from the cloud.',
  },
  {
    id: 'sync-control-tree',
    route: 'sync-control',
    target: 'sync-control-tree',
    preferredPlacement: 'top',
    title: 'Sync Control: File Hierarchy',
    description:
      'Sync Control displays your full reMarkable folder and notebook hierarchy. This is where you configure which folders and notebooks are synchronized to Microsoft OneNote.',
  },
  {
    id: 'sync-control-folder-select',
    route: 'sync-control',
    target: 'sync-control-folder-checkbox',
    preferredPlacement: 'right',
    emphasis: true,
    title: 'Automatic Future Syncing for Folders',
    description:
      'IMPORTANT: When you select a folder checkbox, it is selected for automatic future syncing. Any new notebook or page you create inside this folder on your reMarkable tablet in the future will automatically be discovered and synced to OneNote without needing to re-configure!',
    interactiveHint: 'Try checking or unchecking the folder checkbox.',
  },
  {
    id: 'sync-control-save',
    route: 'sync-control',
    target: 'sync-control-save-btn',
    preferredPlacement: 'bottom',
    title: 'Saving Your Whitelist Selection',
    description:
      'Whenever you adjust your folder or document selections, click "Save Selection". Your choices are saved to extension sync storage so your sync preferences carry over to all your browsers.',
  },
  {
    id: 'sync-control-inspect',
    route: 'sync-control',
    target: 'sync-control-doc-row',
    preferredPlacement: 'right',
    title: 'Inspecting Notebook Pages',
    description:
      'Click directly on any notebook name (like "Calculus 1" or "Linear Algebra") to open the slide-in Document Pages Inspector panel on the right. Try clicking on "Calculus 1" now!',
    interactiveHint: 'Click the notebook name "Calculus 1" to open its pages panel.',
  },
  {
    id: 'sync-control-pages-panel',
    route: 'sync-control',
    target: 'sync-control-pages-panel',
    preferredPlacement: 'left',
    title: 'Document Pages & Individual Sync',
    description:
      'The Pages Inspector lists every page in the notebook with its sync status, file size, and timestamp. You can select individual pages to sync immediately, retry failed uploads, or open them in OneNote.',
  },
  {
    id: 'settings-holistic',
    route: 'settings',
    target: 'settings-container',
    preferredPlacement: 'bottom',
    title: 'Extension Settings & Portability',
    description:
      'Settings lets you fine-tune autonomous sync frequency, set default target OneNote sections, adjust container dimensions, and manage local database backups. Backups allow seamlessly transferring full sync histories to fresh browsers and PCs.',
  },
  {
    id: 'tour-sidebar-button',
    route: 'dashboard',
    target: 'sidebar-tour-btn',
    preferredPlacement: 'right',
    title: 'Restart the Tour Anytime',
    description:
      'Whenever you want a refresher on any feature or want to safely experiment in demo mode, click "Take Interactive Tour" here at the bottom of the sidebar. Click "Finish Tour" to exit demo mode and start syncing your notes!',
    primaryButtonLabel: 'Finish Tour',
  },
];
