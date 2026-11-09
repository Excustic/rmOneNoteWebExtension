import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveMicrosoftAuth } from '../auth/authStore';
import { RmOneNoteDatabase } from '../db/db';
import {
  AsyncSemaphore,
  buildUpdateInkMlMultipart,
  buildUploadInkMlMultipart,
  computeGraphBackoffMs,
  KeyedMutex,
  ONENOTE_GRAPH_BASE_URL,
  OneNoteClient,
  OneNoteDirectoryCache,
  parseRetryAfterMs,
  parseVirtualPathToOneNoteTarget,
  sanitizeOneNoteDisplayName,
} from '../onenote';
import { resetMockBrowserStorage } from './setup';

const UTF8_DECODER = new TextDecoder('utf-8');

describe('Phase 6: Microsoft Graph OneNote Client, Throttling, and Directory Cache', () => {
  let testDb: RmOneNoteDatabase;

  beforeEach(async () => {
    resetMockBrowserStorage();
    testDb = new RmOneNoteDatabase(`testOneNote_${crypto.randomUUID()}`);
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

  it('sanitizes OneNote names and maps virtual paths to deterministic notebook/section/page targets', () => {
    expect(sanitizeOneNoteDisplayName('')).toBe('Untitled');
    expect(sanitizeOneNoteDisplayName('Calc & Phys #1: 100% ~ "A"')).toBe(
      'Calc _ Phys _1_ 100_ _ _A_'
    );
    expect(sanitizeOneNoteDisplayName('A'.repeat(70))).toHaveLength(49);

    expect(parseVirtualPathToOneNoteTarget('')).toEqual({
      notebookName: 'rm_Uncategorized',
      sectionName: 'Default',
      pageTitle: 'Untitled',
    });

    expect(parseVirtualPathToOneNoteTarget('Quick sheets/Page 1')).toEqual({
      notebookName: 'rm_Quick sheets',
      sectionName: 'Quick sheets',
      pageTitle: 'Page 1',
    });

    expect(
      parseVirtualPathToOneNoteTarget(
        'Academy/BachelorPhysCS/Year1/Semester A/Calculus 1/Page 40'
      )
    ).toEqual({
      notebookName: 'rm_Academy_BachelorPhysCS_Year1_Semester A',
      sectionName: 'Calculus 1',
      pageTitle: 'Page 40',
    });
  });

  it('encodes RFC 7578 multipart payloads for POST upload and PATCH update without duplicating <title>', () => {
    const uploadPayload = buildUploadInkMlMultipart({
      title: 'Page 1 & <2>',
      inkmlXml: '<inkml:ink></inkml:ink>',
      presentationHtml:
        '<html><head><title>Old</title></head><body data-absolute-enabled="true"><p>Hi</p></body></html>',
      boundary: 'test_boundary_123',
    });

    expect(uploadPayload.contentTypeHeader).toBe(
      'multipart/form-data; boundary=test_boundary_123'
    );
    const uploadText = UTF8_DECODER.decode(uploadPayload.body);
    expect(uploadText).toContain(
      'Content-Disposition: form-data; name="presentation-onenote-inkml"; filename="drawing.xml"\r\nContent-Type: application/inkml+xml'
    );
    expect(uploadText).toContain(
      'Content-Disposition: form-data; name="presentation"; filename="presentation.html"\r\nContent-Type: text/html'
    );
    expect(uploadText).toContain('<title>Page 1 &amp; &lt;2&gt;</title>');
    expect(uploadText).not.toContain('<title>Old</title>');

    const updatePayload = buildUpdateInkMlMultipart({
      title: 'Updated Page',
      inkmlXml: '<inkml:ink></inkml:ink>',
      presentationHtml: '<html><head></head><body><p>Body</p></body></html>',
      backgroundPdfBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      boundary: 'patch_boundary_456',
    });
    const updateText = UTF8_DECODER.decode(updatePayload.body);
    expect(updateText).toContain(
      'Content-Disposition: form-data; name="Commands"\r\nContent-Type: application/json'
    );
    expect(updateText).toContain(
      'Content-Disposition: form-data; name="background"; filename="background.pdf"\r\nContent-Type: application/pdf'
    );
    expect(updateText).toContain('data-render-src=\\"name:background\\"');
    expect(updateText).toContain('"target":"body","action":"replace"');
    expect(updateText).toContain('<title>Updated Page</title>');

    const uploadWithPdf = buildUploadInkMlMultipart({
      title: 'PDF Page 1',
      inkmlXml: '<inkml:ink></inkml:ink>',
      presentationHtml:
        '<html><head></head><body><img data-render-src="name:background" style="position:absolute;top:0;left:0;z-index:-1" /><p>Note</p></body></html>',
      backgroundPdfBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      boundary: 'pdf_upload_boundary',
    });
    const uploadPdfText = UTF8_DECODER.decode(uploadWithPdf.body);
    expect(uploadPdfText).toContain(
      'Content-Disposition: form-data; name="background"; filename="background.pdf"\r\nContent-Type: application/pdf'
    );
    // Should not duplicate data-render-src="name:background" if already present in HTML
    expect(uploadPdfText.match(/data-render-src="name:background"/g)).toHaveLength(1);
  });

  it('parses Retry-After headers and enforces bounded concurrency with AsyncSemaphore', async () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
    const baseNow = Date.parse('2026-11-06T18:00:00.000Z');
    expect(parseRetryAfterMs('Fri, 06 Nov 2026 18:00:12 GMT', baseNow)).toBe(12000);
    expect(
      computeGraphBackoffMs(2, {
        retryAfterHeader: null,
        jitterMaxSeconds: 3,
        randomFn: () => 0.5,
      })
    ).toBe(5500); // (2^2 + 1.5) * 1000

    const sem = new AsyncSemaphore(3);
    let active = 0;
    let peakActive = 0;

    const tasks = Array.from({ length: 8 }, () =>
      sem.run(async () => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
      })
    );

    await Promise.all(tasks);
    expect(peakActive).toBe(3);
  });

  it('retries uploadInkMlPage on HTTP 429/504 and verifies Phantom Links across 404 and missing links', async () => {
    const sleepDelays: number[] = [];
    const sleepImpl = vi.fn(async (ms: number) => {
      sleepDelays.push(ms);
    });

    let uploadAttempt = 0;
    let getPageAttempt = 0;

    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (url === `${ONENOTE_GRAPH_BASE_URL}/sections/sec-1/pages` && method === 'POST') {
        uploadAttempt += 1;
        if (uploadAttempt === 1) {
          return new Response('Rate limited', {
            status: 429,
            headers: { 'Retry-After': '4' },
          });
        }
        if (uploadAttempt === 2) {
          return new Response('Gateway Timeout', { status: 504 });
        }
        return new Response(JSON.stringify({ id: 'page-999' }), {
          status: 201,
          headers: {
            Location: 'https://graph.microsoft.com/v1.0/users/me/onenote/pages/page-999',
          },
        });
      }

      if (url === `${ONENOTE_GRAPH_BASE_URL}/pages/page-999` && method === 'GET') {
        getPageAttempt += 1;
        if (getPageAttempt === 1) {
          // Eventual consistency 404
          return new Response('Not Found', { status: 404 });
        }
        if (getPageAttempt === 2) {
          // Phantom Link: page exists but links not populated yet
          return new Response(
            JSON.stringify({ id: 'page-999', title: 'Page 1', links: {} }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            id: 'page-999',
            title: 'Page 1',
            links: {
              oneNoteWebUrl: { href: 'https://onenote.live.com/view?id=page-999' },
            },
          }),
          { status: 200 }
        );
      }

      return new Response('Unexpected URL', { status: 500 });
    });

    const client = new OneNoteClient({
      fetchImpl: mockFetch,
      sleepImpl,
      randomImpl: () => 0,
      phantomLinkPollDelaysMs: [2000, 4000, 8000],
    });

    const pageId = await client.uploadInkMlPage({
      sectionId: 'sec-1',
      title: 'Page 1',
      inkmlXml: '<inkml:ink></inkml:ink>',
      presentationHtml: '<html><head><title>Page 1</title></head><body></body></html>',
    });

    expect(pageId).toBe('page-999');
    expect(uploadAttempt).toBe(3);

    const verified = await client.getPageWithPhantomLinkVerification(pageId);
    expect(verified.oneNoteUrl).toBe('https://onenote.live.com/view?id=page-999');
    expect(getPageAttempt).toBe(3);
    // 4000ms (Retry-After: 4), 2000ms (2^1 backoff), 2000ms (poll 1), 4000ms (poll 2)
    expect(sleepDelays).toEqual([4000, 2000, 2000, 4000]);
  });

  it('deduplicates concurrent notebook and section creation via OneNoteDirectoryCache and Dexie.notebooks', async () => {
    let createNotebookCalls = 0;
    let createSectionCalls = 0;
    let listNotebooksCalls = 0;

    const mockFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (url === `${ONENOTE_GRAPH_BASE_URL}/notebooks?$expand=sections` && method === 'GET') {
        listNotebooksCalls += 1;
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }

      if (url === `${ONENOTE_GRAPH_BASE_URL}/notebooks` && method === 'POST') {
        createNotebookCalls += 1;
        await new Promise((r) => setTimeout(r, 15));
        return new Response(
          JSON.stringify({
            id: 'nb-academy',
            displayName: 'rm_Academy',
            links: { oneNoteWebUrl: { href: 'https://onenote.live.com/nb-academy' } },
            sections: [],
          }),
          { status: 201 }
        );
      }

      if (
        url === `${ONENOTE_GRAPH_BASE_URL}/notebooks/nb-academy/sections` &&
        method === 'GET'
      ) {
        return new Response(JSON.stringify({ value: [] }), { status: 200 });
      }

      if (
        url === `${ONENOTE_GRAPH_BASE_URL}/notebooks/nb-academy/sections` &&
        method === 'POST'
      ) {
        createSectionCalls += 1;
        await new Promise((r) => setTimeout(r, 15));
        return new Response(
          JSON.stringify({
            id: 'sec-calculus',
            displayName: 'Calculus 1',
          }),
          { status: 201 }
        );
      }

      return new Response('Not Found', { status: 404 });
    });

    const client = new OneNoteClient({ fetchImpl: mockFetch });
    const cache = new OneNoteDirectoryCache(client, testDb);

    // 5 concurrent workers resolving the exact same uncached notebook and section
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        cache.resolveTargetNotebookAndSection('rm_Academy', 'Calculus 1')
      )
    );

    expect(createNotebookCalls).toBe(1);
    expect(createSectionCalls).toBe(1);
    expect(listNotebooksCalls).toBe(1);
    for (const res of results) {
      expect(res).toEqual({
        notebookId: 'nb-academy',
        notebookDisplayName: 'rm_Academy',
        notebookWebUrl: 'https://onenote.live.com/nb-academy',
        sectionId: 'sec-calculus',
        sectionDisplayName: 'Calculus 1',
      });
    }

    // Subsequent cache lookup hits Dexie.notebooks with zero additional network requests
    const callCountBefore = mockFetch.mock.calls.length;
    const secondLookup = await cache.resolveTargetNotebookAndSection('rm_Academy', 'Calculus 1');
    expect(secondLookup.sectionId).toBe('sec-calculus');
    expect(mockFetch.mock.calls.length).toBe(callCountBefore);

    // Verify KeyedMutex also runs distinct keys concurrently
    const mutex = new KeyedMutex();
    const order: string[] = [];
    await Promise.all([
      mutex.runExclusive('k1', async () => {
        order.push('k1-start');
        await new Promise((r) => setTimeout(r, 10));
        order.push('k1-end');
      }),
      mutex.runExclusive('k1', async () => {
        order.push('k1-second');
      }),
    ]);
    expect(order).toEqual(['k1-start', 'k1-end', 'k1-second']);
  });
});

