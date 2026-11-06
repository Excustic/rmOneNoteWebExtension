export function LogsView() {
  return (
    <div className="space-y-6">
      <header>
        <h1 id="main-heading" tabIndex={-1} className="text-2xl font-semibold text-slate-900">
          Diagnostic Logs
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Structured background worker events, Graph API throttling retries, and WASM parser output.
        </p>
      </header>

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
        <h2 className="text-base font-semibold text-slate-900">Recent Events</h2>
        <pre
          tabIndex={0}
          className="mt-3 max-h-96 overflow-auto rounded-lg bg-slate-900 p-4 font-mono text-xs text-slate-200"
        >
          <code>[system] Extension scaffold initialized. Awaiting background sync events.</code>
        </pre>
      </div>
    </div>
  );
}

