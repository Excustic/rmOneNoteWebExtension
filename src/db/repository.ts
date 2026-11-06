import { db, type RmOneNoteDatabase } from './db';
import {
  type DocumentRecord,
  type NotebookCacheRecord,
  type OneNoteSectionCacheEntry,
  type PageRecord,
  type PageSyncStatus,
  TRANSIENT_PAGE_STATUSES,
} from './models';

export interface UpdatePageStatusOptions {
  lastError?: string | null;
  oneNotePageId?: string | null;
  oneNotePageUrl?: string | null;
  syncedAtIso?: string;
}

/**
 * Upserts the reMarkable Cloud file/folder tree without overwriting locally resolved
 * `oneNoteNotebookUrl` links on existing documents.
 */
export async function upsertFileTree(
  incomingDocs: readonly DocumentRecord[],
  database: RmOneNoteDatabase = db,
): Promise<void> {
  if (incomingDocs.length === 0) {
    return;
  }

  await database.transaction('rw', database.documents, async () => {
    const ids = incomingDocs.map((doc) => doc.documentId);
    const existingList = await database.documents.bulkGet(ids);

    const merged: DocumentRecord[] = incomingDocs.map((incoming, index) => {
      const existing = existingList[index];
      if (!existing) {
        return incoming;
      }

      const newerLastModified =
        incoming.lastModified >= existing.lastModified
          ? incoming.lastModified
          : existing.lastModified;

      return {
        ...incoming,
        virtualPath: incoming.virtualPath || existing.virtualPath,
        lastModified: newerLastModified,
        oneNoteNotebookUrl: incoming.oneNoteNotebookUrl ?? existing.oneNoteNotebookUrl,
      };
    });

    await database.documents.bulkPut(merged);
  });
}

export async function getDocument(
  documentId: string,
  database: RmOneNoteDatabase = db,
): Promise<DocumentRecord | undefined> {
  return database.documents.get(documentId);
}

export async function getAllDocuments(
  database: RmOneNoteDatabase = db,
): Promise<DocumentRecord[]> {
  const docs = await database.documents.toArray();
  return docs.sort((a, b) => a.visibleName.localeCompare(b.visibleName));
}

export async function setDocumentOneNoteUrl(
  documentId: string,
  oneNoteNotebookUrl: string,
  database: RmOneNoteDatabase = db,
): Promise<void> {
  await database.documents.update(documentId, { oneNoteNotebookUrl });
}

export async function getPage(
  documentId: string,
  pageId: string,
  database: RmOneNoteDatabase = db,
): Promise<PageRecord | undefined> {
  return database.pages.get([documentId, pageId]);
}

export async function getDocumentPages(
  documentId: string,
  database: RmOneNoteDatabase = db,
): Promise<PageRecord[]> {
  return database.pages.where('documentId').equals(documentId).toArray();
}

export async function getPendingPages(
  limit = 100,
  database: RmOneNoteDatabase = db,
): Promise<PageRecord[]> {
  const pending = await database.pages.where('status').equals('Pending').toArray();
  pending.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  return pending.slice(0, limit);
}

export async function getRecentPages(
  limit = 100,
  database: RmOneNoteDatabase = db,
): Promise<PageRecord[]> {
  return database.pages.orderBy('lastModified').reverse().limit(limit).toArray();
}

export async function getPagesByStatus(
  status: PageSyncStatus,
  database: RmOneNoteDatabase = db,
): Promise<PageRecord[]> {
  return database.pages.where('status').equals(status).toArray();
}

export async function getIndexedPageCount(database: RmOneNoteDatabase = db): Promise<number> {
  return database.pages.count();
}

export async function savePage(
  page: PageRecord,
  database: RmOneNoteDatabase = db,
): Promise<void> {
  await database.pages.put(page);
}

export async function updatePageStatus(
  documentId: string,
  pageId: string,
  status: PageSyncStatus,
  options: UpdatePageStatusOptions = {},
  database: RmOneNoteDatabase = db,
): Promise<void> {
  await database.transaction('rw', database.pages, async () => {
    const existing = await database.pages.get([documentId, pageId]);
    if (!existing) {
      return;
    }

    const updated: PageRecord = {
      ...existing,
      status,
      lastError: options.lastError !== undefined ? options.lastError : null,
      lastSyncTime:
        status === 'Uploaded'
          ? (options.syncedAtIso ?? new Date().toISOString())
          : existing.lastSyncTime,
      oneNotePageId:
        options.oneNotePageId !== undefined ? options.oneNotePageId : existing.oneNotePageId,
      oneNotePageUrl:
        options.oneNotePageUrl !== undefined ? options.oneNotePageUrl : existing.oneNotePageUrl,
      retryCount: status === 'Failed' ? existing.retryCount + 1 : existing.retryCount,
    };

    await database.pages.put(updated);
  });
}

/**
 * Resets any transient in-flight page statuses (`Queued`, `Converting`, `Uploading`, `Indexing`)
 * back to `Pending` when the MV3 background worker restarts after termination.
 */
export async function resetInProgressPages(
  database: RmOneNoteDatabase = db,
): Promise<number> {
  return database.transaction('rw', database.pages, async () => {
    const stuck = await database.pages
      .where('status')
      .anyOf([...TRANSIENT_PAGE_STATUSES])
      .toArray();

    if (stuck.length === 0) {
      return 0;
    }

    const resetRecords = stuck.map((page) => ({
      ...page,
      status: 'Pending' as const,
    }));
    await database.pages.bulkPut(resetRecords);
    return resetRecords.length;
  });
}

export async function getCachedNotebookByName(
  displayName: string,
  database: RmOneNoteDatabase = db,
): Promise<NotebookCacheRecord | undefined> {
  return database.notebooks.where('displayName').equals(displayName).first();
}

export async function upsertCachedNotebook(
  notebook: {
    oneNoteNotebookId: string;
    displayName: string;
    webUrl: string | null;
    sections?: Record<string, OneNoteSectionCacheEntry>;
  },
  database: RmOneNoteDatabase = db,
): Promise<NotebookCacheRecord> {
  return database.transaction('rw', database.notebooks, async () => {
    const existing = await database.notebooks.get(notebook.oneNoteNotebookId);
    const merged: NotebookCacheRecord = {
      oneNoteNotebookId: notebook.oneNoteNotebookId,
      displayName: notebook.displayName,
      webUrl: notebook.webUrl ?? existing?.webUrl ?? null,
      sections: {
        ...(existing?.sections ?? {}),
        ...(notebook.sections ?? {}),
      },
      updatedAt: new Date().toISOString(),
    };

    await database.notebooks.put(merged);
    return merged;
  });
}

export async function upsertCachedSection(
  oneNoteNotebookId: string,
  section: OneNoteSectionCacheEntry,
  database: RmOneNoteDatabase = db,
): Promise<void> {
  await database.transaction('rw', database.notebooks, async () => {
    const existing = await database.notebooks.get(oneNoteNotebookId);
    if (!existing) {
      return;
    }

    await database.notebooks.put({
      ...existing,
      sections: {
        ...existing.sections,
        [section.displayName]: section,
      },
      updatedAt: new Date().toISOString(),
    });
  });
}

export async function clearAllCache(database: RmOneNoteDatabase = db): Promise<void> {
  await database.transaction('rw', [database.documents, database.pages, database.notebooks], async () => {
    await database.pages.clear();
    await database.documents.clear();
    await database.notebooks.clear();
  });
}

export async function resetDatabase(database: RmOneNoteDatabase = db): Promise<void> {
  database.close();
  await database.delete();
  await database.open();
}
