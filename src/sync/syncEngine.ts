import { getAuthStatusSummary } from '../auth';
import { convertRmPage } from '../converter';
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
  type OneNotePage,
} from '../onenote';
import { downloadPageRmBytes, syncRemarkableCloudTree } from '../remarkable';
import { getPreferences, getWhitelist, type SyncWhitelist } from '../storage/preferences';
import {
  reconcileSyncLedgerToDexie,
  recordSyncedPagesInLedger,
} from '../storage/syncLedger';
import type { PageSyncOutcome, RunSyncCycleOptions, SyncCycleSummary } from './types';

const DEFAULT_SYNC_WORKER_CONCURRENCY = 3;

const cancelledPageKeys = new Set<string>();
const manualOverridePageKeys = new Set<string>();
let activeDefaultSyncCycle: Promise<SyncCycleSummary> | null = null;

function buildPageKey(documentId: string, pageId: string): string {
  return `${documentId}:${pageId}`;
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
          matchedMap.set(buildPageKey(page.documentId, page.pageId), page);
        }
      }
    }

    for (const ref of explicitPages) {
      const existing = await database.pages.get([ref.documentId, ref.pageId]);
      if (existing) {
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
    concurrency = DEFAULT_SYNC_WORKER_CONCURRENCY,
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

  const whitelistedDocsLower = computeWhitelistedDocumentSet(allDocs, whitelist);

  const oneNoteClient =
    options.oneNoteClient ??
    new OneNoteClient({
      fetchImpl,
      maxConcurrentRequests: Math.max(1, concurrency),
      phantomLinkPollDelaysMs: options.phantomLinkPollDelaysMs,
    });

  const directoryCache =
    options.directoryCache ?? new OneNoteDirectoryCache(oneNoteClient, database);

  // Pre-warm notebook & section cache in a single Graph call (non-fatal if it fails).
  await directoryCache.primeFromGraph();

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
      const listed = await oneNoteClient.listPages(sectionId);
      sectionPagesMap.set(sectionId, [...listed]);
      return sectionPagesMap.get(sectionId)!;
    });
  };

  const upsertSectionPageInMemory = async (
    sectionId: string,
    uploadedPage: OneNotePage,
    replacedPageId?: string | null,
  ): Promise<void> => {
    await sectionPagesMutex.runExclusive(sectionId, async () => {
      const current = sectionPagesMap.get(sectionId) ?? [];
      const filtered = current.filter(
        (p) =>
          p.id !== uploadedPage.id &&
          (replacedPageId ? p.id !== replacedPageId : true) &&
          p.title !== uploadedPage.title,
      );
      filtered.push(uploadedPage);
      sectionPagesMap.set(sectionId, filtered);
    });
  };

  const outcomes: PageSyncOutcome[] = new Array<PageSyncOutcome>(pendingPages.length);
  let nextIndex = 0;

  const processSinglePage = async (page: PageRecord): Promise<PageSyncOutcome> => {
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
      // Phase A: Queued -> Converting (.rm download + native TypeScript SceneTree -> InkML/HTML)
      await updatePageStatus(page.documentId, page.pageId, 'Converting', {}, database);
      await onPhaseChange?.('Converting', `Converting ${page.virtualPath}`);

      const targetPath = parseVirtualPathToOneNoteTarget(
        page.virtualPath,
        prefs.targetSection,
      );

      const rmBytes = await downloadPageRmBytes(page.documentId, page.pageId, {
        knownBlobHash: page.contentHash || undefined,
        fetchImpl,
      });

      if (cancelledPageKeys.has(pageKey)) {
        throw new Error('Cancelled by user');
      }

      const converted = convertRmPage(rmBytes, {
        pageTitle: targetPath.pageTitle,
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
      const matchingExisting = existingSectionPages.find(
        (candidate) =>
          (page.oneNotePageId !== null && candidate.id === page.oneNotePageId) ||
          candidate.title === targetPath.pageTitle,
      );

      const uploadedPageId = matchingExisting
        ? await oneNoteClient.updateInkMlPage({
            pageId: matchingExisting.id,
            title: targetPath.pageTitle,
            presentationHtml: converted.presentationHtml,
            inkmlXml: converted.inkmlXml,
          })
        : await oneNoteClient.uploadInkMlPage({
            sectionId: resolvedTarget.sectionId,
            title: targetPath.pageTitle,
            presentationHtml: converted.presentationHtml,
            inkmlXml: converted.inkmlXml,
          });

      await upsertSectionPageInMemory(
        resolvedTarget.sectionId,
        { id: uploadedPageId, title: targetPath.pageTitle },
        matchingExisting?.id ?? null,
      );

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
  };

  const workerCount = Math.max(1, Math.min(concurrency, pendingPages.length));
  const runWorker = async (): Promise<void> => {
    while (nextIndex < pendingPages.length) {
      const current = nextIndex++;
      outcomes[current] = await processSinglePage(pendingPages[current]);
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

