import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getIndexedPageCount, getPage, RmOneNoteDatabase, savePage } from '../db';
import { serializeDatabaseBackup } from '../db/backup';
import {
  DEFAULT_USER_PREFERENCES,
  dismissBackupImportWarning,
  getBackupImportWarningStatus,
  getPreferences,
  getWhitelist,
  importBackupAndReconcile,
  MAX_LEDGER_ENTRIES,
  recordSyncedPagesInLedger,
  reconcileSyncLedgerToDexie,
  registerSyncLedgerAutoReconcile,
  type SyncLedgerEntry,
  setWhitelist,
  updatePreferences,
} from '../storage';
import {
  getRawSyncStoreSnapshot,
  resetMockBrowserStorage,
  resetMockLocalStorageOnly,
  SYNC_QUOTA_BYTES_PER_ITEM,
} from './setup';

let seqDbId = 0;

function makeDb(): RmOneNoteDatabase {
  seqDbId += 1;
  return new RmOneNoteDatabase(`ledgerTestDb_${seqDbId}`);
}

function makeUuid(prefixNum: number, itemNum: number): string {
  const p = prefixNum.toString(16).padStart(8, '0');
  const m = itemNum.toString(16).padStart(12, '0');
  return `${p}-0000-4000-8000-${m}`;
}

