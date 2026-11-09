import { importDatabaseBackupJson, type ImportBackupSummary } from '../db/backup';
import { db, type RmOneNoteDatabase } from '../db/db';
import type { PageRecord } from '../db/models';
import { ext } from '../shared/browser';
import {
  packSyncLedgerRecords,
  type SyncLedgerEntry,
  unpackSyncLedgerRecords,
} from './uuidCodec';

/**
 * 160 records x 48 chars = 7,680 bytes per chunk key (< 8,192-byte `QUOTA_BYTES_PER_ITEM`).
 * 8 chunks x 160 = 1,280 synced pages retained in the cross-browser `storage.sync` window.
 */
export const LEDGER_ENTRIES_PER_CHUNK = 160;
export const MAX_LEDGER_CHUNKS = 8;
export const MAX_LEDGER_ENTRIES = LEDGER_ENTRIES_PER_CHUNK * MAX_LEDGER_CHUNKS;

const LEDGER_META_KEY = 'sl_meta';
const LEDGER_CHUNK_PREFIX = 'sl_';
const LOCAL_LEDGER_STATE_KEY = 'syncLedgerLocalState';

export interface SyncLedgerMetadata {
  chunkCount: number;
  /**
   * Monotonic count of distinct synced page entries that rolled off `storage.sync`
   * once `MAX_LEDGER_ENTRIES` was exceeded. When `> 0`, any freshly installed PC knows
   * immediately that `storage.sync` no longer holds the complete historical set and
   * prompts the user to import a local DB backup file from their previous PC.
   */
  evictedCount: number;
  /** Monotonic sequence counter of ledger insertions/updates across all PCs. */
  totalSeq: number;
}

export interface LocalLedgerTrackingState {
  initialized: boolean;
  lastSeenSeq: number;
  missingHistoryCount: number;
  warningDismissed: boolean;
}

export interface BackupWarningStatus {
  needsBackupImport: boolean;
  missingHistoryCount: number;
  evictedCountInSync: number;
}

const DEFAULT_META: SyncLedgerMetadata = {
  chunkCount: 0,
  evictedCount: 0,
  totalSeq: 0,
};

const DEFAULT_LOCAL_STATE: LocalLedgerTrackingState = {
  initialized: false,
  lastSeenSeq: 0,
  missingHistoryCount: 0,
  warningDismissed: false,
};

function isLedgerChunkKey(key: string): boolean {
  return key === LEDGER_META_KEY || key.startsWith(LEDGER_CHUNK_PREFIX);
}

export interface SyncLedgerSnapshot {
  meta: SyncLedgerMetadata;
  entries: SyncLedgerEntry[];
}

export async function readSyncLedgerSnapshot(): Promise<SyncLedgerSnapshot> {
  const metaObj = await ext.storage.sync.get(LEDGER_META_KEY);
  const rawMeta = metaObj[LEDGER_META_KEY] as Partial<SyncLedgerMetadata> | undefined;

  const meta: SyncLedgerMetadata = {
    chunkCount: typeof rawMeta?.chunkCount === 'number' ? rawMeta.chunkCount : 0,
    evictedCount: typeof rawMeta?.evictedCount === 'number' ? rawMeta.evictedCount : 0,
    totalSeq: typeof rawMeta?.totalSeq === 'number' ? rawMeta.totalSeq : 0,
  };

  if (meta.chunkCount <= 0) {
    return { meta: { ...DEFAULT_META, ...meta, chunkCount: 0 }, entries: [] };
  }

  const chunkKeys = Array.from(
    { length: meta.chunkCount },
    (_, idx) => `${LEDGER_CHUNK_PREFIX}${idx}`,
  );
  const chunkValues = await ext.storage.sync.get(chunkKeys);

  const entries: SyncLedgerEntry[] = [];
  for (const key of chunkKeys) {
    const packed = chunkValues[key];
    if (typeof packed === 'string' && packed.length > 0) {
      entries.push(...unpackSyncLedgerRecords(packed));
    }
  }

  return { meta, entries };
}

