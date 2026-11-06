import {
  clearRemarkableAuth,
  getRemarkableAuth,
  type RemarkableAuthState,
  saveRemarkableAuth,
} from './authStore';
import { extractJwtExpiryMs } from './jwt';

export const REMARKABLE_AUTH_HOST = 'https://webapp-prod.cloud.remarkable.engineering';
export const REMARKABLE_DEVICE_TOKEN_URL = `${REMARKABLE_AUTH_HOST}/token/json/2/device/new`;
export const REMARKABLE_USER_TOKEN_URL = `${REMARKABLE_AUTH_HOST}/token/json/2/user/new`;

/**
 * Client descriptor matching `ddvk/rmapi` (`api/auth.go`) accepted by `/token/json/2/device/new`.
 */
export const REMARKABLE_DEVICE_DESC = 'desktop-linux';

const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const FALLBACK_USER_TOKEN_TTL_MS = 23 * 60 * 60 * 1000;
const OTP_PATTERN = /^[a-z0-9]{8}$/;

let inflightUserTokenRefresh: Promise<string> | null = null;

export function normalizeRemarkableOtp(rawCode: string): string {
  const normalized = rawCode.replace(/[\s-]+/g, '').toLowerCase();
  if (!OTP_PATTERN.test(normalized)) {
    throw new Error(
      'One-time pairing code must be 8 letters or digits (for example: abcdefgh).',
    );
  }
  return normalized;
}

async function requestRemarkableUserToken(
  deviceToken: string,
  fetchImpl: typeof fetch,
): Promise<{ userToken: string; expiresAtMs: number }> {
  let response: Response;
  try {
    response = await fetchImpl(REMARKABLE_USER_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        Accept: 'text/plain',
      },
      body: '',
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Network error contacting reMarkable Cloud (${REMARKABLE_AUTH_HOST}): ${detail}. Ensure extension host permissions are granted in your browser.`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    await clearRemarkableAuth();
    throw new Error(
      'reMarkable device token was revoked or expired. Please pair again in Account Setup.',
    );
  }

  if (!response.ok) {
    throw new Error(
      `Failed to refresh reMarkable session token (HTTP ${response.status}).`,
    );
  }

  const userToken = (await response.text()).trim();
  if (!userToken) {
    throw new Error('reMarkable Cloud returned an empty user session token.');
  }

  const expiresAtMs =
    extractJwtExpiryMs(userToken) ?? Date.now() + FALLBACK_USER_TOKEN_TTL_MS;

  return { userToken, expiresAtMs };
}

/**
 * Exchanges an 8-character one-time code from `my.remarkable.com` for a persistent
 * `deviceToken`, immediately verifies it by minting an initial `userToken`, and persists
 * both in `browser.storage.local`.
 */
export async function pairRemarkableDevice(
  rawCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RemarkableAuthState> {
  const code = normalizeRemarkableOtp(rawCode);
  const deviceId = crypto.randomUUID();

  let response: Response;
  try {
    response = await fetchImpl(REMARKABLE_DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer',
        'Content-Type': 'application/json',
        Accept: 'text/plain',
      },
      body: JSON.stringify({
        code,
        deviceDesc: REMARKABLE_DEVICE_DESC,
        deviceID: deviceId,
      }),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Network error contacting reMarkable Cloud (${REMARKABLE_AUTH_HOST}): ${detail}. Ensure extension host permissions are granted in your browser.`,
    );
  }

  if (response.status === 400 || response.status === 401) {
    throw new Error(
      'Invalid or expired pairing code. Generate a new 8-character code at my.remarkable.com and try again.',
    );
  }

  if (!response.ok) {
    throw new Error(
      `reMarkable device registration failed (HTTP ${response.status}).`,
    );
  }

  const deviceToken = (await response.text()).trim();
  if (!deviceToken) {
    throw new Error('reMarkable Cloud returned an empty device token.');
  }

  const { userToken, expiresAtMs } = await requestRemarkableUserToken(
    deviceToken,
    fetchImpl,
  );

  const authState: RemarkableAuthState = {
    deviceId,
    deviceToken,
    userToken,
    userTokenExpiresAtMs: expiresAtMs,
    pairedAt: new Date().toISOString(),
  };

  await saveRemarkableAuth(authState);
  return authState;
}

export interface GetRemarkableTokenOptions {
  forceRefresh?: boolean;
  fetchImpl?: typeof fetch;
}

/**
 * Returns a valid short-lived reMarkable `userToken`, silently refreshing via the
 * stored `deviceToken` when within 5 minutes of expiry or when `forceRefresh` is set.
 */
export async function getValidRemarkableUserToken(
  options: GetRemarkableTokenOptions = {},
): Promise<string> {
  const { forceRefresh = false, fetchImpl = fetch } = options;
  const stored = await getRemarkableAuth();

  if (!stored) {
    throw new Error('reMarkable Cloud is not paired. Complete pairing in Account Setup.');
  }

  if (
    !forceRefresh &&
    stored.userToken &&
    stored.userTokenExpiresAtMs !== null &&
    stored.userTokenExpiresAtMs - Date.now() > TOKEN_EXPIRY_BUFFER_MS
  ) {
    return stored.userToken;
  }

  const runRefresh = async (): Promise<string> => {
    const latest = await getRemarkableAuth();
    if (!latest) {
      throw new Error('reMarkable Cloud is not paired. Complete pairing in Account Setup.');
    }

    const { userToken, expiresAtMs } = await requestRemarkableUserToken(
      latest.deviceToken,
      fetchImpl,
    );

    await saveRemarkableAuth({
      ...latest,
      userToken,
      userTokenExpiresAtMs: expiresAtMs,
    });

    return userToken;
  };

  if (fetchImpl !== fetch) {
    return runRefresh();
  }

  if (!inflightUserTokenRefresh) {
    inflightUserTokenRefresh = runRefresh().finally(() => {
      inflightUserTokenRefresh = null;
    });
  }

  return inflightUserTokenRefresh;
}

/**
 * Authenticated `fetch` interceptor for reMarkable Cloud API requests.
 * Injects `Authorization: Bearer <userToken>` and transparently refreshes + retries once on HTTP 401.
 */
export async function fetchWithRemarkableAuth(
  input: string | URL,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const token = await getValidRemarkableUserToken({ fetchImpl });
  const firstHeaders = new Headers(init.headers);
  firstHeaders.set('Authorization', `Bearer ${token}`);

  const firstResponse = await fetchImpl(input, {
    ...init,
    headers: firstHeaders,
  });

  if (firstResponse.status !== 401) {
    return firstResponse;
  }

  const refreshedToken = await getValidRemarkableUserToken({
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

export async function disconnectRemarkableDevice(): Promise<void> {
  await clearRemarkableAuth();
}

