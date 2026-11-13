import { beforeEach, describe, expect, it } from 'vitest';
import { saveRemarkableAuth } from '../auth/authStore';
import { RmOneNoteDatabase } from '../db/db';
import { deriveOneNoteNotebookName, type PageRecord } from '../db/models';
import { computeRollupForPages } from '../options/views/SyncControlView';
import {
  buildFileTreeHierarchy,
  deriveDeterministicPdfPageUuid,
  deriveInitialSelectionMap,
  downloadPageRmBytes,
  extractOrderedPageIdsFromContent,
  extractWhitelistFromSelection,
  formatFolderItemCount,
  formatSelectionSummary,
  getFolderSubtreeCounts,
  getNodeSelectionState,
  normalizeRemarkableTimestamp,
  parseDocumentMetadata,
  parseSync15Index,
  REMARKABLE_SYNC_FILES_URL,
  REMARKABLE_SYNC_ROOT_URL,
  resolveDocumentRmPages,
  saveWhitelistAndReconcilePages,
  syncRemarkableCloudTree,
  toggleNodeSelection,
} from '../remarkable';
import { getWhitelist, setWhitelist, updatePreferences } from '../storage/preferences';
import { recordSyncedPagesInLedger, reconcileSyncLedgerToDexie } from '../storage/syncLedger';
import { resetMockBrowserStorage } from './setup';

const FOLDER_ACADEMY_ID = '11111111-1111-4111-8111-111111111111';
const FOLDER_SEMESTER_ID = '22222222-2222-4222-8222-222222222222';
const DOC_CALCULUS_ID = '33333333-3333-4333-8333-333333333333';
const DOC_LINEAR_ID = '44444444-4444-4444-8444-444444444444';
const FOLDER_TRASHED_ID = '55555555-5555-4555-8555-555555555555';
const DOC_IN_TRASH_FOLDER_ID = '66666666-6666-4666-8666-666666666666';

const PAGE_1_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAGE_2_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PAGE_DELETED_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PAGE_LINEAR_1_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

interface MockCloudRequestLog {
  url: string;
  rmFilename: string | null;
  authorization: string | null;
}

