import type { PDFDocument } from 'pdf-lib';
import { getAuthStatusSummary } from '../auth';
import {
  convertRmPage,
  type ExtractedPdfPageResult,
  extractSinglePdfPageWithMetricsFromDocument,
  loadSourcePdfDocument,
} from '../converter';
import { db, type RmOneNoteDatabase } from '../db/db';
import type { DocumentRecord, PageRecord } from '../db/models';
import {
  getAllDocuments,
  getPagesByStatus,
  getPendingPages,
  setDocumentOneNoteUrl,
  updatePageStatus,
} from '../db/repository';
import {
  KeyedMutex,
  OneNoteClient,
  OneNoteDirectoryCache,
  parseVirtualPathToOneNoteTarget,
  sanitizeOneNoteDisplayName,
  type OneNotePage,
} from '../onenote';
import {
  downloadDocumentBlobBytes,
  downloadPageRmBytes,
  fetchDocumentIndexEntries,
  fetchSync15BlobText,
  resolveDocumentRmPages,
  syncRemarkableCloudTree,
} from '../remarkable';
import { getPreferences, getWhitelist, type SyncWhitelist } from '../storage/preferences';
import {
  reconcileSyncLedgerToDexie,
  recordSyncedPagesInLedger,
  removeSyncedPagesFromLedger,
} from '../storage/syncLedger';
import type { PageSyncOutcome, RunSyncCycleOptions, SyncCycleSummary } from './types';

const DEFAULT_SYNC_WORKER_CONCURRENCY = 3;

const cancelledPageKeys = new Set<string>();
const manualOverridePageKeys = new Set<string>();
let activeDefaultSyncCycle: Promise<SyncCycleSummary> | null = null;

function buildPageKey(documentId: string, pageId: string): string {
  return `${documentId}:${pageId}`;
}

/**
 * Resolves a collision-free OneNote page title for 'preserve' mode by suffixing
 * with `(1)`, `(2)`, etc. when the base title already exists in the section.
 */
export function resolveNonCollidingPageTitle(
  baseTitle: string,
  existingTitles: ReadonlySet<string>,
): string {
  if (!existingTitles.has(baseTitle)) {
    return baseTitle;
  }
  let index = 1;
  while (existingTitles.has(`${baseTitle} (${index})`)) {
    index += 1;
  }
  return `${baseTitle} (${index})`;
}

export function isSyncCycleRunning(): boolean {
  return activeDefaultSyncCycle !== null;
}

/**
 * Cancels an in-flight or queued page sync item and marks its status `'Skipped'`.
 */
export async function cancelSyncItem(
  documentId: string,
  pageId: string,
  database: RmOneNoteDatabase = db,
): Promise<void> {
  const key = buildPageKey(documentId, pageId);
  cancelledPageKeys.add(key);
  manualOverridePageKeys.delete(key);
  await updatePageStatus(
    documentId,
    pageId,
    'Skipped',
    { lastError: 'Cancelled by user' },
    database,
  );
}

/**
 * Queues specific documents and/or individual pages for immediate manual synchronization,
 * even if they are already `'Uploaded'`, `'Skipped'`, or outside the recurring folder whitelist.
 */
export async function queueManualSyncItems(
  options: {
    documentIds?: readonly string[];
    pages?: readonly { documentId: string; pageId: string }[];
    database?: RmOneNoteDatabase;
  } = {},
): Promise<number> {
  const database = options.database ?? db;
  const docIdSet = new Set(
    (options.documentIds ?? []).map((id) => id.trim()).filter(Boolean),
  );
  const explicitPages = options.pages ?? [];

  if (docIdSet.size === 0 && explicitPages.length === 0) {
    return 0;
  }

  return database.transaction('rw', database.pages, async () => {
    const matchedMap = new Map<string, PageRecord>();

    if (docIdSet.size > 0) {
      for (const docId of docIdSet) {
        const docPages = await database.pages.where('documentId').equals(docId).toArray();
        for (const page of docPages) {
          if (page.status !== 'Deleted') {
            matchedMap.set(buildPageKey(page.documentId, page.pageId), page);
          }
        }
      }
    }

    for (const ref of explicitPages) {
      const existing = await database.pages.get([ref.documentId, ref.pageId]);
      if (existing && existing.status !== 'Deleted') {
        matchedMap.set(buildPageKey(existing.documentId, existing.pageId), existing);
      }
    }

    if (matchedMap.size === 0) {
      return 0;
    }

    const updatedRecords: PageRecord[] = [];
    for (const [key, page] of matchedMap.entries()) {
      cancelledPageKeys.delete(key);
      manualOverridePageKeys.add(key);
      updatedRecords.push({
        ...page,
        status: 'Pending',
        retryCount: 0,
        lastError: null,
      });
    }

    await database.pages.bulkPut(updatedRecords);
    return updatedRecords.length;
  });
}

/**
 * Resets `'Failed'` pages (or a single specified page) back to `'Pending'` with `retryCount = 0`.
 */
