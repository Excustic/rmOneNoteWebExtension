import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveMicrosoftAuth, saveRemarkableAuth } from '../auth/authStore';
import { extractSinglePdfPage, RM_HEADER_V3 } from '../converter';
import { RmOneNoteDatabase } from '../db/db';
import { getDocument, getPage } from '../db/repository';
import { REMARKABLE_SYNC_FILES_URL, REMARKABLE_SYNC_ROOT_URL } from '../remarkable';
import { ext } from '../shared/browser';
import { setWhitelist, updatePreferences } from '../storage/preferences';
import {
  AUTO_SYNC_ALARM_NAME,
  cancelSyncItem,
  queueManualSyncItems,
  registerAutoSyncAlarmListeners,
  retryFailedPages,
  runSyncCycle,
  syncAutoSyncAlarmWithPreferences,
} from '../sync';
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
    const annotatedPdfPagePayload = uploadedMultipartPayloads.find((p) =>
      p.includes('<title>Page 2</title>'),
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
});
