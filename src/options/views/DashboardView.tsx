import type { SyncOverviewState } from '../../shared/messaging';
import type { OptionsRouteId } from '../../shared/routes';

interface DashboardViewProps {
  overview: SyncOverviewState;
  onNavigate: (route: OptionsRouteId) => void;
}

export function DashboardView({ overview, onNavigate }: DashboardViewProps) {
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
            {overview.isConfigured ? 'Connected' : 'Pending'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            reMarkable OTP and MS Graph PKCE wire in Phase 3.
          </p>
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Indexed Pages
          </h2>
          <p className="mt-2 text-xl font-semibold text-slate-900">0</p>
          <p className="mt-1 text-xs text-slate-500">
            Dexie.js IndexedDB tables initialize in Phase 2.
          </p>
        </article>
      </div>
    </div>
  );
}

