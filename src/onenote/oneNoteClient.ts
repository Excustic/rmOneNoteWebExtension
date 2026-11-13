/**
 * Microsoft Graph OneNote REST API client with concurrency throttling,
 * Retry-After / exponential-backoff retries, and Phantom Link verification.
 *
 * Ported from `rmOneNoteSync/app/rmOneNoteSyncApp/Services/OneNoteClient.cs`
 * and `SyncService.cs`.
 */

import { fetchWithMicrosoftAuth } from '../auth/microsoftAuth';
import { MAX_ONENOTE_SECTION_NAME_LENGTH } from '../db/models';
import { isAbortError, throwIfAborted } from '../shared/abort';
import {
  buildUpdateInkMlMultipart,
  buildUploadInkMlMultipart,
} from './multipart';
import {
  AsyncSemaphore,
  computeGraphBackoffMs,
  DEFAULT_GRAPH_CONCURRENCY_LIMIT,
  DEFAULT_PHANTOM_LINK_POLL_DELAYS_MS,
  defaultSleepMs,
  isRetryableGraphStatus,
} from './throttle';
import {
  type ODataCollectionResponse,
  ONENOTE_GRAPH_BASE_URL,
  type OneNoteLinks,
  type OneNoteNotebook,
  type OneNotePage,
  type OneNoteSection,
  type OneNoteTargetPath,
  type UpdateInkMlPageParams,
  type UploadInkMlPageParams,
  type VerifiedOneNotePageResult,
} from './types';

const INVALID_ONENOTE_NAME_REGEX = /[?*\\/:<>|&#"'%~]/g;

/**
 * Sanitizes a notebook or section display name for Microsoft Graph OneNote API
 * (replaces invalid characters, removes control characters, and caps at 49 chars).
 * Matches `SyncService.SanitizeOneNoteName` in the legacy C# client.
 */
export function sanitizeOneNoteDisplayName(rawName: string): string {
  if (!rawName) {
    return 'Untitled';
  }

  let sanitized = rawName.replace(INVALID_ONENOTE_NAME_REGEX, '_');
  let withoutControls = '';
  for (const ch of sanitized) {
    const code = ch.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) {
      withoutControls += ch;
    }
  }

  sanitized = withoutControls.trim();
  if (!sanitized) {
    return 'Untitled';
  }

  if (sanitized.length > MAX_ONENOTE_SECTION_NAME_LENGTH) {
    sanitized = sanitized.slice(0, MAX_ONENOTE_SECTION_NAME_LENGTH).trimEnd();
  }

  return sanitized || 'Untitled';
}

/**
 * Translates a reMarkable virtual path (for example
 * `"Academy/BachelorPhysCS/Year1/Semester A/Calculus 1/Page 40"` or `"Testbook2/Page 1"`) into the
 * target OneNote `{ notebookName, sectionName, pageTitle }`.
 *
 * For root-level reMarkable notebooks (not in any folder, i.e. 2 path segments like `"Testbook2/Page 1"`):
 * - If `rootNotebookContainer` is specified (default: `'Documents'`), all root notebooks appear
 *   as sections inside a consolidated OneNote notebook (e.g. `rm_Documents`).
 * - If `rootNotebookContainer` is left blank (`''`), each root notebook converts into
 *   its own OneNote notebook (e.g. `rm_Testbook2`) with a section of the same name.
 */
export function parseVirtualPathToOneNoteTarget(
  virtualPath: string,
  rootNotebookContainer = 'Documents'
): OneNoteTargetPath {
  const parts = virtualPath
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  const trimmedContainer = rootNotebookContainer ? rootNotebookContainer.trim() : '';

  if (parts.length === 0) {
    return {
      notebookName: trimmedContainer
        ? sanitizeOneNoteDisplayName(`rm_${trimmedContainer}`)
        : 'rm_Uncategorized',
      sectionName: trimmedContainer
        ? sanitizeOneNoteDisplayName(trimmedContainer)
        : 'Untitled',
      pageTitle: 'Untitled',
    };
  }

  if (parts.length === 1) {
    return {
      notebookName: trimmedContainer
        ? sanitizeOneNoteDisplayName(`rm_${trimmedContainer}`)
        : sanitizeOneNoteDisplayName(`rm_${parts[0]}`),
      sectionName: sanitizeOneNoteDisplayName(parts[0]),
      pageTitle: 'Untitled',
    };
  }

  if (parts.length === 2) {
    return {
      notebookName: trimmedContainer
        ? sanitizeOneNoteDisplayName(`rm_${trimmedContainer}`)
        : sanitizeOneNoteDisplayName(`rm_${parts[0]}`),
      sectionName: sanitizeOneNoteDisplayName(parts[0]),
      pageTitle: parts[1],
    };
  }

  const notebookParts = parts.slice(0, -2);
  const rawNotebookName = `rm_${notebookParts.join('_')}`;
  const rawSectionName = parts[parts.length - 2];
  const pageTitle = parts[parts.length - 1];

  return {
    notebookName: sanitizeOneNoteDisplayName(rawNotebookName),
    sectionName: sanitizeOneNoteDisplayName(rawSectionName),
    pageTitle,
  };
}

