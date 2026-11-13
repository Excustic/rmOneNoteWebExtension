import { db, type RmOneNoteDatabase } from '../db/db';
import type { DocumentRecord, PageRecord } from '../db/models';
import { ext } from '../shared/browser';
import {
  getPreferences,
  getWhitelist,
  setWhitelist,
  type SyncWhitelist,
} from '../storage/preferences';
import { removeSyncedPagesFromLedger } from '../storage/syncLedger';
import {
  buildFileTreeHierarchy,
  collectVirtualPaths,
  isItemInTrash,
  parseDocumentMetadata,
  resolveDocumentRmPages,
} from './metadataParser';
import {
  fetchDocumentIndexEntries,
  fetchRootIndexEntries,
  fetchSync15BlobText,
  fetchSync15RootPointer,
} from './sync15Client';
import type {
  CloudTreeSyncResult,
  ResolvedRemarkablePage,
  Sync15IndexEntry,
} from './types';

export const CLOUD_ROOT_STATE_STORAGE_KEY = 'rmCloudRootState';
const DEFAULT_FETCH_CONCURRENCY = 6;

export interface StoredCloudRootState {
  rootHash: string;
  generation: number;
  syncedAt: string;
}

export interface SyncRemarkableTreeOptions {
  /** Bypass the cached root-hash fast path and re-verify `root.docSchema`. */
  forceRefresh?: boolean;
  maxConcurrency?: number;
  database?: RmOneNoteDatabase;
  fetchImpl?: typeof fetch;
}

interface FetchedDocumentBundle {
  documentId: string;
  docRecord: DocumentRecord | null;
  pages: ResolvedRemarkablePage[];
}

let inflightDefaultSync: Promise<CloudTreeSyncResult> | null = null;

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const runWorker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await worker(items[current], current);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  return results;
}

async function readStoredCloudRootState(): Promise<StoredCloudRootState | null> {
  const raw = await ext.storage.local.get(CLOUD_ROOT_STATE_STORAGE_KEY);
  const candidate = raw[CLOUD_ROOT_STATE_STORAGE_KEY] as Partial<StoredCloudRootState> | undefined;
  if (!candidate || typeof candidate.rootHash !== 'string') {
    return null;
  }
  return {
    rootHash: candidate.rootHash,
    generation: typeof candidate.generation === 'number' ? candidate.generation : 0,
    syncedAt: typeof candidate.syncedAt === 'string' ? candidate.syncedAt : '',
  };
}

async function writeStoredCloudRootState(state: StoredCloudRootState): Promise<void> {
  await ext.storage.local.set({ [CLOUD_ROOT_STATE_STORAGE_KEY]: state });
}

export async function clearStoredCloudRootState(): Promise<void> {
  await ext.storage.local.remove(CLOUD_ROOT_STATE_STORAGE_KEY);
}

