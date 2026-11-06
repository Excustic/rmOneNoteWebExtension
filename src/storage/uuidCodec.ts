/**
 * Stateless, bijective (1-to-1 and invertible) binary Base64url codecs for UUIDs and
 * compact `storage.sync` rolling ledger records.
 *
 * - Canonical 36-char UUID (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) <-> 22-char Base64url
 * - 36-byte SyncLedgerEntry (16B doc UUID + 16B page UUID + 4B uint32 timestamp) <-> 48-char Base64url
 */

export const COMPACT_UUID_LENGTH = 22;
export const COMPACT_LEDGER_RECORD_LENGTH = 48;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPACT_UUID_REGEX = /^[A-Za-z0-9\-_]{22}$/;
const COMPACT_LEDGER_REGEX = /^[A-Za-z0-9\-_]{48}$/;

const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const BASE64URL_LOOKUP = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64URL_ALPHABET.length; i++) {
  BASE64URL_LOOKUP[BASE64URL_ALPHABET.charCodeAt(i)] = i;
}

const HEX_TABLE: string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);

export interface SyncLedgerEntry {
  documentId: string;
  pageId: string;
  /** Unix epoch timestamp in whole seconds (`uint32`). */
  syncedAtUnixSec: number;
}

function bytesToBase64Url(bytes: Uint8Array): string {
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

  const remaining = bytes.length - i;
  if (remaining === 1) {
    const byte0 = bytes[i];
    out +=
      BASE64URL_ALPHABET[(byte0 >>> 2) & 0x3f] +
      BASE64URL_ALPHABET[(byte0 & 0x03) << 4];
  } else if (remaining === 2) {
    const pair = (bytes[i] << 8) | bytes[i + 1];
    out +=
      BASE64URL_ALPHABET[(pair >>> 10) & 0x3f] +
      BASE64URL_ALPHABET[(pair >>> 4) & 0x3f] +
      BASE64URL_ALPHABET[(pair & 0x0f) << 2];
  }

  return out;
}

function base64UrlToBytes(encoded: string, expectedByteLength: number): Uint8Array {
  const out = new Uint8Array(expectedByteLength);
  let bitBuffer = 0;
  let bitsCollected = 0;
  let outIndex = 0;

  for (let i = 0; i < encoded.length; i++) {
    const code = encoded.charCodeAt(i);
    const val = code < 128 ? BASE64URL_LOOKUP[code] : -1;
    if (val === -1) {
      throw new Error(`Invalid Base64url character at index ${i}.`);
    }

    bitBuffer = (bitBuffer << 6) | val;
    bitsCollected += 6;

    if (bitsCollected >= 8) {
      bitsCollected -= 8;
      if (outIndex >= expectedByteLength) {
        throw new Error('Base64url input exceeds expected byte length.');
      }
      out[outIndex++] = (bitBuffer >>> bitsCollected) & 0xff;
    }
  }

  if (outIndex !== expectedByteLength) {
    throw new Error(
      `Decoded ${outIndex} bytes from Base64url, expected ${expectedByteLength}.`,
    );
  }

  // Any trailing padding bits must be zero to maintain strict 1-to-1 canonical bijection.
  if (bitsCollected > 0) {
    const trailingMask = (1 << bitsCollected) - 1;
    if ((bitBuffer & trailingMask) !== 0) {
      throw new Error('Non-canonical trailing bits in Base64url string.');
    }
  }

  return out;
}

function uuidToBytes(uuid: string): Uint8Array {
  const trimmed = uuid.trim();
  if (!UUID_REGEX.test(trimmed)) {
    throw new Error(`Invalid UUID format: "${uuid}".`);
  }

  const hex = trimmed.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array, offset = 0): string {
  return (
    HEX_TABLE[bytes[offset + 0]] +
    HEX_TABLE[bytes[offset + 1]] +
    HEX_TABLE[bytes[offset + 2]] +
    HEX_TABLE[bytes[offset + 3]] +
    '-' +
    HEX_TABLE[bytes[offset + 4]] +
    HEX_TABLE[bytes[offset + 5]] +
    '-' +
    HEX_TABLE[bytes[offset + 6]] +
    HEX_TABLE[bytes[offset + 7]] +
    '-' +
    HEX_TABLE[bytes[offset + 8]] +
    HEX_TABLE[bytes[offset + 9]] +
    '-' +
    HEX_TABLE[bytes[offset + 10]] +
    HEX_TABLE[bytes[offset + 11]] +
    HEX_TABLE[bytes[offset + 12]] +
    HEX_TABLE[bytes[offset + 13]] +
    HEX_TABLE[bytes[offset + 14]] +
    HEX_TABLE[bytes[offset + 15]]
  );
}

