import type { SyncOverviewState } from '../../shared/messaging';
import type { OptionsRouteId } from '../../shared/routes';

interface DashboardViewProps {
  overview: SyncOverviewState;
  onNavigate: (route: OptionsRouteId) => void;
  onDismissBackupWarning: () => void;
}

export function DashboardView({
  overview,
  onNavigate,
  onDismissBackupWarning,
}: DashboardViewProps) {
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 id="main-heading" tabIndex={-1} className="text-2xl font-semibold text-slate-900">
            Dashboard
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Overview of your reMarkable Cloud connection, OneNote target notebook, and sync status.
          </p>
        </div>

        <button
          type="button"
          onClick={() => onNavigate(overview.isConfigured ? 'sync-status' : 'setup')}
          className="min-h-10 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover"
        >
          {overview.isConfigured ? 'Inspect Sync Queue' : 'Configure Accounts'}
        </button>
      </header>

      {overview.needsBackupImport ? (
        <div
          role="status"
          className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-amber-950"
        >
          <h2 className="text-sm font-semibold">Older Sync History Omitted from Browser Sync</h2>
          <p className="mt-1 text-sm leading-relaxed text-amber-900">
            {overview.missingHistoryCount} older synced page record
            {overview.missingHistoryCount === 1 ? ' was' : 's were'} omitted from cross-browser sync
            storage due to extension quota limits. Before syncing on this PC, export a database
            backup file from your previous browser and import it in Settings to avoid re-uploading
            older pages.
          </p>
          <div className="mt-3.5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => onNavigate('settings')}
              className="min-h-9 rounded-md bg-amber-900 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-950"
            >
              Import Backup in Settings
            </button>
            <button
              type="button"
              onClick={onDismissBackupWarning}
              className="min-h-9 rounded-md border border-amber-400 bg-white px-3.5 py-1.5 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-100"
            >
              Dismiss Warning
            </button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Pipeline State
          </h2>
          <p className="mt-2 text-xl font-semibold text-slate-900">{overview.phase}</p>
          <p className="mt-1 text-xs text-slate-500">
            Autonomous background alarm engine wires in Phase 7.
          </p>
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Account Pairing
          </h2>
          <p className="mt-2 text-xl font-semibold text-slate-900">
            {overview.isConfigured
              ? 'Connected'
              : overview.remarkablePaired || overview.microsoftConnected
                ? '1 of 2 Connected'
                : 'Pending'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {overview.isConfigured
              ? `reMarkable paired${overview.microsoftAccount ? ` | ${overview.microsoftAccount}` : ' | Microsoft connected'}`
              : `reMarkable: ${overview.remarkablePaired ? 'Paired' : 'Unpaired'} | Microsoft: ${overview.microsoftConnected ? 'Connected' : 'Pending'}`}
          </p>
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Indexed Pages
          </h2>
          <p className="mt-2 text-xl font-semibold text-slate-900">{overview.indexedPagesCount}</p>
          <p className="mt-1 text-xs text-slate-500">
            Stored locally in IndexedDB and synced via rolling ledger.
          </p>
        </article>
      </div>
    </div>
  );
}
