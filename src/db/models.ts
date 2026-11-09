export type RemarkableItemType = 'DocumentType' | 'CollectionType';

/**
 * Cached metadata for a reMarkable Cloud notebook (`DocumentType`) or folder (`CollectionType`).
 * Stored locally in IndexedDB (`Dexie.documents`).
 */
export interface DocumentRecord {
  documentId: string;
  visibleName: string;
  type: RemarkableItemType;
  /** Parent folder UUID, `"trash"` for trashed items, or `""` for root items. */
  parent: string;
  virtualPath: string;
  /** Cloud revision / hash used to detect modified notebooks before downloading `.zip` blobs. */
  cloudVersion: number;
  contentHash: string;
  /** ISO 8601 UTC timestamp. */
  lastModified: string;
  /** Cached OneNote web/client URL once the target notebook is resolved. */
  oneNoteNotebookUrl: string | null;
  /** Optional Sync15 SHA-256 blob hash of `<documentId>.pdf` when the document is a PDF. */
  pdfBlobHash?: string | null;
}

export type PageSyncStatus =
  | 'Pending'
  | 'Queued'
  | 'Converting'
  | 'Uploading'
  | 'Indexing'
  | 'Uploaded'
  | 'Failed'
  | 'Skipped'
  | 'Deleted';

/**
 * Statuses indicating an active sync operation that was interrupted if the MV3
 * background worker was terminated mid-flight.
 */
export const TRANSIENT_PAGE_STATUSES: readonly PageSyncStatus[] = [
  'Queued',
  'Converting',
  'Uploading',
  'Indexing',
] as const;

/**
 * Per-page synchronization state stored locally in IndexedDB (`Dexie.pages`).
 * Keyed by composite primary key `[documentId, pageId]`.
 */
export interface PageRecord {
  documentId: string;
  pageId: string;
  pageNumber: string;
  title: string;
  virtualPath: string;
  fileSizeBytes: number;
  /** ISO 8601 UTC timestamp of the page modification on reMarkable. */
  lastModified: string;
  contentHash: string;
  status: PageSyncStatus;
  /** ISO 8601 UTC timestamp of the last verified OneNote upload. */
  lastSyncTime: string | null;
  oneNotePageId: string | null;
  oneNotePageUrl: string | null;
  retryCount: number;
  lastError: string | null;
  /** Optional Sync15 SHA-256 blob hash of `<documentId>.pdf` if backed by a PDF. */
  pdfBlobHash?: string | null;
  /** 0-based page index inside `<documentId>.pdf`, or `null` for non-PDF / inserted blank pages. */
  pdfPageIndex?: number | null;
  /**
   * Original page number when first uploaded or when retained under the 'preserve' strategy,
   * used to render visual move cues (e.g. `Moved: Page 9 -> Page 3`).
   */
  originalPageNumber?: string | null;
  /**
   * Fast-path flag indicating the page ink strokes are unchanged and only its OneNote page title
   * needs to be renamed in Microsoft Graph (`PATCH /pages/{id}/content`).
   */
  titleRenameOnly?: boolean;
}

export interface OneNoteSectionCacheEntry {
  sectionId: string;
  displayName: string;
}

/**
 * Local IndexedDB cache of resolved OneNote notebooks and their sections (`Dexie.notebooks`).
 * Replaces the in-memory `ConcurrentDictionary` caches from the desktop daemon so MV3
 * service worker restarts do not repeatedly list/create notebooks on Microsoft Graph.
 */
export interface NotebookCacheRecord {
  oneNoteNotebookId: string;
  displayName: string;
  webUrl: string | null;
  /** Map keyed by sanitized OneNote section `displayName` (max 49 chars). */
  sections: Record<string, OneNoteSectionCacheEntry>;
  /** ISO 8601 UTC timestamp. */
  updatedAt: string;
}

export const DATABASE_BACKUP_SCHEMA_VERSION = 1 as const;

/**
 * Portable JSON backup format allowing users to transfer full local sync history
 * to a newly installed browser when `storage.sync` rolling ledger evictions > 0.
 */
export interface DatabaseBackupPayload {
  schemaVersion: typeof DATABASE_BACKUP_SCHEMA_VERSION;
  exportedAt: string;
  documents: DocumentRecord[];
  pages: PageRecord[];
  notebooks: NotebookCacheRecord[];
}

const INVALID_ONENOTE_CHARS = /[\\/:*?"<>|]/g;
export const MAX_ONENOTE_SECTION_NAME_LENGTH = 49;

export function sanitizeOneNoteName(name: string): string {
  return name.replace(INVALID_ONENOTE_CHARS, '_').trim();
}

/**
 * Translates a reMarkable virtual path (e.g. `"Academy/Semester A/Calculus 1/Page 1"`)
 * into the deterministic `rm_...` OneNote notebook name used by the legacy C# client.
 */
export function deriveOneNoteNotebookName(virtualPath: string, fallbackName = ''): string {
  if (!virtualPath.trim()) {
    return fallbackName || 'rm_Uncategorized';
  }

  const parts = virtualPath
    .split(/[\\/]/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    return 'rm_Uncategorized';
  }
  if (parts.length === 2) {
    return `rm_${sanitizeOneNoteName(parts[0])}`;
  }

  const folderSegments = parts.slice(0, -2).map(sanitizeOneNoteName);
  return `rm_${folderSegments.join('_')}`;
}

