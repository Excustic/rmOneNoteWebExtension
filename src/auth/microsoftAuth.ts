import { ext } from '../shared/browser';
import {
  clearMicrosoftAuth,
  DEFAULT_AZURE_TENANT_ID,
  getMicrosoftAuth,
  getMicrosoftAuthConfig,
  type MicrosoftAuthConfig,
  type MicrosoftAuthState,
  resolveExtensionRedirectUri,
  saveMicrosoftAuth,
  saveMicrosoftAuthConfig,
} from './authStore';
import { extractAccountNameFromIdToken } from './jwt';
import { createPkcePair, generateOAuthState } from './pkce';

export const MICROSOFT_GRAPH_SCOPES = [
  'openid',
  'profile',
  'offline_access',
  'Notes.ReadWrite',
  'Notes.Read',
  'Notes.Create',
] as const;

const SCOPE_STRING = MICROSOFT_GRAPH_SCOPES.join(' ');
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

let inflightMsRefresh: Promise<string> | null = null;

interface EntraTokenSuccessPayload {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

interface EntraTokenErrorPayload {
  error?: string;
  error_description?: string;
  error_codes?: number[];
}

export function buildMicrosoftAuthorizeUrl(params: {
  clientId: string;
  tenantId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}): string {
  const query = new URLSearchParams({
    client_id: params.clientId,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    response_mode: 'query',
    scope: SCOPE_STRING,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    state: params.state,
    prompt: 'select_account',
  });

  return `https://login.microsoftonline.com/${encodeURIComponent(params.tenantId)}/oauth2/v2.0/authorize?${query.toString()}`;
}

export function parseAuthorizationCallbackUrl(
  callbackUrl: string,
  expectedState: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    throw new Error('Microsoft sign-in returned a malformed callback URL.');
  }

