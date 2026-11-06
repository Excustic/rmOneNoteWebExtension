interface SettingsViewProps {
  onOpenSetup: () => void;
}

export function SettingsView({ onOpenSetup }: SettingsViewProps) {
  return (
    <div className="space-y-6">
      <header>
        <h1 id="main-heading" tabIndex={-1} className="text-2xl font-semibold text-slate-900">
          Settings
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Configure autonomous sync cadence, automatic background execution, and linked accounts.
        </p>
      </header>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
        <h2 className="text-base font-semibold text-slate-900">Sync Schedule</h2>
        <p className="mt-1 text-xs text-slate-500">
          {/* TODO(Phase 2 & Phase 7): Persist preferences to chrome.storage.sync and update chrome.alarms. */}
          Preferences will sync across browser profiles via extension sync storage in Phase 2.
        </p>

        <form
          className="mt-4 max-w-md space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <div>
            <label
              htmlFor="sync-interval-minutes"
              className="block text-sm font-medium text-slate-700"
            >
              Sync interval (minutes)
            </label>
            <span id="sync-interval-hint" className="mt-0.5 block text-xs text-slate-500">
              Minimum interval supported by browser background alarms is 1 minute.
            </span>
            <input
              id="sync-interval-minutes"
              type="number"
              min={1}
              max={1440}
              defaultValue={15}
              aria-describedby="sync-interval-hint"
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-2xs"
            />
          </div>

          <div className="flex items-center gap-2.5">
            <input
              id="auto-sync-enabled"
              type="checkbox"
              defaultChecked
              className="h-4 w-4 rounded border-slate-300 text-brand"
            />
            <label htmlFor="auto-sync-enabled" className="text-sm font-medium text-slate-700">
              Enable autonomous background sync
            </label>
          </div>
        </form>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
        <h2 className="text-base font-semibold text-slate-900">Connected Accounts</h2>
        <p className="mt-1 text-sm text-slate-600">
          Re-run onboarding to pair a new reMarkable device token or refresh Microsoft Graph
          consent.
        </p>
        <button
          type="button"
          onClick={onOpenSetup}
          className="mt-4 min-h-9 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100"
        >
          Open Account Setup
        </button>
      </section>
    </div>
  );
}

