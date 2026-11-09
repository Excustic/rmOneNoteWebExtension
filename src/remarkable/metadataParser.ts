import type { DocumentRecord, RemarkableItemType } from '../db/models';
import type {
  FileTreeNode,
  NormalizedRemarkableMetadata,
  RawCrdtPageEntry,
  RawRemarkableContent,
  RawRemarkableMetadata,
  ResolvedRemarkablePage,
  Sync15IndexEntry,
} from './types';

const EPOCH_ISO = new Date(0).toISOString();

/**
 * Converts reMarkable's `lastModified` string/number into an ISO 8601 UTC string.
 * Handles the historical firmware bug (`ddvk/rmapi/api/sync15/blobdoc.go`) where
 * nanosecond timestamps (`> 18` digits) were occasionally written instead of milliseconds.
 */
export function normalizeRemarkableTimestamp(rawValue: string | number | undefined): string {
  if (rawValue === undefined || rawValue === null) {
    return EPOCH_ISO;
  }

  const digits = String(rawValue).trim();
  if (!/^\d+$/.test(digits)) {
    return EPOCH_ISO;
  }

  try {
    const epochMs =
      digits.length > 18 ? Number(BigInt(digits) / 1_000_000n) : Number.parseInt(digits, 10);

    if (!Number.isFinite(epochMs) || epochMs <= 0) {
      return EPOCH_ISO;
    }

    const date = new Date(epochMs);
    if (Number.isNaN(date.getTime())) {
      return EPOCH_ISO;
    }
    return date.toISOString();
  } catch {
    return EPOCH_ISO;
  }
}

export function parseDocumentMetadata(rawJson: string): NormalizedRemarkableMetadata {
  const parsed = JSON.parse(rawJson) as RawRemarkableMetadata;

  let normalizedType: RemarkableItemType | 'TemplateType' = 'DocumentType';
  if (parsed.type === 'CollectionType') {
    normalizedType = 'CollectionType';
  } else if (parsed.type === 'TemplateType') {
    normalizedType = 'TemplateType';
  }

  const visibleName =
    typeof parsed.visibleName === 'string' && parsed.visibleName.trim().length > 0
      ? parsed.visibleName.trim()
      : 'Untitled';

  const parent = typeof parsed.parent === 'string' ? parsed.parent.trim() : '';

  return {
    visibleName,
    type: normalizedType,
    parent,
    lastModifiedIso: normalizeRemarkableTimestamp(parsed.lastModified),
    version: typeof parsed.version === 'number' && Number.isFinite(parsed.version) ? parsed.version : 0,
    deleted: Boolean(parsed.deleted),
    pinned: Boolean(parsed.pinned),
  };
}

function isCrdtPageDeleted(entry: RawCrdtPageEntry): boolean {
  if (entry.deleted === undefined || entry.deleted === null) {
    return false;
  }
  if (typeof entry.deleted === 'boolean') {
    return entry.deleted;
  }
  if (typeof entry.deleted === 'object') {
    return entry.deleted.value === undefined || entry.deleted.value !== 0;
  }
  return false;
}

export interface ExtractedContentPages {
  /** Whether `.content` carried an explicit `cPages.pages` or `pages` list. */
  hasExplicitPageList: boolean;
  orderedPageIds: string[];
  /**
   * 0-based PDF page index for each entry in `orderedPageIds` (`null` when the entry
   * is an inserted blank page inside a PDF that has no `redir` target).
   */
  pdfPageIndices: Array<number | null>;
}

/**
 * Extracts ordered, non-deleted page UUIDs from a `.content` JSON payload.
 *
 * - Firmware 3.0+ (`cPages.pages`): filters deleted entries and sorts by CRDT fractional
 *   index `idx.value` in strict code-unit (ASCII) order.
 * - Firmware 2.x (`pages`): preserves array display order.
 */
export function extractOrderedPageIdsFromContent(rawJson: string): string[] {
  return parseContentPageList(rawJson).orderedPageIds;
}