  const params = parsed.searchParams.size > 0
    ? parsed.searchParams
    : new URLSearchParams(parsed.hash.replace(/^#/, ''));

  const oauthError = params.get('error');
  if (oauthError) {
    const desc = params.get('error_description') ?? oauthError;
    throw new Error(`Microsoft sign-in failed: ${desc}`);
  }

  const returnedState = params.get('state');
  if (!returnedState || returnedState !== expectedState) {
    throw new Error('Microsoft sign-in failed OAuth state verification.');
  }

  const code = params.get('code');
  if (!code) {
    throw new Error('Microsoft sign-in callback did not include an authorization code.');
  }

  return code;
}

function formatEntraTokenError(
  status: number,
  bodyText: string,
  redirectUri?: string,
): { message: string; isInvalidGrant: boolean } {
  let parsed: EntraTokenErrorPayload | null = null;
  try {
    parsed = JSON.parse(bodyText) as EntraTokenErrorPayload;
  } catch {
    parsed = null;
  }

  const codes = parsed?.error_codes ?? [];
  const isInvalidGrant = parsed?.error === 'invalid_grant';

  if (codes.includes(50011)) {
    return {
      message: `Redirect URI mismatch (AADSTS50011). Add "${redirectUri ?? 'browser redirect URI'}" under Authentication > Single-page application in your Azure App Registration.`,
      isInvalidGrant: false,
    };
  }

  if (codes.includes(9002326)) {
    return {
      message:
        'Platform type mismatch (AADSTS9002326). Move the extension Redirect URI in Azure Portal to the "Single-page application (SPA)" platform.',
      isInvalidGrant: false,
    };
  }

  if (codes.includes(9002327)) {
    return {
      message:
        'Origin header rejected for SPA client (AADSTS9002327). Ensure the extension executes CORS token redemption or register the Firefox Redirect URI under "Mobile and desktop applications".',
      isInvalidGrant: false,
    };
  }

  if (codes.includes(700016)) {
    return {
      message:
        'Application (Client) ID was not found in Microsoft Entra ID (AADSTS700016). Verify your Client ID and Tenant ID.',
      isInvalidGrant: false,
    };
  }

  if (isInvalidGrant) {
    return {
      message:
        'Microsoft OneNote authorization expired or was revoked. Please sign in again in Account Setup.',
      isInvalidGrant: true,
    };
  }

  const detail = parsed?.error_description?.split('\r\n')[0] ?? parsed?.error ?? `HTTP ${status}`;
  return {
    message: `Microsoft token request failed: ${detail}`,
    isInvalidGrant: false,
  };
}

export interface SignInMicrosoftOptions extends Partial<MicrosoftAuthConfig> {
  fetchImpl?: typeof fetch;
  launchWebAuthFlowImpl?: (details: { url: string; interactive?: boolean }) => Promise<string>;
  redirectUriOverride?: string;
}

/**
 * Executes interactive OAuth 2.0 Authorization Code + PKCE sign-in via
 * `browser.identity.launchWebAuthFlow` and persists tokens in `browser.storage.local`.
 */
export async function signInWithMicrosoftInteractive(
  options: SignInMicrosoftOptions = {},
): Promise<MicrosoftAuthState> {
  const {
    fetchImpl = fetch,
    launchWebAuthFlowImpl = (details) => ext.identity.launchWebAuthFlow(details),
    redirectUriOverride,
    ...configPatch
  } = options;

  let config = await getMicrosoftAuthConfig();
  if (configPatch.clientId !== undefined || configPatch.tenantId !== undefined) {
    config = await saveMicrosoftAuthConfig(configPatch);
  }

  if (!config.clientId) {
    throw new Error(
      'Microsoft Application (Client) ID is not configured. Enter your Azure Client ID or set VITE_AZURE_CLIENT_ID in .env.local.',
    );
  }

  const tenantId = config.tenantId || DEFAULT_AZURE_TENANT_ID;
  const redirectUri = redirectUriOverride ?? resolveExtensionRedirectUri();
  if (!redirectUri) {
    throw new Error('Browser identity API did not return an extension Redirect URI.');
  }

  const { codeVerifier, codeChallenge } = await createPkcePair();
  const state = generateOAuthState();

  const authorizeUrl = buildMicrosoftAuthorizeUrl({
    clientId: config.clientId,
    tenantId,
    redirectUri,
    codeChallenge,
    state,
  });

  let callbackUrl: string;
  try {
    callbackUrl = await launchWebAuthFlowImpl({
      url: authorizeUrl,
      interactive: true,
    });
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    if (/cancel|denied|closed/i.test(rawMsg)) {
      throw new Error('Microsoft sign-in was cancelled.');
    }
    throw new Error(`Microsoft sign-in failed to complete: ${rawMsg}`);
  }

  const authCode = parseAuthorizationCallbackUrl(callbackUrl, state);

  const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
  const formBody = new URLSearchParams({
    client_id: config.clientId,
    grant_type: 'authorization_code',
    code: authCode,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    scope: SCOPE_STRING,
  });

  const tokenResponse = await fetchImpl(tokenUrl, {
    method: 'POST',
    mode: 'cors',
    credentials: 'omit',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: formBody.toString(),
  });

  const bodyText = await tokenResponse.text();
  if (!tokenResponse.ok) {
    const formatted = formatEntraTokenError(tokenResponse.status, bodyText, redirectUri);
    throw new Error(formatted.message);
  }

  const payload = JSON.parse(bodyText) as EntraTokenSuccessPayload;
  if (!payload.access_token || !payload.refresh_token) {
    throw new Error(
      'Microsoft token response did not include both access_token and refresh_token (verify offline_access scope).',
    );
  }

  const expiresInSec =
    typeof payload.expires_in === 'number' && payload.expires_in > 0
      ? payload.expires_in
      : 3600;

  const authState: MicrosoftAuthState = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAtMs: Date.now() + expiresInSec * 1000,
    accountName: extractAccountNameFromIdToken(payload.id_token),
    clientId: config.clientId,
    tenantId,
    connectedAt: new Date().toISOString(),
  };

  await saveMicrosoftAuth(authState);
  return authState;
}

export interface GetMicrosoftTokenOptions {
  forceRefresh?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Returns a valid Microsoft Graph `accessToken`, silently exchanging the stored
 * `refreshToken` when within 5 minutes of expiry or when `forceRefresh` is requested.
 */
export async function getValidMicrosoftAccessToken(
  options: GetMicrosoftTokenOptions = {},
): Promise<string> {
  const { forceRefresh = false, fetchImpl = fetch } = options;
  const stored = await getMicrosoftAuth();

  if (!stored) {
    throw new Error('Microsoft OneNote is not connected. Sign in from Account Setup.');
  }

  if (!forceRefresh && stored.expiresAtMs - Date.now() > TOKEN_EXPIRY_BUFFER_MS) {
    return stored.accessToken;
  }

  const runRefresh = async (): Promise<string> => {
    const latest = await getMicrosoftAuth();
    if (!latest) {
      throw new Error('Microsoft OneNote is not connected. Sign in from Account Setup.');
    }

    const config = await getMicrosoftAuthConfig();
    const clientId = latest.clientId || config.clientId;
    const tenantId = latest.tenantId || config.tenantId || DEFAULT_AZURE_TENANT_ID;

    if (!clientId) {
      throw new Error('Microsoft Client ID is missing; cannot refresh access token.');
    }

    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
    const formBody = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: latest.refreshToken,
      scope: SCOPE_STRING,
    });

