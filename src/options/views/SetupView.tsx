import { type FormEvent, useCallback, useEffect, useState } from 'react';
import {
  type AuthStatusSummary,
  DEFAULT_AZURE_TENANT_ID,
  getAuthStatusSummary,
  saveMicrosoftAuthConfig,
} from '../../auth/authStore';
import { ext } from '../../shared/browser';
import type { RuntimeResponse, SyncOverviewState } from '../../shared/messaging';

interface SetupViewProps {
  overview: SyncOverviewState;
  onAuthStateChanged: (nextOverview?: SyncOverviewState) => void;
  onFinish: () => void;
}

interface FeedbackMessage {
  isError: boolean;
  text: string;
}

export function SetupView({ overview, onAuthStateChanged, onFinish }: SetupViewProps) {
  const [authSummary, setAuthSummary] = useState<AuthStatusSummary | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [clientId, setClientId] = useState('');
  const [tenantId, setTenantId] = useState(DEFAULT_AZURE_TENANT_ID);

  const [isRmBusy, setIsRmBusy] = useState(false);
  const [rmFeedback, setRmFeedback] = useState<FeedbackMessage | null>(null);

  const [isMsBusy, setIsMsBusy] = useState(false);
  const [msFeedback, setMsFeedback] = useState<FeedbackMessage | null>(null);
  const [copyFeedback, setCopyFeedback] = useState('');

  const reloadSummary = useCallback(async () => {
    const summary = await getAuthStatusSummary();
    setAuthSummary(summary);
    setClientId((prev) => prev || summary.clientId);
    setTenantId((prev) => (prev === DEFAULT_AZURE_TENANT_ID ? summary.tenantId : prev));
  }, []);

  useEffect(() => {
    void reloadSummary();
  }, [reloadSummary]);

  async function handlePairRemarkable(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsRmBusy(true);
    setRmFeedback(null);

    try {
      const response = (await ext.runtime.sendMessage({
        type: 'PAIR_REMARKABLE',
        code: otpCode,
      })) as RuntimeResponse | undefined;

      if (!response?.ok) {
        throw new Error(response?.error ?? 'Failed to pair reMarkable account.');
      }

      setOtpCode('');
      await reloadSummary();
      onAuthStateChanged(response.state);
      setRmFeedback({
        isError: false,
        text: response.detail ?? 'reMarkable paired successfully.',
      });
    } catch (err) {
      setRmFeedback({
        isError: true,
        text: err instanceof Error ? err.message : 'reMarkable pairing failed.',
      });
    } finally {
      setIsRmBusy(false);
    }
  }

  async function handleVerifyRemarkable() {
    setIsRmBusy(true);
    setRmFeedback(null);
    try {
      const response = (await ext.runtime.sendMessage({
        type: 'VERIFY_REMARKABLE_SESSION',
      })) as RuntimeResponse | undefined;

      if (!response?.ok) {
        throw new Error(response?.error ?? 'Session verification failed.');
      }

      await reloadSummary();
      onAuthStateChanged(response.state);
      setRmFeedback({
        isError: false,
        text: response.detail ?? 'Session token verified.',
      });
    } catch (err) {
      await reloadSummary();
      onAuthStateChanged();
      setRmFeedback({
        isError: true,
        text: err instanceof Error ? err.message : 'Session verification failed.',
      });
    } finally {
      setIsRmBusy(false);
    }
  }

  async function handleDisconnectRemarkable() {
    setIsRmBusy(true);
    setRmFeedback(null);
    try {
      const response = (await ext.runtime.sendMessage({
        type: 'DISCONNECT_REMARKABLE',
      })) as RuntimeResponse | undefined;

      await reloadSummary();
      onAuthStateChanged(response?.ok ? response.state : undefined);
      setRmFeedback({
        isError: false,
        text: 'Disconnected reMarkable device token.',
      });
    } catch (err) {
      setRmFeedback({
        isError: true,
        text: err instanceof Error ? err.message : 'Failed to disconnect reMarkable.',
      });
    } finally {
      setIsRmBusy(false);
    }
  }

  async function handleSignInMicrosoft(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsMsBusy(true);
    setMsFeedback(null);

    try {
      const savedConfig = await saveMicrosoftAuthConfig({ clientId, tenantId });
      setClientId(savedConfig.clientId);
      setTenantId(savedConfig.tenantId);

      const response = (await ext.runtime.sendMessage({
        type: 'SIGN_IN_MICROSOFT',
        clientId: savedConfig.clientId,
        tenantId: savedConfig.tenantId,
      })) as RuntimeResponse | undefined;

      if (!response?.ok) {
        throw new Error(response?.error ?? 'Microsoft sign-in failed.');
      }

      await reloadSummary();
      onAuthStateChanged(response.state);
      setMsFeedback({
        isError: false,
        text: response.detail ?? 'Connected to Microsoft OneNote.',
      });
    } catch (err) {
      setMsFeedback({
        isError: true,
        text: err instanceof Error ? err.message : 'Microsoft sign-in failed.',
      });
    } finally {
      setIsMsBusy(false);
    }
  }

  async function handleVerifyMicrosoft() {
    setIsMsBusy(true);
    setMsFeedback(null);
    try {
      const response = (await ext.runtime.sendMessage({
        type: 'VERIFY_MICROSOFT_SESSION',
      })) as RuntimeResponse | undefined;

      if (!response?.ok) {
        throw new Error(response?.error ?? 'Microsoft session verification failed.');
      }

      await reloadSummary();
      onAuthStateChanged(response.state);
      setMsFeedback({
        isError: false,
        text: response.detail ?? 'Microsoft OneNote access verified.',
      });
    } catch (err) {
      await reloadSummary();
      onAuthStateChanged();
      setMsFeedback({
        isError: true,
        text: err instanceof Error ? err.message : 'Microsoft session verification failed.',
      });
    } finally {
      setIsMsBusy(false);
    }
  }

  async function handleSignOutMicrosoft() {
    setIsMsBusy(true);
    setMsFeedback(null);
    try {
      const response = (await ext.runtime.sendMessage({
        type: 'SIGN_OUT_MICROSOFT',
      })) as RuntimeResponse | undefined;

      await reloadSummary();
      onAuthStateChanged(response?.ok ? response.state : undefined);
      setMsFeedback({
        isError: false,
        text: 'Signed out of Microsoft OneNote.',
      });
    } catch (err) {
      setMsFeedback({
        isError: true,
        text: err instanceof Error ? err.message : 'Failed to sign out of Microsoft.',
      });
    } finally {
      setIsMsBusy(false);
    }
  }

  async function handleCopyRedirectUri() {
    const uri = authSummary?.redirectUri;
    if (!uri) {
      return;
    }
    try {
      await navigator.clipboard.writeText(uri);
      setCopyFeedback('Copied');
      window.setTimeout(() => setCopyFeedback(''), 2000);
    } catch {
      setCopyFeedback('Select and copy manually');
    }
  }

  const rmPaired = authSummary?.remarkablePaired ?? overview.remarkablePaired;
  const msConnected = authSummary?.microsoftConnected ?? overview.microsoftConnected;
  const msAccount = authSummary?.microsoftAccount ?? overview.microsoftAccount;
  const redirectUri = authSummary?.redirectUri ?? '';

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 id="main-heading" tabIndex={-1} className="text-2xl font-semibold text-slate-900">
            Account Setup
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Pair your reMarkable Cloud account and authorize Microsoft OneNote uploads.
          </p>
        </div>

        <button
          type="button"
          onClick={onFinish}
          className="min-h-9 rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100"
        >
          Back to Dashboard
        </button>
      </header>

      {rmPaired && msConnected ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-emerald-300 bg-emerald-50 p-5 text-emerald-950"
        >
          <div>
            <h2 className="text-sm font-semibold">Both Accounts Connected</h2>
            <p className="mt-0.5 text-sm text-emerald-900">
              reMarkable Cloud and Microsoft OneNote tokens are stored locally and configured for
              silent refresh.
            </p>
          </div>
          <button
            type="button"
            onClick={onFinish}
            className="min-h-9 rounded-md bg-emerald-800 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-emerald-900"
          >
            Continue to Dashboard
          </button>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
          <div>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-900">
                1. reMarkable Cloud Pairing
              </h2>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                  rmPaired
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-amber-100 text-amber-800'
                }`}
              >
                {rmPaired ? 'Paired' : 'Not Paired'}
              </span>
            </div>

            <p className="mt-2 text-sm text-slate-600">
              Generate an 8-character one-time code at{' '}
              <a
                href="https://my.remarkable.com/device/desktop/connect"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-brand underline underline-offset-2 hover:text-brand-hover"
              >
                my.remarkable.com/device/desktop/connect
              </a>{' '}
              to register a browser device token.
            </p>

            {rmPaired ? (
              <div className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs text-slate-700">
                  Persistent device token stored in local extension storage
                  {authSummary?.remarkablePairedAt
                    ? ` (paired ${new Date(authSummary.remarkablePairedAt).toLocaleString()}).`
                    : '.'}
                </p>
                <div className="flex flex-wrap gap-2.5">
                  <button
                    type="button"
                    disabled={isRmBusy}
                    onClick={() => void handleVerifyRemarkable()}
                    className="min-h-9 rounded-md bg-brand px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-60"
                  >
                    {isRmBusy ? 'Verifying...' : 'Verify Session Token'}
                  </button>
                  <button
                    type="button"
                    disabled={isRmBusy}
                    onClick={() => void handleDisconnectRemarkable()}
                    className="min-h-9 rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-60"
                  >
                    Disconnect
                  </button>
                </div>
              </div>
            ) : (
              <form
                className="mt-4 space-y-3"
                onSubmit={(e) => void handlePairRemarkable(e)}
              >
                <div>
                  <label
                    htmlFor="rm-otp-code"
                    className="block text-sm font-medium text-slate-700"
                  >
                    One-time pairing code
                  </label>
                  <p id="rm-otp-hint" className="mt-0.5 text-xs text-slate-500">
                    Enter the 8-character code shown on my.remarkable.com (spaces are ignored).
                  </p>
                  <input
                    id="rm-otp-code"
                    name="otpCode"
                    type="text"
                    autoComplete="one-time-code"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={12}
                    required
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value)}
                    placeholder="abcdefgh"
                    aria-describedby="rm-otp-hint"
                    className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-base tracking-widest text-slate-900 shadow-2xs"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isRmBusy}
                  className="min-h-9 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-60"
                >
                  {isRmBusy ? 'Pairing...' : 'Pair reMarkable'}
                </button>
              </form>
            )}
          </div>

          <p
            aria-live="polite"
            className={`mt-3 text-xs font-medium ${
              rmFeedback?.isError ? 'text-red-700' : 'text-emerald-700'
            }`}
          >
            {rmFeedback?.text ?? ''}
          </p>
        </section>

        <section className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
          <div>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-900">
                2. Microsoft OneNote OAuth (PKCE)
              </h2>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                  msConnected
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-amber-100 text-amber-800'
                }`}
              >
                {msConnected ? 'Connected' : 'Not Connected'}
              </span>
            </div>

            <p className="mt-2 text-sm text-slate-600">
              Sign in with Microsoft Entra ID using Authorization Code + PKCE so converted pages
              upload directly to your OneNote notebooks.
            </p>

            {redirectUri ? (
              <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-slate-700">
                    Extension OAuth Redirect URI
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleCopyRedirectUri()}
                    className="min-h-6 rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 transition-colors hover:bg-slate-100"
                  >
                    {copyFeedback || 'Copy URI'}
                  </button>
                </div>
                <code className="mt-1 block break-all font-mono text-xs text-slate-800">
                  {redirectUri}
                </code>
                <p className="mt-1 text-[11px] text-slate-500">
                  Register this exact URI under Authentication &gt; Single-page application in your
                  Azure App Registration.
                </p>
              </div>
            ) : null}

            {msConnected ? (
              <div className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs text-slate-700">
                  Signed in{msAccount ? ` as ${msAccount}` : ''} (Client ID:{' '}
                  <span className="font-mono">{clientId || 'configured'}</span>).
                </p>
                <div className="flex flex-wrap gap-2.5">
                  <button
                    type="button"
                    disabled={isMsBusy}
                    onClick={() => void handleVerifyMicrosoft()}
                    className="min-h-9 rounded-md bg-brand px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-60"
                  >
                    {isMsBusy ? 'Verifying...' : 'Verify OneNote Access'}
                  </button>
                  <button
                    type="button"
                    disabled={isMsBusy}
                    onClick={() => void handleSignOutMicrosoft()}
                    className="min-h-9 rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-60"
                  >
                    Sign Out
                  </button>
                </div>
              </div>
            ) : (
              <form
                className="mt-4 space-y-3"
                onSubmit={(e) => void handleSignInMicrosoft(e)}
              >
                <div>
                  <label
                    htmlFor="ms-client-id"
                    className="block text-sm font-medium text-slate-700"
                  >
                    Azure Application (Client) ID
                  </label>
                  <p id="ms-client-id-hint" className="mt-0.5 text-xs text-slate-500">
                    Defaults to VITE_AZURE_CLIENT_ID if set in .env.local, or paste your App
                    Registration UUID here.
                  </p>
                  <input
                    id="ms-client-id"
                    name="clientId"
                    type="text"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder="00000000-0000-0000-0000-000000000000"
                    aria-describedby="ms-client-id-hint"
                    className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 shadow-2xs"
                  />
                </div>

                <div>
                  <label
                    htmlFor="ms-tenant-id"
                    className="block text-sm font-medium text-slate-700"
                  >
                    Directory (Tenant) ID
                  </label>
                  <p id="ms-tenant-id-hint" className="mt-0.5 text-xs text-slate-500">
                    Keep &quot;common&quot; for personal Microsoft accounts and multi-tenant work or
                    school accounts.
                  </p>
                  <input
                    id="ms-tenant-id"
                    name="tenantId"
                    type="text"
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={tenantId}
                    onChange={(e) => setTenantId(e.target.value)}
                    aria-describedby="ms-tenant-id-hint"
                    className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 shadow-2xs"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isMsBusy}
                  className="min-h-9 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-60"
                >
                  {isMsBusy ? 'Waiting for Microsoft Sign-In...' : 'Sign in with Microsoft'}
                </button>
              </form>
            )}
          </div>

          <p
            aria-live="polite"
            className={`mt-3 text-xs font-medium ${
              msFeedback?.isError ? 'text-red-700' : 'text-emerald-700'
            }`}
          >
            {msFeedback?.text ?? ''}
          </p>
        </section>
      </div>
    </div>
  );
}