function createMockSync15Server(initialRoot: {
  hash: string;
  generation: number;
  blobs: Record<string, string | Uint8Array>;
}) {
  const state = {
    hash: initialRoot.hash,
    generation: initialRoot.generation,
    blobs: { ...initialRoot.blobs },
  };
  const requests: MockCloudRequestLog[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers(init?.headers);
    const rmFilename = headers.get('rm-filename');
    const authorization = headers.get('Authorization');

    requests.push({ url, rmFilename, authorization });

    if (url === REMARKABLE_SYNC_ROOT_URL) {
      if (!state.hash && state.generation === 0) {
        return new Response('Not Found', { status: 404 });
      }
      return new Response(
        JSON.stringify({
          hash: state.hash,
          generation: state.generation,
          schemaVersion: 4,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    if (url.startsWith(`${REMARKABLE_SYNC_FILES_URL}/`)) {
      if (!rmFilename) {
        return new Response('Missing mandatory rm-filename header', { status: 400 });
      }
      const blobHash = decodeURIComponent(url.slice(`${REMARKABLE_SYNC_FILES_URL}/`.length));
      const payload = state.blobs[blobHash];
      if (payload === undefined) {
        return new Response(`Missing blob ${blobHash}`, { status: 404 });
      }

      if (payload instanceof Uint8Array) {
        const copy = new Uint8Array(payload.byteLength);
        copy.set(payload);
        return new Response(copy.buffer, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        });
      }

      return new Response(payload, {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }

    return new Response(`Unhandled URL ${url}`, { status: 500 });
  };

  return { state, requests, fetchImpl };
}

describe('Sync15 index and metadata parsers', () => {
  it('parses both schema v3 and schema v4 .docSchema indexes', () => {
    const v3Raw = [
      '3',
      `hash_meta:0:${DOC_CALCULUS_ID}.metadata:0:182`,
      `hash_p1:0:${DOC_CALCULUS_ID}/${PAGE_1_ID}.rm:0:4096`,
    ].join('\n');

    const v3 = parseSync15Index(v3Raw);
    expect(v3.schemaVersion).toBe(3);
    expect(v3.entries).toHaveLength(2);
    expect(v3.entries[1]).toEqual({
      hash: 'hash_p1',
      entryType: '0',
      id: `${DOC_CALCULUS_ID}/${PAGE_1_ID}.rm`,
      subfiles: 0,
      size: 4096,
    });

    const v4Raw = [
      '4',
      '0:.:2:5000',
      `doc_hash_1:80000000:${FOLDER_ACADEMY_ID}:1:150`,
      `doc_hash_2:80000000:${DOC_CALCULUS_ID}:4:4850`,
    ].join('\r\n');

    const v4 = parseSync15Index(v4Raw);
    expect(v4.schemaVersion).toBe(4);
    expect(v4.entries).toHaveLength(2);
    expect(v4.entries[0].id).toBe(FOLDER_ACADEMY_ID);
    expect(v4.entries[1].size).toBe(4850);

    const v4DocSubIndexRaw = [
      '4',
      '0:00cdb943-d8b6-4db7-9792-3dc44f06e93e:2:1562389',
      'hash_doc_meta:0:00cdb943-d8b6-4db7-9792-3dc44f06e93e.metadata:0:189',
      `hash_doc_rm:0:00cdb943-d8b6-4db7-9792-3dc44f06e93e/${PAGE_1_ID}.rm:0:1562200`,
    ].join('\n');

    const v4DocSub = parseSync15Index(v4DocSubIndexRaw);
    expect(v4DocSub.schemaVersion).toBe(4);
    expect(v4DocSub.entries).toHaveLength(2);
    expect(v4DocSub.entries[0].id).toBe('00cdb943-d8b6-4db7-9792-3dc44f06e93e.metadata');

    expect(() => parseSync15Index('')).toThrow(/empty payload/i);
    expect(() => parseSync15Index('5\n0:.:0:0')).toThrow(/Unsupported reMarkable Sync15 schema/i);
  });

  it('normalizes standard ms and >18-digit nanosecond timestamps accurately', () => {
    expect(normalizeRemarkableTimestamp('1730900000000')).toBe('2024-11-06T13:33:20.000Z');
    // 19-digit nanosecond bug format
    expect(normalizeRemarkableTimestamp('1730900000000000000')).toBe('2024-11-06T13:33:20.000Z');
    expect(normalizeRemarkableTimestamp('')).toBe('1970-01-01T00:00:00.000Z');

    const parsedMeta = parseDocumentMetadata(
      JSON.stringify({
        visibleName: '  Calculus 1  ',
        type: 'DocumentType',
        parent: FOLDER_SEMESTER_ID,
        lastModified: '1730900000000000000',
        version: 4,
        deleted: false,
      }),
    );
    expect(parsedMeta.visibleName).toBe('Calculus 1');
    expect(parsedMeta.lastModifiedIso).toBe('2024-11-06T13:33:20.000Z');
  });

  it('orders firmware 3.x cPages by CRDT ASCII idx, skips deleted pages, and preserves annotated PDF page numbers', () => {
    const contentJson = JSON.stringify({
      fileType: 'notebook',
      formatVersion: 2,
      cPages: {
        pages: [
          { id: PAGE_2_ID, idx: { timestamp: '1:2', value: 'bc' } },
          {
            id: PAGE_DELETED_ID,
            idx: { timestamp: '1:3', value: 'bb' },
            deleted: { timestamp: '1:4', value: 1 },
          },
          { id: PAGE_1_ID, idx: { timestamp: '1:1', value: 'ab' } },
        ],
      },
    });

    expect(extractOrderedPageIdsFromContent(contentJson)).toEqual([PAGE_1_ID, PAGE_2_ID]);

    // Annotated PDF where page 1 has no strokes, page 2 has strokes, and a deleted page still has a tombstoned .rm blob
    const pdfContentJson = JSON.stringify({
      fileType: 'pdf',
      cPages: {
        pages: [
          { id: 'unannotated-p1', idx: { timestamp: '1:1', value: 'aa' } },
          { id: PAGE_2_ID, idx: { timestamp: '1:2', value: 'ab' } },
          {
            id: PAGE_DELETED_ID,
            idx: { timestamp: '1:3', value: 'ac' },
            deleted: { timestamp: '1:4', value: 1 },
          },
        ],
      },
    });

    const docEntries = parseSync15Index(
      [
        '4',
        '0:.:3:8000',
        `h_meta:0:${DOC_CALCULUS_ID}.metadata:0:120`,
        `h_p2_rm:0:${DOC_CALCULUS_ID}/${PAGE_2_ID}.rm:0:3200`,
        `h_del_rm:0:${DOC_CALCULUS_ID}/${PAGE_DELETED_ID}.rm:0:1500`,
      ].join('\n'),
    ).entries;

    const resolved = resolveDocumentRmPages(DOC_CALCULUS_ID, docEntries, pdfContentJson);
    expect(resolved).toEqual([
      {
        pageId: 'unannotated-p1',
        pageNumber: '1',
        title: 'Page 1',
        rmBlobHash: '',
        fileSizeBytes: 0,
      },
      {
        pageId: PAGE_2_ID,
        pageNumber: '2',
        title: 'Page 2',
        rmBlobHash: 'h_p2_rm',
        fileSizeBytes: 3200,
      },
    ]);

    // Ensure when ALL cPages are deleted, tombstoned .rm blobs are NOT resurrected
    const allDeletedJson = JSON.stringify({
      cPages: {
        pages: [
          {
            id: PAGE_DELETED_ID,
            idx: { timestamp: '1:1', value: 'aa' },
            deleted: { timestamp: '1:2', value: 1 },
          },
        ],
      },
    });
    expect(resolveDocumentRmPages(DOC_CALCULUS_ID, docEntries, allDeletedJson)).toEqual([]);

    // Firmware 3.x PDF with cPages.pages[].redir mapping and an inserted blank note page (no redir)
    const pdfWithRedirEntries = parseSync15Index(
      [
        '4',
        '0:.:4:18000',
        `h_meta:0:${DOC_CALCULUS_ID}.metadata:0:120`,
        `h_pdf_blob:0:${DOC_CALCULUS_ID}.pdf:0:12000`,
        `h_inserted_rm:0:${DOC_CALCULUS_ID}/${PAGE_1_ID}.rm:0:2000`,
        `h_pdf_p2_rm:0:${DOC_CALCULUS_ID}/${PAGE_2_ID}.rm:0:3200`,
      ].join('\n'),
    ).entries;

    const pdfWithRedirContentJson = JSON.stringify({
      fileType: 'pdf',
      cPages: {
        pages: [
          { id: 'unannotated-p1', idx: { timestamp: '1:1', value: 'aa' }, redir: { timestamp: '1:1', value: 0 } },
          // Inserted blank note page between PDF page 1 and PDF page 2 (no redir property)
          { id: PAGE_1_ID, idx: { timestamp: '1:2', value: 'ab' } },
          // Annotated PDF page 2 (0-based redir.value = 1, even though it is position 3 in the notebook)
          { id: PAGE_2_ID, idx: { timestamp: '1:3', value: 'ac' }, redir: { timestamp: '1:3', value: 1 } },
        ],
      },
    });

    expect(
      resolveDocumentRmPages(DOC_CALCULUS_ID, pdfWithRedirEntries, pdfWithRedirContentJson),
    ).toEqual([
      {
        pageId: 'unannotated-p1',
        pageNumber: '1',
        title: 'Page 1',
        rmBlobHash: '',
        fileSizeBytes: 0,
        pdfBlobHash: 'h_pdf_blob',
        pdfPageIndex: 0,
      },
      {
        pageId: PAGE_1_ID,
        pageNumber: '2',
        title: 'Page 2',
        rmBlobHash: 'h_inserted_rm',
        fileSizeBytes: 2000,
        pdfBlobHash: 'h_pdf_blob',
        pdfPageIndex: null,
      },
      {
        pageId: PAGE_2_ID,
        pageNumber: '3',
        title: 'Page 3',
        rmBlobHash: 'h_pdf_p2_rm',
        fileSizeBytes: 3200,
        pdfBlobHash: 'h_pdf_blob',
        pdfPageIndex: 1,
      },
    ]);

    // Synthesizes all pages for a completely unannotated PDF using pageCount
    const unannotatedPdfEntries = parseSync15Index(
      [
        '4',
        '0:.:2:12120',
        `h_meta:0:${DOC_CALCULUS_ID}.metadata:0:120`,
        `h_pdf_blob:0:${DOC_CALCULUS_ID}.pdf:0:12000`,
      ].join('\n'),
    ).entries;

    const unannotatedPdfContent = JSON.stringify({
      fileType: 'pdf',
      pageCount: 3,
      cPages: { pages: [] },
    });

    const unannotatedResolved = resolveDocumentRmPages(
      DOC_CALCULUS_ID,
      unannotatedPdfEntries,
      unannotatedPdfContent,
    );
    expect(unannotatedResolved).toHaveLength(3);
    expect(unannotatedResolved[0]).toEqual({
      pageId: deriveDeterministicPdfPageUuid(DOC_CALCULUS_ID, 0),
      pageNumber: '1',
      title: 'Page 1',
      rmBlobHash: '',
      fileSizeBytes: 0,
      pdfBlobHash: 'h_pdf_blob',
      pdfPageIndex: 0,
    });
    expect(unannotatedResolved[2]).toEqual({
      pageId: deriveDeterministicPdfPageUuid(DOC_CALCULUS_ID, 2),
      pageNumber: '3',
      title: 'Page 3',
      rmBlobHash: '',
      fileSizeBytes: 0,
      pdfBlobHash: 'h_pdf_blob',
      pdfPageIndex: 2,
    });

    // Synthesizes unannotated pages around a sparse annotated page in a 5-page PDF
    const sparsePdfEntries = parseSync15Index(
      [
        '4',
        '0:.:3:15320',
        `h_meta:0:${DOC_CALCULUS_ID}.metadata:0:120`,
        `h_pdf_blob:0:${DOC_CALCULUS_ID}.pdf:0:12000`,
        `h_pdf_p4_rm:0:${DOC_CALCULUS_ID}/${PAGE_2_ID}.rm:0:3200`,
      ].join('\n'),
    ).entries;

    const sparsePdfContent = JSON.stringify({
      fileType: 'pdf',
      pageCount: 5,
      cPages: {
        pages: [
          // Only PDF Page 4 (0-based redir.value = 3) is present in cPages
          { id: PAGE_2_ID, idx: { timestamp: '1:1', value: 'ba' }, redir: { timestamp: '1:1', value: 3 } },
        ],
      },
    });

    const sparseResolved = resolveDocumentRmPages(
      DOC_CALCULUS_ID,
      sparsePdfEntries,
      sparsePdfContent,
    );
    expect(sparseResolved).toHaveLength(5);
    expect(sparseResolved.map((p) => p.pageNumber)).toEqual(['1', '2', '3', '4', '5']);
    expect(sparseResolved[0].fileSizeBytes).toBe(0);
    expect(sparseResolved[0].pdfPageIndex).toBe(0);
    expect(sparseResolved[3]).toEqual({
      pageId: PAGE_2_ID,
      pageNumber: '4',
      title: 'Page 4',
      rmBlobHash: 'h_pdf_p4_rm',
      fileSizeBytes: 3200,
      pdfBlobHash: 'h_pdf_blob',
      pdfPageIndex: 3,
    });
    expect(sparseResolved[4].fileSizeBytes).toBe(0);
    expect(sparseResolved[4].pdfPageIndex).toBe(4);
  });
});

describe('syncRemarkableCloudTree, delta updates, and in-memory .rm extraction', () => {
  let testDb: RmOneNoteDatabase;

  beforeEach(async () => {
    resetMockBrowserStorage();
    testDb = new RmOneNoteDatabase(`testSync15_${crypto.randomUUID()}`);
    await saveRemarkableAuth({
      deviceId: 'dev-1',
      deviceToken: 'device-token-1',
      userToken: 'valid-user-jwt',
      userTokenExpiresAtMs: Date.now() + 60 * 60 * 1000,
      pairedAt: '2026-11-06T12:00:00.000Z',
    });
  });

  it('indexes hierarchy, filters trash, computes virtual paths, fast-paths unchanged roots, and downloads .rm bytes in memory', async () => {
    const rmPage1Bytes = new Uint8Array([0x72, 0x65, 0x4d, 0x61, 0x72, 0x6b, 0x36, 0x01]);
    const rmPage2Bytes = new Uint8Array([0x72, 0x65, 0x4d, 0x61, 0x72, 0x6b, 0x36, 0x02]);
    const rmPage1EditedBytes = new Uint8Array([0x72, 0x65, 0x4d, 0x61, 0x72, 0x6b, 0x36, 0x99]);

    const blobs: Record<string, string | Uint8Array> = {
      root_v1: [
        '4',
        '0:.:5:10000',
        `sub_academy_v1:80000000:${FOLDER_ACADEMY_ID}:1:150`,
        `sub_semester_v1:80000000:${FOLDER_SEMESTER_ID}:1:150`,
        `sub_calc_v1:80000000:${DOC_CALCULUS_ID}:4:8000`,
        `sub_trashed_folder:80000000:${FOLDER_TRASHED_ID}:1:150`,
        `sub_doc_in_trash:80000000:${DOC_IN_TRASH_FOLDER_ID}:2:1550`,
      ].join('\n'),

      sub_academy_v1: `4\n0:.:1:150\nmeta_academy_v1:0:${FOLDER_ACADEMY_ID}.metadata:0:150`,
      meta_academy_v1: JSON.stringify({
        visibleName: 'Academy',
        type: 'CollectionType',
        parent: '',
        lastModified: '1730900000000',
        version: 1,
      }),

      sub_semester_v1: `4\n0:.:1:150\nmeta_semester_v1:0:${FOLDER_SEMESTER_ID}.metadata:0:150`,
      meta_semester_v1: JSON.stringify({
        visibleName: 'Semester A',
        type: 'CollectionType',
        parent: FOLDER_ACADEMY_ID,
        lastModified: '1730900000000',
        version: 1,
      }),

      sub_calc_v1: [
        '4',
        '0:.:4:8000',
        `meta_calc_v1:0:${DOC_CALCULUS_ID}.metadata:0:180`,
        `content_calc_v1:0:${DOC_CALCULUS_ID}.content:0:320`,
        `rm_p1_v1:0:${DOC_CALCULUS_ID}/${PAGE_1_ID}.rm:0:${rmPage1Bytes.byteLength}`,
        `rm_p2_v1:0:${DOC_CALCULUS_ID}/${PAGE_2_ID}.rm:0:${rmPage2Bytes.byteLength}`,
      ].join('\n'),
      meta_calc_v1: JSON.stringify({
        visibleName: 'Calculus 1',
        type: 'DocumentType',
        parent: FOLDER_SEMESTER_ID,
        lastModified: '1730900100000',
        version: 2,
      }),
      content_calc_v1: JSON.stringify({
        fileType: 'notebook',
        formatVersion: 2,
        cPages: {
          pages: [
            { id: PAGE_1_ID, idx: { timestamp: '1:1', value: 'aa' } },
            { id: PAGE_2_ID, idx: { timestamp: '1:2', value: 'ab' } },
          ],
        },
      }),
      rm_p1_v1: rmPage1Bytes,
      rm_p2_v1: rmPage2Bytes,

      sub_trashed_folder: `4\n0:.:1:150\nmeta_trashed_folder:0:${FOLDER_TRASHED_ID}.metadata:0:150`,
      meta_trashed_folder: JSON.stringify({
        visibleName: 'Old Trash Folder',
        type: 'CollectionType',
        parent: 'trash',
        lastModified: '1730900000000',
      }),

      sub_doc_in_trash: [
        '4',
        '0:.:2:1550',
        `meta_doc_in_trash:0:${DOC_IN_TRASH_FOLDER_ID}.metadata:0:150`,
        `rm_trash_p1:0:${DOC_IN_TRASH_FOLDER_ID}/${PAGE_1_ID}.rm:0:1400`,
      ].join('\n'),
      meta_doc_in_trash: JSON.stringify({
        visibleName: 'Discarded Notes',
        type: 'DocumentType',
        parent: FOLDER_TRASHED_ID,
        lastModified: '1730900000000',
      }),
    };

    const server = createMockSync15Server({
      hash: 'root_v1',
      generation: 10,
      blobs,
    });

    // 1. Initial cloud tree sync (nothing whitelisted yet -> pages indexed as 'Skipped')
    const firstSync = await syncRemarkableCloudTree({
      database: testDb,
      fetchImpl: server.fetchImpl,
    });

    expect(firstSync.upToDate).toBe(false);
    expect(firstSync.totalItems).toBe(3); // Academy, Semester A, Calculus 1 (trash excluded!)
    expect(firstSync.folderCount).toBe(2);
    expect(firstSync.documentCount).toBe(1);
    expect(firstSync.indexedPagesCount).toBe(2);
    expect(firstSync.pendingPagesCount).toBe(0);

    // Ensure zero .rm binary blobs were downloaded during metadata tree sync
    expect(
      server.requests.some((req) => req.rmFilename?.endsWith('.rm')),
    ).toBe(false);
    expect(
      server.requests.every((req) => req.authorization === 'Bearer valid-user-jwt'),
    ).toBe(true);

    const calcDoc = await testDb.documents.get(DOC_CALCULUS_ID);
    expect(calcDoc?.virtualPath).toBe('Academy/Semester A/Calculus 1');

    const p1Initial = await testDb.pages.get([DOC_CALCULUS_ID, PAGE_1_ID]);
    expect(p1Initial?.virtualPath).toBe('Academy/Semester A/Calculus 1/Page 1');
    expect(deriveOneNoteNotebookName(p1Initial!.virtualPath)).toBe('rm_Academy_Semester A');
    expect(p1Initial?.status).toBe('Skipped');
    expect(p1Initial?.contentHash).toBe('rm_p1_v1');

    // 2. User selects Semester A folder + Calculus 1 in FileBrowserView -> promotes Skipped -> Pending
    const saveRes = await saveWhitelistAndReconcilePages(
      {
        syncFiles: [DOC_CALCULUS_ID],
        syncFolders: [FOLDER_SEMESTER_ID],
      },
      testDb,
    );
    expect(saveRes.updatedPagesCount).toBe(2);
    expect(saveRes.pendingPagesCount).toBe(2);

    // 3. Second sync with identical root hash -> 1 HTTP GET fast-path!
    server.requests.length = 0;
    const fastSync = await syncRemarkableCloudTree({
      database: testDb,
      fetchImpl: server.fetchImpl,
    });
    expect(fastSync.upToDate).toBe(true);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].url).toBe(REMARKABLE_SYNC_ROOT_URL);

    // Simulate Phase 6 completing upload of both pages
    await testDb.pages.update([DOC_CALCULUS_ID, PAGE_1_ID], {
      status: 'Uploaded',
      oneNotePageId: 'onenote-page-1',
      lastSyncTime: '2026-11-06T14:00:00.000Z',
    });
    await testDb.pages.update([DOC_CALCULUS_ID, PAGE_2_ID], {
      status: 'Uploaded',
      oneNotePageId: 'onenote-page-2',
      lastSyncTime: '2026-11-06T14:00:00.000Z',
    });

    // 4. Tablet edits Page 1 of Calculus 1 AND adds a new notebook Linear Algebra inside Semester A
    server.state.hash = 'root_v2';
    server.state.generation = 11;
    server.state.blobs.root_v2 = [
      '4',
      '0:.:4:12000',
      `sub_academy_v1:80000000:${FOLDER_ACADEMY_ID}:1:150`,
      `sub_semester_v1:80000000:${FOLDER_SEMESTER_ID}:1:150`,
      `sub_calc_v2:80000000:${DOC_CALCULUS_ID}:4:8000`,
      `sub_linear_v1:80000000:${DOC_LINEAR_ID}:3:4000`,
    ].join('\n');
    server.state.blobs.sub_calc_v2 = [
      '4',
      '0:.:4:8000',
      `meta_calc_v2:0:${DOC_CALCULUS_ID}.metadata:0:180`,
      `content_calc_v1:0:${DOC_CALCULUS_ID}.content:0:320`,
      `rm_p1_v2:0:${DOC_CALCULUS_ID}/${PAGE_1_ID}.rm:0:${rmPage1EditedBytes.byteLength}`,
      `rm_p2_v1:0:${DOC_CALCULUS_ID}/${PAGE_2_ID}.rm:0:${rmPage2Bytes.byteLength}`,
    ].join('\n');
    server.state.blobs.meta_calc_v2 = JSON.stringify({
      visibleName: 'Calculus 1',
      type: 'DocumentType',
      parent: FOLDER_SEMESTER_ID,
      lastModified: '1730905000000',
      version: 3,
    });
    server.state.blobs.rm_p1_v2 = rmPage1EditedBytes;

    server.state.blobs.sub_linear_v1 = [
      '4',
      '0:.:3:4000',
      `meta_linear_v1:0:${DOC_LINEAR_ID}.metadata:0:180`,
      `content_linear_v1:0:${DOC_LINEAR_ID}.content:0:220`,
      `rm_linear_p1:0:${DOC_LINEAR_ID}/${PAGE_LINEAR_1_ID}.rm:0:2048`,
    ].join('\n');
    server.state.blobs.meta_linear_v1 = JSON.stringify({
      visibleName: 'Linear Algebra',
      type: 'DocumentType',
      parent: FOLDER_SEMESTER_ID,
      lastModified: '1730905100000',
      version: 1,
    });
    server.state.blobs.content_linear_v1 = JSON.stringify({
      cPages: {
        pages: [{ id: PAGE_LINEAR_1_ID, idx: { timestamp: '1:1', value: 'aa' } }],
      },
    });

    server.requests.length = 0;
    const deltaSync = await syncRemarkableCloudTree({
      database: testDb,
      fetchImpl: server.fetchImpl,
    });

    expect(deltaSync.changedDocuments).toBe(2); // Only Calculus 1 + Linear Algebra fetched!
    // Unchanged folders Academy & Semester A were NOT re-fetched!
    expect(
      server.requests.some((req) => req.rmFilename === `${FOLDER_ACADEMY_ID}.docSchema`),
    ).toBe(false);

    // Page 1 flipped back to Pending (preserving oneNotePageId), Page 2 stayed Uploaded!
    const p1After = await testDb.pages.get([DOC_CALCULUS_ID, PAGE_1_ID]);
    const p2After = await testDb.pages.get([DOC_CALCULUS_ID, PAGE_2_ID]);
    expect(p1After?.status).toBe('Pending');
    expect(p1After?.oneNotePageId).toBe('onenote-page-1');
    expect(p1After?.contentHash).toBe('rm_p1_v2');
    expect(p2After?.status).toBe('Uploaded');

    // Linear Algebra inside whitelisted Semester A was auto-added to syncFiles and queued Pending!
    const updatedWl = await getWhitelist();
    expect(updatedWl.syncFiles).toContain(DOC_LINEAR_ID);
    const linearPage = await testDb.pages.get([DOC_LINEAR_ID, PAGE_LINEAR_1_ID]);
    expect(linearPage?.status).toBe('Pending');
    expect(linearPage?.virtualPath).toBe('Academy/Semester A/Linear Algebra/Page 1');

    // 5. In-memory .rm extraction via single GET using knownBlobHash
    server.requests.length = 0;
    const downloadedKnown = await downloadPageRmBytes(DOC_CALCULUS_ID, PAGE_1_ID, {
      knownBlobHash: p1After!.contentHash,
      fetchImpl: server.fetchImpl,
    });
    expect(Array.from(downloadedKnown)).toEqual(Array.from(rmPage1EditedBytes));
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].rmFilename).toBe(`${DOC_CALCULUS_ID}/${PAGE_1_ID}.rm`);

    // And fallback resolution when knownBlobHash is omitted
    const downloadedResolved = await downloadPageRmBytes(DOC_CALCULUS_ID, PAGE_2_ID, {
      fetchImpl: server.fetchImpl,
    });
    expect(Array.from(downloadedResolved)).toEqual(Array.from(rmPage2Bytes));
  });

  it('preserves Uploaded status on cross-browser sync ledger stubs when cloud doc is not newer', async () => {
    await setWhitelist({ syncFiles: [DOC_CALCULUS_ID], syncFolders: [] });

    // Simulate PC #1 having uploaded PAGE_1_ID at unix 1730900500 (after doc lastModified 1730900100000)
    await recordSyncedPagesInLedger([
      {
        documentId: DOC_CALCULUS_ID,
        pageId: PAGE_1_ID,
        syncedAtUnixSec: 1_730_900_500,
      },
    ]);

    // PC #2 reconciles storage.sync ledger into empty IndexedDB before first cloud tree sync
    await reconcileSyncLedgerToDexie(testDb);

    const server = createMockSync15Server({
      hash: 'root_pc2',
      generation: 5,
      blobs: {
        root_pc2: `4\n0:.:1:2000\nsub_calc:80000000:${DOC_CALCULUS_ID}:3:2000`,
        sub_calc: [
          '4',
          '0:.:3:2000',
          `meta_calc:0:${DOC_CALCULUS_ID}.metadata:0:150`,
          `content_calc:0:${DOC_CALCULUS_ID}.content:0:150`,
          `rm_p1:0:${DOC_CALCULUS_ID}/${PAGE_1_ID}.rm:0:1700`,
        ].join('\n'),
        meta_calc: JSON.stringify({
          visibleName: 'Calculus 1',
          type: 'DocumentType',
          parent: '',
          lastModified: '1730900100000',
        }),
        content_calc: JSON.stringify({
          cPages: { pages: [{ id: PAGE_1_ID, idx: { value: 'aa' } }] },
        }),
      },
    });

    await syncRemarkableCloudTree({
      database: testDb,
      fetchImpl: server.fetchImpl,
    });

    const hydratedPage = await testDb.pages.get([DOC_CALCULUS_ID, PAGE_1_ID]);
    expect(hydratedPage?.status).toBe('Uploaded');
    expect(hydratedPage?.contentHash).toBe('rm_p1');
    expect(hydratedPage?.virtualPath).toBe('Calculus 1/Page 1');
  });

  it('indexes all document pages including unannotated blank pages, marking blank pages Skipped when syncUnannotatedPdfPages is false', async () => {
    const BLANK_PAGE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const server = createMockSync15Server({
      hash: 'root',
      generation: 1,
      blobs: {
        root: ['4', '0:.:1:1000', `calc_entry:0:${DOC_CALCULUS_ID}:0:500`].join('\n'),
        calc_entry: [
          '4',
          '0:.:3:3000',
          `meta_calc:0:${DOC_CALCULUS_ID}.metadata:0:100`,
          `content_calc:0:${DOC_CALCULUS_ID}.content:0:200`,
          `rm_p1:0:${DOC_CALCULUS_ID}/${PAGE_1_ID}.rm:0:1024`,
        ].join('\n'),
        meta_calc: JSON.stringify({
          visibleName: 'Calculus 1',
          type: 'DocumentType',
          parent: '',
          lastModified: '1730900100000',
        }),
        content_calc: JSON.stringify({
          cPages: {
            pages: [
              { id: PAGE_1_ID, idx: { value: 'aa' } },
              { id: BLANK_PAGE_ID, idx: { value: 'ab' } },
            ],
          },
        }),
        rm_p1: new Uint8Array([1, 2, 3]),
      },
    });

    await setWhitelist({ syncFiles: [DOC_CALCULUS_ID], syncFolders: [] });
    await updatePreferences({ syncUnannotatedPdfPages: false });

    await syncRemarkableCloudTree({
      database: testDb,
      fetchImpl: server.fetchImpl,
    });

    const page1 = await testDb.pages.get([DOC_CALCULUS_ID, PAGE_1_ID]);
    const page2 = await testDb.pages.get([DOC_CALCULUS_ID, BLANK_PAGE_ID]);

    // Page 1 has strokes -> Pending
    expect(page1?.status).toBe('Pending');
    expect(page1?.fileSizeBytes).toBe(1024);
    expect(page1?.pageNumber).toBe('1');

    // Page 2 is blank (no .rm file) -> Indexed, but Skipped from auto-sync
    expect(page2?.status).toBe('Skipped');
    expect(page2?.fileSizeBytes).toBe(0);
    expect(page2?.contentHash).toBe('');
    expect(page2?.pageNumber).toBe('2');
    expect(page2?.title).toBe('Page 2');

    // Regression check: When root hash changes due to an unrelated document changing,
    // unchanged DOC_CALCULUS_ID must NOT promote its blank page from Skipped to Pending.
    server.state.hash = 'root_v2';
    server.state.blobs.root_v2 = [
      '4',
      '0:.:2:2000',
      `calc_entry:0:${DOC_CALCULUS_ID}:0:500`,
      `lin_entry:0:${DOC_LINEAR_ID}:0:500`,
    ].join('\n');
    server.state.blobs.lin_entry = [
      '4',
      '0:.:1:1000',
      `meta_lin:0:${DOC_LINEAR_ID}.metadata:0:100`,
    ].join('\n');
    server.state.blobs.meta_lin = JSON.stringify({
      visibleName: 'Linear Algebra',
      type: 'DocumentType',
      parent: '',
      lastModified: '1730900200000',
    });

    await syncRemarkableCloudTree({
      database: testDb,
      fetchImpl: server.fetchImpl,
    });
    expect((await testDb.pages.get([DOC_CALCULUS_ID, BLANK_PAGE_ID]))?.status).toBe('Skipped');

    // When syncUnannotatedPdfPages is toggled true, reconcile flips page 2 to Pending
    await updatePreferences({ syncUnannotatedPdfPages: true });
    await syncRemarkableCloudTree({
      database: testDb,
      fetchImpl: server.fetchImpl,
    });
    const page2Updated = await testDb.pages.get([DOC_CALCULUS_ID, BLANK_PAGE_ID]);
    expect(page2Updated?.status).toBe('Pending');
  });
});

describe('Tri-state FileTree selection helpers', () => {
  it('computes indeterminate ancestor states and excludes partial folders from syncFolders', () => {
    const roots = buildFileTreeHierarchy([
      {
        documentId: FOLDER_ACADEMY_ID,
        visibleName: 'Academy',
        type: 'CollectionType',
        parent: '',
        virtualPath: '',
        cloudVersion: 1,
        contentHash: 'h1',
        lastModified: '2026-11-06T00:00:00.000Z',
        oneNoteNotebookUrl: null,
      },
      {
        documentId: DOC_CALCULUS_ID,
        visibleName: 'Calculus 1',
        type: 'DocumentType',
        parent: FOLDER_ACADEMY_ID,
        virtualPath: '',
        cloudVersion: 1,
        contentHash: 'h2',
        lastModified: '2026-11-06T00:00:00.000Z',
        oneNoteNotebookUrl: null,
      },
      {
        documentId: DOC_LINEAR_ID,
        visibleName: 'Linear Algebra',
        type: 'DocumentType',
        parent: FOLDER_ACADEMY_ID,
        virtualPath: '',
        cloudVersion: 1,
        contentHash: 'h3',
        lastModified: '2026-11-06T00:00:00.000Z',
        oneNoteNotebookUrl: null,
      },
    ]);

    expect(formatFolderItemCount(roots[0])).toBe('(2 documents)');

    const initial = deriveInitialSelectionMap(
      roots,
      { syncFiles: [DOC_CALCULUS_ID], syncFolders: [] },
      true,
    );
    expect(initial[FOLDER_ACADEMY_ID]).toBeNull(); // Indeterminate!
    expect(initial[DOC_CALCULUS_ID]).toBe(true);
    expect(initial[DOC_LINEAR_ID]).toBe(false);

    // Partially selected Academy is NOT added to syncFolders
    expect(extractWhitelistFromSelection(roots, initial)).toEqual({
      syncFiles: [DOC_CALCULUS_ID],
      syncFolders: [],
    });
    expect(formatSelectionSummary(roots, initial)).toBe('Selected: 1 document');

    // Toggling indeterminate folder selects all children -> fully checked!
    const allChecked = toggleNodeSelection(roots, initial, roots[0]);
    expect(allChecked[FOLDER_ACADEMY_ID]).toBe(true);
    expect(allChecked[DOC_LINEAR_ID]).toBe(true);
    expect(extractWhitelistFromSelection(roots, allChecked)).toEqual({
      syncFiles: [DOC_CALCULUS_ID, DOC_LINEAR_ID],
      syncFolders: [FOLDER_ACADEMY_ID],
    });
    expect(formatSelectionSummary(roots, allChecked)).toBe(
      'Selected: 1 folder, 2 documents',
    );

    // Toggling checked folder unchecks entire subtree
    const allUnchecked = toggleNodeSelection(roots, allChecked, roots[0]);
    expect(allUnchecked[FOLDER_ACADEMY_ID]).toBe(false);
    expect(allUnchecked[DOC_CALCULUS_ID]).toBe(false);
    expect(formatSelectionSummary(roots, allUnchecked)).toBe('No items selected');
  });

  it('propagates indeterminate null state and descendant selected counts across deeply nested folders', () => {
    const roots = buildFileTreeHierarchy([
      {
        documentId: FOLDER_ACADEMY_ID,
        visibleName: 'Academy',
        type: 'CollectionType',
        parent: '',
        virtualPath: 'Academy',
        cloudVersion: 1,
        contentHash: 'h1',
        lastModified: '2026-11-06T00:00:00.000Z',
        oneNoteNotebookUrl: null,
      },
      {
        documentId: FOLDER_SEMESTER_ID,
        visibleName: 'Semester A',
        type: 'CollectionType',
        parent: FOLDER_ACADEMY_ID,
        virtualPath: 'Academy/Semester A',
        cloudVersion: 1,
        contentHash: 'h2',
        lastModified: '2026-11-06T00:00:00.000Z',
        oneNoteNotebookUrl: null,
      },
      {
        documentId: DOC_CALCULUS_ID,
        visibleName: 'Calculus 1',
        type: 'DocumentType',
        parent: FOLDER_SEMESTER_ID,
        virtualPath: 'Academy/Semester A/Calculus 1',
        cloudVersion: 1,
        contentHash: 'h3',
        lastModified: '2026-11-06T00:00:00.000Z',
        oneNoteNotebookUrl: null,
      },
      {
        documentId: DOC_LINEAR_ID,
        visibleName: 'Linear Algebra',
        type: 'DocumentType',
        parent: FOLDER_SEMESTER_ID,
        virtualPath: 'Academy/Semester A/Linear Algebra',
        cloudVersion: 1,
        contentHash: 'h4',
        lastModified: '2026-11-06T00:00:00.000Z',
        oneNoteNotebookUrl: null,
      },
    ]);

    const initial = deriveInitialSelectionMap(
      roots,
      { syncFiles: [DOC_CALCULUS_ID], syncFolders: [] },
      true,
    );

    // Both parent (Semester A) and grandparent (Academy) must be indeterminate (null)
    expect(getNodeSelectionState(initial, FOLDER_SEMESTER_ID)).toBeNull();
    expect(getNodeSelectionState(initial, FOLDER_ACADEMY_ID)).toBeNull();

    const academyCounts = getFolderSubtreeCounts(roots[0], initial);
    expect(academyCounts).toEqual({
      directFolders: 1,
      directDocuments: 0,
      totalDocuments: 2,
      selectedDocuments: 1,
    });
  });

  it('computes document rollup and detects out-of-date status when modified after OneNote sync', () => {
    const basePage: PageRecord = {
      documentId: 'doc-1',
      pageId: 'page-1',
      pageNumber: '1',
      title: 'Page 1',
      virtualPath: 'Doc/Page 1',
      fileSizeBytes: 100,
      lastModified: '2026-11-09T12:00:00.000Z',
      contentHash: 'hash-1',
      status: 'Uploaded',
      lastSyncTime: '2026-11-09T12:05:00.000Z',
      oneNotePageId: 'on-1',
      oneNotePageUrl: 'https://onenote/page-1',
      retryCount: 0,
      lastError: null,
    };

    // 1. Synced and up to date
    const rollupSynced = computeRollupForPages(
      [basePage],
      'https://onenote/nb-1',
      '2026-11-09T12:00:00.000Z',
    );
    expect(rollupSynced.isOutOfDate).toBe(false);
    expect(rollupSynced.visualState).toBe('uploaded');

    // 2. Document modified on tablet after last sync time
    const rollupDocModified = computeRollupForPages(
      [basePage],
      'https://onenote/nb-1',
      '2026-11-09T14:00:00.000Z',
    );
    expect(rollupDocModified.isOutOfDate).toBe(true);

    // 3. Page modified on tablet after its sync time
    const rollupPageModified = computeRollupForPages(
      [{ ...basePage, lastModified: '2026-11-09T15:00:00.000Z' }],
      'https://onenote/nb-1',
      '2026-11-09T12:00:00.000Z',
    );
    expect(rollupPageModified.isOutOfDate).toBe(true);

    // 4. Page is Pending after a previous upload
    const rollupPagePending = computeRollupForPages(
      [{ ...basePage, status: 'Pending' }],
      'https://onenote/nb-1',
      '2026-11-09T12:00:00.000Z',
    );
    expect(rollupPagePending.isOutOfDate).toBe(true);

    // 5. Never synced document
    const rollupNeverSynced = computeRollupForPages(
      [{ ...basePage, lastSyncTime: null, status: 'Pending' }],
      null,
      '2026-11-09T12:00:00.000Z',
    );
    expect(rollupNeverSynced.isOutOfDate).toBe(false);
  });
});