/**
 * Maps a canonical 36-char UUID 1-to-1 into a 22-char URL-safe Base64url token.
 */
export function encodeUuidToBase64Url(uuid: string): string {
  return bytesToBase64Url(uuidToBytes(uuid));
}

/**
 * Reconstructs the canonical lowercase 36-char UUID from a 22-char Base64url token.
 */
export function decodeBase64UrlToUuid(compact: string): string {
  if (!COMPACT_UUID_REGEX.test(compact)) {
    throw new Error(`Invalid compact UUID token: "${compact}".`);
  }
  return bytesToUuid(base64UrlToBytes(compact, 16));
}

/**
 * Packs an array of canonical UUIDs into a contiguous fixed-width string (22 bytes per UUID,
 * zero delimiter overhead).
 */
export function packUuidList(uuids: readonly string[]): string {
  let packed = '';
  for (const id of uuids) {
    packed += encodeUuidToBase64Url(id);
  }
  return packed;
}

export function unpackUuidList(packed: string): string[] {
  if (!packed) {
    return [];
  }
  if (packed.length % COMPACT_UUID_LENGTH !== 0) {
    throw new Error(
      `Corrupted packed UUID string length (${packed.length} is not a multiple of ${COMPACT_UUID_LENGTH}).`,
    );
  }

  const result: string[] = [];
  for (let offset = 0; offset < packed.length; offset += COMPACT_UUID_LENGTH) {
    result.push(decodeBase64UrlToUuid(packed.slice(offset, offset + COMPACT_UUID_LENGTH)));
  }
  return result;
}

/**
 * Encodes `(documentId, pageId, syncedAtUnixSec)` into an exact 48-char Base64url record
 * (36 raw bytes = 288 bits = 48 x 6-bit symbols with zero wasted padding bits).
 */
export function encodeSyncLedgerRecord(entry: SyncLedgerEntry): string {
  const sec = Math.floor(entry.syncedAtUnixSec);
  if (!Number.isFinite(sec) || sec < 0 || sec > 0xffffffff) {
    throw new Error(`Invalid uint32 Unix timestamp in seconds: ${entry.syncedAtUnixSec}`);
  }

  const buffer = new Uint8Array(36);
  buffer.set(uuidToBytes(entry.documentId), 0);
  buffer.set(uuidToBytes(entry.pageId), 16);

  const view = new DataView(buffer.buffer);
  view.setUint32(32, sec >>> 0, false);

  return bytesToBase64Url(buffer);
}

export function decodeSyncLedgerRecord(encoded: string): SyncLedgerEntry {
  if (!COMPACT_LEDGER_REGEX.test(encoded)) {
    throw new Error(`Invalid 48-char sync ledger token: "${encoded}".`);
  }

  const bytes = base64UrlToBytes(encoded, 36);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return {
    documentId: bytesToUuid(bytes, 0),
    pageId: bytesToUuid(bytes, 16),
    syncedAtUnixSec: view.getUint32(32, false),
  };
}

export function packSyncLedgerRecords(entries: readonly SyncLedgerEntry[]): string {
  let packed = '';
  for (const entry of entries) {
    packed += encodeSyncLedgerRecord(entry);
  }
  return packed;
}

export function unpackSyncLedgerRecords(packed: string): SyncLedgerEntry[] {
  if (!packed) {
    return [];
  }
  if (packed.length % COMPACT_LEDGER_RECORD_LENGTH !== 0) {
    throw new Error(
      `Corrupted packed sync ledger length (${packed.length} is not a multiple of ${COMPACT_LEDGER_RECORD_LENGTH}).`,
    );
  }

  const entries: SyncLedgerEntry[] = [];
  for (let offset = 0; offset < packed.length; offset += COMPACT_LEDGER_RECORD_LENGTH) {
    entries.push(
      decodeSyncLedgerRecord(packed.slice(offset, offset + COMPACT_LEDGER_RECORD_LENGTH)),
    );
  }
  return entries;
}

