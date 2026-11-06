import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deriveOneNoteNotebookName,
  type DocumentRecord,
  exportDatabaseBackup,
  getCachedNotebookByName,
  getDocument,
  getPage,
  getPendingPages,
  importDatabaseBackupJson,
  type PageRecord,
  RmOneNoteDatabase,
  resetInProgressPages,
  savePage,
  serializeDatabaseBackup,
  setDocumentOneNoteUrl,
  updatePageStatus,
  upsertCachedNotebook,
  upsertCachedSection,
  upsertFileTree,
} from '../db';

let dbIndex = 0;

function createIsolatedDb(): RmOneNoteDatabase {
  dbIndex += 1;
  return new RmOneNoteDatabase(`testRmDb_${dbIndex}`);
}

describe('Dexie repository and JSON backup layer', () => {
  let testDb: RmOneNoteDatabase;

  beforeEach(() => {
    testDb = createIsolatedDb();
  });

  afterEach(async () => {
    testDb.close();
    await testDb.delete();
  });

  it('derives deterministic OneNote notebook names matching legacy path conventions', () => {
    expect(deriveOneNoteNotebookName('')).toBe('rm_Uncategorized');
    expect(deriveOneNoteNotebookName('Quick sheets')).toBe('rm_Uncategorized');
    expect(deriveOneNoteNotebookName('Quick sheets/Page 1')).toBe('rm_Quick sheets');
    expect(
      deriveOneNoteNotebookName('Academy/BachelorPhysCS/Year1/Semester A/Calculus 1/Page 40'),
    ).toBe('rm_Academy_BachelorPhysCS_Year1_Semester A');
    expect(deriveOneNoteNotebookName('R&D: Q1*Plan?/Spec/Page 1')).toBe('rm_R&D_ Q1_Plan_');
  });

  it('upserts file tree while preserving locally resolved oneNoteNotebookUrl', async () => {
    const docId = '11111111-1111-4111-8111-111111111111';
    const initial: DocumentRecord = {
      documentId: docId,
      visibleName: 'Calculus 1',
      type: 'DocumentType',
      parent: '22222222-2222-4222-8222-222222222222',
      virtualPath: 'Academy/Calculus 1',
      cloudVersion: 1,
      contentHash: 'hash-v1',
      lastModified: '2026-11-01T10:00:00.000Z',
      oneNoteNotebookUrl: null,
    };

    await upsertFileTree([initial], testDb);
    await setDocumentOneNoteUrl(docId, 'https://onenote.example.com/nb/1', testDb);

    await upsertFileTree(
      [
        {
          ...initial,
          cloudVersion: 2,
          contentHash: 'hash-v2',
          lastModified: '2026-11-02T12:00:00.000Z',
          oneNoteNotebookUrl: null,
        },
      ],
      testDb,
    );

    const saved = await getDocument(docId, testDb);
    expect(saved?.cloudVersion).toBe(2);
    expect(saved?.contentHash).toBe('hash-v2');
    expect(saved?.oneNoteNotebookUrl).toBe('https://onenote.example.com/nb/1');
  });

  it('tracks page lifecycle statuses and resets interrupted transient pages on worker restart', async () => {
    const docId = '33333333-3333-4333-8333-333333333333';
    const basePage: Omit<PageRecord, 'pageId' | 'status'> = {
      documentId: docId,
      pageNumber: '1',
      title: 'Lecture 1',
      virtualPath: 'Academy/Calculus 1/Page 1',
      fileSizeBytes: 4096,
      lastModified: '2026-11-05T08:00:00.000Z',
      contentHash: 'p-hash',
      lastSyncTime: null,
      oneNotePageId: null,
      oneNotePageUrl: null,
      retryCount: 0,
      lastError: null,
    };

    await savePage({ ...basePage, pageId: 'aaaa0001-0000-4000-8000-000000000001', status: 'Queued' }, testDb);
    await savePage({ ...basePage, pageId: 'aaaa0002-0000-4000-8000-000000000002', status: 'Converting' }, testDb);
    await savePage({ ...basePage, pageId: 'aaaa0003-0000-4000-8000-000000000003', status: 'Uploading' }, testDb);
    await savePage({ ...basePage, pageId: 'aaaa0004-0000-4000-8000-000000000004', status: 'Indexing' }, testDb);
    await savePage({ ...basePage, pageId: 'aaaa0005-0000-4000-8000-000000000005', status: 'Uploaded' }, testDb);

    const resetCount = await resetInProgressPages(testDb);
    expect(resetCount).toBe(4);

    const pending = await getPendingPages(10, testDb);
    expect(pending).toHaveLength(4);

    const targetPageId = 'aaaa0001-0000-4000-8000-000000000001';
    await updatePageStatus(
      docId,
      targetPageId,
      'Failed',
      { lastError: 'HTTP 429 Too Many Requests' },
      testDb,
    );

    const failedPage = await getPage(docId, targetPageId, testDb);
    expect(failedPage?.retryCount).toBe(1);
    expect(failedPage?.lastError).toBe('HTTP 429 Too Many Requests');

    await updatePageStatus(
      docId,
      targetPageId,
      'Uploaded',
      {
        syncedAtIso: '2026-11-06T09:00:00.000Z',
        oneNotePageId: 'on-page-1',
        oneNotePageUrl: 'https://onenote.example.com/page/1',
      },
      testDb,
    );

    const uploadedPage = await getPage(docId, targetPageId, testDb);
    expect(uploadedPage?.status).toBe('Uploaded');
    expect(uploadedPage?.lastError).toBeNull();
    expect(uploadedPage?.lastSyncTime).toBe('2026-11-06T09:00:00.000Z');
    expect(uploadedPage?.oneNotePageUrl).toBe('https://onenote.example.com/page/1');
  });

  it('caches OneNote notebooks and merges embedded sections locally', async () => {
    await upsertCachedNotebook(
      {
        oneNoteNotebookId: 'nb-123',
        displayName: 'rm_Academy',
        webUrl: 'https://onenote.example.com/nb-123',
        sections: {
          'Calculus 1': { sectionId: 'sec-1', displayName: 'Calculus 1' },
        },
      },
      testDb,
    );

    await upsertCachedSection(
      'nb-123',
      { sectionId: 'sec-2', displayName: 'Linear Algebra' },
      testDb,
    );

    const cached = await getCachedNotebookByName('rm_Academy', testDb);
    expect(cached?.oneNoteNotebookId).toBe('nb-123');
    expect(Object.keys(cached?.sections ?? {})).toEqual(['Calculus 1', 'Linear Algebra']);
  });

  it('exports and imports portable JSON backups without overwriting newer target sync timestamps', async () => {
    const sourceDb = createIsolatedDb();
    const docId = '44444444-4444-4444-8444-444444444444';
    const oldPageId = 'bbbb0001-0000-4000-8000-000000000001';
    const sharedPageId = 'bbbb0002-0000-4000-8000-000000000002';

    try {
      await upsertFileTree(
        [
          {
            documentId: docId,
            visibleName: 'Physics 1',
            type: 'DocumentType',
            parent: '',
            virtualPath: 'Academy/Physics 1',
            cloudVersion: 3,
            contentHash: 'doc-h3',
            lastModified: '2026-11-04T10:00:00.000Z',
            oneNoteNotebookUrl: 'https://onenote.example.com/physics',
          },
        ],
        sourceDb,
      );

      await savePage(
        {
          documentId: docId,
          pageId: oldPageId,
          pageNumber: '1',
          title: 'Kinematics',
          virtualPath: 'Academy/Physics 1/Page 1',
          fileSizeBytes: 1024,
          lastModified: '2026-11-01T10:00:00.000Z',
          contentHash: 'h1',
          status: 'Uploaded',
          lastSyncTime: '2026-11-01T10:05:00.000Z',
          oneNotePageId: 'on-1',
          oneNotePageUrl: 'https://onenote.example.com/p1',
          retryCount: 0,
          lastError: null,
        },
        sourceDb,
      );

      await savePage(
        {
          documentId: docId,
          pageId: sharedPageId,
          pageNumber: '2',
          title: 'Dynamics',
          virtualPath: 'Academy/Physics 1/Page 2',
          fileSizeBytes: 2048,
          lastModified: '2026-11-02T10:00:00.000Z',
          contentHash: 'h2',
          status: 'Uploaded',
          lastSyncTime: '2026-11-02T10:05:00.000Z',
          oneNotePageId: 'on-2',
          oneNotePageUrl: 'https://onenote.example.com/p2',
          retryCount: 0,
          lastError: null,
        },
        sourceDb,
      );

      await upsertCachedNotebook(
        {
          oneNoteNotebookId: 'nb-phys',
          displayName: 'rm_Academy',
          webUrl: 'https://onenote.example.com/physics',
          sections: { 'Physics 1': { sectionId: 'sec-p1', displayName: 'Physics 1' } },
        },
        sourceDb,
      );

      const exportedJson = await serializeDatabaseBackup(sourceDb);
      const snapshot = await exportDatabaseBackup(sourceDb);
      expect(snapshot.pages).toHaveLength(2);

      // Simulate target PC already having a newer sync timestamp for `sharedPageId` from storage.sync,
      // but lacking `oneNotePageUrl` and lacking `oldPageId`.
      await savePage(
        {
          documentId: docId,
          pageId: sharedPageId,
          pageNumber: '',
          title: '',
          virtualPath: '',
          fileSizeBytes: 0,
          lastModified: '2026-11-06T12:00:00.000Z',
          contentHash: '',
          status: 'Uploaded',
          lastSyncTime: '2026-11-06T12:00:00.000Z',
          oneNotePageId: null,
          oneNotePageUrl: null,
          retryCount: 0,
          lastError: null,
        },
        testDb,
      );

      const summary = await importDatabaseBackupJson(exportedJson, testDb);
      expect(summary).toEqual({
        documentsImported: 1,
        pagesImported: 2,
        notebooksImported: 1,
      });

      const restoredOld = await getPage(docId, oldPageId, testDb);
      expect(restoredOld?.status).toBe('Uploaded');
      expect(restoredOld?.oneNotePageUrl).toBe('https://onenote.example.com/p1');

      const mergedShared = await getPage(docId, sharedPageId, testDb);
      expect(mergedShared?.lastSyncTime).toBe('2026-11-06T12:00:00.000Z');
      expect(mergedShared?.oneNotePageUrl).toBe('https://onenote.example.com/p2');

      await expect(importDatabaseBackupJson('not json', testDb)).rejects.toThrow(
        /failed to parse JSON/,
      );
      await expect(
        importDatabaseBackupJson(JSON.stringify({ schemaVersion: 999 }), testDb),
      ).rejects.toThrow(/Unsupported backup schema version/);
    } finally {
      sourceDb.close();
      await sourceDb.delete();
    }
  });
});