async function readLocalTrackingState(): Promise<LocalLedgerTrackingState> {
  const stored = await ext.storage.local.get(LOCAL_LEDGER_STATE_KEY);
  const raw = stored[LOCAL_LEDGER_STATE_KEY] as Partial<LocalLedgerTrackingState> | undefined;
  return {
    ...DEFAULT_LOCAL_STATE,
    ...raw,
  };
}

async function writeLocalTrackingState(state: LocalLedgerTrackingState): Promise<void> {
  await ext.storage.local.set({ [LOCAL_LEDGER_STATE_KEY]: state });
}

/**
 * Appends or updates newly uploaded pages into the `storage.sync` rolling ledger in a
 * single batched write operation (preserving `MAX_WRITE_OPERATIONS_PER_MINUTE` headroom).
 */
export async function recordSyncedPagesInLedger(
  uploadedEntries: readonly SyncLedgerEntry[],
): Promise<SyncLedgerMetadata> {
  const { meta: prevMeta, entries: existingEntries } = await readSyncLedgerSnapshot();
  if (uploadedEntries.length === 0) {
    return prevMeta;
  }

  // Preserve chronological order (oldest -> newest); re-uploading an existing page moves
  // it to the newest tail with its updated timestamp without consuming a second slot.
  const byCompositeKey = new Map<string, SyncLedgerEntry>();
  for (const entry of existingEntries) {
    byCompositeKey.set(`${entry.documentId}:${entry.pageId}`, entry);
  }
  for (const incoming of uploadedEntries) {
    const key = `${incoming.documentId}:${incoming.pageId}`;
    const prev = byCompositeKey.get(key);
    if (!prev || incoming.syncedAtUnixSec >= prev.syncedAtUnixSec) {
      byCompositeKey.delete(key);
      byCompositeKey.set(key, incoming);
    }
  }

  const combined = Array.from(byCompositeKey.values());
  const overflow = Math.max(0, combined.length - MAX_LEDGER_ENTRIES);
  const retained = overflow > 0 ? combined.slice(overflow) : combined;

  const nextChunkCount = Math.ceil(retained.length / LEDGER_ENTRIES_PER_CHUNK);
  const nextMeta: SyncLedgerMetadata = {
    chunkCount: nextChunkCount,
    evictedCount: prevMeta.evictedCount + overflow,
    totalSeq: prevMeta.totalSeq + uploadedEntries.length,
  };

  const toSet: Record<string, unknown> = {
    [LEDGER_META_KEY]: nextMeta,
  };

  for (let i = 0; i < nextChunkCount; i++) {
    const slice = retained.slice(
      i * LEDGER_ENTRIES_PER_CHUNK,
      (i + 1) * LEDGER_ENTRIES_PER_CHUNK,
    );
    toSet[`${LEDGER_CHUNK_PREFIX}${i}`] = packSyncLedgerRecords(slice);
  }

  const toRemove: string[] = [];
  for (let i = nextChunkCount; i < prevMeta.chunkCount; i++) {
    toRemove.push(`${LEDGER_CHUNK_PREFIX}${i}`);
  }

  await ext.storage.sync.set(toSet);
  if (toRemove.length > 0) {
    await ext.storage.sync.remove(toRemove);
  }

  // Update local tracking sequence so this PC recognizes its own flush.
  const localState = await readLocalTrackingState();
  await writeLocalTrackingState({
    initialized: true,
    lastSeenSeq: nextMeta.totalSeq,
    missingHistoryCount: localState.missingHistoryCount,
    warningDismissed: localState.warningDismissed,
  });

  return nextMeta;
}

/**
 * Removes specified pages from the `storage.sync` rolling ledger in a single batched operation.
 */