/**
 * Extracts a OneNote page ID from the `Location` response header
 * (`https://graph.microsoft.com/v1.0/users/{user}/onenote/pages/{pageId}`)
 * or falls back to parsing the JSON response body `id`.
 */
export function extractOneNotePageId(
  locationHeader: string | null,
  responseBodyText = ''
): string {
  if (locationHeader && locationHeader.trim().length > 0) {
    const clean = locationHeader.trim().replace(/\/+$/, '');
    const segments = clean.split('/');
    const lastSegment = segments[segments.length - 1] ?? '';
    if (lastSegment.length > 0) {
      return lastSegment;
    }
  }

  if (responseBodyText.trim().length > 0) {
    try {
      const parsed = JSON.parse(responseBodyText) as { id?: unknown };
      if (typeof parsed.id === 'string' && parsed.id.trim().length > 0) {
        return parsed.id.trim();
      }
    } catch {
      // Ignore non-JSON body when Location header was expected
    }
  }

  return '';
}

/**
 * Extracts the preferred OneNote web or desktop client URL from a page/notebook `links` object.
 */
export function resolveOneNoteLinkUrl(links?: OneNoteLinks | null): string | null {
  const webHref = links?.oneNoteWebUrl?.href?.trim();
  if (webHref) {
    return webHref;
  }
  const clientHref = links?.oneNoteClientUrl?.href?.trim();
  if (clientHref) {
    return clientHref;
  }
  return null;
}

export class OneNoteGraphError extends Error {
  readonly status: number;
  readonly responseBody: string;

  constructor(status: number, responseBody: string) {
    super(`Graph API Error (${status}): ${responseBody}`);
    this.name = 'OneNoteGraphError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

function isNetworkOrTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  if (err instanceof OneNoteGraphError || isAbortError(err)) {
    return false;
  }
  return (
    err.name === 'TypeError' ||
    err.name === 'TimeoutError' ||
    /network|timeout|gatewaytimeout|fetch/i.test(err.message)
  );
}

export interface OneNoteClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly randomImpl?: () => number;
  readonly maxConcurrentRequests?: number;
  readonly maxUploadRetries?: number;
  readonly phantomLinkPollDelaysMs?: readonly number[];
  readonly signal?: AbortSignal;
}

