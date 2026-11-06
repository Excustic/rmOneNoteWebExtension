interface SetupViewProps {
  onCancel: () => void;
}

export function SetupView({ onCancel }: SetupViewProps) {
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 id="main-heading" tabIndex={-1} className="text-2xl font-semibold text-slate-900">
            Account Setup
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Connect your reMarkable Cloud device token and authorize Microsoft OneNote access.
          </p>
        </div>

        <button
          type="button"
          onClick={onCancel}
          className="min-h-9 rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100"
        >
          Back to Dashboard
        </button>
      </header>

      <div className="grid gap-6 md:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
          <h2 className="text-base font-semibold text-slate-900">1. reMarkable Cloud Pairing</h2>
          <p className="mt-1.5 text-sm text-slate-600">
            {/* TODO(Phase 3): Exchange 8-character OTP against webapp-prod.cloud.remarkable.com/token/json/2/device/new */}
            Enter the 8-character one-time code from your reMarkable account portal to register a
            persistent browser extension device token.
          </p>

          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
            }}
          >
            <div>
              <label htmlFor="rm-otp-code" className="block text-sm font-medium text-slate-700">
                One-time pairing code
              </label>
              <span id="rm-otp-hint" className="mt-0.5 block text-xs text-slate-500">
                8 lowercase letters generated at my.remarkable.com (Phase 3).
              </span>
              <input
                id="rm-otp-code"
                type="text"
                maxLength={8}
                placeholder="abcdefgh"
                aria-describedby="rm-otp-hint"
                className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 shadow-2xs"
              />
            </div>

            <button
              type="submit"
              disabled
              className="min-h-9 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white opacity-60"
            >
              Pair reMarkable (Phase 3)
            </button>
          </form>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
          <h2 className="text-base font-semibold text-slate-900">2. Microsoft OneNote OAuth</h2>
          <p className="mt-1.5 text-sm text-slate-600">
            {/* TODO(Phase 3): Launch PKCE OAuth flow via chrome.identity.launchWebAuthFlow */}
            Sign in with Microsoft Entra ID using PKCE so notebooks can be uploaded directly from
            your browser to OneNote.
          </p>

          <div className="mt-4">
            <button
              type="button"
              disabled
              className="min-h-9 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white opacity-60"
            >
              Sign in with Microsoft (Phase 3)
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