export async function retryFailedPages(
  options: {
    documentId?: string;
    pageId?: string;
    database?: RmOneNoteDatabase;
  } = {},
): Promise<number> {
  const database = options.database ?? db;

  if (options.documentId && options.pageId) {
    const key = buildPageKey(options.documentId, options.pageId);
    cancelledPageKeys.delete(key);
    manualOverridePageKeys.add(key);
    return database.transaction('rw', database.pages, async () => {
      const existing = await database.pages.get([options.documentId!, options.pageId!]);
      if (!existing) {
        return 0;
      }
      await database.pages.put({
        ...existing,
        status: 'Pending',
        retryCount: 0,
        lastError: null,
      });
      return 1;
    });
  }

  return database.transaction('rw', database.pages, async () => {
    const failedPages = await getPagesByStatus('Failed', database);
    if (failedPages.length === 0) {
      return 0;
    }

    const resetList: PageRecord[] = failedPages.map((page) => {
      cancelledPageKeys.delete(buildPageKey(page.documentId, page.pageId));
      return {
        ...page,
        status: 'Pending',
        retryCount: 0,
        lastError: null,
      };
    });

    await database.pages.bulkPut(resetList);
    return resetList.length;
  });
}

function hasWhitelistedAncestor(
  doc: DocumentRecord,
  docMap: ReadonlyMap<string, DocumentRecord>,
  whitelistedFoldersLower: ReadonlySet<string>,
): boolean {
  const visited = new Set<string>();
  let parentId = doc.parent;

  while (parentId) {
    if (whitelistedFoldersLower.has(parentId.toLowerCase())) {
      return true;
    }
    if (visited.has(parentId)) {
      break;
    }
    visited.add(parentId);
    const parentDoc = docMap.get(parentId);
    parentId = parentDoc ? parentDoc.parent : '';
  }

  return false;
}

function computeWhitelistedDocumentSet(
  docs: readonly DocumentRecord[],
  whitelist: SyncWhitelist,
): Set<string> {
  const whitelistedDocIdsLower = new Set<string>(
    whitelist.syncFiles.map((id) => id.trim().toLowerCase()).filter(Boolean),
  );
  const whitelistedFoldersLower = new Set<string>(
    whitelist.syncFolders.map((id) => id.trim().toLowerCase()).filter(Boolean),
  );

  if (whitelistedFoldersLower.size > 0) {
    const docMap = new Map<string, DocumentRecord>(
      docs.map((doc) => [doc.documentId, doc]),
    );
    for (const doc of docs) {
      if (doc.type === 'DocumentType') {
        const lower = doc.documentId.toLowerCase();
        if (!whitelistedDocIdsLower.has(lower) && hasWhitelistedAncestor(doc, docMap, whitelistedFoldersLower)) {
          whitelistedDocIdsLower.add(lower);
        }
      }
    }
  }

  return whitelistedDocIdsLower;
}

