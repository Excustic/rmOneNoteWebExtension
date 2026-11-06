const BASE64URL_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const LOOKUP = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64URL_CHARS.length; i++) {
  LOOKUP[BASE64URL_CHARS.charCodeAt(i)] = i;
}

function decodeBase64UrlBytes(segment: string): Uint8Array | null {
  const cleaned = segment.replace(/=+$/, '');
  if (!cleaned) {
    return null;
  }

  const outputLength = Math.floor((cleaned.length * 6) / 8);
  const bytes = new Uint8Array(outputLength);
  let buffer = 0;
  let bits = 0;
  let index = 0;

  for (let i = 0; i < cleaned.length; i++) {
    const code = cleaned.charCodeAt(i);
    const val = code < 128 ? LOOKUP[code] : -1;
    if (val === -1) {
      return null;
    }

    buffer = (buffer << 6) | val;
    bits += 6;

    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >>> bits) & 0xff;
    }
  }

  return bytes;
}

/**
 * Decodes the middle payload segment of a JWT without trusting unverified claims for
 * security boundaries (used strictly for local token `exp` scheduling and UI display name).
 */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.trim().split('.');
  if (parts.length < 2) {
    return null;
  }

  const payloadBytes = decodeBase64UrlBytes(parts[1]);
  if (!payloadBytes) {
    return null;
  }

  try {
    const json = new TextDecoder().decode(payloadBytes);
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function extractJwtExpiryMs(token: string): number | null {
  const claims = decodeJwtClaims(token);
  if (!claims || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    return null;
  }
  return claims.exp * 1000;
}

export function extractAccountNameFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) {
    return null;
  }
  const claims = decodeJwtClaims(idToken);
  if (!claims) {
    return null;
  }

  const candidates = [claims.preferred_username, claims.email, claims.upn, claims.name];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

