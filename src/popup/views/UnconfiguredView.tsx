import type { SyncOverviewState } from '../../shared/messaging';

interface UnconfiguredViewProps {
  overview: SyncOverviewState;
  onStartSetup: () => void;
  onOpenDashboard: () => void;
}

export function UnconfiguredView({
  overview,
  onStartSetup,
  onOpenDashboard,
}: UnconfiguredViewProps) {
  return (
    <div className="flex flex-1 flex-col justify-between gap-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-2xs">
        <h2 className="text-sm font-semibold text-slate-900">Connect Your Accounts</h2>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
          Pair your reMarkable Cloud account and sign in to Microsoft OneNote in a full tab so popup
          focus changes do not interrupt authentication.
        </p>
        <dl className="mt-3 space-y-1 border-t border-slate-100 pt-2.5 text-xs">
          <div className="flex items-center justify-between">
            <dt className="text-slate-500">reMarkable Cloud</dt>
            <dd className="font-medium text-slate-800">
              {overview.remarkablePaired ? 'Paired' : 'Not paired'}
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-slate-500">Microsoft OneNote</dt>
            <dd className="font-medium text-slate-800">
              {overview.microsoftConnected ? 'Connected' : 'Not connected'}
            </dd>
          </div>
        </dl>
        {overview.remarkablePaired && !overview.microsoftConnected ? (
          <p className="mt-2.5 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] font-medium text-amber-900">
            reMarkable is paired. Connect Microsoft OneNote in Setup before you can sync notebooks.
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={onStartSetup}
          className="min-h-9 w-full rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover"
        >
          Complete Setup
        </button>
        <button
          type="button"
          onClick={onOpenDashboard}
          className="min-h-8 w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100"
        >
          Open Dashboard Shell
        </button>
      </div>
    </div>
  );
}

