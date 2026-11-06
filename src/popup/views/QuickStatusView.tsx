import type { SyncOverviewState } from '../../shared/messaging';

interface QuickStatusViewProps {
  overview: SyncOverviewState;
  isSyncing: boolean;
  onManualSync: () => void;
  onOpenRoute: (route: string) => void;
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTimestamp(isoString: string | null): string {
  if (!isoString) {
    return 'Never synced';
  }
  const parsed = new Date(isoString);
  return Number.isNaN(parsed.getTime()) ? 'Never synced' : dateFormatter.format(parsed);
}

export function QuickStatusView({
  overview,
  isSyncing,
  onManualSync,
  onOpenRoute,
}: QuickStatusViewProps) {
  return (
    <div className="flex flex-1 flex-col justify-between gap-4">
      <div className="rounded-lg border border-slate-200 bg-white p-3.5 shadow-2xs">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Sync Engine
          </h2>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
            <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
            {overview.phase}
          </span>
        </div>

        <dl className="mt-3 space-y-1.5 text-xs">
          <div className="flex items-center justify-between">
            <dt className="text-slate-500">Last synced</dt>
            <dd className="font-medium text-slate-800">{formatTimestamp(overview.lastSyncedAt)}</dd>
          </div>
        </dl>

        {overview.lastError ? (
          <p role="alert" className="mt-2.5 rounded bg-red-50 p-2 text-xs text-red-700">
            {overview.lastError}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          disabled={isSyncing}
          onClick={onManualSync}
          className="min-h-9 w-full rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSyncing ? 'Syncing...' : 'Sync Now'}
        </button>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => onOpenRoute('sync-status')}
            className="min-h-8 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100"
          >
            Sync Queue
          </button>
          <button
            type="button"
            onClick={() => onOpenRoute('files')}
            className="min-h-8 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100"
          >
            Select Folders
          </button>
        </div>
      </div>
    </div>
  );
}