    const response = await fetchImpl(tokenUrl, {
      method: 'POST',
      mode: 'cors',
      credentials: 'omit',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: formBody.toString(),
    });

    const bodyText = await response.text();
    if (!response.ok) {
      const formatted = formatEntraTokenError(response.status, bodyText);
      if (formatted.isInvalidGrant) {
        await clearMicrosoftAuth();
      }
      throw new Error(formatted.message);
    }

    const payload = JSON.parse(bodyText) as EntraTokenSuccessPayload;
    if (!payload.access_token) {
      throw new Error('Microsoft refresh response did not contain an access_token.');
    }

    const expiresInSec =
      typeof payload.expires_in === 'number' && payload.expires_in > 0
        ? payload.expires_in
        : 3600;

    const nextState: MicrosoftAuthState = {
      ...latest,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? latest.refreshToken,
      expiresAtMs: Date.now() + expiresInSec * 1000,
      accountName: extractAccountNameFromIdToken(payload.id_token) ?? latest.accountName,
      clientId,
      tenantId,
    };

    await saveMicrosoftAuth(nextState);
    return nextState.accessToken;
  };

  if (fetchImpl !== fetch) {
    return runRefresh();
  }

  if (!inflightMsRefresh) {
    inflightMsRefresh = runRefresh().finally(() => {
      inflightMsRefresh = null;
    });
  }

  return inflightMsRefresh;
}

/**
 * Authenticated `fetch` interceptor for Microsoft Graph OneNote API calls.
 * Injects `Authorization: Bearer <accessToken>` and transparently refreshes + retries once on HTTP 401.
 */
export async function fetchWithMicrosoftAuth(
  input: string | URL,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const token = await getValidMicrosoftAccessToken({ fetchImpl });
  const firstHeaders = new Headers(init.headers);
  firstHeaders.set('Authorization', `Bearer ${token}`);

  const firstResponse = await fetchImpl(input, {
    ...init,
    headers: firstHeaders,
  });

  if (firstResponse.status !== 401) {
    return firstResponse;
  }

  const refreshedToken = await getValidMicrosoftAccessToken({
    forceRefresh: true,
    fetchImpl,
  });
  const retryHeaders = new Headers(init.headers);
  retryHeaders.set('Authorization', `Bearer ${refreshedToken}`);

  return fetchImpl(input, {
    ...init,
    headers: retryHeaders,
  });
}

export async function signOutMicrosoft(): Promise<void> {
  await clearMicrosoftAuth();
}
