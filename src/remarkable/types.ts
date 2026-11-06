import type { RemarkableItemType } from '../db/models';

export const REMARKABLE_SYNC_HOST = 'https://internal.cloud.remarkable.com';
export const REMARKABLE_SYNC_ROOT_URL = `${REMARKABLE_SYNC_HOST}/sync/v4/root`;
export const REMARKABLE_SYNC_FILES_URL = `${REMARKABLE_SYNC_HOST}/sync/v3/files`;

/**
 * Response returned by `GET /sync/v4/root`.
 */
export interface Sync15RootPointer {
  hash: string;
  generation: number;
  schemaVersion?: number;
}

/**
 * Single parsed entry from a Sync15 `.docSchema` text index (`v3` or `v4`).
 */
export interface Sync15IndexEntry {
  /** SHA-256 hex digest of the referenced blob or sub-index. */
  hash: string;
  /** `"80000000"` for document sub-indexes in `root.docSchema`; `"0"` for regular file blobs. */
  entryType: string;
  /** Document UUID in `root.docSchema`, or logical file path (`<docId>.metadata`, `<docId>/<pageId>.rm`) inside `<docId>.docSchema`. */
  id: string;
  /** Count of child blobs (`0` for regular file blobs). */
  subfiles: number;
  /** Uncompressed byte size reported by the index. */
  size: number;
}

export interface ParsedSync15Index {
  schemaVersion: 3 | 4;
  entries: Sync15IndexEntry[];
}

/**
 * Raw `.metadata` JSON stored for each reMarkable document or folder.
 */
export interface RawRemarkableMetadata {
  visibleName?: string;
  type?: string;
  parent?: string;
  lastModified?: string | number;
  version?: number;
  deleted?: boolean;
  pinned?: boolean;
  lastOpenedPage?: number;
}

export interface NormalizedRemarkableMetadata {
  visibleName: string;
  type: RemarkableItemType | 'TemplateType';
  parent: string;
  /** ISO 8601 UTC string. */
  lastModifiedIso: string;
  version: number;
  deleted: boolean;
  pinned: boolean;
}

export interface CrdtTimestampedValue<T> {
  timestamp?: string;
  value?: T;
}

export interface RawCrdtPageEntry {
  id?: string;
  idx?: CrdtTimestampedValue<string>;
  deleted?: CrdtTimestampedValue<number> | boolean | null;
  template?: CrdtTimestampedValue<string>;
}

/**
 * Subset of `.content` JSON needed to determine ordered, non-deleted notebook pages.
 */
export interface RawRemarkableContent {
  fileType?: string;
  formatVersion?: number;
  pageCount?: number;
  pages?: Array<string | { id?: string }> | null;
  redirectionPageMap?: number[];
  cPages?: {
    pages?: RawCrdtPageEntry[] | null;
  } | null;
}

/**
 * Active page matched against a `<docId>/<pageId>.rm` stroke blob in `<docId>.docSchema`.
 */
export interface ResolvedRemarkablePage {
  pageId: string;
  /** 1-based user-visible page number (`"1"`, `"2"`, ...). */
  pageNumber: string;
  /** `"Page 1"`, `"Page 2"`, ... */
  title: string;
  /** Sync15 SHA-256 blob hash of `<docId>/<pageId>.rm`. */
  rmBlobHash: string;
  fileSizeBytes: number;
}

/**
 * Hierarchical folder/notebook node rendered in `FileBrowserView`.
 */
export interface FileTreeNode {
  id: string;
  visibleName: string;
  type: RemarkableItemType;
  parent: string;
  virtualPath: string;
  lastModified: string;
  children: FileTreeNode[];
}

/**
 * Summary returned by `syncRemarkableCloudTree`.
 */
export interface CloudTreeSyncResult {
  rootHash: string;
  generation: number;
  upToDate: boolean;
  totalItems: number;
  folderCount: number;
  documentCount: number;
  changedDocuments: number;
  indexedPagesCount: number;
  pendingPagesCount: number;
}