export class OneNoteClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly randomImpl: () => number;
  private readonly semaphore: AsyncSemaphore;
  private readonly maxUploadRetries: number;
  private readonly phantomLinkPollDelaysMs: readonly number[];
  private readonly signal?: AbortSignal;

  constructor(options: OneNoteClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? defaultSleepMs;
    this.randomImpl = options.randomImpl ?? Math.random;
    this.semaphore = new AsyncSemaphore(
      options.maxConcurrentRequests ?? DEFAULT_GRAPH_CONCURRENCY_LIMIT
    );
    this.maxUploadRetries = Math.max(1, options.maxUploadRetries ?? 5);
    this.phantomLinkPollDelaysMs =
      options.phantomLinkPollDelaysMs ?? DEFAULT_PHANTOM_LINK_POLL_DELAYS_MS;
    this.signal = options.signal;
  }

  private async sleep(ms: number): Promise<void> {
    throwIfAborted(this.signal);
    await this.sleepImpl(ms, this.signal);
    throwIfAborted(this.signal);
  }

  private async requestWithAuth(url: string, init: RequestInit = {}): Promise<Response> {
    const effectiveSignal = init.signal ?? this.signal;
    throwIfAborted(effectiveSignal);
    return this.semaphore.run(() =>
      fetchWithMicrosoftAuth(
        url,
        {
          ...init,
          ...(effectiveSignal ? { signal: effectiveSignal } : {}),
        },
        this.fetchImpl,
      )
    );
  }

  private async throwDetailedError(response: Response): Promise<never> {
    const bodyText = await response.text();
    throw new OneNoteGraphError(response.status, bodyText);
  }

  /**
   * Lists all OneNote notebooks for the signed-in user with `$expand=sections`.
   */
  async listNotebooks(): Promise<OneNoteNotebook[]> {
    const response = await this.requestWithAuth(
      `${ONENOTE_GRAPH_BASE_URL}/notebooks?$expand=sections`
    );
    if (!response.ok) {
      await this.throwDetailedError(response);
    }
    const payload = (await response.json()) as ODataCollectionResponse<OneNoteNotebook>;
    return payload.value ? [...payload.value] : [];
  }

  /**
   * Creates a new OneNote notebook with the given `displayName`.
   */
  async createNotebook(displayName: string): Promise<OneNoteNotebook> {
    const response = await this.requestWithAuth(`${ONENOTE_GRAPH_BASE_URL}/notebooks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName }),
    });
    if (!response.ok) {
      await this.throwDetailedError(response);
    }
    return (await response.json()) as OneNoteNotebook;
  }

  /**
   * Lists all sections inside a OneNote notebook.
   */
  async listSections(notebookId: string): Promise<OneNoteSection[]> {
    const response = await this.requestWithAuth(
      `${ONENOTE_GRAPH_BASE_URL}/notebooks/${encodeURIComponent(notebookId)}/sections`
    );
    if (!response.ok) {
      await this.throwDetailedError(response);
    }
    const payload = (await response.json()) as ODataCollectionResponse<OneNoteSection>;
    return payload.value ? [...payload.value] : [];
  }

  /**
   * Creates a new section inside a OneNote notebook.
   */
  async createSection(notebookId: string, displayName: string): Promise<OneNoteSection> {
    const response = await this.requestWithAuth(
      `${ONENOTE_GRAPH_BASE_URL}/notebooks/${encodeURIComponent(notebookId)}/sections`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ displayName }),
      }
    );
    if (!response.ok) {
      await this.throwDetailedError(response);
    }
    return (await response.json()) as OneNoteSection;
  }

  /**
   * Lists pages in a section (`id,title,createdDateTime,lastModifiedDateTime,contentUrl,links`)
   * in batches of up to 100 ($top=100), iteratively following `@odata.nextLink` until the section
   * is exhausted or `maxPages` (default 300) is reached.
   */
  async listPages(sectionId: string, maxPages = 300): Promise<OneNotePage[]> {
    const maxRetries = 3;
    const effectiveLimit = Math.max(1, maxPages);
    const pageSize = Math.min(100, effectiveLimit);
    let nextUrl: string | null =
      `${ONENOTE_GRAPH_BASE_URL}/sections/${encodeURIComponent(sectionId)}/pages` +
      `?$select=id,title,createdDateTime,lastModifiedDateTime,contentUrl,links&$top=${pageSize}`;

    const allPages: OneNotePage[] = [];
    const seenUrls = new Set<string>();

    while (nextUrl && allPages.length < effectiveLimit) {
      if (seenUrls.has(nextUrl)) {
        break;
      }
      seenUrls.add(nextUrl);

      const currentUrl: string = nextUrl;
      let fetchedThisPage = false;

      for (let retry = 0; retry < maxRetries; retry += 1) {
        try {
          throwIfAborted(this.signal);
          const response = await this.requestWithAuth(currentUrl);
          if (!response.ok) {
            if (retry < maxRetries - 1 && isRetryableGraphStatus(response.status)) {
              const delayMs = computeGraphBackoffMs(retry, {
                retryAfterHeader: response.headers.get('Retry-After'),
                jitterMaxSeconds: 2,
                randomFn: this.randomImpl,
              });
              await this.sleep(delayMs);
              continue;
            }
            await this.throwDetailedError(response);
          }

          const payload = (await response.json()) as ODataCollectionResponse<OneNotePage>;
          if (payload.value && Array.isArray(payload.value)) {
            for (const p of payload.value) {
              allPages.push(p);
              if (allPages.length >= effectiveLimit) {
                break;
              }
            }
          }

          const nextLink = payload['@odata.nextLink'];
          const trimmedNextLink =
            typeof nextLink === 'string' ? nextLink.trim() : '';
          nextUrl =
            trimmedNextLink.length > 0 &&
            allPages.length < effectiveLimit &&
            !seenUrls.has(trimmedNextLink)
              ? trimmedNextLink
              : null;
          fetchedThisPage = true;
          break;
        } catch (err) {
          if (this.signal?.aborted || isAbortError(err)) {
            throw err;
          }
          if (retry < maxRetries - 1 && isNetworkOrTimeoutError(err)) {
            await this.sleep(1000);
            continue;
          }
          throw err;
        }
      }

      if (!fetchedThisPage) {
        throw new Error('Exhausted retries while listing OneNote pages.');
      }
    }

    return allPages;
  }

  /**
   * Uploads a new OneNote page containing `presentation-onenote-inkml` (`drawing.xml`)
   * and `presentation` (`presentation.html`) via `POST /sections/{sectionId}/pages`.
   */
  async uploadInkMlPage(
    params: UploadInkMlPageParams,
    maxRetriesOverride?: number
  ): Promise<string> {
    const maxRetries = Math.max(1, maxRetriesOverride ?? this.maxUploadRetries);
    const multipart = buildUploadInkMlMultipart(params);
    const url = `${ONENOTE_GRAPH_BASE_URL}/sections/${encodeURIComponent(params.sectionId)}/pages`;

    for (let retry = 0; retry < maxRetries; retry += 1) {
      try {
        throwIfAborted(this.signal);
        const response = await this.requestWithAuth(url, {
          method: 'POST',
          headers: {
            'Content-Type': multipart.contentTypeHeader,
          },
          body: multipart.body.slice(0),
        });

        if (!response.ok) {
          if (retry < maxRetries - 1 && isRetryableGraphStatus(response.status)) {
            const delayMs = computeGraphBackoffMs(retry, {
              retryAfterHeader: response.headers.get('Retry-After'),
              jitterMaxSeconds: 3,
              randomFn: this.randomImpl,
            });
            await this.sleep(delayMs);
            continue;
          }
          await this.throwDetailedError(response);
        }

        const responseText = await response.text();
        const pageId = extractOneNotePageId(response.headers.get('Location'), responseText);
        if (!pageId) {
          throw new Error(
            'Microsoft Graph created the OneNote page but returned neither a Location header nor a page ID.'
          );
        }
        return pageId;
      } catch (err) {
        if (this.signal?.aborted || isAbortError(err)) {
          throw err;
        }
        if (retry < maxRetries - 1 && isNetworkOrTimeoutError(err)) {
          const delayMs = computeGraphBackoffMs(retry, {
            jitterMaxSeconds: 3,
            randomFn: this.randomImpl,
          });
          await this.sleep(delayMs);
          continue;
        }
        throw err;
      }
    }

    throw new Error('Exhausted retries while uploading InkML page to OneNote.');
  }

  /**
   * Updates an existing OneNote page via `PATCH /pages/{pageId}/content` with a
   * `Commands` JSON part (`target: "body", action: "replace"`) and `presentation-onenote-inkml`.
   */
  async updateInkMlPage(
    params: UpdateInkMlPageParams,
    maxRetriesOverride?: number
  ): Promise<string> {
    const maxRetries = Math.max(1, maxRetriesOverride ?? this.maxUploadRetries);
    const multipart = buildUpdateInkMlMultipart(params);
    const url = `${ONENOTE_GRAPH_BASE_URL}/pages/${encodeURIComponent(params.pageId)}/content`;

    for (let retry = 0; retry < maxRetries; retry += 1) {
      try {
        throwIfAborted(this.signal);
        const response = await this.requestWithAuth(url, {
          method: 'PATCH',
          headers: {
            'Content-Type': multipart.contentTypeHeader,
          },
          body: multipart.body.slice(0),
        });

        if (!response.ok) {
          if (retry < maxRetries - 1 && isRetryableGraphStatus(response.status)) {
            const delayMs = computeGraphBackoffMs(retry, {
              retryAfterHeader: response.headers.get('Retry-After'),
              jitterMaxSeconds: 3,
              randomFn: this.randomImpl,
            });
            await this.sleep(delayMs);
            continue;
          }
          await this.throwDetailedError(response);
        }

        return params.pageId;
      } catch (err) {
        if (this.signal?.aborted || isAbortError(err)) {
          throw err;
        }
        if (retry < maxRetries - 1 && isNetworkOrTimeoutError(err)) {
          const delayMs = computeGraphBackoffMs(retry, {
            jitterMaxSeconds: 3,
            randomFn: this.randomImpl,
          });
          await this.sleep(delayMs);
          continue;
        }
        throw err;
      }
    }

    throw new Error('Exhausted retries while updating InkML page in OneNote.');
  }

  /**
   * Renames an existing OneNote page title via `PATCH /pages/{pageId}/content`
   * with a JSON command targeting the title: `[{ target: 'title', action: 'replace', content: newTitle }]`.
   */
  async renamePage(
    pageId: string,
    newTitle: string,
    maxRetriesOverride?: number
  ): Promise<boolean> {
    const maxRetries = Math.max(1, maxRetriesOverride ?? this.maxUploadRetries);
    const url = `${ONENOTE_GRAPH_BASE_URL}/pages/${encodeURIComponent(pageId)}/content`;
    const body = JSON.stringify([
      {
        target: 'title',
        action: 'replace',
        content: newTitle,
      },
    ]);

    for (let retry = 0; retry < maxRetries; retry += 1) {
      try {
        throwIfAborted(this.signal);
        const response = await this.requestWithAuth(url, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
          },
          body,
        });

        if (response.ok) {
          return true;
        }

        if (response.status === 404) {
          return false;
        }

        if (retry < maxRetries - 1 && isRetryableGraphStatus(response.status)) {
          const delayMs = computeGraphBackoffMs(retry, {
            retryAfterHeader: response.headers.get('Retry-After'),
            jitterMaxSeconds: 3,
            randomFn: this.randomImpl,
          });
          await this.sleep(delayMs);
          continue;
        }

        return false;
      } catch (err) {
        if (this.signal?.aborted || isAbortError(err)) {
          throw err;
        }
        if (retry < maxRetries - 1 && isNetworkOrTimeoutError(err)) {
          const delayMs = computeGraphBackoffMs(retry, {
            jitterMaxSeconds: 3,
            randomFn: this.randomImpl,
          });
          await this.sleep(delayMs);
          continue;
        }
        return false;
      }
    }

    return false;
  }

  /**
   * Deletes a OneNote page by ID (`DELETE /pages/{pageId}`).
   */
  async deletePage(pageId: string): Promise<boolean> {
    try {
      const response = await this.requestWithAuth(
        `${ONENOTE_GRAPH_BASE_URL}/pages/${encodeURIComponent(pageId)}`,
        { method: 'DELETE' }
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Fetches a OneNote page by ID and verifies that Microsoft Graph has finished
   * indexing its `oneNoteWebUrl` / `oneNoteClientUrl` ("Phantom Link" verification).
   *
   * Polls across `phantomLinkPollDelaysMs` (`[2s, 4s, 8s, 15s, 20s, 25s]` by default)
   * when Graph returns `404 NotFound`, a retryable `429`/`5xx`, or a `200 OK` page
   * whose `links` object does not yet contain a usable OneNote URL.
   */
  async getPageWithPhantomLinkVerification(
    pageId: string,
    pollDelaysOverrideMs?: readonly number[]
  ): Promise<VerifiedOneNotePageResult> {
    const delays = pollDelaysOverrideMs ?? this.phantomLinkPollDelaysMs;
    const maxAttempts = Math.max(1, delays.length);
    const url = `${ONENOTE_GRAPH_BASE_URL}/pages/${encodeURIComponent(pageId)}`;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const isLastAttempt = attempt === maxAttempts - 1;
      try {
        throwIfAborted(this.signal);
        const response = await this.requestWithAuth(url);

        if ((response.status === 404 || isRetryableGraphStatus(response.status)) && !isLastAttempt) {
          const retryDelayMs =
            computeGraphBackoffMs(attempt, {
              retryAfterHeader: response.headers.get('Retry-After'),
              jitterMaxSeconds: 0,
            });
          const delayMs = response.headers.get('Retry-After')
            ? retryDelayMs
            : delays[attempt];
          await this.sleep(delayMs);
          continue;
        }

        if (!response.ok) {
          await this.throwDetailedError(response);
        }

        const page = (await response.json()) as OneNotePage;
        const oneNoteUrl = resolveOneNoteLinkUrl(page.links);
        if (oneNoteUrl) {
          return { page, oneNoteUrl };
        }

        if (!isLastAttempt) {
          await this.sleep(delays[attempt]);
          continue;
        }

        throw new Error(
          'Graph API indexing timeout: Graph API returned the page, but no valid OneNote URL was attached.'
        );
      } catch (err) {
        if (this.signal?.aborted || isAbortError(err)) {
          throw err;
        }
        if (isLastAttempt) {
          if (err instanceof Error && err.message.startsWith('Graph API indexing timeout:')) {
            throw err;
          }
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Graph API indexing timeout: ${msg}`);
        }
        await this.sleep(delays[attempt]);
      }
    }

    throw new Error('Graph API indexing timeout: Exhausted verification attempts.');
  }
}