export async function removeSyncedPagesFromLedger(
  pagesToRemove: ReadonlyArray<{ documentId: string; pageId: string }>,
): Promise<SyncLedgerMetadata> {
  const { meta: prevMeta, entries: existingEntries } = await readSyncLedgerSnapshot();
  if (pagesToRemove.length === 0 || existingEntries.length === 0) {
    return prevMeta;
  }

  const removeKeys = new Set(pagesToRemove.map((p) => `${p.documentId}:${p.pageId}`));
  const filtered = existingEntries.filter(
    (e) => !removeKeys.has(`${e.documentId}:${e.pageId}`),
  );

  if (filtered.length === existingEntries.length) {
    return prevMeta;
  }

  const nextChunkCount = Math.ceil(filtered.length / LEDGER_ENTRIES_PER_CHUNK);
  const nextMeta: SyncLedgerMetadata = {
    chunkCount: nextChunkCount,
    evictedCount: prevMeta.evictedCount,
    totalSeq: prevMeta.totalSeq + 1,
  };

  const toSet: Record<string, unknown> = {
    [LEDGER_META_KEY]: nextMeta,
  };

  for (let i = 0; i < nextChunkCount; i++) {
    const slice = filtered.slice(
      i * LEDGER_ENTRIES_PER_CHUNK,
      (i + 1) * LEDGER_ENTRIES_PER_CHUNK,
    );
    toSet[`${LEDGER_CHUNK_PREFIX}${i}`] = packSyncLedgerRecords(slice);
  }

  const toRemove: string[] = [];
  for (let i = nextChunkCount; i < prevMeta.chunkCount; i++) {
    toRemove.push(`${LEDGER_CHUNK_PREFIX}${i}`);
  }

  await ext.storage.sync.set(toSet);
  if (toRemove.length > 0) {
    await ext.storage.sync.remove(toRemove);
  }

  const localState = await readLocalTrackingState();
  await writeLocalTrackingState({
    initialized: true,
    lastSeenSeq: nextMeta.totalSeq,
    missingHistoryCount: localState.missingHistoryCount,
    warningDismissed: localState.warningDismissed,
  });

  return nextMeta;
}

/**
 * Merges all entries currently in `storage.sync` into local `Dexie.pages` (making local
 * IndexedDB a permanent superset) and evaluates whether this browser missed older evicted
 * entries (e.g. cold install when `evictedCount > 0`).
 */
