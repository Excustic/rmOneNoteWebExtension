import { describe, expect, it } from 'vitest';
import {
  COMPACT_LEDGER_RECORD_LENGTH,
  COMPACT_UUID_LENGTH,
  decodeBase64UrlToUuid,
  decodeSyncLedgerRecord,
  encodeSyncLedgerRecord,
  encodeUuidToBase64Url,
  packSyncLedgerRecords,
  packUuidList,
  type SyncLedgerEntry,
  unpackSyncLedgerRecords,
  unpackUuidList,
} from '../storage/uuidCodec';

function deterministicUuid(seed: number): string {
  const bytes = new Uint8Array(16);
  let state = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < 16; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 0xff;
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

describe('uuidCodec', () => {
  it('maps boundary and mixed-case UUIDs 1-to-1 with 22-char Base64url tokens', () => {
    const zero = '00000000-0000-0000-0000-000000000000';
    const max = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    const upper = 'A1B2C3D4-E5F6-4789-ABCD-0123456789EF';

    const encodedZero = encodeUuidToBase64Url(zero);
    const encodedMax = encodeUuidToBase64Url(max);
    const encodedUpper = encodeUuidToBase64Url(upper);

    expect(encodedZero).toHaveLength(COMPACT_UUID_LENGTH);
    expect(encodedZero).toBe('AAAAAAAAAAAAAAAAAAAAAA');
    expect(decodeBase64UrlToUuid(encodedZero)).toBe(zero);

    expect(encodedMax).toHaveLength(COMPACT_UUID_LENGTH);
    expect(decodeBase64UrlToUuid(encodedMax)).toBe(max);

    expect(encodedUpper).toHaveLength(COMPACT_UUID_LENGTH);
    expect(decodeBase64UrlToUuid(encodedUpper)).toBe(upper.toLowerCase());
  });

  it('roundtrips 250 distinct UUIDs with zero collisions', () => {
    const uuids = Array.from({ length: 250 }, (_, idx) => deterministicUuid(idx + 1));
    const encodedSet = new Set<string>();

    for (const id of uuids) {
      const compact = encodeUuidToBase64Url(id);
      expect(compact).toHaveLength(COMPACT_UUID_LENGTH);
      encodedSet.add(compact);
      expect(decodeBase64UrlToUuid(compact)).toBe(id);
    }

    expect(encodedSet.size).toBe(uuids.length);

    const packed = packUuidList(uuids);
    expect(packed).toHaveLength(uuids.length * COMPACT_UUID_LENGTH);
    expect(unpackUuidList(packed)).toEqual(uuids);
    expect(unpackUuidList('')).toEqual([]);
  });

  it('rejects malformed UUIDs, corrupted packed lengths, and non-canonical trailing bits', () => {
    expect(() => encodeUuidToBase64Url('not-a-uuid')).toThrow();
    expect(() => decodeBase64UrlToUuid('short')).toThrow();
    expect(() => decodeBase64UrlToUuid('AAAAAAAAAAAAAAAAAAAAA=')).toThrow();

    // 22 chars = 132 bits; 16 bytes = 128 bits -> bottom 4 bits must be 0 for strict 1-to-1 bijection.
    expect(() => decodeBase64UrlToUuid('AAAAAAAAAAAAAAAAAAAAAB')).toThrow(
      /Non-canonical trailing bits/,
    );
    expect(() => unpackUuidList('abc')).toThrow(/multiple of 22/);
  });

  it('encodes and decodes 36-byte SyncLedgerEntry values into exact 48-char records', () => {
    const samples: SyncLedgerEntry[] = [
      {
        documentId: deterministicUuid(10),
        pageId: deterministicUuid(20),
        syncedAtUnixSec: 0,
      },
      {
        documentId: deterministicUuid(30),
        pageId: deterministicUuid(40),
        syncedAtUnixSec: 1_762_436_000,
      },
      {
        documentId: deterministicUuid(50),
        pageId: deterministicUuid(60),
        syncedAtUnixSec: 0xffffffff,
      },
    ];

    for (const sample of samples) {
      const token = encodeSyncLedgerRecord(sample);
      expect(token).toHaveLength(COMPACT_LEDGER_RECORD_LENGTH);
      expect(decodeSyncLedgerRecord(token)).toEqual(sample);
    }

    const packed = packSyncLedgerRecords(samples);
    expect(packed).toHaveLength(samples.length * COMPACT_LEDGER_RECORD_LENGTH);
    expect(unpackSyncLedgerRecords(packed)).toEqual(samples);
    expect(unpackSyncLedgerRecords('')).toEqual([]);

    expect(() =>
      encodeSyncLedgerRecord({
        documentId: deterministicUuid(1),
        pageId: deterministicUuid(2),
        syncedAtUnixSec: -1,
      }),
    ).toThrow();
    expect(() =>
      encodeSyncLedgerRecord({
        documentId: deterministicUuid(1),
        pageId: deterministicUuid(2),
        syncedAtUnixSec: 0x1_0000_0000,
      }),
    ).toThrow();
  });
});
