import type { SyncOverviewState } from '../../shared/messaging';

interface SyncStatusViewProps {
  overview: SyncOverviewState;
}

export function SyncStatusView({ overview }: SyncStatusViewProps) {
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 id="main-heading" tabIndex={-1} className="text-2xl font-semibold text-slate-900">
            Sync Status
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Live page conversion states (`Queued`, `Converting`, `Uploading`, `Indexing`) and
            verified OneNote links.
          </p>
        </div>

        <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700">
          <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
          Engine: {overview.phase}
        </span>
      </header>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-2xs">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="visually-hidden">Synchronized reMarkable pages and statuses</caption>
          <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase">
            <tr>
              <th scope="col" className="px-5 py-3.5">
                Notebook / Page
              </th>
              <th scope="col" className="px-5 py-3.5">
                Stage
              </th>
              <th scope="col" className="px-5 py-3.5">
                Last Updated
              </th>
              <th scope="col" className="px-5 py-3.5">
                OneNote Link
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            <tr>
              <td colSpan={4} className="px-5 py-8 text-center text-sm text-slate-500">
                {/* TODO(Phase 2 & Phase 8): Bind to Dexie.js Pages table via live query. */}
                No pages recorded in local sync database yet.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