function hasWhitelistedAncestorFolder(
  doc: DocumentRecord,
  docMap: ReadonlyMap<string, DocumentRecord>,
  whitelistedFoldersLower: ReadonlySet<string>,
): boolean {
  const visited = new Set<string>();
  let parentId = doc.parent;

  while (parentId) {
    const parentLower = parentId.toLowerCase();
    if (whitelistedFoldersLower.has(parentLower)) {
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

export function computeEffectiveWhitelistedDocIds(
  activeDocs: readonly DocumentRecord[],
  whitelist: SyncWhitelist,
  autoAddNewFiles: boolean,
): { effectiveDocIdsLower: Set<string>; newlyAutoAddedIds: string[] } {
  const effectiveDocIdsLower = new Set<string>(
    whitelist.syncFiles.map((id) => id.trim().toLowerCase()).filter(Boolean),
  );
  const whitelistedFoldersLower = new Set<string>(
    whitelist.syncFolders.map((id) => id.trim().toLowerCase()).filter(Boolean),
  );

  const newlyAutoAddedIds: string[] = [];

  if (autoAddNewFiles && whitelistedFoldersLower.size > 0) {
    const docMap = new Map<string, DocumentRecord>(
      activeDocs.map((doc) => [doc.documentId, doc]),
    );

    for (const doc of activeDocs) {
      if (doc.type !== 'DocumentType') {
        continue;
      }
      const idLower = doc.documentId.toLowerCase();
      if (effectiveDocIdsLower.has(idLower)) {
        continue;
      }
      if (hasWhitelistedAncestorFolder(doc, docMap, whitelistedFoldersLower)) {
        effectiveDocIdsLower.add(idLower);
        newlyAutoAddedIds.push(doc.documentId);
      }
    }
  }

  return { effectiveDocIdsLower, newlyAutoAddedIds };
}

async function fetchSingleDocumentBundle(
  rootEntry: Sync15IndexEntry,
  existingOneNoteUrl: string | null,
  fetchImpl: typeof fetch,
): Promise<FetchedDocumentBundle> {
  const documentId = rootEntry.id;
  const subEntries = await fetchDocumentIndexEntries(documentId, rootEntry.hash, fetchImpl);

  const metadataTarget = `${documentId}.metadata`;
  const metadataEntry = subEntries.find((entry) => entry.id === metadataTarget);
  if (!metadataEntry) {
    return { documentId, docRecord: null, pages: [] };
  }

  const rawMetadata = await fetchSync15BlobText(
    metadataEntry.hash,
    metadataEntry.id,
    fetchImpl,
  );
  const meta = parseDocumentMetadata(rawMetadata);

  if (meta.deleted || meta.type === 'TemplateType') {
    return { documentId, docRecord: null, pages: [] };
  }

  let pages: ResolvedRemarkablePage[] = [];

  if (meta.type === 'DocumentType') {
    const rmPrefix = `${documentId}/`;
    const hasRmBlobs = subEntries.some(
      (entry) => entry.id.startsWith(rmPrefix) && entry.id.endsWith('.rm'),
    );
    const hasPdfBlob = subEntries.some((entry) => entry.id === `${documentId}.pdf`);

    if (hasRmBlobs || hasPdfBlob) {
      const contentTarget = `${documentId}.content`;
      const contentEntry = subEntries.find((entry) => entry.id === contentTarget);
      let rawContent: string | null = null;
      if (contentEntry) {
        try {
          rawContent = await fetchSync15BlobText(
            contentEntry.hash,
            contentEntry.id,
            fetchImpl,
          );
        } catch (err) {
          console.warn(
            `[rmOneNote] Failed to download ${contentTarget}; falling back to .docSchema page order:`,
            err,
          );
        }
      }

      try {
        pages = resolveDocumentRmPages(documentId, subEntries, rawContent);
      } catch (err) {
        console.warn(
          `[rmOneNote] Malformed ${contentTarget} JSON; falling back to .docSchema page order:`,
          err,
        );
        pages = resolveDocumentRmPages(documentId, subEntries, null);
      }
    }
  }

  const pdfEntry =
    meta.type === 'DocumentType'
      ? subEntries.find((entry) => entry.id === `${documentId}.pdf`)
      : undefined;

  const docRecord: DocumentRecord = {
    documentId,
    visibleName: meta.visibleName,
    type: meta.type,
    parent: meta.parent,
    virtualPath: meta.visibleName,
    cloudVersion: meta.version,
    contentHash: rootEntry.hash,
    lastModified: meta.lastModifiedIso,
    oneNoteNotebookUrl: existingOneNoteUrl,
    pdfBlobHash: pdfEntry ? pdfEntry.hash : null,
  };

  return { documentId, docRecord, pages };
}

function canAutoSyncPage(
  isWhitelisted: boolean,
  fileSizeBytes: number,
  syncUnannotatedPdfPages: boolean,
): boolean {
  const isBlank = fileSizeBytes === 0;
  return isWhitelisted && (!isBlank || syncUnannotatedPdfPages);
}

function resolveReconciledPageStatus(
  currentStatus: PageRecord['status'],
  canAutoSync: boolean,
): PageRecord['status'] {
  if (canAutoSync && currentStatus === 'Skipped') {
    return 'Pending';
  }
  if (!canAutoSync && currentStatus === 'Pending') {
    return 'Skipped';
  }
  return currentStatus;
}

async function reconcileWhitelistStatusesInDb(
  effectiveDocIdsLower: ReadonlySet<string>,
  syncUnannotatedPdfPages: boolean,
  database: RmOneNoteDatabase,
): Promise<number> {
  return database.transaction('rw', database.pages, async () => {
    const allPages = await database.pages.toArray();
    const updates: PageRecord[] = [];

    for (const page of allPages) {
      const isWhitelisted = effectiveDocIdsLower.has(page.documentId.toLowerCase());
      const canAutoSync = canAutoSyncPage(
        isWhitelisted,
        page.fileSizeBytes,
        syncUnannotatedPdfPages,
      );
      const nextStatus = resolveReconciledPageStatus(page.status, canAutoSync);

      if (nextStatus !== page.status) {
        updates.push({ ...page, status: nextStatus });
      }
    }

    if (updates.length > 0) {
      await database.pages.bulkPut(updates);
    }

    return updates.length;
  });
}

async function buildSyncResultFromDb(
  rootHash: string,
  generation: number,
  upToDate: boolean,
  changedDocuments: number,
  database: RmOneNoteDatabase,
): Promise<CloudTreeSyncResult> {
  const [docs, indexedPagesCount, pendingPagesCount] = await Promise.all([
    database.documents.toArray(),
    database.pages.count(),
    database.pages.where('status').equals('Pending').count(),
  ]);

  let folderCount = 0;
  let documentCount = 0;
  for (const doc of docs) {
    if (doc.type === 'CollectionType') {
      folderCount++;
    } else {
      documentCount++;
    }
  }

  return {
    rootHash,
    generation,
    upToDate,
    totalItems: docs.length,
    folderCount,
    documentCount,
    changedDocuments,
    indexedPagesCount,
    pendingPagesCount,
  };
}

async function executeCloudTreeSync(
  options: SyncRemarkableTreeOptions,
): Promise<CloudTreeSyncResult> {
  const {
    forceRefresh = false,
    maxConcurrency = DEFAULT_FETCH_CONCURRENCY,
    database = db,
    fetchImpl = fetch,
  } = options;

  const [rootPointer, cachedRoot, existingDocs, whitelist, prefs] = await Promise.all([
    fetchSync15RootPointer(fetchImpl),
    readStoredCloudRootState(),
    database.documents.toArray(),
    getWhitelist(),
    getPreferences(),
  ]);

  // Fast path: root pointer hash unchanged on reMarkable Cloud.
  if (
    !forceRefresh &&
    cachedRoot !== null &&
    cachedRoot.rootHash === rootPointer.hash &&
    (rootPointer.hash !== '' || existingDocs.length === 0)
  ) {
    const { effectiveDocIdsLower, newlyAutoAddedIds } = computeEffectiveWhitelistedDocIds(
      existingDocs,
      whitelist,
      prefs.autoAddNewFiles,
    );
    if (newlyAutoAddedIds.length > 0) {
      await setWhitelist({
        syncFiles: [...whitelist.syncFiles, ...newlyAutoAddedIds],
        syncFolders: whitelist.syncFolders,
      });
    }
    await reconcileWhitelistStatusesInDb(
      effectiveDocIdsLower,
      prefs.syncUnannotatedPdfPages,
      database,
    );

    return buildSyncResultFromDb(
      rootPointer.hash,
      rootPointer.generation,
      true,
      0,
      database,
    );
  }

  // Empty cloud account: clear stale cached documents and mark previously uploaded pages Deleted.
  if (!rootPointer.hash) {
    await database.transaction('rw', [database.documents, database.pages], async () => {
      await database.documents.clear();
      const allPages = await database.pages.toArray();
      const toKeepDeleted: PageRecord[] = [];
      const keysToDelete: Array<[string, string]> = [];

      for (const page of allPages) {
        if (page.status === 'Uploaded' || page.oneNotePageId !== null) {
          if (page.status !== 'Deleted') {
            toKeepDeleted.push({ ...page, status: 'Deleted' });
          }
        } else {
          keysToDelete.push([page.documentId, page.pageId]);
        }
      }

      if (toKeepDeleted.length > 0) {
        await database.pages.bulkPut(toKeepDeleted);
      }
      if (keysToDelete.length > 0) {
        await database.pages.bulkDelete(keysToDelete);
      }
    });

    await writeStoredCloudRootState({
      rootHash: '',
      generation: rootPointer.generation,
      syncedAt: new Date().toISOString(),
    });

    return buildSyncResultFromDb('', rootPointer.generation, false, 0, database);
  }

  const rootEntries = await fetchRootIndexEntries(rootPointer.hash, fetchImpl);
  const existingDocMap = new Map<string, DocumentRecord>(
    existingDocs.map((doc) => [doc.documentId, doc]),
  );
  const rootEntryIds = new Set<string>(rootEntries.map((entry) => entry.id));

  const allExistingPages = await database.pages.toArray();
  const existingPagesByDoc = new Map<string, Map<string, PageRecord>>();
  for (const page of allExistingPages) {
    let byPageId = existingPagesByDoc.get(page.documentId);
    if (!byPageId) {
      byPageId = new Map<string, PageRecord>();
      existingPagesByDoc.set(page.documentId, byPageId);
    }
    byPageId.set(page.pageId, page);
  }

  const entriesToFetch = rootEntries.filter((entry) => {
    const existing = existingDocMap.get(entry.id);
    if (!existing || existing.contentHash !== entry.hash) {
      return true;
    }
    // Only during an explicit force-refresh (e.g. Load Folders), re-check PDF documents
    // that may have been indexed under older versions without unannotated blank pages.
    if (forceRefresh && existing.type === 'DocumentType' && existing.pdfBlobHash) {
      const cachedPages = existingPagesByDoc.get(entry.id);
      const hasAnyBlankPage =
        cachedPages !== undefined &&
        Array.from(cachedPages.values()).some((p) => p.fileSizeBytes === 0);
      if (!hasAnyBlankPage) {
        return true;
      }
    }
    return false;
  });

  const fetchedBundles = await mapWithConcurrency(
    entriesToFetch,
    maxConcurrency,
    (entry) =>
      fetchSingleDocumentBundle(
        entry,
        existingDocMap.get(entry.id)?.oneNoteNotebookUrl ?? null,
        fetchImpl,
      ),
  );

  const fetchedMap = new Map<string, FetchedDocumentBundle>(
    fetchedBundles.map((bundle) => [bundle.documentId, bundle]),
  );

  // Merge unchanged local DocumentRecords with newly fetched DocumentRecords.
  const candidateMap = new Map<string, DocumentRecord>();
  for (const entry of rootEntries) {
    const fetched = fetchedMap.get(entry.id);
    if (fetched) {
      if (fetched.docRecord) {
        candidateMap.set(entry.id, fetched.docRecord);
      }
    } else {
      const existing = existingDocMap.get(entry.id);
      if (existing) {
        candidateMap.set(entry.id, existing);
      }
    }
  }

  // Filter out trashed items and compute hierarchical virtual paths across the entire cloud tree.
  const nonTrashDocs: DocumentRecord[] = [];
  for (const doc of candidateMap.values()) {
    if (!isItemInTrash(doc, candidateMap)) {
      nonTrashDocs.push(doc);
    }
  }

  const treeRoots = buildFileTreeHierarchy(nonTrashDocs);
  const virtualPathMap = collectVirtualPaths(treeRoots);

  const finalActiveDocs: DocumentRecord[] = nonTrashDocs.map((doc) => ({
    ...doc,
    virtualPath: virtualPathMap.get(doc.documentId) ?? doc.visibleName,
  }));
  const finalActiveDocMap = new Map<string, DocumentRecord>(
    finalActiveDocs.map((doc) => [doc.documentId, doc]),
  );

  // Auto-add newly created documents placed inside whitelisted folders if enabled.
  const { effectiveDocIdsLower, newlyAutoAddedIds } = computeEffectiveWhitelistedDocIds(
    finalActiveDocs,
    whitelist,
    prefs.autoAddNewFiles,
  );

  if (newlyAutoAddedIds.length > 0) {
    await setWhitelist({
      syncFiles: [...whitelist.syncFiles, ...newlyAutoAddedIds],
      syncFolders: whitelist.syncFolders,
    });
  }

  const removedDocIds: string[] = [];
  for (const existing of existingDocs) {
    if (!rootEntryIds.has(existing.documentId) || !finalActiveDocMap.has(existing.documentId)) {
      removedDocIds.push(existing.documentId);
    }
  }

  await database.transaction('rw', [database.documents, database.pages], async () => {
    if (removedDocIds.length > 0) {
      await database.documents.bulkDelete(removedDocIds);
    }
    if (finalActiveDocs.length > 0) {
      await database.documents.bulkPut(finalActiveDocs);
    }

    const pagesToPut: PageRecord[] = [];
    const pageKeysToDelete: Array<[string, string]> = [];

    // 1. Handle pages belonging to removed or trashed documents.
    if (removedDocIds.length > 0) {
      const removedPages = await database.pages
        .where('documentId')
        .anyOf(removedDocIds)
        .toArray();

      for (const page of removedPages) {
        if (page.status === 'Uploaded' || page.oneNotePageId !== null) {
          if (page.status !== 'Deleted') {
            pagesToPut.push({ ...page, status: 'Deleted' });
          }
        } else {
          pageKeysToDelete.push([page.documentId, page.pageId]);
        }
      }
    }

    // 2. Reconcile pages for changed/new active documents.
    const changedActiveDocIds = finalActiveDocs
      .filter((doc) => doc.type === 'DocumentType' && fetchedMap.has(doc.documentId))
      .map((doc) => doc.documentId);

    for (const docId of changedActiveDocIds) {
      const doc = finalActiveDocMap.get(docId)!;
      const bundle = fetchedMap.get(docId)!;
      const existingByPageId = existingPagesByDoc.get(docId) ?? new Map<string, PageRecord>();
      const seenActivePageIds = new Set<string>();
      const isDocWhitelisted = effectiveDocIdsLower.has(docId.toLowerCase());

      for (const resolvedPage of bundle.pages) {
        seenActivePageIds.add(resolvedPage.pageId);
        const pageVirtualPath = `${doc.virtualPath}/${resolvedPage.title}`;
        const existingPage = existingByPageId.get(resolvedPage.pageId);
        const pdfBlobHash = resolvedPage.pdfBlobHash ?? null;
        const pdfPageIndex = resolvedPage.pdfPageIndex ?? null;

        const canAutoSync = canAutoSyncPage(
          isDocWhitelisted,
          resolvedPage.fileSizeBytes,
          prefs.syncUnannotatedPdfPages,
        );

        if (!existingPage) {
          pagesToPut.push({
            documentId: docId,
            pageId: resolvedPage.pageId,
            pageNumber: resolvedPage.pageNumber,
            title: resolvedPage.title,
            virtualPath: pageVirtualPath,
            fileSizeBytes: resolvedPage.fileSizeBytes,
            lastModified: doc.lastModified,
            contentHash: resolvedPage.rmBlobHash,
            status: canAutoSync ? 'Pending' : 'Skipped',
            lastSyncTime: null,
            oneNotePageId: null,
            oneNotePageUrl: null,
            retryCount: 0,
            lastError: null,
            pdfBlobHash,
            pdfPageIndex,
          });
        } else if (existingPage.contentHash !== resolvedPage.rmBlobHash) {
          // Cross-browser ledger stubs arrive with `contentHash === ""` and `status === "Uploaded"`.
          // Hydrate their blob hash without re-queuing unless the tablet modified the doc after `lastSyncTime`.
          const isUnmodifiedLedgerStub =
            existingPage.contentHash === '' &&
            existingPage.status === 'Uploaded' &&
            existingPage.lastSyncTime !== null &&
            Date.parse(existingPage.lastSyncTime) + 1000 >= Date.parse(doc.lastModified);

          const isPageNumberChanged = existingPage.pageNumber !== resolvedPage.pageNumber;
          let originalPageNumber = existingPage.originalPageNumber;
          if (isPageNumberChanged && prefs.pageSyncStrategy === 'preserve' && !originalPageNumber) {
            originalPageNumber = existingPage.pageNumber;
          }

          pagesToPut.push({
            ...existingPage,
            pageNumber: resolvedPage.pageNumber,
            title: resolvedPage.title,
            virtualPath: pageVirtualPath,
            fileSizeBytes: resolvedPage.fileSizeBytes,
            lastModified: doc.lastModified,
            contentHash: resolvedPage.rmBlobHash,
            status: isUnmodifiedLedgerStub
              ? 'Uploaded'
              : canAutoSync
                ? 'Pending'
                : 'Skipped',
            retryCount: isUnmodifiedLedgerStub ? existingPage.retryCount : 0,
            lastError: isUnmodifiedLedgerStub ? existingPage.lastError : null,
            pdfBlobHash,
            pdfPageIndex,
            titleRenameOnly: false,
            originalPageNumber,
          });
        } else {
          let nextStatus = existingPage.status;
          if (canAutoSync && (nextStatus === 'Skipped' || nextStatus === 'Deleted')) {
            nextStatus = 'Pending';
          } else if (!canAutoSync && nextStatus === 'Pending') {
            nextStatus = 'Skipped';
          }

          const isPageNumberChanged = existingPage.pageNumber !== resolvedPage.pageNumber;
          let titleRenameOnly = existingPage.titleRenameOnly;
          let originalPageNumber = existingPage.originalPageNumber;
          let titleToStore = resolvedPage.title;

          if (isPageNumberChanged) {
            if (prefs.pageSyncStrategy === 'mirror') {
              if (existingPage.oneNotePageId && canAutoSync) {
                // In mirror mode with an existing OneNote page, schedule lightweight title rename
                nextStatus = 'Pending';
                titleRenameOnly = true;
              }
            } else {
              // In preserve mode, keep OneNote title static and record original tablet page number
              if (!originalPageNumber) {
                originalPageNumber = existingPage.pageNumber;
              }
              if (existingPage.status === 'Uploaded') {
                titleToStore = existingPage.title;
              }
            }
          }

          if (
            existingPage.pageNumber !== resolvedPage.pageNumber ||
            existingPage.title !== titleToStore ||
            existingPage.virtualPath !== pageVirtualPath ||
            existingPage.fileSizeBytes !== resolvedPage.fileSizeBytes ||
            existingPage.status !== nextStatus ||
            existingPage.pdfBlobHash !== pdfBlobHash ||
            existingPage.pdfPageIndex !== pdfPageIndex ||
            existingPage.titleRenameOnly !== titleRenameOnly ||
            existingPage.originalPageNumber !== originalPageNumber
          ) {
            pagesToPut.push({
              ...existingPage,
              pageNumber: resolvedPage.pageNumber,
              title: titleToStore,
              virtualPath: pageVirtualPath,
              fileSizeBytes: resolvedPage.fileSizeBytes,
              status: nextStatus,
              pdfBlobHash,
              pdfPageIndex,
              titleRenameOnly,
              originalPageNumber,
            });
          }
        }
      }

      for (const [pageId, existingPage] of existingByPageId.entries()) {
        if (!seenActivePageIds.has(pageId)) {
          // If this is an invalid or corrupted orphan stub without a page number, prune it completely
          if (!existingPage.pageNumber || existingPage.pageNumber.trim() === '') {
            pageKeysToDelete.push([docId, pageId]);
            void removeSyncedPagesFromLedger([{ documentId: docId, pageId }]);
            continue;
          }

          // If the page was removed from the tablet, mark it as Deleted so it remains visible
          // in Deleted Pages for inspection and recovery. Do not prune it from Dexie.
          if (existingPage.status !== 'Deleted') {
            pagesToPut.push({
              ...existingPage,
              status: 'Deleted',
              titleRenameOnly: false,
            });
          }
        }
      }
    }

    // 3. Propagate renamed parent folder `virtualPath` or whitelist changes to unchanged documents.
    const unchangedActiveDocIds = finalActiveDocs
      .filter((doc) => doc.type === 'DocumentType' && !fetchedMap.has(doc.documentId))
      .map((doc) => doc.documentId);

    if (unchangedActiveDocIds.length > 0) {
      const unchangedPages = await database.pages
        .where('documentId')
        .anyOf(unchangedActiveDocIds)
        .toArray();

      for (const page of unchangedPages) {
        const doc = finalActiveDocMap.get(page.documentId);
        if (!doc) {
          continue;
        }
        const expectedVirtualPath = `${doc.virtualPath}/${page.title}`;
        const isDocWhitelisted = effectiveDocIdsLower.has(page.documentId.toLowerCase());
        const canAutoSync = canAutoSyncPage(
          isDocWhitelisted,
          page.fileSizeBytes,
          prefs.syncUnannotatedPdfPages,
        );
        const nextStatus = resolveReconciledPageStatus(page.status, canAutoSync);

        if (page.virtualPath !== expectedVirtualPath || page.status !== nextStatus) {
          pagesToPut.push({
            ...page,
            virtualPath: expectedVirtualPath,
            status: nextStatus,
          });
        }
      }
    }

    if (pagesToPut.length > 0) {
      await database.pages.bulkPut(pagesToPut);
    }
    if (pageKeysToDelete.length > 0) {
      await database.pages.bulkDelete(pageKeysToDelete);
    }
  });

  await writeStoredCloudRootState({
    rootHash: rootPointer.hash,
    generation: rootPointer.generation,
    syncedAt: new Date().toISOString(),
  });

  return buildSyncResultFromDb(
    rootPointer.hash,
    rootPointer.generation,
    false,
    fetchedMap.size,
    database,
  );
}

/**
 * Mirrors the user's reMarkable Cloud folder/notebook metadata and per-page `.rm` blob hashes
 * into IndexedDB (`Dexie.documents` and `Dexie.pages`) using the native Sync15 protocol.
 */
export async function syncRemarkableCloudTree(
  options: SyncRemarkableTreeOptions = {},
): Promise<CloudTreeSyncResult> {
  const isDefaultRuntime =
    (options.database === undefined || options.database === db) &&
    (options.fetchImpl === undefined || options.fetchImpl === fetch) &&
    !options.forceRefresh;

  if (!isDefaultRuntime) {
    return executeCloudTreeSync(options);
  }

  if (!inflightDefaultSync) {
    inflightDefaultSync = executeCloudTreeSync(options).finally(() => {
      inflightDefaultSync = null;
    });
  }

  return inflightDefaultSync;
}

export interface SaveWhitelistSelectionResult {
  savedWhitelist: SyncWhitelist;
  updatedPagesCount: number;
  pendingPagesCount: number;
}

/**
 * Persists user-selected folder and document UUIDs to `browser.storage.sync` and
 * immediately reconciles local `Dexie.pages` `'Skipped'` <-> `'Pending'` statuses.
 */
export async function saveWhitelistAndReconcilePages(
  whitelist: SyncWhitelist,
  database: RmOneNoteDatabase = db,
): Promise<SaveWhitelistSelectionResult> {
  const [savedWhitelist, prefs, activeDocs] = await Promise.all([
    setWhitelist(whitelist),
    getPreferences(),
    database.documents.toArray(),
  ]);

  const { effectiveDocIdsLower } = computeEffectiveWhitelistedDocIds(
    activeDocs,
    savedWhitelist,
    prefs.autoAddNewFiles,
  );

  const updatedPagesCount = await reconcileWhitelistStatusesInDb(
    effectiveDocIdsLower,
    prefs.syncUnannotatedPdfPages,
    database,
  );
  const pendingPagesCount = await database.pages.where('status').equals('Pending').count();

  return {
    savedWhitelist,
    updatedPagesCount,
    pendingPagesCount,
  };
}
