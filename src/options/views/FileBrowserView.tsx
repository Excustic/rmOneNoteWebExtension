export function FileBrowserView() {
  return (
    <div className="space-y-6">
      <header>
        <h1 id="main-heading" tabIndex={-1} className="text-2xl font-semibold text-slate-900">
          File Browser
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Browse your reMarkable Cloud folder hierarchy and select notebooks to sync into OneNote.
        </p>
      </header>

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
        <h2 className="text-base font-semibold text-slate-900">Cloud Document Tree</h2>
        <p className="mt-2 text-sm text-slate-600">
          {/* TODO(Phase 4 & Phase 8): Populate from reMarkable /document-storage/json/2/docs and persist whitelist to chrome.storage.sync. */}
          Connect your reMarkable account to load folders and notebooks. Whitelisted folders will be
          stored in synced extension preferences.
        </p>
      </div>
    </div>
  );
}
