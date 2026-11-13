import { type FormEvent, useCallback, useEffect, useState } from 'react';
import type { AuthStatusSummary } from '../../auth/authStore';
import { ext } from '../../shared/browser';
import type { RuntimeResponse, SyncOverviewState } from '../../shared/messaging';
import { useDataSource } from '../context/DataSourceContext';

interface SetupViewProps {
  overview: SyncOverviewState;
  onAuthStateChanged: (nextOverview?: SyncOverviewState) => void;
  onFinish: () => void;
}

interface FeedbackMessage {
  isError: boolean;
  text: string;
}

const REMARKABLE_HOST_ORIGINS = [
  'https://webapp-prod.cloud.remarkable.engineering/*',
  'https://internal.cloud.remarkable.com/*',
  'https://*.storage.googleapis.com/*',
];

const MICROSOFT_HOST_ORIGINS = [
  'https://login.microsoftonline.com/*',
  'https://graph.microsoft.com/*',
];

/**
 * Synchronously initiates `permissions.request` inside the active user-gesture turn
 * before any `await` gap. Required in Firefox MV3 where `host_permissions` are not
 * always auto-granted at install time; resolves immediately to `true` in Chromium.
 */
function requestHostOriginsFromGesture(origins: string[]): Promise<boolean> {
  if (ext.permissions && typeof ext.permissions.request === 'function') {
    return ext.permissions.request({ origins });
  }
  return Promise.resolve(true);
}

export function SetupView({ overview, onAuthStateChanged, onFinish }: SetupViewProps) {
  const { sendMessage, getAuthSummary, isDemo } = useDataSource();
  const [authSummary, setAuthSummary] = useState<AuthStatusSummary | null>(null);
  const [otpCode, setOtpCode] = useState('');

  const [isRmBusy, setIsRmBusy] = useState(false);
  const [rmFeedback, setRmFeedback] = useState<FeedbackMessage | null>(null);

  const [isMsBusy, setIsMsBusy] = useState(false);
  const [msFeedback, setMsFeedback] = useState<FeedbackMessage | null>(null);
  const [copyFeedback, setCopyFeedback] = useState('');

  const reloadSummary = useCallback(async () => {
    const summary = await getAuthSummary();
    setAuthSummary(summary);
  }, [getAuthSummary]);

  useEffect(() => {
    void reloadSummary();
  }, [reloadSummary]);

  async function handlePairRemarkable(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const permissionPromise = isDemo ? Promise.resolve(true) : requestHostOriginsFromGesture(REMARKABLE_HOST_ORIGINS);
    setIsRmBusy(true);
    setRmFeedback(null);

    try {
      const granted = await permissionPromise;
      if (!granted) {
        throw new Error(
          'Host permission for reMarkable Cloud was denied. Allow access when prompted or enable Permissions in about:addons.',
        );
      }

      const response = (await sendMessage({
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
    const permissionPromise = isDemo ? Promise.resolve(true) : requestHostOriginsFromGesture(REMARKABLE_HOST_ORIGINS);
    setIsRmBusy(true);
    setRmFeedback(null);
    try {
      const granted = await permissionPromise;
      if (!granted) {
        throw new Error(
          'Host permission for reMarkable Cloud was denied. Allow access when prompted or enable Permissions in about:addons.',
        );
      }

      const response = (await sendMessage({
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
      const response = (await sendMessage({
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

  async function handleSignInMicrosoft() {
    const permissionPromise = isDemo ? Promise.resolve(true) : requestHostOriginsFromGesture(MICROSOFT_HOST_ORIGINS);
    setIsMsBusy(true);
    setMsFeedback(null);

    try {
      const granted = await permissionPromise;
      if (!granted) {
        throw new Error(
          'Host permission for Microsoft OneNote was denied. Allow access when prompted or enable Permissions in about:addons.',
        );
      }

      const response = (await sendMessage({
        type: 'SIGN_IN_MICROSOFT',
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
    const permissionPromise = isDemo ? Promise.resolve(true) : requestHostOriginsFromGesture(MICROSOFT_HOST_ORIGINS);
    setIsMsBusy(true);
    setMsFeedback(null);
    try {
      const granted = await permissionPromise;
      if (!granted) {
        throw new Error(
          'Host permission for Microsoft OneNote was denied. Allow access when prompted or enable Permissions in about:addons.',
        );
      }

      const response = (await sendMessage({
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
      const response = (await sendMessage({
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
  const hasBuiltInClientId = Boolean(authSummary?.clientId);
  const redirectUri = authSummary?.redirectUri ?? '';

  return (
    <div className="space-y-6">
      <header
        data-tour="setup-header"
        className="flex flex-wrap items-center justify-between gap-4"
      >
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
        <section
          data-tour="setup-remarkable-section"
          className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-6 shadow-2xs"
        >
          <div>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-900">
                1. reMarkable Cloud Pairing
              </h2>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${rmPaired
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
                href="https://my.remarkable.com/device/browser/connect"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-brand underline underline-offset-2 hover:text-brand-hover"
              >
                my.remarkable.com/device/browser/connect
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
                    autoCapitalize="off"
                    spellCheck={false}
                    maxLength={8}
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
            className={`mt-3 text-xs font-medium ${rmFeedback?.isError ? 'text-red-700' : 'text-emerald-700'
              }`}
          >
            {rmFeedback?.text ?? ''}
          </p>
        </section>

        <section
          data-tour="setup-microsoft-section"
          className="flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-6 shadow-2xs"
        >
          <div>
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-900">
                2. Microsoft OneNote Account
              </h2>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${msConnected
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-amber-100 text-amber-800'
                  }`}
              >
                {msConnected ? 'Connected' : 'Not Connected'}
              </span>
            </div>

            <p className="mt-2 text-sm text-slate-600">
              Sign in with your personal, work, or school Microsoft account so converted notebook
              pages upload directly into OneNote.
            </p>

            {authSummary && !hasBuiltInClientId ? (
              <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3.5 text-amber-950">
                <p className="text-xs font-semibold">Maintainer Configuration Pending</p>
                <p className="mt-1 text-xs text-amber-900">
                  Set <code className="font-mono">BUILT_IN_AZURE_CLIENT_ID</code> in{' '}
                  <code className="font-mono">src/auth/authStore.ts</code> so users sign in with one
                  click. Register this browser&apos;s Redirect URI in your Azure App Registration:
                </p>
                {redirectUri ? (
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-white px-2.5 py-1.5">
                    <code className="break-all font-mono text-xs text-slate-800">
                      {redirectUri}
                    </code>
                    <button
                      type="button"
                      onClick={() => void handleCopyRedirectUri()}
                      className="min-h-7 rounded border border-slate-300 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100"
                    >
                      {copyFeedback || 'Copy URI'}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}

            {msConnected ? (
              <div className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <p className="text-xs text-slate-700">
                  Signed in{msAccount ? ` as ${msAccount}` : ''}. Refresh token stored locally for
                  autonomous background uploads.
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
              <div className="mt-5">
                <button
                  type="button"
                  disabled={isMsBusy}
                  onClick={() => void handleSignInMicrosoft()}
                  className="min-h-9 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-60"
                >
                  {isMsBusy ? 'Waiting for Microsoft Sign-In...' : 'Sign in with Microsoft'}
                </button>
              </div>
            )}
          </div>

          <p
            aria-live="polite"
            className={`mt-3 text-xs font-medium ${msFeedback?.isError ? 'text-red-700' : 'text-emerald-700'
              }`}
          >
            {msFeedback?.text ?? ''}
          </p>
        </section>
      </div>
    </div>
  );
}