export async function reconcileSyncLedgerToDexie(
  database: RmOneNoteDatabase = db,
): Promise<BackupWarningStatus> {
  const [{ meta, entries }, localState] = await Promise.all([
    readSyncLedgerSnapshot(),
    readLocalTrackingState(),
  ]);

  if (entries.length > 0) {
    await database.transaction('rw', [database.pages, database.documents], async () => {
      const keys = entries.map((e): [string, string] => [e.documentId, e.pageId]);
      const existingList = await database.pages.bulkGet(keys);

      const toPut: PageRecord[] = [];

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const existing = existingList[i];
        const incomingIso = new Date(entry.syncedAtUnixSec * 1000).toISOString();

        if (!existing) {
          // If the document is already indexed in local Dexie, do not insert a headless stub
          // with empty pageNumber (which would produce a ghost page).
          const doc = await database.documents.get(entry.documentId);
          if (doc) {
            continue;
          }

          toPut.push({
            documentId: entry.documentId,
            pageId: entry.pageId,
            pageNumber: '',
            title: '',
            virtualPath: '',
            fileSizeBytes: 0,
            lastModified: incomingIso,
            contentHash: '',
            status: 'Uploaded',
            lastSyncTime: incomingIso,
            oneNotePageId: null,
            oneNotePageUrl: null,
            retryCount: 0,
            lastError: null,
          });
          continue;
        }

        const existingSyncMs = existing.lastSyncTime ? Date.parse(existing.lastSyncTime) : 0;
        const incomingSyncMs = entry.syncedAtUnixSec * 1000;

        if (incomingSyncMs > existingSyncMs) {
          toPut.push({
            ...existing,
            status: 'Uploaded',
            lastSyncTime: incomingIso,
            lastModified:
              incomingIso > existing.lastModified ? incomingIso : existing.lastModified,
            lastError: null,
          });
        }
      }

      if (toPut.length > 0) {
        await database.pages.bulkPut(toPut);
      }
    });
  }

  let missingHistoryCount = localState.missingHistoryCount;
  let warningDismissed = localState.warningDismissed;

  if (!localState.initialized) {
    // Brand-new PC / fresh profile: if `evictedCount > 0`, older pages were omitted from
    // `storage.sync` and require importing a local DB backup file from a previous PC.
    if (meta.evictedCount > 0) {
      missingHistoryCount = meta.evictedCount;
      warningDismissed = false;
    }
  } else {
    // Existing PC: detect if more than `entries.length` updates occurred while offline.
    const seqDelta = meta.totalSeq - localState.lastSeenSeq;
    if (seqDelta > entries.length && meta.evictedCount > 0) {
      const newlyMissed = seqDelta - entries.length;
      missingHistoryCount += newlyMissed;
      warningDismissed = false;
    }
  }

  await writeLocalTrackingState({
    initialized: true,
    lastSeenSeq: meta.totalSeq,
    missingHistoryCount,
    warningDismissed,
  });

  return {
    needsBackupImport: missingHistoryCount > 0 && !warningDismissed,
    missingHistoryCount,
    evictedCountInSync: meta.evictedCount,
  };
}

export async function getBackupImportWarningStatus(): Promise<BackupWarningStatus> {
  const [{ meta }, localState] = await Promise.all([
    readSyncLedgerSnapshot(),
    readLocalTrackingState(),
  ]);

  if (!localState.initialized) {
    return reconcileSyncLedgerToDexie();
  }

  return {
    needsBackupImport: localState.missingHistoryCount > 0 && !localState.warningDismissed,
    missingHistoryCount: localState.missingHistoryCount,
    evictedCountInSync: meta.evictedCount,
  };
}

export async function dismissBackupImportWarning(): Promise<void> {
  const localState = await readLocalTrackingState();
  await writeLocalTrackingState({
    ...localState,
    initialized: true,
    warningDismissed: true,
  });
}

/**
 * Imports a JSON backup file from another PC, reconciles any newer entries still in
 * `storage.sync` on top, and clears the missing-history warning flag.
 */
export async function importBackupAndReconcile(
  rawJson: string,
  database: RmOneNoteDatabase = db,
): Promise<ImportBackupSummary> {
  const summary = await importDatabaseBackupJson(rawJson, database);
  const { meta } = await readSyncLedgerSnapshot();

  await writeLocalTrackingState({
    initialized: true,
    lastSeenSeq: meta.totalSeq,
    missingHistoryCount: 0,
    warningDismissed: false,
  });

  await reconcileSyncLedgerToDexie(database);
  return summary;
}

/**
 * Registers a cross-browser `storage.onChanged` listener that automatically hydrates
 * incoming `storage.sync` ledger updates into local `Dexie.pages`.
 */
export function registerSyncLedgerAutoReconcile(database: RmOneNoteDatabase = db): () => void {
  const listener = (changes: Record<string, unknown>, areaName: string) => {
    if (areaName !== 'sync') {
      return;
    }
    const touchedLedger = Object.keys(changes).some(isLedgerChunkKey);
    if (touchedLedger) {
      void reconcileSyncLedgerToDexie(database).catch((err) => {
        console.error('[rmOneNote] Failed to reconcile incoming sync ledger:', err);
      });
    }
  };

  ext.storage.onChanged.addListener(listener);
  return () => {
    ext.storage.onChanged.removeListener(listener);
  };
}

