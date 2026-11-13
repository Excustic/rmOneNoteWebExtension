import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveMicrosoftAuth, saveRemarkableAuth } from '../auth/authStore';
import { extractSinglePdfPage, RM_HEADER_V3 } from '../converter';
import { RmOneNoteDatabase } from '../db/db';
import { getDocument, getPage, savePage } from '../db/repository';
import { REMARKABLE_SYNC_FILES_URL, REMARKABLE_SYNC_ROOT_URL } from '../remarkable';
import { ext } from '../shared/browser';
import { formatCountdownMmSs } from '../shared/components/NextSyncCountdown';
import { setWhitelist, updatePreferences } from '../storage/preferences';
import {
  AUTO_SYNC_ALARM_NAME,
  cancelSyncItem,
  getNextAutoSyncAt,
  queueManualSyncItems,
  recoverDeletedPage,
  registerAutoSyncAlarmListeners,
  retryFailedPages,
  runSyncCycle,
  syncAutoSyncAlarmWithPreferences,
} from '../sync';
import { resolveNonCollidingPageTitle } from '../sync/syncEngine';
import { getRawSyncStoreSnapshot, resetMockBrowserStorage, triggerMockAlarm } from './setup';

const FOLDER_ID = '11111111-1111-4111-8111-111111111111';
const DOC_ID = '22222222-2222-4222-8222-222222222222';
const PAGE_1_ID = '33333333-3333-4333-8333-333333333333';
const PAGE_2_ID = '44444444-4444-4444-8444-444444444444';

/** Builds a minimal legacy `.rm` v3 page containing a single two-point fineliner stroke. */
function buildMinimalRmV3Bytes(): Uint8Array {
  const header = new TextEncoder().encode(RM_HEADER_V3);
  const floatsPerPoint = 6;
  const payload = new ArrayBuffer(4 + 4 + 16 + 4 + 2 * floatsPerPoint * 4);
  const view = new DataView(payload);
  let offset = 0;
  const u32 = (v: number) => {
    view.setUint32(offset, v, true);
    offset += 4;
  };
  const f32 = (v: number) => {
    view.setFloat32(offset, v, true);
    offset += 4;
  };

  u32(1); // layers
  u32(1); // lines
  u32(4); // brush type (fineliner)
  u32(0); // color black
  u32(0); // padding
  f32(2.0); // brush size
  u32(2); // points
  for (const [x, y] of [
    [820, 240],
    [1000, 420],
  ]) {
    f32(x);
    f32(y);
    f32(0.1);
    f32(0);
    f32(0.5);
    f32(0.8);
  }

  const out = new Uint8Array(header.length + payload.byteLength);
  out.set(header, 0);
  out.set(new Uint8Array(payload), header.length);
  return out;
}

function buildCloudBlobs(page1Hash: string, docHash: string, rmBytes: Uint8Array) {
  return {
    sub_folder: `4\n0:.:1:150\nmeta_folder:0:${FOLDER_ID}.metadata:0:150`,
    meta_folder: JSON.stringify({
      visibleName: 'Academy',
      type: 'CollectionType',
      parent: '',
      lastModified: '1730900000000',
      version: 1,
    }),
    [docHash]: [
      '4',
      '0:.:4:8000',
      `meta_doc:0:${DOC_ID}.metadata:0:150`,
      `content_doc:0:${DOC_ID}.content:0:300`,
      `${page1Hash}:0:${DOC_ID}/${PAGE_1_ID}.rm:0:${rmBytes.byteLength}`,
      `rm_page2:0:${DOC_ID}/${PAGE_2_ID}.rm:0:${rmBytes.byteLength}`,
    ].join('\n'),
    meta_doc: JSON.stringify({
      visibleName: 'Calculus 1',
      type: 'DocumentType',
      parent: FOLDER_ID,
      lastModified: String(Date.now() - 60_000),
      version: 2,
    }),
    content_doc: JSON.stringify({
      cPages: {
        pages: [
          { id: PAGE_1_ID, idx: { timestamp: '1:1', value: 'aa' } },
          { id: PAGE_2_ID, idx: { timestamp: '1:2', value: 'ab' } },
        ],
      },
    }),
    [page1Hash]: rmBytes,
    rm_page2: rmBytes,
  } as Record<string, string | Uint8Array>;
}