async function executeSyncCycle(options: RunSyncCycleOptions): Promise<SyncCycleSummary> {
  const {
    trigger = 'manual',
    forceTreeRefresh = false,
    concurrency: concurrencyOverride,
    database = db,
    fetchImpl,
    onPhaseChange,
  } = options;

  const startedAt = new Date().toISOString();
  cancelledPageKeys.clear();

  // 1. Reconcile any cross-PC sync ledger records into local Dexie before diffing.
  await reconcileSyncLedgerToDexie(database);

  const auth = await getAuthStatusSummary();
  const hasCustomFetch = fetchImpl !== undefined;
  const hasCustomOneNote = options.oneNoteClient !== undefined;

  if (!auth.remarkablePaired && !hasCustomFetch) {
    return {
      trigger,
      startedAt,
      completedAt: new Date().toISOString(),
      treeSync: null,
      processedCount: 0,
      uploadedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      outcomes: [],
    };
  }

  // 2. Mirror reMarkable Cloud Sync15 tree and mark new/modified pages in whitelisted notebooks Pending.
  await onPhaseChange?.('Queued', 'Checking reMarkable Cloud for updated notebooks...');
  const treeSync = await syncRemarkableCloudTree({
    forceRefresh: forceTreeRefresh,
    database,
    fetchImpl,
  });

  if (!auth.microsoftConnected && !hasCustomFetch && !hasCustomOneNote) {
    await onPhaseChange?.('Idle');
    return {
      trigger,
      startedAt,
      completedAt: new Date().toISOString(),
      treeSync,
      processedCount: 0,
      uploadedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      outcomes: [],
    };
  }

  // Ensure any manually overridden pages stay Pending even if treeSync refreshed non-whitelisted docs.
  if (manualOverridePageKeys.size > 0) {
    await database.transaction('rw', database.pages, async () => {
      for (const key of manualOverridePageKeys) {
        const sepIdx = key.indexOf(':');
        if (sepIdx <= 0) continue;
        const docId = key.slice(0, sepIdx);
        const pgId = key.slice(sepIdx + 1);
        const row = await database.pages.get([docId, pgId]);
        if (row && row.status !== 'Pending') {
          await database.pages.put({
            ...row,
            status: 'Pending',
            retryCount: 0,
            lastError: null,
          });
        }
      }
    });
  }

  // 3. Gather user preferences, active whitelist, and Pending pages.
  const [prefs, whitelist, allDocs, pendingPagesRaw] = await Promise.all([
    getPreferences(),
    getWhitelist(),
    getAllDocuments(database),
    getPendingPages(1000, database),
  ]);

  const effectiveConcurrency =
    concurrencyOverride ?? prefs.syncConcurrency ?? DEFAULT_SYNC_WORKER_CONCURRENCY;

  const oneNoteClient =
    options.oneNoteClient ??
    new OneNoteClient({
      fetchImpl,
      maxConcurrentRequests: Math.max(1, effectiveConcurrency),
      phantomLinkPollDelaysMs: options.phantomLinkPollDelaysMs,
    });

  const directoryCache =
    options.directoryCache ?? new OneNoteDirectoryCache(oneNoteClient, database);

  // Pre-warm notebook & section cache in a single Graph call (non-fatal if it fails).
  await directoryCache.primeFromGraph();

  // Reconcile deleted pages according to the active lifecycle strategy
  if (prefs.pageSyncStrategy === 'mirror') {
    const deletedPages = await getPagesByStatus('Deleted', database);
    if (deletedPages.length > 0) {
      await onPhaseChange?.(
        'Uploading',
        `Purging ${deletedPages.length} deleted pages from OneNote...`,
      );
      const purgedFromOneNote: Array<{ documentId: string; pageId: string }> = [];
      for (const delPage of deletedPages) {
        if (delPage.oneNotePageId) {
          const deleted = await oneNoteClient.deletePage(delPage.oneNotePageId);
          if (deleted) {
            purgedFromOneNote.push({
              documentId: delPage.documentId,
              pageId: delPage.pageId,
            });
            // Keep the page record in Dexie so its metadata (pageNumber, size, strokes)
            // is preserved for Deleted Pages inspection and recovery, but clear OneNote references.
            await updatePageStatus(
              delPage.documentId,
              delPage.pageId,
              'Deleted',
              {
                oneNotePageId: null,
                oneNotePageUrl: null,
                titleRenameOnly: false,
              },
              database,
            );
          } else {
            console.warn(
              `[SyncEngine] Could not delete OneNote page ${delPage.oneNotePageId} for deleted tablet page.`,
            );
          }
        }
      }
      if (purgedFromOneNote.length > 0) {
        await removeSyncedPagesFromLedger(purgedFromOneNote);
      }
    }
  }

  if (pendingPagesRaw.length === 0) {
    await onPhaseChange?.('Idle');
    return {
      trigger,
      startedAt,
      completedAt: new Date().toISOString(),
      treeSync,
      processedCount: 0,
      uploadedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      outcomes: [],
    };
  }

  // Sort pending pages deterministically by document path and pageNumber ascending
  // so multi-page notebooks upload in chronological order (Page 1, Page 2, ...).
  const pendingPages = [...pendingPagesRaw].sort((a, b) => {
    const docCmp = a.documentId.localeCompare(b.documentId);
    if (docCmp !== 0) {
      return docCmp;
    }
    return a.pageNumber.localeCompare(b.pageNumber, undefined, { numeric: true });
  });

  // Pre-create sequential in-order creation barriers per document so multi-page
  // notebooks create pages on Microsoft Graph in exact ascending chronological order (Page 1, Page 2, ...).
  // Workers can still download and convert in parallel; only the final Graph page creation
  // awaits completion of the preceding page of the same document.
  interface PageCreationGate {
    wait: Promise<void>;
    promise: Promise<void>;
    release: () => void;
  }

  const pageCreationGates = new Map<number, PageCreationGate>();
  const lastIndexByDocId = new Map<string, number>();

  for (let idx = 0; idx < pendingPages.length; idx++) {
    const page = pendingPages[idx];
    const prevIdx = lastIndexByDocId.get(page.documentId);
    lastIndexByDocId.set(page.documentId, idx);

    let releaseCurrent: () => void = () => {};
    const currentPromise = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });

    const waitPromise =
      prevIdx !== undefined
        ? pageCreationGates.get(prevIdx)!.promise
        : Promise.resolve();

    pageCreationGates.set(idx, {
      wait: waitPromise,
      promise: currentPromise,
      release: releaseCurrent,
    });
  }

  const whitelistedDocsLower = computeWhitelistedDocumentSet(allDocs, whitelist);
  const docMap = new Map<string, DocumentRecord>(
    allDocs.map((doc) => [doc.documentId, doc]),
  );

  // Per-cycle caches for annotated PDF documents so `<documentId>.pdf` is downloaded
  // and parsed at most once per document across all concurrent page workers.
  const pdfIndexCache = new Map<
    string,
    { pdfBlobHash: string | null; pageIndexByPageId: Map<string, number | null> }
  >();
  const pdfSourceDocCache = new Map<string, PDFDocument | null>();
  const pdfMutex = new KeyedMutex();

  const resolvePageBackgroundPdf = async (
    page: PageRecord,
  ): Promise<ExtractedPdfPageResult | null> => {
    try {
      let pdfBlobHash: string | null | undefined = page.pdfBlobHash;
      let pdfPageIndex: number | null | undefined = page.pdfPageIndex;

      if (pdfBlobHash === undefined) {
        const docMeta = docMap.get(page.documentId);
        if (docMeta?.pdfBlobHash === null) {
          pdfBlobHash = null;
          pdfPageIndex = null;
        } else if (docMeta?.contentHash) {
          const resolved = await pdfMutex.runExclusive(
            `idx:${page.documentId}`,
            async () => {
              const cached = pdfIndexCache.get(page.documentId);
              if (cached) {
                return cached;
              }
              const subEntries = await fetchDocumentIndexEntries(
                page.documentId,
                docMeta.contentHash,
                fetchImpl,
              );
              const pdfEntry = subEntries.find(
                (entry) => entry.id === `${page.documentId}.pdf`,
              );
              const pageIndexByPageId = new Map<string, number | null>();
              if (pdfEntry) {
                const contentEntry = subEntries.find(
                  (entry) => entry.id === `${page.documentId}.content`,
                );
                let rawContent: string | null = null;
                if (contentEntry) {
                  try {
                    rawContent = await fetchSync15BlobText(
                      contentEntry.hash,
                      contentEntry.id,
                      fetchImpl,
                    );
                  } catch {
                    rawContent = null;
                  }
                }
                const rmPages = resolveDocumentRmPages(
                  page.documentId,
                  subEntries,
                  rawContent,
                );
                for (const rmPage of rmPages) {
                  pageIndexByPageId.set(rmPage.pageId, rmPage.pdfPageIndex ?? null);
                }
              }
              const result = {
                pdfBlobHash: pdfEntry ? pdfEntry.hash : null,
                pageIndexByPageId,
              };
              pdfIndexCache.set(page.documentId, result);
              return result;
            },
          );
          pdfBlobHash = resolved.pdfBlobHash;
          pdfPageIndex = resolved.pageIndexByPageId.has(page.pageId)
            ? (resolved.pageIndexByPageId.get(page.pageId) ?? null)
            : Number.parseInt(page.pageNumber, 10) - 1;
        }
      }

      if (!pdfBlobHash) {
        return null;
      }

      const resolvedPageIndex =
        pdfPageIndex !== undefined
          ? pdfPageIndex
          : Number.parseInt(page.pageNumber, 10) - 1;

      if (
        resolvedPageIndex === null ||
        !Number.isInteger(resolvedPageIndex) ||
        resolvedPageIndex < 0
      ) {
        return null;
      }

      const cacheKey = `${page.documentId}:${pdfBlobHash}`;
      const srcPdfDoc = await pdfMutex.runExclusive(
        `pdf:${cacheKey}`,
        async () => {
          if (pdfSourceDocCache.has(cacheKey)) {
            return pdfSourceDocCache.get(cacheKey) ?? null;
          }
          const pdfBytes = await downloadDocumentBlobBytes(
            page.documentId,
            `${page.documentId}.pdf`,
            {
              knownBlobHash: pdfBlobHash,
              fetchImpl,
            },
          );
          const loaded = await loadSourcePdfDocument(pdfBytes);
          pdfSourceDocCache.set(cacheKey, loaded);
          return loaded;
        },
      );

      if (!srcPdfDoc) {
        return null;
      }

      return await extractSinglePdfPageWithMetricsFromDocument(srcPdfDoc, resolvedPageIndex);
    } catch (err) {
      console.warn(
        `[rmOneNote] Failed to extract PDF background for ${page.virtualPath}; uploading strokes without PDF background:`,
        err,
      );
      return null;
    }
  };

  // Cache existing pages per target OneNote section so we only call `listPages(sectionId)`
  // once per section during a sync batch, guarded by a KeyedMutex.
  const sectionPagesMap = new Map<string, OneNotePage[]>();
  const sectionPagesMutex = new KeyedMutex();

  const getSectionPagesCached = async (sectionId: string): Promise<OneNotePage[]> => {
    return sectionPagesMutex.runExclusive(sectionId, async () => {
      const cached = sectionPagesMap.get(sectionId);
      if (cached) {
        return cached;
      }
      const listed = await oneNoteClient.listPages(
        sectionId,
        prefs.maxSectionPagesQueryLimit,
      );
      sectionPagesMap.set(sectionId, [...listed]);
      return sectionPagesMap.get(sectionId)!;
    });
  };

  const upsertSectionPageInMemory = async (
    sectionId: string,
    uploadedPage: OneNotePage,
    replacedPageIds?: readonly string[] | string | null,
  ): Promise<void> => {
    const replacedSet = new Set<string>();
    if (Array.isArray(replacedPageIds)) {
      for (const id of replacedPageIds) {
        replacedSet.add(id);
      }
    } else if (typeof replacedPageIds === 'string' && replacedPageIds.length > 0) {
      replacedSet.add(replacedPageIds);
    }

    await sectionPagesMutex.runExclusive(sectionId, async () => {
      const current = sectionPagesMap.get(sectionId) ?? [];
      const filtered = current.filter(
        (p) =>
          p.id !== uploadedPage.id &&
          !replacedSet.has(p.id) &&
          (prefs.pageSyncStrategy === 'preserve' || p.title !== uploadedPage.title),
      );
      filtered.push(uploadedPage);
      sectionPagesMap.set(sectionId, filtered);
    });
  };

  const outcomes: PageSyncOutcome[] = new Array<PageSyncOutcome>(pendingPages.length);
  let nextIndex = 0;

  const processSinglePage = async (
    page: PageRecord,
    pageIndex: number,
  ): Promise<PageSyncOutcome> => {
    try {
      const pageKey = buildPageKey(page.documentId, page.pageId);
    const isManualOverride = manualOverridePageKeys.has(pageKey);
    manualOverridePageKeys.delete(pageKey);

    if (cancelledPageKeys.has(pageKey)) {
      await updatePageStatus(
        page.documentId,
        page.pageId,
        'Skipped',
        { lastError: 'Cancelled by user' },
        database,
      );
      return {
        documentId: page.documentId,
        pageId: page.pageId,
        virtualPath: page.virtualPath,
        status: 'Skipped',
        oneNotePageId: page.oneNotePageId,
        oneNotePageUrl: page.oneNotePageUrl,
        error: 'Cancelled by user',
      };
    }

    if (!whitelistedDocsLower.has(page.documentId.toLowerCase()) && !isManualOverride) {
      await updatePageStatus(page.documentId, page.pageId, 'Skipped', {}, database);
      return {
        documentId: page.documentId,
        pageId: page.pageId,
        virtualPath: page.virtualPath,
        status: 'Skipped',
        oneNotePageId: page.oneNotePageId,
        oneNotePageUrl: page.oneNotePageUrl,
        error: null,
      };
    }

    if (page.retryCount >= prefs.maxRetries) {
      const maxRetryMsg = `Exceeded max retry attempts (${prefs.maxRetries}).`;
      await updatePageStatus(
        page.documentId,
        page.pageId,
        'Failed',
        { lastError: maxRetryMsg },
        database,
      );
      return {
        documentId: page.documentId,
        pageId: page.pageId,
        virtualPath: page.virtualPath,
        status: 'Failed',
        oneNotePageId: page.oneNotePageId,
        oneNotePageUrl: page.oneNotePageUrl,
        error: maxRetryMsg,
      };
    }

    try {
      const targetPath = parseVirtualPathToOneNoteTarget(
        page.virtualPath,
        prefs.targetSection,
      );

      // Fast-path: When a page was reordered on tablet without stroke modifications,
      // rename the OneNote page title directly via lightweight JSON PATCH.
      if (page.titleRenameOnly && page.oneNotePageId && prefs.pageSyncStrategy === 'mirror') {
        await updatePageStatus(page.documentId, page.pageId, 'Uploading', {}, database);
        await onPhaseChange?.('Uploading', `Renaming ${page.virtualPath}`);

        const renamed = await oneNoteClient.renamePage(page.oneNotePageId, targetPath.pageTitle);
        if (renamed) {
          const resolvedTarget = await directoryCache.resolveTargetNotebookAndSection(
            targetPath.notebookName,
            targetPath.sectionName,
          );
          await upsertSectionPageInMemory(
            resolvedTarget.sectionId,
            { id: page.oneNotePageId, title: targetPath.pageTitle },
          );

          const syncedAtMs = Date.now();
          const syncedAtIso = new Date(syncedAtMs).toISOString();
          await updatePageStatus(
            page.documentId,
            page.pageId,
            'Uploaded',
            {
              titleRenameOnly: false,
              syncedAtIso,
              lastError: null,
            },
            database,
          );

          return {
            documentId: page.documentId,
            pageId: page.pageId,
            virtualPath: page.virtualPath,
            status: 'Uploaded',
            oneNotePageId: page.oneNotePageId,
            oneNotePageUrl: page.oneNotePageUrl,
            error: null,
          };
        }
        // If rename failed (e.g. 404 in OneNote), fall through to normal full re-upload.
      }

      // Phase A: Queued -> Converting (.rm download + native TypeScript SceneTree -> InkML/HTML)
      await updatePageStatus(page.documentId, page.pageId, 'Converting', {}, database);
      await onPhaseChange?.('Converting', `Converting ${page.virtualPath}`);

      const hasRmBlob = Boolean(page.contentHash && page.fileSizeBytes > 0);
      const [rmBytes, backgroundPdf] = await Promise.all([
        hasRmBlob
          ? downloadPageRmBytes(page.documentId, page.pageId, {
              knownBlobHash: page.contentHash || undefined,
              fetchImpl,
            })
          : Promise.resolve(new Uint8Array(0)),
        resolvePageBackgroundPdf(page),
      ]);

      if (cancelledPageKeys.has(pageKey)) {
        throw new Error('Cancelled by user');
      }

      const backgroundPdfBytes = backgroundPdf ? backgroundPdf.pdfBytes : null;
      const converted = convertRmPage(rmBytes, {
        pageTitle: targetPath.pageTitle,
        includeBackgroundImageRef: backgroundPdfBytes !== null,
        pdfPageSizePt: backgroundPdf
          ? { widthPt: backgroundPdf.widthPt, heightPt: backgroundPdf.heightPt }
          : null,
      });

      // Phase B: Resolve OneNote Notebook & Section (creating if missing, deduplicated via KeyedMutex)
      const resolvedTarget = await directoryCache.resolveTargetNotebookAndSection(
        targetPath.notebookName,
        targetPath.sectionName,
      );

      if (resolvedTarget.notebookWebUrl) {
        await setDocumentOneNoteUrl(
          page.documentId,
          resolvedTarget.notebookWebUrl,
          database,
        );
      }

      if (cancelledPageKeys.has(pageKey)) {
        throw new Error('Cancelled by user');
      }

      // Phase C: Uploading (Check for existing page by ID or title -> update or create)
      await updatePageStatus(page.documentId, page.pageId, 'Uploading', {}, database);
      await onPhaseChange?.('Uploading', `Uploading ${page.virtualPath}`);

      const existingSectionPages = await getSectionPagesCached(resolvedTarget.sectionId);

      let effectiveTitle = targetPath.pageTitle;
      if (prefs.pageSyncStrategy === 'preserve') {
        const otherExistingTitles = new Set(
          existingSectionPages
            .filter((candidate) => candidate.id !== page.oneNotePageId)
            .map((candidate) => candidate.title),
        );
        effectiveTitle = resolveNonCollidingPageTitle(targetPath.pageTitle, otherExistingTitles);
      }

      const matchingExistingList = existingSectionPages.filter(
        (candidate) =>
          (page.oneNotePageId !== null && candidate.id === page.oneNotePageId) ||
          candidate.title === effectiveTitle,
      );

      // Graph only ingests `presentation-onenote-inkml` on page creation.
      // `PATCH /pages/{id}/content` silently drops the InkML part and appends
      // another PDF printout on every call, so an edited page is replaced by
      // creating a fresh page first and deleting the stale one afterwards.
      // Deleting last means a failed upload never loses the existing page.
      //
      // To guarantee OneNote displays pages in ascending order (Page 1, Page 2, Page 3),
      // we await the sequential creation barrier of the preceding page of this document,
      // and serialize page creation per target section so faster lightweight pages do
      // not overtake earlier pages on Microsoft Graph.
      const gate = pageCreationGates.get(pageIndex);
      if (gate) {
        await gate.wait;
      }

      const uploadedPageId = await sectionPagesMutex.runExclusive(
        `create:${resolvedTarget.sectionId}`,
        async () => {
          const pageId = await oneNoteClient.uploadInkMlPage({
            sectionId: resolvedTarget.sectionId,
            title: effectiveTitle,
            presentationHtml: converted.presentationHtml,
            inkmlXml: converted.inkmlXml,
            backgroundPdfBytes,
          });

          const stalePageIdsToDelete =
            prefs.pageSyncStrategy === 'mirror'
              ? matchingExistingList
                  .map((candidate) => candidate.id)
                  .filter((id) => id !== pageId)
              : [];

          for (const staleId of stalePageIdsToDelete) {
            const deleted = await oneNoteClient.deletePage(staleId);
            if (!deleted) {
              // TODO: Surface orphaned pages in Sync Control so users can clean them up.
              console.warn(
                `[SyncEngine] Replaced OneNote page ${staleId} but could not delete it.`,
              );
            }
          }

          await upsertSectionPageInMemory(
            resolvedTarget.sectionId,
            { id: pageId, title: effectiveTitle },
            stalePageIdsToDelete,
          );

          return pageId;
        },
      );

      // Release the barrier for the next page in this document immediately
      gate?.release();

      // Phase D: Indexing (Phantom Link verification polling until links.oneNoteWebUrl is populated)
      await updatePageStatus(
        page.documentId,
        page.pageId,
        'Indexing',
        { oneNotePageId: uploadedPageId },
        database,
      );
      await onPhaseChange?.('Indexing', `Indexing ${page.virtualPath}`);

      const verified =
        await oneNoteClient.getPageWithPhantomLinkVerification(uploadedPageId);

      // Phase E: Uploaded + Cross-PC Rolling Sync Ledger update
      const syncedAtMs = Date.now();
      const syncedAtIso = new Date(syncedAtMs).toISOString();

      await updatePageStatus(
        page.documentId,
        page.pageId,
        'Uploaded',
        {
          oneNotePageId: uploadedPageId,
          oneNotePageUrl: verified.oneNoteUrl,
          syncedAtIso,
          lastError: null,
          titleRenameOnly: false,
        },
        database,
      );

      await recordSyncedPagesInLedger([
        {
          documentId: page.documentId,
          pageId: page.pageId,
          syncedAtUnixSec: Math.floor(syncedAtMs / 1000),
        },
      ]);

      return {
        documentId: page.documentId,
        pageId: page.pageId,
        virtualPath: page.virtualPath,
        status: 'Uploaded',
        oneNotePageId: uploadedPageId,
        oneNotePageUrl: verified.oneNoteUrl,
        error: null,
      };
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Unknown page sync error.';

      if (cancelledPageKeys.has(pageKey) || errorMessage === 'Cancelled by user') {
        await updatePageStatus(
          page.documentId,
          page.pageId,
          'Skipped',
          { lastError: 'Cancelled by user' },
          database,
        );
        return {
          documentId: page.documentId,
          pageId: page.pageId,
          virtualPath: page.virtualPath,
          status: 'Skipped',
          oneNotePageId: page.oneNotePageId,
          oneNotePageUrl: page.oneNotePageUrl,
          error: 'Cancelled by user',
        };
      }

      console.error(
        `[rmOneNote] Failed to sync page ${page.virtualPath} (${page.documentId}/${page.pageId}):`,
        err,
      );
      await updatePageStatus(
        page.documentId,
        page.pageId,
        'Failed',
        { lastError: errorMessage },
        database,
      );

      return {
        documentId: page.documentId,
        pageId: page.pageId,
        virtualPath: page.virtualPath,
        status: 'Failed',
        oneNotePageId: page.oneNotePageId,
        oneNotePageUrl: page.oneNotePageUrl,
        error: errorMessage,
      };
    }
  } finally {
    pageCreationGates.get(pageIndex)?.release();
  }
};

  const workerCount = Math.max(1, Math.min(effectiveConcurrency, pendingPages.length));
  const runWorker = async (): Promise<void> => {
    while (nextIndex < pendingPages.length) {
      const current = nextIndex++;
      outcomes[current] = await processSinglePage(pendingPages[current], current);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  let uploadedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  for (const outcome of outcomes) {
    if (outcome.status === 'Uploaded') {
      uploadedCount++;
    } else if (outcome.status === 'Skipped') {
      skippedCount++;
    } else if (outcome.status === 'Failed') {
      failedCount++;
    }
  }

  const firstFailure = outcomes.find((item) => item.status === 'Failed');
  if (failedCount > 0 && uploadedCount === 0) {
    await onPhaseChange?.('Error', firstFailure?.error ?? 'One or more pages failed to sync.');
  } else {
    await onPhaseChange?.('Idle');
  }

  return {
    trigger,
    startedAt,
    completedAt: new Date().toISOString(),
    treeSync,
    processedCount: outcomes.length,
    uploadedCount,
    skippedCount,
    failedCount,
    outcomes,
  };
}

/**
 * Runs a full end-to-end synchronization cycle:
 * 1. Reconciles the cross-PC rolling sync ledger (`storage.sync` -> `Dexie.pages`).
 * 2. Syncs the reMarkable Cloud Sync15 folder/document tree and marks new/modified pages `Pending`.
 * 3. Downloads `.rm` blobs, converts strokes/text to InkML + HTML, uploads/updates OneNote pages,
 *    verifies Phantom Links, and records completed pages in both `Dexie.pages` and `storage.sync`.
 */
export async function runSyncCycle(
  options: RunSyncCycleOptions = {},
): Promise<SyncCycleSummary> {
  const isDefaultRuntime =
    (options.database === undefined || options.database === db) &&
    options.fetchImpl === undefined &&
    options.oneNoteClient === undefined &&
    options.directoryCache === undefined;

  if (!isDefaultRuntime) {
    return executeSyncCycle(options);
  }

  if (!activeDefaultSyncCycle) {
    activeDefaultSyncCycle = executeSyncCycle(options).finally(() => {
      activeDefaultSyncCycle = null;
    });
  }

  return activeDefaultSyncCycle;
}

export interface RecoverPageResult {
  ok: boolean;
  oneNoteUrl?: string;
  error?: string;
}

/**
 * Recovers a tablet-deleted page by uploading it to a dedicated `<SectionName> (Recovered)`
 * OneNote section, disambiguating multiple deleted revisions (e.g. `Page 3 (rev 1)`),
 * and verifying that the `.rm` blob has not expired/been pruned on reMarkable Cloud.
 */
export async function recoverDeletedPage(
  documentId: string,
  pageId: string,
  options: {
    database?: RmOneNoteDatabase;
    fetchImpl?: typeof fetch;
    oneNoteClient?: OneNoteClient;
    directoryCache?: OneNoteDirectoryCache;
    phantomLinkPollDelaysMs?: readonly number[];
  } = {},
): Promise<RecoverPageResult> {
  const database = options.database ?? db;
  const page = await database.pages.get([documentId, pageId]);
  if (!page) {
    return { ok: false, error: 'Page record not found in local database.' };
  }

  const prefs = await getPreferences();
  const oneNoteClient =
    options.oneNoteClient ??
    new OneNoteClient({
      fetchImpl: options.fetchImpl,
      maxConcurrentRequests: 1,
      phantomLinkPollDelaysMs: options.phantomLinkPollDelaysMs,
    });
  const directoryCache =
    options.directoryCache ?? new OneNoteDirectoryCache(oneNoteClient, database);

  const targetPath = parseVirtualPathToOneNoteTarget(page.virtualPath, prefs.targetSection);
  const recoveredSectionName = sanitizeOneNoteDisplayName(`${targetPath.sectionName} (Recovered)`);

  // Disambiguate revision if multiple pages share this page number
  const siblingPages = await database.pages.where('documentId').equals(documentId).toArray();
  const sameNumberPages = siblingPages
    .filter((p) => p.pageNumber === page.pageNumber)
    .sort((a, b) => a.lastModified.localeCompare(b.lastModified));

  let targetTitle = `Page ${page.pageNumber}`;
  if (sameNumberPages.length > 1) {
    const revIndex = sameNumberPages.findIndex((p) => p.pageId === pageId) + 1;
    targetTitle = `Page ${page.pageNumber} (rev ${revIndex > 0 ? revIndex : 1})`;
  }

  let rmBytes: Uint8Array = new Uint8Array(0);
  if (page.contentHash && page.fileSizeBytes > 0) {
    try {
      rmBytes = await downloadPageRmBytes(documentId, pageId, {
        knownBlobHash: page.contentHash,
        fetchImpl: options.fetchImpl,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isExpired =
        errMsg.includes('404') ||
        errMsg.toLowerCase().includes('not found') ||
        errMsg.toLowerCase().includes('pruned');

      if (isExpired) {
        const expiredMsg =
          'Page content has expired and is no longer available on reMarkable Cloud.';
        await updatePageStatus(
          documentId,
          pageId,
          'Deleted',
          { lastError: expiredMsg },
          database,
        );
        return {
          ok: false,
          error: expiredMsg,
        };
      }
      throw err;
    }
  }

  let backgroundPdfBytes: Uint8Array | null = null;
  if (page.pdfBlobHash) {
    try {
      const pdfBytes = await downloadDocumentBlobBytes(
        documentId,
        `${documentId}.pdf`,
        {
          knownBlobHash: page.pdfBlobHash,
          fetchImpl: options.fetchImpl,
        },
      );
      const loadedPdf = await loadSourcePdfDocument(pdfBytes);
      const resolvedPageIndex = page.pdfPageIndex ?? Number.parseInt(page.pageNumber, 10) - 1;
      const extracted = await extractSinglePdfPageWithMetricsFromDocument(
        loadedPdf,
        resolvedPageIndex,
      );
      backgroundPdfBytes = extracted ? extracted.pdfBytes : null;
    } catch (err) {
      console.warn(`[rmOneNote] Failed to load background PDF during page recovery:`, err);
    }
  }

  const converted = convertRmPage(rmBytes, {
    pageTitle: targetTitle,
    includeBackgroundImageRef: backgroundPdfBytes !== null,
  });

  const resolvedTarget = await directoryCache.resolveTargetNotebookAndSection(
    targetPath.notebookName,
    recoveredSectionName,
  );

  const uploadedPageId = await oneNoteClient.uploadInkMlPage({
    sectionId: resolvedTarget.sectionId,
    title: targetTitle,
    presentationHtml: converted.presentationHtml,
    inkmlXml: converted.inkmlXml,
    backgroundPdfBytes,
  });

  const verified = await oneNoteClient.getPageWithPhantomLinkVerification(uploadedPageId);
  const syncedAtMs = Date.now();
  const syncedAtIso = new Date(syncedAtMs).toISOString();

  await updatePageStatus(
    documentId,
    pageId,
    'Deleted',
    {
      oneNotePageId: uploadedPageId,
      oneNotePageUrl: verified.oneNoteUrl,
      syncedAtIso,
      lastError: null,
      titleRenameOnly: false,
    },
    database,
  );

  await recordSyncedPagesInLedger([
    {
      documentId,
      pageId,
      syncedAtUnixSec: Math.floor(syncedAtMs / 1000),
    },
  ]);

  return {
    ok: true,
    oneNoteUrl: verified.oneNoteUrl,
  };
}