function parseContentPageList(rawJson: string): ExtractedContentPages {
  const parsed = JSON.parse(rawJson) as RawRemarkableContent;

  if (parsed.cPages && Array.isArray(parsed.cPages.pages)) {
    const indexed = parsed.cPages.pages
      .map((entry, originalOrder) => ({ entry, originalOrder }))
      .filter(
        ({ entry }) =>
          typeof entry.id === 'string' && entry.id.trim().length > 0 && !isCrdtPageDeleted(entry),
      );

    indexed.sort((a, b) => {
      const aIdx = a.entry.idx?.value ?? '';
      const bIdx = b.entry.idx?.value ?? '';
      if (aIdx < bIdx) return -1;
      if (aIdx > bIdx) return 1;
      return a.originalOrder - b.originalOrder;
    });

    const hasExplicitRedir = indexed.some(
      ({ entry }) => typeof entry.redir?.value === 'number' && Number.isFinite(entry.redir.value),
    );

    return {
      hasExplicitPageList: true,
      orderedPageIds: indexed.map(({ entry }) => entry.id!.trim()),
      pdfPageIndices: indexed.map(({ entry }, i) => {
        if (hasExplicitRedir) {
          const redirVal = entry.redir?.value;
          return typeof redirVal === 'number' && Number.isInteger(redirVal) && redirVal >= 0
            ? redirVal
            : null;
        }
        return i;
      }),
    };
  }

  if (Array.isArray(parsed.pages)) {
    const ids: string[] = [];
    const pdfPageIndices: Array<number | null> = [];
    const redirMap = Array.isArray(parsed.redirectionPageMap) ? parsed.redirectionPageMap : null;

    for (let i = 0; i < parsed.pages.length; i++) {
      const item = parsed.pages[i];
      let pageId = '';
      if (typeof item === 'string' && item.trim().length > 0) {
        pageId = item.trim();
      } else if (typeof item === 'object' && item !== null && typeof item.id === 'string') {
        pageId = item.id.trim();
      }

      if (pageId.length > 0) {
        const positionIndex = ids.length;
        ids.push(pageId);
        if (redirMap) {
          const mapped = redirMap[i];
          pdfPageIndices.push(
            typeof mapped === 'number' && Number.isInteger(mapped) && mapped >= 0 ? mapped : null,
          );
        } else {
          pdfPageIndices.push(positionIndex);
        }
      }
    }
    return {
      hasExplicitPageList: true,
      orderedPageIds: ids,
      pdfPageIndices,
    };
  }

  return {
    hasExplicitPageList: false,
    orderedPageIds: [],
    pdfPageIndices: [],
  };
}

/**
 * Resolves active `.rm` stroke pages for a document by combining `.content` page ordering
 * with `<docId>/<pageId>.rm` entries from `<docId>.docSchema`.
 *
 * Page numbers (`"1"`, `"2"`, ...) reflect the user-visible 1-based page position in `.content`
 * so annotated PDFs preserve their true page numbers even when unannotated pages have no `.rm` file.
 */
export function resolveDocumentRmPages(
  documentId: string,
  docSchemaEntries: readonly Sync15IndexEntry[],
  rawContentJson: string | null,
): ResolvedRemarkablePage[] {
  const rmPrefix = `${documentId}/`;
  const rmSuffix = '.rm';
  const pdfTarget = `${documentId}.pdf`;
  const pdfEntry = docSchemaEntries.find((entry) => entry.id === pdfTarget);
  const pdfBlobHash = pdfEntry ? pdfEntry.hash : null;

  const rmEntriesByPageId = new Map<string, Sync15IndexEntry>();
  for (const entry of docSchemaEntries) {
    if (entry.id.startsWith(rmPrefix) && entry.id.endsWith(rmSuffix)) {
      const pageId = entry.id.slice(rmPrefix.length, entry.id.length - rmSuffix.length).trim();
      if (pageId.length > 0) {
        rmEntriesByPageId.set(pageId, entry);
      }
    }
  }

  if (rmEntriesByPageId.size === 0) {
    return [];
  }

  const { hasExplicitPageList, orderedPageIds, pdfPageIndices } = rawContentJson
    ? parseContentPageList(rawContentJson)
    : { hasExplicitPageList: false, orderedPageIds: [], pdfPageIndices: [] };

  const resolved: ResolvedRemarkablePage[] = [];
  const seenPageIds = new Set<string>();

  for (let i = 0; i < orderedPageIds.length; i++) {
    const pageId = orderedPageIds[i];
    if (seenPageIds.has(pageId)) {
      continue;
    }
    seenPageIds.add(pageId);

    const rmEntry = rmEntriesByPageId.get(pageId);
    if (!rmEntry) {
      continue;
    }

    const pageNumber = String(i + 1);
    const pdfPageIndex =
      pdfBlobHash !== null ? (pdfPageIndices[i] !== undefined ? pdfPageIndices[i] : i) : null;
    resolved.push({
      pageId,
      pageNumber,
      title: `Page ${pageNumber}`,
      rmBlobHash: rmEntry.hash,
      fileSizeBytes: rmEntry.size,
      ...(pdfBlobHash !== null
        ? {
            pdfBlobHash,
            pdfPageIndex,
          }
        : {}),
    });
  }

  // Fallback ONLY when `.content` is completely absent or lacks any `cPages.pages` / `pages` array.
  if (!hasExplicitPageList) {
    let fallbackNumber = 1;
    for (const [pageId, rmEntry] of rmEntriesByPageId.entries()) {
      const zeroBasedIndex = fallbackNumber - 1;
      const pageNumber = String(fallbackNumber++);
      resolved.push({
        pageId,
        pageNumber,
        title: `Page ${pageNumber}`,
        rmBlobHash: rmEntry.hash,
        fileSizeBytes: rmEntry.size,
        ...(pdfBlobHash !== null
          ? {
              pdfBlobHash,
              pdfPageIndex: zeroBasedIndex,
            }
          : {}),
      });
    }
  }

  return resolved;
}