describe('Phase 7: Autonomous Sync Engine and Alarm Scheduler', () => {
  let testDb: RmOneNoteDatabase;

  beforeEach(async () => {
    resetMockBrowserStorage();
    testDb = new RmOneNoteDatabase(`testSyncEngine_${crypto.randomUUID()}`);
    await saveRemarkableAuth({
      deviceId: 'dev-1',
      deviceToken: 'device-token-1',
      userToken: 'valid-user-jwt',
      userTokenExpiresAtMs: Date.now() + 3_600_000,
      pairedAt: '2026-11-06T12:00:00.000Z',
    });
    await saveMicrosoftAuth({
      accessToken: 'ms-access-token',
      refreshToken: 'ms-refresh-token',
      expiresAtMs: Date.now() + 3_600_000,
      accountName: 'user@example.com',
      clientId: '0a6b8d7c-e92a-47d9-8dd0-dc7e500ef798',
      tenantId: 'common',
      connectedAt: '2026-11-06T12:00:00.000Z',
    });
  });

  afterEach(async () => {
    testDb.close();
    await testDb.delete();
  });

  it('runs Sync15 tree -> .rm conversion -> OneNote upload -> verification -> ledger, then updates edited pages by replacing them', async () => {
    await setWhitelist({ syncFiles: [], syncFolders: [FOLDER_ID] });

    const rmBytes = buildMinimalRmV3Bytes();
    const cloud = {
      rootHash: 'root_v1',
      generation: 1,
      blobs: {} as Record<string, string | Uint8Array>,
    };
    const setCloudVersion = (rootHash: string, page1Hash: string, docHash: string) => {
      cloud.rootHash = rootHash;
      cloud.generation += 1;
      cloud.blobs = {
        ...cloud.blobs,
        ...buildCloudBlobs(page1Hash, docHash, rmBytes),
        [rootHash]: [
          '4',
          '0:.:2:8150',
          `sub_folder:80000000:${FOLDER_ID}:1:150`,
          `${docHash}:80000000:${DOC_ID}:4:8000`,
        ].join('\n'),
      };
    };
    setCloudVersion('root_v1', 'rm_page1_v1', 'sub_doc_v1');

    const createdNotebooks: string[] = [];
    const createdSections: string[] = [];
    const uploadBodies: string[] = [];
    const patchedPageIds: string[] = [];
    const deletedPageIds: string[] = [];
    const sectionPages: Array<{ id: string; title: string }> = [];
    let uploadCounter = 0;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url === REMARKABLE_SYNC_ROOT_URL) {
        return new Response(
          JSON.stringify({ hash: cloud.rootHash, generation: cloud.generation, schemaVersion: 4 }),
          { status: 200 },
        );
      }
      if (url.startsWith(`${REMARKABLE_SYNC_FILES_URL}/`)) {
        const hash = decodeURIComponent(url.slice(`${REMARKABLE_SYNC_FILES_URL}/`.length));
        const blob = cloud.blobs[hash];
        if (blob === undefined) {
          return new Response(`Missing blob ${hash}`, { status: 404 });
        }
        if (blob instanceof Uint8Array) {
          const copy = new Uint8Array(blob.byteLength);
          copy.set(blob);
          return new Response(copy.buffer, { status: 200 });
        }
        return new Response(blob, { status: 200 });
      }

      const path = url.replace('https://graph.microsoft.com/v1.0/me/onenote', '').split('?')[0];

      if (path === '/notebooks' && method === 'GET') {
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }
      if (path === '/notebooks' && method === 'POST') {
        const body = JSON.parse(init?.body as string) as { displayName: string };
        createdNotebooks.push(body.displayName);
        return new Response(
          JSON.stringify({
            id: 'nb-1',
            displayName: body.displayName,
            links: { oneNoteWebUrl: { href: 'https://onenote.example/nb-1' } },
          }),
          { status: 201 },
        );
      }
      if (path === '/notebooks/nb-1/sections' && method === 'GET') {
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }
      if (path === '/notebooks/nb-1/sections' && method === 'POST') {
        const body = JSON.parse(init?.body as string) as { displayName: string };
        createdSections.push(body.displayName);
        return new Response(JSON.stringify({ id: 'sec-1', displayName: body.displayName }), {
          status: 201,
        });
      }
      if (path === '/sections/sec-1/pages' && method === 'GET') {
        return new Response(JSON.stringify({ value: sectionPages }), { status: 200 });
      }
      if (path === '/sections/sec-1/pages' && method === 'POST') {
        uploadCounter += 1;
        const raw = new TextDecoder().decode(init?.body as ArrayBuffer);
        uploadBodies.push(raw);
        const title = raw.match(/<title>([^<]+)<\/title>/)?.[1] ?? `Page ${uploadCounter}`;
        const id = `onenote-page-${uploadCounter}`;
        sectionPages.push({ id, title });
        return new Response(JSON.stringify({ id, title }), { status: 201 });
      }
      const patchMatch = path.match(/^\/pages\/([^/]+)\/content$/);
      if (patchMatch && method === 'PATCH') {
        patchedPageIds.push(decodeURIComponent(patchMatch[1]));
        return new Response(null, { status: 204 });
      }
      const pageMatch = path.match(/^\/pages\/([^/]+)$/);
      if (pageMatch && method === 'DELETE') {
        const id = decodeURIComponent(pageMatch[1]);
        deletedPageIds.push(id);
        const index = sectionPages.findIndex((candidate) => candidate.id === id);
        if (index >= 0) {
          sectionPages.splice(index, 1);
        }
        return new Response(null, { status: 204 });
      }
      if (pageMatch && method === 'GET') {
        const id = decodeURIComponent(pageMatch[1]);
        return new Response(
          JSON.stringify({
            id,
            title: 'Verified',
            links: { oneNoteWebUrl: { href: `https://onenote.example/${id}` } },
          }),
          { status: 200 },
        );
      }

      return new Response(`Unhandled ${method} ${url}`, { status: 500 });
    };

    const firstRun = await runSyncCycle({
      database: testDb,
      fetchImpl: mockFetch,
      phantomLinkPollDelaysMs: [1, 1, 1],
    });

    expect(firstRun.failedCount).toBe(0);
    expect(firstRun.uploadedCount).toBe(2);
    expect(createdNotebooks).toEqual(['rm_Academy']);
    expect(createdSections).toEqual(['Calculus 1']);
    expect(uploadBodies).toHaveLength(2);
    expect(uploadBodies[0]).toContain('presentation-onenote-inkml');
    expect(uploadBodies[0]).toContain('<inkml:trace');

    const doc = await getDocument(DOC_ID, testDb);
    expect(doc?.oneNoteNotebookUrl).toBe('https://onenote.example/nb-1');

    const page1 = await getPage(DOC_ID, PAGE_1_ID, testDb);
    const page2 = await getPage(DOC_ID, PAGE_2_ID, testDb);
    expect(page1?.status).toBe('Uploaded');
    expect(page1?.oneNotePageId).toBe('onenote-page-1');
    expect(page1?.oneNotePageUrl).toBe('https://onenote.example/onenote-page-1');
    expect(page2?.status).toBe('Uploaded');
    expect(page2?.oneNotePageId).toBe('onenote-page-2');

    const ledgerMeta = getRawSyncStoreSnapshot().get('sl_meta') as { totalSeq: number };
    expect(ledgerMeta.totalSeq).toBe(2);

    // Edit page 1 on the tablet: new blob hash -> page is re-queued, re-created
    // (Graph ignores InkML on PATCH) and the superseded page is deleted.
    setCloudVersion('root_v2', 'rm_page1_v2', 'sub_doc_v2');
    const secondRun = await runSyncCycle({
      database: testDb,
      fetchImpl: mockFetch,
      phantomLinkPollDelaysMs: [1, 1, 1],
    });

    expect(secondRun.processedCount).toBe(1);
    expect(secondRun.uploadedCount).toBe(1);
    expect(patchedPageIds).toEqual([]);
    expect(uploadBodies).toHaveLength(3);
    expect(uploadBodies[2]).toContain('<inkml:trace');
    expect(deletedPageIds).toEqual(['onenote-page-1']);
    expect((await getPage(DOC_ID, PAGE_1_ID, testDb))?.oneNotePageId).toBe('onenote-page-3');

    // Simulate an existing orphaned duplicate in OneNote: both the previous page
    // and the orphaned duplicate matching the title are purged on the next sync
    sectionPages.push({ id: 'orphaned-dup-1', title: 'Page 1' });
    setCloudVersion('root_v3', 'rm_page1_v3', 'sub_doc_v3');
    const thirdRun = await runSyncCycle({
      database: testDb,
      fetchImpl: mockFetch,
      phantomLinkPollDelaysMs: [1, 1, 1],
    });

    expect(thirdRun.uploadedCount).toBe(1);
    expect(deletedPageIds).toEqual(['onenote-page-1', 'onenote-page-3', 'orphaned-dup-1']);
    expect((await getPage(DOC_ID, PAGE_1_ID, testDb))?.oneNotePageId).toBe('onenote-page-4');
  });

  it('supports per-item cancellation, failed page retry reset, and alarm scheduling from preferences', async () => {
    await testDb.pages.put({
      documentId: DOC_ID,
      pageId: PAGE_1_ID,
      pageNumber: '1',
      title: 'Page 1',
      virtualPath: 'Academy/Calculus 1/Page 1',
      fileSizeBytes: 512,
      lastModified: new Date().toISOString(),
      contentHash: 'abcd',
      status: 'Pending',
      lastSyncTime: null,
      oneNotePageId: null,
      oneNotePageUrl: null,
      retryCount: 0,
      lastError: null,
    });

    await cancelSyncItem(DOC_ID, PAGE_1_ID, testDb);
    const cancelled = await getPage(DOC_ID, PAGE_1_ID, testDb);
    expect(cancelled?.status).toBe('Skipped');
    expect(cancelled?.lastError).toBe('Cancelled by user');

    await testDb.pages.update([DOC_ID, PAGE_1_ID], {
      status: 'Failed',
      retryCount: 3,
      lastError: 'Simulated failure',
    });
    expect(await retryFailedPages({ database: testDb })).toBe(1);
    const reset = await getPage(DOC_ID, PAGE_1_ID, testDb);
    expect(reset?.status).toBe('Pending');
    expect(reset?.retryCount).toBe(0);
    expect(reset?.lastError).toBeNull();

    let alarmFired = 0;
    const dispose = registerAutoSyncAlarmListeners(() => {
      alarmFired += 1;
    });

    await syncAutoSyncAlarmWithPreferences();
    expect((await ext.alarms.get(AUTO_SYNC_ALARM_NAME))?.periodInMinutes).toBe(5);

    await updatePreferences({ syncIntervalMinutes: 15 });
    // Preference listener reschedules asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await ext.alarms.get(AUTO_SYNC_ALARM_NAME))?.periodInMinutes).toBe(15);

    triggerMockAlarm(AUTO_SYNC_ALARM_NAME);
    expect(alarmFired).toBe(1);

    await updatePreferences({ autoSync: false });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await ext.alarms.get(AUTO_SYNC_ALARM_NAME)).toBeUndefined();

    dispose();
  });

  it('queues manual sync items by documentId or page key even when already Uploaded or outside whitelist', async () => {
    await testDb.pages.bulkPut([
      {
        documentId: DOC_ID,
        pageId: PAGE_1_ID,
        pageNumber: '1',
        title: 'Page 1',
        virtualPath: 'Academy/Calculus 1/Page 1',
        fileSizeBytes: 512,
        lastModified: new Date().toISOString(),
        contentHash: 'h1',
        status: 'Uploaded',
        lastSyncTime: '2026-11-06T12:00:00.000Z',
        oneNotePageId: 'on-1',
        oneNotePageUrl: 'https://onenote.example/on-1',
        retryCount: 0,
        lastError: null,
      },
      {
        documentId: DOC_ID,
        pageId: PAGE_2_ID,
        pageNumber: '2',
        title: 'Page 2',
        virtualPath: 'Academy/Calculus 1/Page 2',
        fileSizeBytes: 512,
        lastModified: new Date().toISOString(),
        contentHash: 'h2',
        status: 'Skipped',
        lastSyncTime: null,
        oneNotePageId: null,
        oneNotePageUrl: null,
        retryCount: 0,
        lastError: null,
      },
    ]);

    // Queue a single page manually
    const queuedSingle = await queueManualSyncItems({
      pages: [{ documentId: DOC_ID, pageId: PAGE_2_ID }],
      database: testDb,
    });
    expect(queuedSingle).toBe(1);
    expect((await getPage(DOC_ID, PAGE_2_ID, testDb))?.status).toBe('Pending');
    expect((await getPage(DOC_ID, PAGE_1_ID, testDb))?.status).toBe('Uploaded');

    // Queue an entire document manually (re-queues Uploaded pages too)
    const queuedDoc = await queueManualSyncItems({
      documentIds: [DOC_ID],
      database: testDb,
    });
    expect(queuedDoc).toBe(2);
    expect((await getPage(DOC_ID, PAGE_1_ID, testDb))?.status).toBe('Pending');
    expect((await getPage(DOC_ID, PAGE_2_ID, testDb))?.status).toBe('Pending');
  });

  it('slices the target single page from a multi-page PDF via pdf-lib and attaches it as application/pdf background', async () => {
    // Build a 3-page PDF with distinct page dimensions so we can verify exact page slicing
    const sourcePdf = await PDFDocument.create();
    sourcePdf.addPage([400, 500]); // Page index 0
    sourcePdf.addPage([612, 792]); // Page index 1 (target annotated page)
    sourcePdf.addPage([800, 1000]); // Page index 2
    const fullPdfBytes = await sourcePdf.save();

    // Direct unit check on extractSinglePdfPage
    const slicedPage1 = await extractSinglePdfPage(fullPdfBytes, 1);
    expect(slicedPage1).not.toBeNull();
    const parsedSlice = await PDFDocument.load(slicedPage1!);
    expect(parsedSlice.getPageCount()).toBe(1);
    expect(parsedSlice.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(await extractSinglePdfPage(fullPdfBytes, 99)).toBeNull();

    // End-to-end sync cycle with an annotated PDF document
    await setWhitelist({ syncFiles: [DOC_ID], syncFolders: [] });
    const rmBytes = buildMinimalRmV3Bytes();
    const blobs: Record<string, string | Uint8Array> = {
      root_pdf: `4\n0:.:1:20000\nsub_pdf_doc:80000000:${DOC_ID}:5:20000`,
      sub_pdf_doc: [
        '4',
        '0:.:5:20000',
        `meta_pdf:0:${DOC_ID}.metadata:0:150`,
        `content_pdf:0:${DOC_ID}.content:0:300`,
        `blob_pdf:0:${DOC_ID}.pdf:0:${fullPdfBytes.byteLength}`,
        `rm_inserted:0:${DOC_ID}/${PAGE_1_ID}.rm:0:${rmBytes.byteLength}`,
        `rm_annotated_p2:0:${DOC_ID}/${PAGE_2_ID}.rm:0:${rmBytes.byteLength}`,
      ].join('\n'),
      meta_pdf: JSON.stringify({
        visibleName: 'Annotated Paper',
        type: 'DocumentType',
        parent: '',
        lastModified: String(Date.now() - 30_000),
        version: 1,
      }),
      content_pdf: JSON.stringify({
        fileType: 'pdf',
        cPages: {
          pages: [
            // Inserted blank note page (no redir -> pdfPageIndex: null)
            { id: PAGE_1_ID, idx: { timestamp: '1:1', value: 'aa' } },
            // Annotated PDF Page 2 (0-based redir.value = 1)
            { id: PAGE_2_ID, idx: { timestamp: '1:2', value: 'ab' }, redir: { timestamp: '1:2', value: 1 } },
          ],
        },
      }),
      blob_pdf: fullPdfBytes,
      rm_inserted: rmBytes,
      rm_annotated_p2: rmBytes,
    };

    let pdfDownloadCount = 0;
    const uploadedMultipartPayloads: string[] = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url === REMARKABLE_SYNC_ROOT_URL) {
        return new Response(
          JSON.stringify({ hash: 'root_pdf', generation: 1, schemaVersion: 4 }),
          { status: 200 },
        );
      }
      if (url.startsWith(`${REMARKABLE_SYNC_FILES_URL}/`)) {
        const hash = decodeURIComponent(url.slice(`${REMARKABLE_SYNC_FILES_URL}/`.length));
        if (hash === 'blob_pdf') {
          pdfDownloadCount += 1;
        }
        const blob = blobs[hash];
        if (!blob) {
          return new Response(`Missing ${hash}`, { status: 404 });
        }
        if (blob instanceof Uint8Array) {
          const copy = new Uint8Array(blob.byteLength);
          copy.set(blob);
          return new Response(copy.buffer, { status: 200 });
        }
        return new Response(blob, { status: 200 });
      }

      const path = url.replace('https://graph.microsoft.com/v1.0/me/onenote', '').split('?')[0];
      if (path === '/notebooks' && method === 'GET') {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: 'nb-root',
                displayName: 'rm_Annotated Paper',
                links: { oneNoteWebUrl: { href: 'https://onenote.example/nb-root' } },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (path === '/notebooks/nb-root/sections' && method === 'GET') {
        return new Response(
          JSON.stringify({ value: [{ id: 'sec-pdf', displayName: 'Annotated Paper' }] }),
          { status: 200 },
        );
      }
      if (path === '/sections/sec-pdf/pages' && method === 'GET') {
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }
      if (path === '/sections/sec-pdf/pages' && method === 'POST') {
        const rawText = new TextDecoder('latin1').decode(init?.body as ArrayBuffer);
        uploadedMultipartPayloads.push(rawText);
        const pageId = `on-pdf-${uploadedMultipartPayloads.length}`;
        return new Response(JSON.stringify({ id: pageId, title: 'Page' }), { status: 201 });
      }
      const pageMatch = path.match(/^\/pages\/([^/]+)$/);
      if (pageMatch && method === 'GET') {
        const id = decodeURIComponent(pageMatch[1]);
        return new Response(
          JSON.stringify({
            id,
            title: 'Page',
            links: { oneNoteWebUrl: { href: `https://onenote.example/${id}` } },
          }),
          { status: 200 },
        );
      }

      return new Response(`Unhandled ${method} ${url}`, { status: 500 });
    };

    await updatePreferences({ targetSection: '' });
    const summary = await runSyncCycle({
      database: testDb,
      fetchImpl: mockFetch,
      phantomLinkPollDelaysMs: [1, 1],
    });

    expect(summary.failedCount).toBe(0);
    expect(summary.uploadedCount).toBe(2);
    expect(pdfDownloadCount).toBe(1);
    expect(uploadedMultipartPayloads).toHaveLength(2);

    const insertedPagePayload = uploadedMultipartPayloads.find((p) =>
      p.includes('<title>Page 1</title>'),
    )!;
    // Page 2 is synthesized for unannotated PDF page index 0; annotated PDF page index 1 is Page 3.
    const annotatedPdfPagePayload = uploadedMultipartPayloads.find((p) =>
      p.includes('<title>Page 3</title>'),
    )!;

    // Inserted blank note page has no PDF background part
    expect(insertedPagePayload).not.toContain('filename="background.pdf"');
    expect(insertedPagePayload).not.toContain('data-render-src="name:background"');

    // Annotated PDF page includes single-page application/pdf background part + data-render-src
    expect(annotatedPdfPagePayload).toContain(
      'Content-Disposition: form-data; name="background"; filename="background.pdf"\r\nContent-Type: application/pdf',
    );
    expect(annotatedPdfPagePayload).toContain(
      '<img data-render-src="name:background" style="position:absolute;top:0;left:0;z-index:-1" />',
    );
    expect(annotatedPdfPagePayload).toContain('%PDF-');
  });

  it('resolves non-colliding page titles for preserve mode', () => {
    const existing = new Set(['Page 1', 'Page 2', 'Page 2 (1)']);
    expect(resolveNonCollidingPageTitle('Page 3', existing)).toBe('Page 3');
    expect(resolveNonCollidingPageTitle('Page 1', existing)).toBe('Page 1 (1)');
    expect(resolveNonCollidingPageTitle('Page 2', existing)).toBe('Page 2 (2)');
  });

  it('purges OneNote pages for deleted tablet pages in mirror mode, but preserves them in preserve mode', async () => {
    const deletedUrls: string[] = [];
    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url.startsWith(REMARKABLE_SYNC_ROOT_URL)) {
        return new Response(JSON.stringify({ hash: 'empty-root', generation: 1 }));
      }
      if (url.startsWith(REMARKABLE_SYNC_FILES_URL)) {
        return new Response('4\n0:.:0:0', { status: 200 });
      }
      if (method === 'DELETE' && url.includes('/pages/')) {
        deletedUrls.push(url);
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    };

    // 1. In preserve mode, deleted pages stay in IndexedDB and are NOT deleted from OneNote
    await updatePreferences({ pageSyncStrategy: 'preserve' });
    await savePage(
      {
        documentId: DOC_ID,
        pageId: PAGE_1_ID,
        pageNumber: '1',
        title: 'Page 1',
        virtualPath: 'Doc/Page 1',
        fileSizeBytes: 100,
        lastModified: '2026-11-06T12:00:00.000Z',
        contentHash: 'hash1',
        status: 'Deleted',
        lastSyncTime: '2026-11-06T12:00:00.000Z',
        oneNotePageId: 'on-del-1',
        oneNotePageUrl: 'https://onenote/on-del-1',
        retryCount: 0,
        lastError: null,
      },
      testDb,
    );

    await runSyncCycle({
      database: testDb,
      fetchImpl: mockFetch,
    });

    expect(deletedUrls).toHaveLength(0);
    const preservedPage = await getPage(DOC_ID, PAGE_1_ID, testDb);
    expect(preservedPage).toBeDefined();
    expect(preservedPage?.status).toBe('Deleted');
    expect(preservedPage?.oneNotePageId).toBe('on-del-1');

    // 2. In mirror mode, deleted pages trigger DELETE in OneNote, clear OneNote links, and remain in IndexedDB as Deleted for recovery
    await updatePreferences({ pageSyncStrategy: 'mirror' });
    await runSyncCycle({
      database: testDb,
      fetchImpl: mockFetch,
    });

    expect(deletedUrls).toHaveLength(1);
    expect(deletedUrls[0]).toContain('/pages/on-del-1');
    const purgedPage = await getPage(DOC_ID, PAGE_1_ID, testDb);
    expect(purgedPage).toBeDefined();
    expect(purgedPage?.status).toBe('Deleted');
    expect(purgedPage?.oneNotePageId).toBeNull();
    expect(purgedPage?.pageNumber).toBe('1');
  });

  it('renames reordered pages in mirror mode via fast path without re-uploading ink', async () => {
    const patchCalls: Array<{ url: string; body: string }> = [];
    let uploadInkCalls = 0;

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const path = url.replace('https://graph.microsoft.com/v1.0/me/onenote', '');

      if (url.startsWith(REMARKABLE_SYNC_ROOT_URL)) {
        return new Response(JSON.stringify({ hash: 'root-reorder', generation: 1 }));
      }
      if (url.startsWith(REMARKABLE_SYNC_FILES_URL)) {
        return new Response('4\n0:.:0:0', { status: 200 });
      }
      if (path.startsWith('/notebooks') && !path.includes('/sections') && method === 'GET') {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: 'nb-1',
                displayName: 'rm_Notebook',
                links: { oneNoteWebUrl: { href: 'https://onenote.example/nb-1' } },
                sections: [{ id: 'sec-1', displayName: 'Notebook' }],
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (path === '/notebooks/nb-1/sections' && method === 'GET') {
        return new Response(
          JSON.stringify({ value: [{ id: 'sec-1', displayName: 'Notebook' }] }),
          { status: 200 },
        );
      }
      if (path === '/sections/sec-1/pages' && method === 'GET') {
        return new Response(
          JSON.stringify({ value: [{ id: 'on-pg-reorder', title: 'Page 9' }] }),
          { status: 200 },
        );
      }
      if (path === '/pages/on-pg-reorder/content' && method === 'PATCH') {
        patchCalls.push({ url, body: String(init?.body ?? '') });
        return new Response(null, { status: 204 });
      }
      if (path === '/sections/sec-1/pages' && method === 'POST') {
        uploadInkCalls += 1;
        return new Response(JSON.stringify({ id: 'on-pg-new', title: 'Page 3' }), { status: 201 });
      }
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    };

    await updatePreferences({ pageSyncStrategy: 'mirror', targetSection: '' });
    await setWhitelist({ syncFiles: [DOC_ID], syncFolders: [] });

    // Seed a page that was moved from Page 9 to Page 3 without stroke changes (titleRenameOnly)
    await savePage(
      {
        documentId: DOC_ID,
        pageId: PAGE_1_ID,
        pageNumber: '3',
        title: 'Page 3',
        virtualPath: 'Notebook/Page 3',
        fileSizeBytes: 100,
        lastModified: '2026-11-06T12:00:00.000Z',
        contentHash: 'hash-unchanged',
        status: 'Pending',
        lastSyncTime: '2026-11-06T11:00:00.000Z',
        oneNotePageId: 'on-pg-reorder',
        oneNotePageUrl: 'https://onenote/on-pg-reorder',
        retryCount: 0,
        lastError: null,
        titleRenameOnly: true,
      },
      testDb,
    );

    const summary = await runSyncCycle({
      database: testDb,
      fetchImpl: mockFetch,
    });

    expect(summary.failedCount).toBe(0);
    expect(summary.uploadedCount).toBe(1);
    expect(uploadInkCalls).toBe(0); // Zero full ink uploads!
    expect(patchCalls).toHaveLength(1);
    expect(JSON.parse(patchCalls[0].body)).toEqual([
      { target: 'title', action: 'replace', content: 'Page 3' },
    ]);

    const updated = await getPage(DOC_ID, PAGE_1_ID, testDb);
    expect(updated?.status).toBe('Uploaded');
    expect(updated?.titleRenameOnly).toBe(false);
  });

  it('recovers a deleted page to a dedicated (Recovered) section with revision disambiguation', async () => {
    await updatePreferences({ targetSection: '' });
    let createdSectionName = '';
    let uploadedTitle = '';
    const minimalBytes = buildMinimalRmV3Bytes();

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.includes('internal.cloud.remarkable.com/sync/v3/files/')) {
        return new Response(minimalBytes as unknown as BodyInit, { status: 200 });
      }

      const parsedUrl = new URL(url);
      const path = parsedUrl.pathname.replace(/^\/v1\.0\/me\/onenote/, '');

      if (path.startsWith('/notebooks') && !path.includes('/sections')) {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: 'nb-1',
                displayName: 'rm_Notebook',
                sections: [{ id: 'sec-1', displayName: 'Notebook' }],
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (path === '/notebooks/nb-1/sections' && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        createdSectionName = body.displayName;
        return new Response(
          JSON.stringify({ id: 'sec-recovered', displayName: body.displayName }),
          { status: 201 },
        );
      }
      if (path === '/sections/sec-recovered/pages' && method === 'POST') {
        const bodyBytes =
          init?.body instanceof Uint8Array
            ? init.body
            : init?.body instanceof ArrayBuffer
              ? new Uint8Array(init.body)
              : new TextEncoder().encode(String(init?.body ?? ''));
        const bodyStr = new TextDecoder().decode(bodyBytes);
        const titleMatch = bodyStr.match(/<title>([^<]+)<\/title>/);
        if (titleMatch) {
          uploadedTitle = titleMatch[1];
        }
        return new Response(
          JSON.stringify({
            id: 'on-pg-recovered',
            title: uploadedTitle,
            links: { oneNoteWebUrl: { href: 'https://onenote.com/test-recovered-page' } },
          }),
          { status: 201 },
        );
      }
      if (path === '/pages/on-pg-recovered' && method === 'GET') {
        return new Response(
          JSON.stringify({
            id: 'on-pg-recovered',
            title: uploadedTitle,
            links: { oneNoteWebUrl: { href: 'https://onenote.com/test-recovered-page' } },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    };

    // Seed 2 pages with the same page number: one active, one deleted (to test rev disambiguation)
    await savePage(
      {
        documentId: DOC_ID,
        pageId: PAGE_1_ID,
        pageNumber: '2',
        title: 'Page 2',
        virtualPath: 'Notebook/Page 2',
        fileSizeBytes: 100,
        lastModified: '2026-11-06T10:00:00.000Z',
        contentHash: 'hash-del',
        status: 'Deleted',
        lastSyncTime: null,
        oneNotePageId: null,
        oneNotePageUrl: null,
        retryCount: 0,
        lastError: null,
      },
      testDb,
    );
    await savePage(
      {
        documentId: DOC_ID,
        pageId: PAGE_2_ID,
        pageNumber: '2',
        title: 'Page 2',
        virtualPath: 'Notebook/Page 2',
        fileSizeBytes: 120,
        lastModified: '2026-11-06T12:00:00.000Z',
        contentHash: 'hash-active',
        status: 'Uploaded',
        lastSyncTime: '2026-11-06T12:05:00.000Z',
        oneNotePageId: 'on-pg-2',
        oneNotePageUrl: 'https://onenote.com/test-active-page',
        retryCount: 0,
        lastError: null,
      },
      testDb,
    );

    const result = await recoverDeletedPage(DOC_ID, PAGE_1_ID, {
      database: testDb,
      fetchImpl: mockFetch,
      phantomLinkPollDelaysMs: [0],
    });

    expect(result.ok).toBe(true);
    expect(result.oneNoteUrl).toBe('https://onenote.com/test-recovered-page');
    expect(createdSectionName).toBe('Notebook (Recovered)');
    expect(uploadedTitle).toBe('Page 2 (rev 1)');

    const updated = await getPage(DOC_ID, PAGE_1_ID, testDb);
    expect(updated?.status).toBe('Deleted');
    expect(updated?.oneNotePageId).toBe('on-pg-recovered');
    expect(updated?.oneNotePageUrl).toBe('https://onenote.com/test-recovered-page');
  });

  it('marks deleted page as expired when reMarkable Cloud returns 404', async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('internal.cloud.remarkable.com/sync/v3/files/')) {
        return new Response('Not Found', { status: 404 });
      }
      return new Response(JSON.stringify({ value: [] }), { status: 200 });
    };

    await savePage(
      {
        documentId: DOC_ID,
        pageId: PAGE_1_ID,
        pageNumber: '5',
        title: 'Page 5',
        virtualPath: 'Notebook/Page 5',
        fileSizeBytes: 50,
        lastModified: '2026-11-06T10:00:00.000Z',
        contentHash: 'hash-pruned',
        status: 'Deleted',
        lastSyncTime: null,
        oneNotePageId: null,
        oneNotePageUrl: null,
        retryCount: 0,
        lastError: null,
      },
      testDb,
    );

    const result = await recoverDeletedPage(DOC_ID, PAGE_1_ID, {
      database: testDb,
      fetchImpl: mockFetch,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('expired');

    const updated = await getPage(DOC_ID, PAGE_1_ID, testDb);
    expect(updated?.status).toBe('Deleted');
    expect(updated?.lastError).toBe(
      'Page content has expired and is no longer available on reMarkable Cloud.',
    );
  });

  it('uploads multi-page notebook in chronological ascending order even if later pages finish conversion earlier', async () => {
    const createdPageTitles: string[] = [];
    const rmBytes = buildMinimalRmV3Bytes();

    const cloudBlobs: Record<string, string | Uint8Array> = {
      ...buildCloudBlobs('rm_page1_v1', 'sub_doc_v1', rmBytes),
      root_v1: [
        '4',
        '0:.:2:8150',
        `sub_folder:80000000:${FOLDER_ID}:1:150`,
        `sub_doc_v1:80000000:${DOC_ID}:4:8000`,
      ].join('\n'),
    };

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const path = url.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/onenote/, '');

      if (url === REMARKABLE_SYNC_ROOT_URL) {
        return new Response(
          JSON.stringify({ hash: 'root_v1', generation: 1, schemaVersion: 4 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (url.startsWith(`${REMARKABLE_SYNC_FILES_URL}/`)) {
        const hash = decodeURIComponent(url.slice(`${REMARKABLE_SYNC_FILES_URL}/`.length));
        if (hash === 'rm_page1_v1') {
          // Delay Page 1 download so Page 2 finishes conversion much faster
          await new Promise((resolve) => setTimeout(resolve, 60));
        }
        const data = cloudBlobs[hash];
        if (data) {
          const body = typeof data === 'string' ? data : (data as unknown as BodyInit);
          return new Response(body, {
            status: 200,
            headers: {
              'Content-Type': typeof data === 'string' ? 'text/plain' : 'application/octet-stream',
            },
          });
        }
        return new Response('Not Found', { status: 404 });
      }

      if (path.startsWith('/notebooks') && !path.includes('/sections') && method === 'GET') {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: 'nb-1',
                displayName: 'rm_Academy',
                links: { oneNoteWebUrl: { href: 'https://onenote.com/nb-1' } },
                sections: [{ id: 'sec-1', displayName: 'Calculus 1' }],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (path.includes('/sections') && method === 'GET') {
        return new Response(
          JSON.stringify({
            value: [{ id: 'sec-1', displayName: 'Calculus 1' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (path.includes('/pages') && method === 'POST') {
        const bodyStr =
          typeof init?.body === 'string'
            ? init.body
            : init?.body instanceof Uint8Array
              ? new TextDecoder().decode(init.body)
              : '';
        const match = bodyStr.match(/<title>([^<]+)<\/title>/);
        if (match) {
          createdPageTitles.push(match[1]);
        }
        return new Response(
          JSON.stringify({
            id: `on-pg-${createdPageTitles.length}`,
            title: match ? match[1] : 'Untitled',
            links: { oneNoteWebUrl: { href: 'https://onenote.com/test' } },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }

      if (path.includes('/pages/') && method === 'GET') {
        return new Response(
          JSON.stringify({
            id: 'on-pg-verified',
            links: { oneNoteWebUrl: { href: 'https://onenote.com/test' } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response(JSON.stringify({ value: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await updatePreferences({ syncConcurrency: 3, targetSection: 'Default' });
    await setWhitelist({ syncFiles: [DOC_ID], syncFolders: [] });

    const summary = await runSyncCycle({
      database: testDb,
      fetchImpl: mockFetch,
      phantomLinkPollDelaysMs: [0],
    });

    expect(summary.uploadedCount).toBe(2);
    expect(createdPageTitles).toEqual(['Page 1', 'Page 2']);
  });

  it('syncs root-level notebooks into rm_Documents container with root notebooks as sections by default', async () => {
    const rmBytes = buildMinimalRmV3Bytes();
    const cloudBlobs: Record<string, string | Uint8Array> = {
      root_hash: [
        '4',
        '0:.:1:8000',
        `sub_doc_root:80000000:${DOC_ID}:4:8000`,
      ].join('\n'),
      sub_doc_root: [
        '4',
        '0:.:3:8000',
        `meta_doc_root:0:${DOC_ID}.metadata:0:150`,
        `content_doc_root:0:${DOC_ID}.content:0:300`,
        `rm_root_p1:0:${DOC_ID}/${PAGE_1_ID}.rm:0:${rmBytes.byteLength}`,
      ].join('\n'),
      meta_doc_root: JSON.stringify({
        visibleName: 'RootBook',
        type: 'DocumentType',
        parent: '',
        lastModified: String(Date.now() - 60_000),
        version: 1,
      }),
      content_doc_root: JSON.stringify({
        cPages: {
          pages: [{ id: PAGE_1_ID, idx: { timestamp: '1:1', value: 'aa' } }],
        },
      }),
      rm_root_p1: rmBytes,
    };

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url === REMARKABLE_SYNC_ROOT_URL) {
        return new Response(JSON.stringify({ hash: 'root_hash', generation: 1, schemaVersion: 4 }), { status: 200 });
      }
      if (url.startsWith(`${REMARKABLE_SYNC_FILES_URL}/`)) {
        const hash = decodeURIComponent(url.slice(`${REMARKABLE_SYNC_FILES_URL}/`.length));
        const data = cloudBlobs[hash];
        if (data) {
          const body = typeof data === 'string' ? data : (data as unknown as BodyInit);
          return new Response(body, { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      }

      const parsedUrl = new URL(url);
      const path = parsedUrl.pathname.replace(/^\/v1\.0\/me\/onenote/, '');

      if (path === '/notebooks' && method === 'GET') {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: 'nb-docs',
                displayName: 'rm_Documents',
                sections: [{ id: 'sec-root-book', displayName: 'RootBook' }],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/notebooks' && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return new Response(
          JSON.stringify({ id: 'nb-docs', displayName: body.displayName }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/notebooks/nb-docs/sections' && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return new Response(
          JSON.stringify({ id: 'sec-root-book', displayName: body.displayName }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/sections/sec-root-book/pages' && method === 'GET') {
        return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (path === '/sections/sec-root-book/pages' && method === 'POST') {
        return new Response(
          JSON.stringify({
            id: 'on-pg-root-1',
            title: 'Page 1',
            links: { oneNoteWebUrl: { href: 'https://onenote.com/test' } },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path.includes('/pages/on-pg-root-1') && method === 'GET') {
        return new Response(
          JSON.stringify({
            id: 'on-pg-root-1',
            links: { oneNoteWebUrl: { href: 'https://onenote.com/test' } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response(JSON.stringify({ value: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await updatePreferences({ targetSection: 'Documents' });
    await setWhitelist({ syncFiles: [DOC_ID], syncFolders: [] });

    const summary = await runSyncCycle({
      database: testDb,
      fetchImpl: mockFetch,
      phantomLinkPollDelaysMs: [0],
    });

    expect(summary.uploadedCount).toBe(1);
    const updated = await getPage(DOC_ID, PAGE_1_ID, testDb);
    expect(updated?.status).toBe('Uploaded');
  });

  it('never auto-uploads or document-syncs blank pages when syncUnannotatedPdfPages is false, while permitting explicit per-page sync', async () => {
    const rmBytes = buildMinimalRmV3Bytes();
    const uploadedPageTitles: string[] = [];

    const cloudBlobs: Record<string, string | Uint8Array> = {
      root_hash: [
        '4',
        '0:.:1:8000',
        `sub_doc_blank_test:80000000:${DOC_ID}:4:8000`,
      ].join('\n'),
      sub_doc_blank_test: [
        '4',
        '0:.:3:8000',
        `meta_doc:0:${DOC_ID}.metadata:0:150`,
        `content_doc:0:${DOC_ID}.content:0:300`,
        `rm_p1:0:${DOC_ID}/${PAGE_1_ID}.rm:0:${rmBytes.byteLength}`,
      ].join('\n'),
      meta_doc: JSON.stringify({
        visibleName: 'AnnotatedPDF',
        type: 'DocumentType',
        parent: '',
        lastModified: String(Date.now() - 60_000),
        version: 1,
      }),
      content_doc: JSON.stringify({
        cPages: {
          pages: [
            { id: PAGE_1_ID, idx: { timestamp: '1:1', value: 'aa' } },
            { id: PAGE_2_ID, idx: { timestamp: '1:2', value: 'ab' } },
          ],
        },
      }),
      rm_p1: rmBytes,
    };

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url === REMARKABLE_SYNC_ROOT_URL) {
        return new Response(JSON.stringify({ hash: 'root_hash', generation: 1, schemaVersion: 4 }), { status: 200 });
      }
      if (url.startsWith(`${REMARKABLE_SYNC_FILES_URL}/`)) {
        const hash = decodeURIComponent(url.slice(`${REMARKABLE_SYNC_FILES_URL}/`.length));
        const data = cloudBlobs[hash];
        if (data) {
          const body = typeof data === 'string' ? data : (data as unknown as BodyInit);
          return new Response(body, { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      }

      const parsedUrl = new URL(url);
      const path = parsedUrl.pathname.replace(/^\/v1\.0\/me\/onenote/, '');

      if (path === '/notebooks' && method === 'GET') {
        return new Response(
          JSON.stringify({
            value: [
              {
                id: 'nb-docs',
                displayName: 'rm_Documents',
                sections: [{ id: 'sec-pdf', displayName: 'AnnotatedPDF' }],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path === '/sections/sec-pdf/pages' && method === 'GET') {
        return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (path === '/sections/sec-pdf/pages' && method === 'POST') {
        const rawBody =
          init?.body instanceof Uint8Array
            ? new TextDecoder().decode(init.body)
            : String(init?.body ?? '');
        const titleMatch = rawBody.match(/<title>([^<]+)<\/title>/);
        const title = titleMatch ? titleMatch[1] : `Unknown (${uploadedPageTitles.length + 1})`;
        uploadedPageTitles.push(title);
        const id = `on-pg-${uploadedPageTitles.length}`;
        return new Response(
          JSON.stringify({
            id,
            title,
            links: { oneNoteWebUrl: { href: `https://onenote.com/${id}` } },
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (path.includes('/pages/on-pg-') && method === 'GET') {
        const id = path.split('/').pop()!;
        return new Response(
          JSON.stringify({
            id,
            links: { oneNoteWebUrl: { href: `https://onenote.com/${id}` } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response(JSON.stringify({ value: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await updatePreferences({ targetSection: 'Documents', syncUnannotatedPdfPages: false });
    await setWhitelist({ syncFiles: [DOC_ID], syncFolders: [] });

    // Pre-seed blank page with stale Pending status to verify syncEngine's defense-in-depth guard
    await savePage(
      {
        documentId: DOC_ID,
        pageId: PAGE_2_ID,
        pageNumber: '2',
        title: 'Page 2',
        virtualPath: 'AnnotatedPDF/Page 2',
        fileSizeBytes: 0,
        lastModified: new Date().toISOString(),
        contentHash: '',
        status: 'Pending',
        lastSyncTime: null,
        oneNotePageId: null,
        oneNotePageUrl: null,
        retryCount: 0,
        lastError: null,
      },
      testDb,
    );

    const summary = await runSyncCycle({
      database: testDb,
      fetchImpl: mockFetch,
      phantomLinkPollDelaysMs: [0],
    });

    expect(summary.uploadedCount).toBe(1);
    expect(uploadedPageTitles).toEqual(['Page 1']);
    expect((await getPage(DOC_ID, PAGE_1_ID, testDb))?.status).toBe('Uploaded');
    expect((await getPage(DOC_ID, PAGE_2_ID, testDb))?.status).toBe('Skipped');

    // Document-level manual sync must also skip blank pages when syncUnannotatedPdfPages is false
    const docQueueCount = await queueManualSyncItems({
      documentIds: [DOC_ID],
      database: testDb,
    });
    expect(docQueueCount).toBe(1);
    expect((await getPage(DOC_ID, PAGE_2_ID, testDb))?.status).toBe('Skipped');

    const docSyncSummary = await runSyncCycle({
      database: testDb,
      fetchImpl: mockFetch,
      phantomLinkPollDelaysMs: [0],
    });
    expect(docSyncSummary.uploadedCount).toBe(1);
    expect((await getPage(DOC_ID, PAGE_2_ID, testDb))?.status).toBe('Skipped');
    expect(uploadedPageTitles).toEqual(['Page 1', 'Page 1']);

    // Explicit per-page manual sync overrides and uploads the selected blank page
    const pageQueueCount = await queueManualSyncItems({
      pages: [{ documentId: DOC_ID, pageId: PAGE_2_ID }],
      database: testDb,
    });
    expect(pageQueueCount).toBe(1);

    const explicitSummary = await runSyncCycle({
      database: testDb,
      fetchImpl: mockFetch,
      phantomLinkPollDelaysMs: [0],
    });
    expect(explicitSummary.uploadedCount).toBe(1);
    expect((await getPage(DOC_ID, PAGE_2_ID, testDb))?.status).toBe('Uploaded');
    expect(uploadedPageTitles).toEqual(['Page 1', 'Page 1', 'Page 2']);
  });

  it('aborts cleanly via abortSignal without throwing and leaves unfinished pages Pending', async () => {
    const rmBytes = buildMinimalRmV3Bytes();
    await savePage(
      {
        documentId: DOC_ID,
        pageId: PAGE_1_ID,
        pageNumber: '1',
        title: 'Page 1',
        virtualPath: 'AbortDoc/Page 1',
        fileSizeBytes: rmBytes.length,
        lastModified: new Date().toISOString(),
        contentHash: 'hash-1',
        status: 'Pending',
        lastSyncTime: null,
        oneNotePageId: null,
        oneNotePageUrl: null,
        retryCount: 0,
        lastError: null,
      },
      testDb,
    );

    const controller = new AbortController();
    controller.abort();

    const phases: string[] = [];
    await expect(
      runSyncCycle({
        database: testDb,
        abortSignal: controller.signal,
        onPhaseChange: async (phase) => {
          phases.push(phase);
        },
      }),
    ).rejects.toThrow(/aborted/i);

    expect((await getPage(DOC_ID, PAGE_1_ID, testDb))?.status).toBe('Pending');
    expect(phases).toEqual([]);
  });

  it('tracks next auto-sync timestamp and preserves running alarms unless interval changes or forceReset is set', async () => {
    expect(await getNextAutoSyncAt()).toBeNull();

    await updatePreferences({ autoSync: true, syncIntervalMinutes: 5 });
    await syncAutoSyncAlarmWithPreferences();

    const firstScheduled = (await ext.alarms.get(AUTO_SYNC_ALARM_NAME))?.scheduledTime;
    const firstIso = await getNextAutoSyncAt();
    expect(firstIso).not.toBeNull();
    expect(Date.parse(firstIso!)).toBe(firstScheduled);

    // Wait briefly and call again without forceReset; scheduledTime should remain unchanged.
    await new Promise((resolve) => setTimeout(resolve, 15));
    await updatePreferences({ containerWidthPx: 1100 });
    await syncAutoSyncAlarmWithPreferences();
    expect((await ext.alarms.get(AUTO_SYNC_ALARM_NAME))?.scheduledTime).toBe(firstScheduled);

    // Explicitly resetting moves the alarm forward.
    await syncAutoSyncAlarmWithPreferences(undefined, { forceReset: true });
    const resetScheduled = (await ext.alarms.get(AUTO_SYNC_ALARM_NAME))?.scheduledTime;
    expect(resetScheduled).toBeGreaterThanOrEqual(firstScheduled!);

    // Countdown formatting handles boundary and multi-minute intervals cleanly.
    expect(formatCountdownMmSs(0)).toBe('00:00');
    expect(formatCountdownMmSs(-250)).toBe('00:00');
    expect(formatCountdownMmSs(61_200)).toBe('01:02');
    expect(formatCountdownMmSs(5 * 60_000)).toBe('05:00');
  });
});
