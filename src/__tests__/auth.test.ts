import { beforeEach, describe, expect, it } from 'vitest';
import {
  derivePkceCodeChallengeS256,
  encodeBytesToBase64Url,
  extractAccountNameFromIdToken,
  extractJwtExpiryMs,
  fetchWithMicrosoftAuth,
  fetchWithRemarkableAuth,
  generatePkceCodeVerifier,
  getAuthStatusSummary,
  getMicrosoftAuth,
  getRemarkableAuth,
  getValidMicrosoftAccessToken,
  getValidRemarkableUserToken,
  normalizeRemarkableOtp,
  pairRemarkableDevice,
  REMARKABLE_DEVICE_DESC,
  REMARKABLE_DEVICE_TOKEN_URL,
  REMARKABLE_USER_TOKEN_URL,
  saveMicrosoftAuth,
  saveRemarkableAuth,
  signInWithMicrosoftInteractive,
} from '../auth';
import { resetMockBrowserStorage } from './setup';

function buildUnsignedJwt(payload: Record<string, unknown>): string {
  const header = encodeBytesToBase64Url(
    new TextEncoder().encode(JSON.stringify({ alg: 'none', typ: 'JWT' })),
  );
  const body = encodeBytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${header}.${body}.sig`;
}

describe('Phase 3 Authentication Services & Silent Refresh Interceptors', () => {
  beforeEach(() => {
    resetMockBrowserStorage();
  });

  it('satisfies the official IETF RFC 7636 Appendix B S256 PKCE test vector and decodes JWT claims', async () => {
    // RFC 7636 Appendix B test vector
    const rfcVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = await derivePkceCodeChallengeS256(rfcVerifier);
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');

    const randomVerifier = generatePkceCodeVerifier();
    expect(randomVerifier).toHaveLength(43);

    const expSec = 1_800_000_000;
    const idToken = buildUnsignedJwt({
      exp: expSec,
      preferred_username: 'ada.lovelace@example.org',
    });

    expect(extractJwtExpiryMs(idToken)).toBe(expSec * 1000);
    expect(extractAccountNameFromIdToken(idToken)).toBe('ada.lovelace@example.org');
  });

  it('normalizes reMarkable OTP codes, pairs device tokens, and refreshes + retries on HTTP 401', async () => {
    expect(normalizeRemarkableOtp('  ABCD-ef12 ')).toBe('abcdef12');
    expect(() => normalizeRemarkableOtp('short')).toThrow(/8 letters or digits/);

    const futureExpSec = Math.floor((Date.now() + 60 * 60 * 1000) / 1000);
    const initialUserJwt = buildUnsignedJwt({ exp: futureExpSec, sub: 'rm-user-1' });
    const calls: Array<{ url: string; authHeader: string | null; body: string | null }> = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        authHeader: headers.get('Authorization'),
        body: typeof init?.body === 'string' ? init.body : null,
      });

      if (url === REMARKABLE_DEVICE_TOKEN_URL) {
        return new Response('device-jwt-token-123', { status: 200 });
      }
      if (url === REMARKABLE_USER_TOKEN_URL) {
        return new Response(initialUserJwt, { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const paired = await pairRemarkableDevice('APWN GEAD', mockFetch);
    expect(paired.deviceToken).toBe('device-jwt-token-123');
    expect(paired.userToken).toBe(initialUserJwt);

    expect(calls).toHaveLength(2);
    expect(calls[0].authHeader).toBe('Bearer');
    expect(REMARKABLE_DEVICE_TOKEN_URL).toContain('remarkable.engineering');
    const deviceBody = JSON.parse(calls[0].body ?? '{}') as Record<string, string>;
    expect(deviceBody.code).toBe('apwngead');
    expect(deviceBody.deviceDesc).toBe(REMARKABLE_DEVICE_DESC);
    expect(calls[1].authHeader).toBe('Bearer device-jwt-token-123');

    // Cached user token is still valid -> no network call needed.
    const cachedToken = await getValidRemarkableUserToken({ fetchImpl: mockFetch });
    expect(cachedToken).toBe(initialUserJwt);
    expect(calls).toHaveLength(2);

    // Simulate downstream 401 triggering transparent user token refresh + retry
    const rotatedUserJwt = buildUnsignedJwt({ exp: futureExpSec + 3600 });
    let cloudAttempts = 0;

    const interceptorFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get('Authorization');

      if (url === REMARKABLE_USER_TOKEN_URL) {
        expect(auth).toBe('Bearer device-jwt-token-123');
        return new Response(rotatedUserJwt, { status: 200 });
      }

      cloudAttempts += 1;
      if (cloudAttempts === 1) {
        expect(auth).toBe(`Bearer ${initialUserJwt}`);
        return new Response('Token expired', { status: 401 });
      }

      expect(auth).toBe(`Bearer ${rotatedUserJwt}`);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const cloudRes = await fetchWithRemarkableAuth(
      'https://internal.cloud.remarkable.com/document-storage/json/2/docs',
      {},
      interceptorFetch,
    );
    expect(cloudRes.status).toBe(200);
    expect(cloudAttempts).toBe(2);
    expect((await getRemarkableAuth())?.userToken).toBe(rotatedUserJwt);
  });

  it('clears reMarkable credentials if the persistent device token is revoked (HTTP 401)', async () => {
    await saveRemarkableAuth({
      deviceId: '11111111-1111-4111-8111-111111111111',
      deviceToken: 'revoked-device-token',
      userToken: 'stale-user-token',
      userTokenExpiresAtMs: Date.now() - 10_000,
      pairedAt: '2026-11-06T10:00:00.000Z',
    });

    const revokedFetch: typeof fetch = async () => new Response('Unauthorized', { status: 401 });

    await expect(getValidRemarkableUserToken({ fetchImpl: revokedFetch })).rejects.toThrow(
      /revoked or expired/,
    );
    expect(await getRemarkableAuth()).toBeNull();
  });

  it('executes Microsoft PKCE sign-in, validates OAuth state, and updates isConfigured summary', async () => {
    let capturedAuthUrl = '';
    const idToken = buildUnsignedJwt({
      preferred_username: 'researcher@university.edu',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const mockLaunchWebAuthFlow = async ({ url }: { url: string }): Promise<string> => {
      capturedAuthUrl = url;
      const parsed = new URL(url);
      const state = parsed.searchParams.get('state') ?? '';
      const redirectUri = parsed.searchParams.get('redirect_uri') ?? '';
      return `${redirectUri}?code=ms-auth-code-xyz&state=${encodeURIComponent(state)}`;
    };

    let tokenRequestBody = '';
    const mockFetch: typeof fetch = async (_input, init) => {
      tokenRequestBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          access_token: 'ms-access-1',
          refresh_token: 'ms-refresh-1',
          expires_in: 3600,
          id_token: idToken,
        }),
        { status: 200 },
      );
    };

    const msState = await signInWithMicrosoftInteractive({
      clientId: '22222222-2222-4222-8222-222222222222',
      tenantId: 'common',
      launchWebAuthFlowImpl: mockLaunchWebAuthFlow,
      fetchImpl: mockFetch,
    });

    expect(msState.accessToken).toBe('ms-access-1');
    expect(msState.refreshToken).toBe('ms-refresh-1');
    expect(msState.accountName).toBe('researcher@university.edu');

    const authUrlObj = new URL(capturedAuthUrl);
    expect(authUrlObj.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authUrlObj.searchParams.get('response_type')).toBe('code');
    expect(authUrlObj.searchParams.get('scope')).toContain('Notes.ReadWrite');
    expect(authUrlObj.searchParams.get('scope')).toContain('offline_access');

    const redeemedParams = new URLSearchParams(tokenRequestBody);
    expect(redeemedParams.get('grant_type')).toBe('authorization_code');
    expect(redeemedParams.get('code')).toBe('ms-auth-code-xyz');
    const sentVerifier = redeemedParams.get('code_verifier') ?? '';
    expect(await derivePkceCodeChallengeS256(sentVerifier)).toBe(
      authUrlObj.searchParams.get('code_challenge'),
    );

    // Pair reMarkable too -> isConfigured must flip to true
    await saveRemarkableAuth({
      deviceId: '33333333-3333-4333-8333-333333333333',
      deviceToken: 'rm-dev-token',
      userToken: 'rm-usr-token',
      userTokenExpiresAtMs: Date.now() + 3_600_000,
      pairedAt: '2026-11-06T12:00:00.000Z',
    });

    const summary = await getAuthStatusSummary();
    expect(summary.isConfigured).toBe(true);
    expect(summary.microsoftAccount).toBe('researcher@university.edu');

    // Verify CSRF state mismatch is rejected
    await expect(
      signInWithMicrosoftInteractive({
        clientId: '22222222-2222-4222-8222-222222222222',
        launchWebAuthFlowImpl: async () =>
          'https://testextensionid.chromiumapp.org/?code=abc&state=tampered',
        fetchImpl: mockFetch,
      }),
    ).rejects.toThrow(/state verification/);
  });

  it('silently refreshes expiring Microsoft tokens, retries 401 Graph calls, and handles invalid_grant', async () => {
    await saveMicrosoftAuth({
      accessToken: 'expiring-ms-token',
      refreshToken: 'valid-refresh-token',
      expiresAtMs: Date.now() + 60_000, // Within 5-minute buffer -> triggers proactive silent refresh
      accountName: 'user@example.com',
      clientId: '44444444-4444-4444-8444-444444444444',
      tenantId: 'common',
      connectedAt: '2026-11-06T10:00:00.000Z',
    });

    const refreshFetch: typeof fetch = async (_input, init) => {
      const params = new URLSearchParams(String(init?.body ?? ''));
      expect(params.get('grant_type')).toBe('refresh_token');
      expect(params.get('refresh_token')).toBe('valid-refresh-token');

      return new Response(
        JSON.stringify({
          access_token: 'fresh-ms-token-2',
          refresh_token: 'rotated-refresh-token-2',
          expires_in: 3600,
        }),
        { status: 200 },
      );
    };

    const refreshed = await getValidMicrosoftAccessToken({ fetchImpl: refreshFetch });
    expect(refreshed).toBe('fresh-ms-token-2');
    expect((await getMicrosoftAuth())?.refreshToken).toBe('rotated-refresh-token-2');

    // Now test reactive 401 retry via fetchWithMicrosoftAuth when cached token looks fresh
    let graphCalls = 0;
    const graphAndRefreshFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('login.microsoftonline.com')) {
        return new Response(
          JSON.stringify({
            access_token: 'fresh-ms-token-3',
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }

      graphCalls += 1;
      const auth = new Headers(init?.headers).get('Authorization');
      if (graphCalls === 1) {
        expect(auth).toBe('Bearer fresh-ms-token-2');
        return new Response('Unauthorized', { status: 401 });
      }
      expect(auth).toBe('Bearer fresh-ms-token-3');
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    };

    const graphRes = await fetchWithMicrosoftAuth(
      'https://graph.microsoft.com/v1.0/me/onenote/notebooks',
      {},
      graphAndRefreshFetch,
    );
    expect(graphRes.status).toBe(200);
    expect(graphCalls).toBe(2);

    // Verify invalid_grant clears stored Microsoft credentials
    const invalidGrantFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Refresh token was revoked.',
        }),
        { status: 400 },
      );

    await expect(
      getValidMicrosoftAccessToken({ forceRefresh: true, fetchImpl: invalidGrantFetch }),
    ).rejects.toThrow(/expired or was revoked/);
    expect(await getMicrosoftAuth()).toBeNull();
  });
});