export function isItemInTrash<T extends { documentId: string; parent: string }>(
  item: T,
  itemMap: ReadonlyMap<string, T>,
): boolean {
  const visited = new Set<string>();
  let current: T | undefined = item;

  while (current) {
    const idLower = current.documentId.toLowerCase();
    const parentLower = current.parent.toLowerCase();
    if (idLower === 'trash' || parentLower === 'trash') {
      return true;
    }
    if (!current.parent || visited.has(current.documentId)) {
      break;
    }
    visited.add(current.documentId);
    current = itemMap.get(current.parent);
  }

  return false;
}

function sortTreeNodesInPlace(nodes: FileTreeNode[]): void {
  nodes.sort((a, b) => {
    const aIsFolder = a.type === 'CollectionType';
    const bIsFolder = b.type === 'CollectionType';
    if (aIsFolder !== bIsFolder) {
      return aIsFolder ? -1 : 1;
    }
    return a.visibleName.localeCompare(b.visibleName, undefined, { sensitivity: 'base' });
  });

  for (const node of nodes) {
    if (node.children.length > 0) {
      sortTreeNodesInPlace(node.children);
    }
  }
}

function assignVirtualPathsInPlace(nodes: FileTreeNode[], parentPath: string): void {
  for (const node of nodes) {
    const nextPath = parentPath ? `${parentPath}/${node.visibleName}` : node.visibleName;
    node.virtualPath = nextPath;
    if (node.children.length > 0) {
      assignVirtualPathsInPlace(node.children, nextPath);
    }
  }
}

/**
 * Builds a sorted, trash-filtered `FileTreeNode[]` hierarchy from flat `DocumentRecord` items
 * and populates each node's `virtualPath` (`"Folder A/Subfolder B/Notebook Name"`).
 */
export function buildFileTreeHierarchy(records: readonly DocumentRecord[]): FileTreeNode[] {
  const recordMap = new Map<string, DocumentRecord>();
  for (const rec of records) {
    recordMap.set(rec.documentId, rec);
  }

  const activeRecords = records.filter((rec) => !isItemInTrash(rec, recordMap));
  const nodeMap = new Map<string, FileTreeNode>();

  for (const rec of activeRecords) {
    nodeMap.set(rec.documentId, {
      id: rec.documentId,
      visibleName: rec.visibleName,
      type: rec.type,
      parent: rec.parent,
      virtualPath: rec.virtualPath,
      lastModified: rec.lastModified,
      children: [],
    });
  }

  const roots: FileTreeNode[] = [];

  for (const node of nodeMap.values()) {
    if (!node.parent) {
      roots.push(node);
      continue;
    }
    const parentNode = nodeMap.get(node.parent);
    if (parentNode && parentNode.type === 'CollectionType' && parentNode.id !== node.id) {
      parentNode.children.push(node);
    } else {
      roots.push(node);
    }
  }

  sortTreeNodesInPlace(roots);
  assignVirtualPathsInPlace(roots, '');
  return roots;
}

/**
 * Flattens a `FileTreeNode[]` hierarchy into a `documentId -> virtualPath` lookup map.
 */
export function collectVirtualPaths(roots: readonly FileTreeNode[]): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (nodes: readonly FileTreeNode[]) => {
    for (const node of nodes) {
      map.set(node.id, node.virtualPath);
      if (node.children.length > 0) {
        walk(node.children);
      }
    }
  };
  walk(roots);
  return map;
}
