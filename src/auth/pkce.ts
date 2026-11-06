const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function encodeBytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;

  while (i + 2 < bytes.length) {
    const triplet = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      BASE64URL_ALPHABET[(triplet >>> 18) & 0x3f] +
      BASE64URL_ALPHABET[(triplet >>> 12) & 0x3f] +
      BASE64URL_ALPHABET[(triplet >>> 6) & 0x3f] +
      BASE64URL_ALPHABET[triplet & 0x3f];
    i += 3;
  }

  const rem = bytes.length - i;
  if (rem === 1) {
    const b0 = bytes[i];
    out += BASE64URL_ALPHABET[(b0 >>> 2) & 0x3f] + BASE64URL_ALPHABET[(b0 & 0x03) << 4];
  } else if (rem === 2) {
    const pair = (bytes[i] << 8) | bytes[i + 1];
    out +=
      BASE64URL_ALPHABET[(pair >>> 10) & 0x3f] +
      BASE64URL_ALPHABET[(pair >>> 4) & 0x3f] +
      BASE64URL_ALPHABET[(pair & 0x0f) << 2];
  }

  return out;
}

/**
 * Generates an RFC 7636 compliant PKCE `code_verifier` (32 random bytes -> 43 Base64url chars).
 */
export function generatePkceCodeVerifier(byteLength = 32): string {
  const randomBytes = new Uint8Array(byteLength);
  crypto.getRandomValues(randomBytes);
  return encodeBytesToBase64Url(randomBytes);
}

/**
 * Computes the RFC 7636 `S256` `code_challenge` (`BASE64URL(SHA256(ASCII(code_verifier)))`).
 */
export async function derivePkceCodeChallengeS256(codeVerifier: string): Promise<string> {
  const asciiBytes = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', asciiBytes);
  return encodeBytesToBase64Url(new Uint8Array(digest));
}

export async function createPkcePair(): Promise<{
  codeVerifier: string;
  codeChallenge: string;
}> {
  const codeVerifier = generatePkceCodeVerifier(32);
  const codeChallenge = await derivePkceCodeChallengeS256(codeVerifier);
  return { codeVerifier, codeChallenge };
}

export function generateOAuthState(byteLength = 16): string {
  const randomBytes = new Uint8Array(byteLength);
  crypto.getRandomValues(randomBytes);
  return encodeBytesToBase64Url(randomBytes);
}