describe('UserPreferences, chunked Whitelists, and Cross-PC Rolling Sync Ledger', () => {
  let pc1Db: RmOneNoteDatabase;
  let pc2Db: RmOneNoteDatabase;

  beforeEach(() => {
    resetMockBrowserStorage();
    pc1Db = makeDb();
    pc2Db = makeDb();
  });

  afterEach(async () => {
    pc1Db.close();
    pc2Db.close();
    await pc1Db.delete();
    await pc2Db.delete();
  });

  it('normalizes and clamps user preferences in storage.sync', async () => {
    expect(await getPreferences()).toEqual(DEFAULT_USER_PREFERENCES);

    const saved = await updatePreferences({
      syncIntervalMinutes: 0,
      targetSection: '   ',
      maxRetries: 99,
      autoSync: false,
    });

    expect(saved.syncIntervalMinutes).toBe(1);
    expect(saved.targetSection).toBe('Documents');
    expect(saved.maxRetries).toBe(10);
    expect(saved.autoSync).toBe(false);
  });

  it('packs 700+ whitelist UUIDs across 8KB-safe chunks and cleans up stale chunks when shrunk', async () => {
    const largeFiles = Array.from({ length: 700 }, (_, idx) => makeUuid(1, idx + 1));
    const folders = Array.from({ length: 15 }, (_, idx) => makeUuid(2, idx + 1));

    const roundtripped = await setWhitelist({
      syncFiles: largeFiles,
      syncFolders: folders,
    });

    expect(roundtripped.syncFiles).toEqual(largeFiles);
    expect(roundtripped.syncFolders).toEqual(folders);

    const rawAfterGrow = getRawSyncStoreSnapshot();
    expect(rawAfterGrow.get('wl_files_n')).toBe(3);
    expect(rawAfterGrow.has('wl_files_2')).toBe(true);

    for (const [key, value] of rawAfterGrow.entries()) {
      expect(key.length + JSON.stringify(value).length).toBeLessThanOrEqual(
        SYNC_QUOTA_BYTES_PER_ITEM,
      );
    }

    // Shrink back to 5 files -> chunks wl_files_1 and wl_files_2 must be removed.
    const shrunk = largeFiles.slice(0, 5);
    expect((await setWhitelist({ syncFiles: shrunk, syncFolders: [] })).syncFiles).toEqual(shrunk);
    expect((await getWhitelist()).syncFolders).toEqual([]);

    const rawAfterShrink = getRawSyncStoreSnapshot();
    expect(rawAfterShrink.get('wl_files_n')).toBe(1);
    expect(rawAfterShrink.has('wl_files_1')).toBe(false);
    expect(rawAfterShrink.has('wl_files_2')).toBe(false);
    expect(rawAfterShrink.has('wl_folders_0')).toBe(false);
  });

  it('hydrates synced pages across PCs with zero warning when below MAX_LEDGER_ENTRIES', async () => {
    const docId = makeUuid(10, 1);
    const batch: SyncLedgerEntry[] = Array.from({ length: 250 }, (_, idx) => ({
      documentId: docId,
      pageId: makeUuid(20, idx + 1),
      syncedAtUnixSec: 1_762_000_000 + idx,
    }));

    const meta = await recordSyncedPagesInLedger(batch);
    expect(meta.evictedCount).toBe(0);
    expect(meta.totalSeq).toBe(250);

    // Simulate switching to a brand-new PC sharing the same browser.storage.sync account
    resetMockLocalStorageOnly();

    const status = await reconcileSyncLedgerToDexie(pc2Db);
    expect(status.needsBackupImport).toBe(false);
    expect(status.missingHistoryCount).toBe(0);
    expect(await getIndexedPageCount(pc2Db)).toBe(250);

    const samplePage = await getPage(docId, makeUuid(20, 40), pc2Db);
    expect(samplePage?.status).toBe('Uploaded');
    expect(samplePage?.lastSyncTime).toBe(
      new Date((1_762_000_000 + 39) * 1000).toISOString(),
    );
  });

  it('evicts oldest records past 1,280 entries, warns fresh PCs, and clears warning on backup import', async () => {
    const docId = makeUuid(50, 1);
    const totalPages = MAX_LEDGER_ENTRIES + 70; // 1,350 pages -> 70 evicted
    const entries: SyncLedgerEntry[] = [];

    for (let i = 0; i < totalPages; i++) {
      const pageId = makeUuid(60, i + 1);
      const unixSec = 1_762_100_000 + i;
      entries.push({ documentId: docId, pageId, syncedAtUnixSec: unixSec });

      await savePage(
        {
          documentId: docId,
          pageId,
          pageNumber: String(i + 1),
          title: `Page ${i + 1}`,
          virtualPath: `Academy/Calculus 1/Page ${i + 1}`,
          fileSizeBytes: 512,
          lastModified: new Date(unixSec * 1000).toISOString(),
          contentHash: `hash-${i + 1}`,
          status: 'Uploaded',
          lastSyncTime: new Date(unixSec * 1000).toISOString(),
          oneNotePageId: `on-${i + 1}`,
          oneNotePageUrl: `https://onenote.example.com/p/${i + 1}`,
          retryCount: 0,
          lastError: null,
        },
        pc1Db,
      );
    }

    const metaAfterOverflow = await recordSyncedPagesInLedger(entries);
    expect(metaAfterOverflow.evictedCount).toBe(70);
    expect(metaAfterOverflow.chunkCount).toBe(8);

    // Re-uploading an already-retained page updates its timestamp in place without evicting another entry.
    const metaAfterUpdate = await recordSyncedPagesInLedger([
      {
        documentId: docId,
        pageId: makeUuid(60, totalPages),
        syncedAtUnixSec: 1_762_999_999,
      },
    ]);
    expect(metaAfterUpdate.evictedCount).toBe(70);

    // PC 1 itself has no warning because it originated the syncs.
    const pc1Warning = await getBackupImportWarningStatus();
    expect(pc1Warning.needsBackupImport).toBe(false);

    // Export full backup from PC 1 before switching to fresh PC 2.
    const pc1BackupJson = await serializeDatabaseBackup(pc1Db);

    // Fresh PC 2 connects to browser sync: storage.local is empty, storage.sync has evictedCount = 70.
    resetMockLocalStorageOnly();

    const pc2InitialWarning = await reconcileSyncLedgerToDexie(pc2Db);
    expect(pc2InitialWarning.needsBackupImport).toBe(true);
    expect(pc2InitialWarning.missingHistoryCount).toBe(70);
    expect(await getIndexedPageCount(pc2Db)).toBe(MAX_LEDGER_ENTRIES);

    // User can either dismiss or import backup; verify import restores all 1,350 pages and clears warning.
    const importSummary = await importBackupAndReconcile(pc1BackupJson, pc2Db);
    expect(importSummary.pagesImported).toBe(totalPages);
    expect(await getIndexedPageCount(pc2Db)).toBe(totalPages);

    // Verify newest timestamp from storage.sync (1_762_999_999) was preserved on top of the backup!
    const latestPage = await getPage(docId, makeUuid(60, totalPages), pc2Db);
    expect(latestPage?.lastSyncTime).toBe(new Date(1_762_999_999 * 1000).toISOString());

    const pc2AfterImport = await getBackupImportWarningStatus();
    expect(pc2AfterImport.needsBackupImport).toBe(false);
    expect(pc2AfterImport.missingHistoryCount).toBe(0);
  });

  it('supports dismissing the cold-start warning and auto-reconciles live storage.onChanged events', async () => {
    const docId = makeUuid(90, 1);
    const overflowEntries: SyncLedgerEntry[] = Array.from(
      { length: MAX_LEDGER_ENTRIES + 5 },
      (_, idx) => ({
        documentId: docId,
        pageId: makeUuid(91, idx + 1),
        syncedAtUnixSec: 1_762_500_000 + idx,
      }),
    );

    await recordSyncedPagesInLedger(overflowEntries);
    resetMockLocalStorageOnly();

    const initial = await reconcileSyncLedgerToDexie(pc2Db);
    expect(initial.needsBackupImport).toBe(true);

    await dismissBackupImportWarning();
    expect((await getBackupImportWarningStatus()).needsBackupImport).toBe(false);

    // Register auto-reconcile listener on PC 2 and record a brand-new page into storage.sync.
    const unsubscribe = registerSyncLedgerAutoReconcile(pc2Db);
    try {
      const livePageId = makeUuid(99, 999);
      await recordSyncedPagesInLedger([
        {
          documentId: docId,
          pageId: livePageId,
          syncedAtUnixSec: 1_763_000_000,
        },
      ]);

      // Wait briefly for the async storage.onChanged reconciliation promise to settle.
      await new Promise((resolve) => setTimeout(resolve, 30));

      const hydratedLivePage = await getPage(docId, livePageId, pc2Db);
      expect(hydratedLivePage?.status).toBe('Uploaded');
    } finally {
      unsubscribe();
    }
  });
});
