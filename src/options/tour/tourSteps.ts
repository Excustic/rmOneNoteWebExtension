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
      'Click "Sign in with Microsoft" to connect your Microsoft account (personal, school, or work). Both reMarkable Cloud and Microsoft OneNote must be connected before Sync buttons become active. OAuth tokens stay local in your browser.',
    interactiveHint: 'Try clicking "Sign in with Microsoft" to simulate connecting.',
  },
  {
    id: 'settings-privacy',
    route: 'settings',
    target: 'settings-privacy-section',
    preferredPlacement: 'top',
    emphasis: true,
    title: 'Privacy & Cross-Device Profile Sync',
    description:
      'By default, this extension synchronizes your preferences, folder selections, and rolling page sync history across different devices using your browser profile sync storage (Chrome Sync or Firefox Sync). If you do not want this information stored in your browser profile cloud, enable "Local-only storage mode" here to opt out and keep everything strictly on this device.',
    interactiveHint: 'Toggle "Local-only storage mode" to test keeping all data strictly local.',
  },
  {
    id: 'settings-holistic',
    route: 'settings',
    target: 'settings-container',
    preferredPlacement: 'bottom',
    title: 'Extension Settings, Lifecycle & Portability',
    description:
      'Settings lets you configure autonomous sync frequency, root notebook grouping (default "Documents" -> rm_Documents, or blank for individual notebooks), Mirror vs Preserve deletion/reordering strategy, skipping blank unannotated PDF pages, worker concurrency, layout width, and portable database backups.',
  },
  {
    id: 'dashboard-overview',
    route: 'dashboard',
    target: 'dashboard-overview-cards',
    preferredPlacement: 'bottom',
    title: 'Dashboard: Status Overview & Profile Storage',
    description:
      'These four panels monitor your engine pipeline state, both paired accounts, uploaded/pending/failed page counts, and Profile Storage — showing whether browser profile sync is active (with its last updated timestamp) or set to Local-Only.',
  },
  {
    id: 'dashboard-sync-now',
    route: 'dashboard',
    target: 'dashboard-sync-now-btn',
    preferredPlacement: 'bottom',
    title: 'Sync Progress Phases & Abort Control',
    description:
      'Click "Sync Now" to run an immediate sync cycle. Watch Pipeline State move through Queued (scanning cloud changes), Converting (.rm strokes & PDF backgrounds to InkML), Uploading (sending to OneNote), Indexing (verifying web links), and back to Idle (or Error if an upload fails). An "Abort Sync" button appears while syncing if you ever need to stop cleanly.',
    interactiveHint: 'Click "Sync Now" to watch the demo pipeline transition in real time.',
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
    title: 'Sync Control: File Hierarchy & Progress',
    description:
      'Sync Control mirrors your reMarkable folder and notebook hierarchy. The Engine badge in the top-right shows live progress (Idle, Queued, Converting, Uploading, Indexing, or Error), and an Abort Sync button appears whenever a sync is active. Notebooks with newer tablet edits display an "Out of date" badge.',
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
      'The Pages Inspector lists every page in the selected notebook with checkboxes to run "Sync Selected", individual "Sync" or "Cancel" actions, OneNote web links, file sizes, and sync timestamps.',
  },
  {
    id: 'sync-control-page-tags',
    route: 'sync-control',
    target: 'sync-control-pages-list',
    preferredPlacement: 'left',
    title: 'Understanding Page Status Tags & Badges',
    description:
      'Badges next to each page tell you its exact state: Uploaded / Pending / Queued / Converting / Uploading / Indexing / Failed / Skipped track pipeline progress; "Out of date" means edits happened on the tablet after the last upload; "Moved: Page X -> Page Y" and "Reorder Pending" indicate page reordering; and "0 KB (Blank / No strokes)" marks unannotated pages skipped by default.',
  },
  {
    id: 'sync-control-deleted-pages',
    route: 'sync-control',
    target: 'sync-control-deleted-pages',
    preferredPlacement: 'left',
    title: 'Deleted Pages & Recovery',
    description:
      'Pages removed on your tablet appear under "Deleted Pages" with "Deleted" / "Deleted on tablet" tags. Click "Recover" to upload the preserved page to a dedicated "(Recovered)" OneNote section whenever the cloud blob is still available.',
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
