import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DocumentRecord, PageRecord } from '../../db/models';
import {
  buildFileTreeHierarchy,
  deriveInitialSelectionMap,
  extractWhitelistFromSelection,
  type FileTreeNode,
  formatFolderItemCount,
  formatSelectionSummary,
  getFolderSubtreeCounts,
  getNodeSelectionState,
  type SelectionMap,
  toggleNodeSelection,
} from '../../remarkable';
import { ext } from '../../shared/browser';
import { LegacyIcon } from '../../shared/legacyIcons';
import type { RuntimeResponse, SyncOverviewState } from '../../shared/messaging';
import { onSyncStorageChanged } from '../../storage/preferences';
import {
  formatFileSize,
  formatSyncTimestamp,
  isPageActivelySyncing,
  mapPageStatusToVisualState,
  SyncStatusBadge,
  SyncStatusIcon,
  type VisualSyncState,
} from '../components/SyncStatusIcon';
import { useDataSource } from '../context/DataSourceContext';

interface SyncControlViewProps {
  overview: SyncOverviewState;
  currentTourStepId?: string;
  onOpenSetup: () => void;
  onSyncStateChanged: (nextOverview?: SyncOverviewState) => void;
}

interface NodeSyncRollup {
  visualState: VisualSyncState;
  lastSyncedAt: string | null;
  oneNoteUrl: string | null;
  totalPages: number;
  uploadedPages: number;
  pendingPages: number;
  failedPages: number;
  activePages: number;
  isOutOfDate: boolean;
}

const EMPTY_ROLLUP: NodeSyncRollup = {
  visualState: 'idle',
  lastSyncedAt: null,
  oneNoteUrl: null,
  totalPages: 0,
  uploadedPages: 0,
  pendingPages: 0,
  failedPages: 0,
  activePages: 0,
  isOutOfDate: false,
};

const REMARKABLE_HOST_ORIGINS = [
  'https://webapp-prod.cloud.remarkable.engineering/*',
  'https://internal.cloud.remarkable.com/*',
  'https://*.storage.googleapis.com/*',
];

const MICROSOFT_GRAPH_ORIGINS = [
  'https://graph.microsoft.com/*',
  'https://login.microsoftonline.com/*',
];

function requestHostOriginsFromGesture(origins: string[]): Promise<boolean> {
  if (ext.permissions && typeof ext.permissions.request === 'function') {
    return ext.permissions.request({ origins });
  }
  return Promise.resolve(true);
}

function collectAllFolderIds(nodes: readonly FileTreeNode[]): string[] {
  const ids: string[] = [];
  const walk = (list: readonly FileTreeNode[]) => {
    for (const node of list) {
      if (node.type === 'CollectionType' && node.children.length > 0) {
        ids.push(node.id);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return ids;
}

function collectSubtreeDocumentIds(
  node: FileTreeNode,
  selectionMap?: Readonly<SelectionMap>,
): string[] {
  const allDocIds: string[] = [];
  const selectedDocIds: string[] = [];

  const walk = (current: FileTreeNode) => {
    if (current.type !== 'CollectionType') {
      allDocIds.push(current.id);
      if (selectionMap && getNodeSelectionState(selectionMap, current.id) === true) {
        selectedDocIds.push(current.id);
      }
      return;
    }
    for (const child of current.children) {
      walk(child);
    }
  };

  walk(node);
  return selectedDocIds.length > 0 ? selectedDocIds : allDocIds;
}

export function computeRollupForPages(
  pages: readonly PageRecord[],
  docOneNoteUrl?: string | null,
  docLastModified?: string | null,
): NodeSyncRollup {
  // Exclude tablet-deleted pages from the tree badges and document rollup
  const activePagesList = pages.filter((p) => p.status !== 'Deleted');
  if (activePagesList.length === 0) {
    return {
      ...EMPTY_ROLLUP,
      oneNoteUrl: docOneNoteUrl ?? null,
    };
  }

  let uploadedPages = 0;
  let pendingPages = 0;
  let failedPages = 0;
  let activePages = 0;
  let latestSyncMs = 0;
  let lastSyncedAt: string | null = null;
  let latestOneNoteUrl: string | null = docOneNoteUrl ?? null;
  let anyPageOutOfDate = false;

  for (const page of activePagesList) {
    const vState = mapPageStatusToVisualState(page.status);
    if (vState === 'uploading') {
      activePages++;
    } else if (vState === 'failed') {
      failedPages++;
    } else if (vState === 'pending') {
      pendingPages++;
    } else if (vState === 'uploaded') {
      uploadedPages++;
    }

    if (page.lastSyncTime) {
      const ms = Date.parse(page.lastSyncTime);
      if (!Number.isNaN(ms) && ms >= latestSyncMs) {
        latestSyncMs = ms;
        lastSyncedAt = page.lastSyncTime;
        if (page.oneNotePageUrl) {
          latestOneNoteUrl = page.oneNotePageUrl;
        }
      }

      const modMs = Date.parse(page.lastModified);
      if (!Number.isNaN(modMs) && modMs > ms + 1000) {
        anyPageOutOfDate = true;
      }
    }
    if (!latestOneNoteUrl && page.oneNotePageUrl) {
      latestOneNoteUrl = page.oneNotePageUrl;
    }
  }

  const isDocModifiedAfterSync = Boolean(
    lastSyncedAt &&
    docLastModified &&
    Date.parse(docLastModified) > Date.parse(lastSyncedAt) + 1000,
  );

  const isOutOfDate = Boolean(
    (lastSyncedAt !== null && (isDocModifiedAfterSync || anyPageOutOfDate)) ||
    (lastSyncedAt !== null && pendingPages > 0),
  );

  let visualState: VisualSyncState = 'idle';
  if (activePages > 0) {
    visualState = 'uploading';
  } else if (failedPages > 0) {
    visualState = 'failed';
  } else if (pendingPages > 0) {
    visualState = 'pending';
  } else if (uploadedPages > 0) {
    visualState = 'uploaded';
  }

  return {
    visualState,
    lastSyncedAt,
    oneNoteUrl: latestOneNoteUrl,
    totalPages: activePagesList.length,
    uploadedPages,
    pendingPages,
    failedPages,
    activePages,
    isOutOfDate,
  };
}

function buildRollupMap(
  roots: readonly FileTreeNode[],
  pagesByDocId: ReadonlyMap<string, PageRecord[]>,
  docsById: ReadonlyMap<string, DocumentRecord>,
): Map<string, NodeSyncRollup> {
  const map = new Map<string, NodeSyncRollup>();

  const collectFolderPages = (node: FileTreeNode): PageRecord[] => {
    if (node.type !== 'CollectionType') {
      const docPages = pagesByDocId.get(node.id) ?? [];
      const docMeta = docsById.get(node.id);
      map.set(
        node.id,
        computeRollupForPages(docPages, docMeta?.oneNoteNotebookUrl, docMeta?.lastModified),
      );
      return docPages;
    }

    const combined: PageRecord[] = [];
    for (const child of node.children) {
      combined.push(...collectFolderPages(child));
    }
    map.set(node.id, computeRollupForPages(combined, null, null));
    return combined;
  };

  for (const root of roots) {
    collectFolderPages(root);
  }

  return map;
}

function filterTreeByQuery(
  nodes: readonly FileTreeNode[],
  queryLower: string,
): FileTreeNode[] {
  if (!queryLower) {
    return [...nodes];
  }

  const result: FileTreeNode[] = [];
  for (const node of nodes) {
    const matchesSelf =
      node.visibleName.toLowerCase().includes(queryLower) ||
      node.virtualPath.toLowerCase().includes(queryLower);

    if (node.type === 'CollectionType') {
      const filteredChildren = filterTreeByQuery(node.children, queryLower);
      if (matchesSelf || filteredChildren.length > 0) {
        result.push({
          ...node,
          children: matchesSelf ? node.children : filteredChildren,
        });
      }
    } else if (matchesSelf) {
      result.push(node);
    }
  }
  return result;
}

function findNodeById(
  nodes: readonly FileTreeNode[],
  targetId: string,
): FileTreeNode | null {
  for (const node of nodes) {
    if (node.id === targetId) {
      return node;
    }
    if (node.children.length > 0) {
      const found = findNodeById(node.children, targetId);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

interface TreeNodeRowProps {
  node: FileTreeNode;
  depth: number;
  baseId: string;
  selectionMap: Readonly<SelectionMap>;
  rollupMap: ReadonlyMap<string, NodeSyncRollup>;
  expandedIds: ReadonlySet<string>;
  inspectedDocId: string | null;
  disabled: boolean;
  isSyncingEngine: boolean;
  onToggleCheckbox: (node: FileTreeNode) => void;
  onToggleExpand: (folderId: string) => void;
  onToggleSubtreeExpand: (folderNode: FileTreeNode) => void;
  onInspectDocument: (docNode: FileTreeNode) => void;
  onManualSyncNode: (node: FileTreeNode) => void;
}

function TreeNodeRow({
  node,
  depth,
  baseId,
  selectionMap,
  rollupMap,
  expandedIds,
  inspectedDocId,
  disabled,
  isSyncingEngine,
  onToggleCheckbox,
  onToggleExpand,
  onToggleSubtreeExpand,
  onInspectDocument,
  onManualSyncNode,
}: TreeNodeRowProps) {
  const isFolder = node.type === 'CollectionType';
  const hasChildren = isFolder && node.children.length > 0;
  const hasChildFolders =
    hasChildren &&
    node.children.some((c) => c.type === 'CollectionType' && c.children.length > 0);
  const isExpanded = expandedIds.has(node.id);
  const state = getNodeSelectionState(selectionMap, node.id);
  const isInspected = !isFolder && inspectedDocId === node.id;

  const checkboxId = `${baseId}-cb-${node.id}`;
  const labelTextId = `${baseId}-lbl-${node.id}`;
  const groupId = `${baseId}-grp-${node.id}`;
  const itemCountText = formatFolderItemCount(node);
  const folderCounts = useMemo(
    () => (isFolder ? getFolderSubtreeCounts(node, selectionMap) : null),
    [isFolder, node, selectionMap],
  );
  const rollup = rollupMap.get(node.id) ?? EMPTY_ROLLUP;

  return (
    <div>
      <div
        data-nested={depth > 0 ? 'true' : undefined}
        className={`tree-guide-row flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1 transition-colors ${isInspected
          ? 'bg-blue-50/90 ring-1 ring-blue-300'
          : 'hover:bg-slate-100/80'
          }`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {hasChildren ? (
            <button
              type="button"
              data-tour={isFolder && depth === 0 ? 'sync-control-folder-expand' : undefined}
              aria-expanded={isExpanded}
              aria-controls={groupId}
              aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${node.visibleName}`}
              onClick={() => onToggleExpand(node.id)}
              className="inline-flex min-h-9 min-w-7 shrink-0 items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-800"
            >
              <LegacyIcon
                name="chevronDown"
                className={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-0' : '-rotate-90'
                  }`}
              />
            </button>
          ) : (
            <span className="inline-block w-7 shrink-0" aria-hidden="true" />
          )}

          <input
            ref={(el) => {
              if (el) {
                el.indeterminate = state === null;
              }
            }}
            id={checkboxId}
            data-tour={isFolder && depth === 0 ? 'sync-control-folder-checkbox' : undefined}
            type="checkbox"
            checked={state === true}
            disabled={disabled}
            aria-label={`Select ${node.visibleName} for automatic sync`}
            onChange={() => onToggleCheckbox(node)}
            className="checkbox-custom text-base"
          />

          <button
            type="button"
            data-tour={!isFolder && node.visibleName === 'Calculus 1' ? 'sync-control-doc-row' : undefined}
            onClick={() => {
              if (isFolder) {
                if (hasChildren) {
                  onToggleExpand(node.id);
                }
              } else {
                onInspectDocument(node);
              }
            }}
            aria-pressed={!isFolder ? isInspected : undefined}
            className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left transition-colors focus-visible:outline-2"
          >
            <LegacyIcon
              name={isFolder ? 'folder' : 'notebook'}
              className={`h-4 w-4 shrink-0 ${isFolder ? 'text-amber-500' : 'text-violet-500'
                }`}
            />
            <span
              id={labelTextId}
              title={node.visibleName}
              className={`truncate text-sm font-medium ${isInspected ? 'text-brand font-semibold' : 'text-slate-900'
                }`}
            >
              {node.visibleName}
            </span>

            {isFolder && itemCountText ? (
              <span className="shrink-0 text-xs text-slate-500">{itemCountText}</span>
            ) : null}

            {isFolder && folderCounts && folderCounts.totalDocuments > 0 ? (
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${folderCounts.selectedDocuments > 0
                  ? 'bg-blue-100 text-blue-800'
                  : 'bg-slate-100 text-slate-600'
                  }`}
              >
                {folderCounts.selectedDocuments}/{folderCounts.totalDocuments} selected
              </span>
            ) : null}

            {!isFolder && rollup.totalPages > 0 ? (
              <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
                {rollup.totalPages} {rollup.totalPages === 1 ? 'page' : 'pages'}
              </span>
            ) : null}

            {!isFolder && rollup.isOutOfDate ? (
              <span
                className="shrink-0 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
                title="Document was modified on your reMarkable tablet after the last upload to OneNote"
              >
                Out of date
              </span>
            ) : null}
          </button>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <SyncStatusIcon state={rollup.visualState} />

          {rollup.lastSyncedAt ? (
            <span className="hidden text-[11px] text-slate-500 sm:inline">
              {formatSyncTimestamp(rollup.lastSyncedAt, true)}
            </span>
          ) : null}

          {!isFolder && rollup.oneNoteUrl ? (
            <a
              href={rollup.oneNoteUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${node.visibleName} in OneNote`}
              className="inline-flex min-h-7 items-center rounded border border-blue-200 bg-blue-50/70 px-2 py-0.5 text-xs font-medium text-brand underline-offset-2 transition-colors hover:bg-blue-100 hover:underline"
            >
              OneNote
            </a>
          ) : null}

          <button
            type="button"
            disabled={disabled || isSyncingEngine}
            onClick={() => onManualSyncNode(node)}
            aria-label={`Sync ${node.visibleName} now`}
            className="inline-flex min-h-7 items-center gap-1 rounded border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <LegacyIcon name="syncCycle" className="h-3 w-3 text-slate-500" />
            <span>Sync</span>
          </button>

          {hasChildFolders ? (
            <button
              type="button"
              onClick={() => onToggleSubtreeExpand(node)}
              aria-label={`${isExpanded ? 'Collapse Subtree' : 'Expand Subtree'} in ${node.visibleName}`}
              className="min-h-7 shrink-0 rounded border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
            >
              {isExpanded ? 'Collapse Subtree' : 'Expand Subtree'}
            </button>
          ) : null}
        </div>
      </div>

      {hasChildren && isExpanded ? (
        <div
          id={groupId}
          role="group"
          aria-labelledby={labelTextId}
          className="tree-guide-group mt-0.5 space-y-0.5"
        >
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              baseId={baseId}
              selectionMap={selectionMap}
              rollupMap={rollupMap}
              expandedIds={expandedIds}
              inspectedDocId={inspectedDocId}
              disabled={disabled}
              isSyncingEngine={isSyncingEngine}
              onToggleCheckbox={onToggleCheckbox}
              onToggleExpand={onToggleExpand}
              onToggleSubtreeExpand={onToggleSubtreeExpand}
              onInspectDocument={onInspectDocument}
              onManualSyncNode={onManualSyncNode}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SyncControlView({
  overview,
  currentTourStepId,
  onOpenSetup,
  onSyncStateChanged,
}: SyncControlViewProps) {
  const baseId = useId();
  const [roots, setRoots] = useState<FileTreeNode[]>([]);
  const [selectionMap, setSelectionMap] = useState<SelectionMap>({});
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const [inspectedDocId, setInspectedDocId] = useState<string | null>(null);
  const [selectedPageIds, setSelectedPageIds] = useState<Set<string>>(() => new Set());
  const [showDeletedPages, setShowDeletedPages] = useState<boolean>(false);
  const [recoveringPageId, setRecoveringPageId] = useState<string | null>(null);

  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncingNow, setIsSyncingNow] = useState(false);
  const [saveSuccessFlash, setSaveSuccessFlash] = useState(false);
  const [feedback, setFeedback] = useState<{ isError: boolean; text: string } | null>(null);

  const hasUnsavedRef = useRef(hasUnsavedChanges);
  hasUnsavedRef.current = hasUnsavedChanges;
  const flashTimerRef = useRef<number | null>(null);

  const {
    db,
    sendMessage,
    getAllDocs,
    getPrefs,
    getWl,
    saveWhitelist,
    isDemo,
  } = useDataSource();

  const livePages = useLiveQuery(async () => db.pages.toArray(), [db], [] as PageRecord[]);
  const liveDocs = useLiveQuery(async () => db.documents.toArray(), [db], [] as DocumentRecord[]);

  const pagesByDocId = useMemo(() => {
    const map = new Map<string, PageRecord[]>();
    for (const page of livePages) {
      if (!page.pageNumber || page.pageNumber.trim() === '') {
        continue;
      }
      const list = map.get(page.documentId);
      if (list) {
        list.push(page);
      } else {
        map.set(page.documentId, [page]);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) =>
        a.pageNumber.localeCompare(b.pageNumber, undefined, { numeric: true }),
      );
    }
    return map;
  }, [livePages]);

  const docsById = useMemo(() => {
    return new Map<string, DocumentRecord>(liveDocs.map((d) => [d.documentId, d]));
  }, [liveDocs]);

  const rollupMap = useMemo(
    () => buildRollupMap(roots, pagesByDocId, docsById),
    [roots, pagesByDocId, docsById],
  );

  const hydrateFromLocalCache = useCallback(async (preserveExpanded = false) => {
    const [docs, whitelist, prefs] = await Promise.all([
      getAllDocs(),
      getWl(),
      getPrefs(),
    ]);

    const nextRoots = buildFileTreeHierarchy(docs);
    const nextSelection = deriveInitialSelectionMap(
      nextRoots,
      whitelist,
      prefs.autoAddNewFiles,
    );

    setRoots(nextRoots);
    setSelectionMap(nextSelection);
    setHasUnsavedChanges(false);

    if (!preserveExpanded) {
      if (isDemo) {
        setExpandedIds(new Set(collectAllFolderIds(nextRoots)));
      } else {
        const topFolderIds = nextRoots
          .filter((node) => node.type === 'CollectionType' && node.children.length > 0)
          .map((node) => node.id);
        setExpandedIds(new Set(topFolderIds));
      }
    }
  }, [getAllDocs, getPrefs, getWl, isDemo]);

  useEffect(() => {
    if (isDemo && currentTourStepId === 'sync-control-pages-panel' && !inspectedDocId) {
      setInspectedDocId('demo-doc-calc');
    }
  }, [isDemo, currentTourStepId, inspectedDocId]);

  useEffect(() => {
    void hydrateFromLocalCache(false);

    const unsubscribe = onSyncStorageChanged(() => {
      if (!hasUnsavedRef.current) {
        void hydrateFromLocalCache(true);
      }
    });

    return () => {
      unsubscribe();
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
      }
    };
  }, [hydrateFromLocalCache]);

  // Close the slide-in Pages Side Panel when pressing Escape.
  useEffect(() => {
    if (!inspectedDocId) {
      return;
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setInspectedDocId(null);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [inspectedDocId]);

  const inspectedDocNode = useMemo(
    () => (inspectedDocId ? findNodeById(roots, inspectedDocId) : null),
    [roots, inspectedDocId],
  );

  const inspectedDocPages = useMemo(
    () => (inspectedDocId ? (pagesByDocId.get(inspectedDocId) ?? []) : []),
    [pagesByDocId, inspectedDocId],
  );

  const activePages = useMemo(
    () => inspectedDocPages.filter((p) => p.status !== 'Deleted'),
    [inspectedDocPages],
  );

  const deletedPages = useMemo(
    () => inspectedDocPages.filter((p) => p.status === 'Deleted'),
    [inspectedDocPages],
  );

  const deletedPageRevLabels = useMemo(() => {
    const revMap = new Map<string, string>();
    const byNumber = new Map<string, PageRecord[]>();
    for (const page of inspectedDocPages) {
      const list = byNumber.get(page.pageNumber) ?? [];
      list.push(page);
      byNumber.set(page.pageNumber, list);
    }

    for (const list of byNumber.values()) {
      const deletedInGroup = list.filter((p) => p.status === 'Deleted');
      if (deletedInGroup.length === 0) continue;

      if (list.length > 1) {
        deletedInGroup.sort((a, b) => a.lastModified.localeCompare(b.lastModified));
        deletedInGroup.forEach((page, idx) => {
          revMap.set(page.pageId, ` (rev ${idx + 1})`);
        });
      } else {
        revMap.set(deletedInGroup[0].pageId, '');
      }
    }
    return revMap;
  }, [inspectedDocPages]);

  const inspectedDocRollup = useMemo(
    () => (inspectedDocId ? (rollupMap.get(inspectedDocId) ?? EMPTY_ROLLUP) : EMPTY_ROLLUP),
    [rollupMap, inspectedDocId],
  );

  // Reconcile selectedPageIds whenever active pages change so ghost selections
  // from deleted or reordered pages do not inflate the "Sync Selected (N)" counter.
  useEffect(() => {
    if (!inspectedDocId) {
      return;
    }
    const validActiveIds = new Set(activePages.map((p) => p.pageId));
    setSelectedPageIds((prev) => {
      let hasChanges = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validActiveIds.has(id)) {
          next.add(id);
        } else {
          hasChanges = true;
        }
      }
      return hasChanges ? next : prev;
    });
  }, [activePages, inspectedDocId]);

  const handleInspectDocument = useCallback(
    (docNode: FileTreeNode) => {
      setInspectedDocId((prev) => {
        if (prev === docNode.id) {
          return null;
        }
        setShowDeletedPages(false);
        const docPages = pagesByDocId.get(docNode.id) ?? [];
        const nonDeletedPages = docPages.filter((p) => p.status !== 'Deleted');
        setSelectedPageIds(new Set(nonDeletedPages.map((p) => p.pageId)));
        return docNode.id;
      });
    },
    [pagesByDocId],
  );

  async function handleLoadFolders() {
    const permissionPromise = isDemo ? Promise.resolve(true) : requestHostOriginsFromGesture(REMARKABLE_HOST_ORIGINS);
    setIsLoading(true);
    setFeedback(null);

    try {
      const granted = await permissionPromise;
      if (!granted) {
        throw new Error(
          'Host permission for reMarkable Cloud was denied. Allow access when prompted or enable Permissions in about:addons.',
        );
      }

      const response = (await sendMessage({
        type: 'SYNC_REMARKABLE_TREE',
        forceRefresh: true,
      })) as RuntimeResponse | undefined;

      if (!response?.ok) {
        throw new Error(response?.error ?? 'Failed to load cloud folder hierarchy.');
      }

      await hydrateFromLocalCache(roots.length > 0);
      onSyncStateChanged(response.state);
      setFeedback({
        isError: false,
        text: response.detail ?? 'Cloud folder hierarchy updated.',
      });
    } catch (err) {
      setFeedback({
        isError: true,
        text: err instanceof Error ? err.message : 'Error loading folders from reMarkable Cloud.',
      });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSaveSelection() {
    setIsSaving(true);
    setFeedback(null);

    try {
      const nextWhitelist = extractWhitelistFromSelection(roots, selectionMap);
      const result = await saveWhitelist(nextWhitelist);
      setHasUnsavedChanges(false);
      onSyncStateChanged();

      setSaveSuccessFlash(true);
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
      }
      flashTimerRef.current = window.setTimeout(() => {
        setSaveSuccessFlash(false);
      }, 2500);

      const docCount = result.savedWhitelist.syncFiles.length;
      setFeedback({
        isError: false,
        text: `Selection saved to synced preferences (${docCount} document${docCount === 1 ? '' : 's'
          } selected, ${result.pendingPagesCount} page${result.pendingPagesCount === 1 ? '' : 's'
          } pending sync).`,
      });
    } catch (err) {
      setFeedback({
        isError: true,
        text: err instanceof Error ? err.message : 'Failed to save selection.',
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleTriggerGlobalSync() {
    const permissionPromise = isDemo
      ? Promise.resolve(true)
      : requestHostOriginsFromGesture([
        ...REMARKABLE_HOST_ORIGINS,
        ...MICROSOFT_GRAPH_ORIGINS,
      ]);
    setIsSyncingNow(true);
    setFeedback(null);

    try {
      await permissionPromise;
      const response = (await sendMessage({
        type: 'TRIGGER_MANUAL_SYNC',
      })) as RuntimeResponse | undefined;

      if (!response?.ok) {
        throw new Error(response?.error ?? 'Sync cycle failed.');
      }

      onSyncStateChanged(response.state);
      setFeedback({
        isError: false,
        text: response.detail ?? 'Sync cycle completed.',
      });
    } catch (err) {
      setFeedback({
        isError: true,
        text: err instanceof Error ? err.message : 'Failed to run manual sync.',
      });
    } finally {
      setIsSyncingNow(false);
    }
  }

  async function handleRetryAllFailed() {
    const permissionPromise = isDemo
      ? Promise.resolve(true)
      : requestHostOriginsFromGesture([
        ...REMARKABLE_HOST_ORIGINS,
        ...MICROSOFT_GRAPH_ORIGINS,
      ]);
    setIsSyncingNow(true);
    setFeedback(null);

    try {
      await permissionPromise;
      const response = (await sendMessage({
        type: 'RETRY_FAILED_PAGES',
        runNow: true,
      })) as RuntimeResponse | undefined;

      if (!response?.ok) {
        throw new Error(response?.error ?? 'Failed to retry failed pages.');
      }

      onSyncStateChanged(response.state);
      setFeedback({
        isError: false,
        text: response.detail ?? 'Retried failed pages.',
      });
    } catch (err) {
      setFeedback({
        isError: true,
        text: err instanceof Error ? err.message : 'Failed to retry pages.',
      });
    } finally {
      setIsSyncingNow(false);
    }
  }

  async function handleManualSyncNode(node: FileTreeNode) {
    const permissionPromise = isDemo
      ? Promise.resolve(true)
      : requestHostOriginsFromGesture([
        ...REMARKABLE_HOST_ORIGINS,
        ...MICROSOFT_GRAPH_ORIGINS,
      ]);
    const documentIds =
      node.type === 'CollectionType'
        ? collectSubtreeDocumentIds(node, selectionMap)
        : [node.id];

    if (documentIds.length === 0) {
      setFeedback({
        isError: true,
        text: `No documents found inside "${node.visibleName}" to sync.`,
      });
      return;
    }

    setIsSyncingNow(true);
    setFeedback(null);

    try {
      await permissionPromise;
      const response = (await sendMessage({
        type: 'MANUAL_SYNC_ITEMS',
        documentIds,
        runNow: true,
      })) as RuntimeResponse | undefined;

      if (!response?.ok) {
        throw new Error(response?.error ?? `Failed to sync "${node.visibleName}".`);
      }

      onSyncStateChanged(response.state);
      setFeedback({
        isError: false,
        text: response.detail ?? `Synced "${node.visibleName}".`,
      });
    } catch (err) {
      setFeedback({
        isError: true,
        text: err instanceof Error ? err.message : `Failed to sync "${node.visibleName}".`,
      });
    } finally {
      setIsSyncingNow(false);
    }
  }

  async function handleManualSyncSpecificPages(
    pages: Array<{ documentId: string; pageId: string }>,
  ) {
    if (pages.length === 0) {
      return;
    }
    const permissionPromise = isDemo
      ? Promise.resolve(true)
      : requestHostOriginsFromGesture([
        ...REMARKABLE_HOST_ORIGINS,
        ...MICROSOFT_GRAPH_ORIGINS,
      ]);
    setIsSyncingNow(true);
    setFeedback(null);

    try {
      await permissionPromise;
      const response = (await sendMessage({
        type: 'MANUAL_SYNC_ITEMS',
        pages,
        runNow: true,
      })) as RuntimeResponse | undefined;

      if (!response?.ok) {
        throw new Error(response?.error ?? 'Failed to sync selected pages.');
      }

      onSyncStateChanged(response.state);
      setFeedback({
        isError: false,
        text: response.detail ?? 'Synced selected pages.',
      });
    } catch (err) {
      setFeedback({
        isError: true,
        text: err instanceof Error ? err.message : 'Failed to sync selected pages.',
      });
    } finally {
      setIsSyncingNow(false);
    }
  }

  async function handleCancelPageSync(documentId: string, pageId: string) {
    try {
      const response = (await sendMessage({
        type: 'CANCEL_SYNC_ITEM',
        documentId,
        pageId,
      })) as RuntimeResponse | undefined;

      if (response?.ok) {
        onSyncStateChanged(response.state);
      }
    } catch (err) {
      console.error('[rmOneNote] Failed to cancel sync item:', err);
    }
  }

  async function handleRecoverPage(documentId: string, pageId: string) {
    const permissionPromise = isDemo
      ? Promise.resolve(true)
      : requestHostOriginsFromGesture([
        ...REMARKABLE_HOST_ORIGINS,
        ...MICROSOFT_GRAPH_ORIGINS,
      ]);
    setRecoveringPageId(pageId);
    setFeedback(null);

    try {
      await permissionPromise;
      const response = (await sendMessage({
        type: 'RECOVER_DELETED_PAGE',
        documentId,
        pageId,
      })) as RuntimeResponse | undefined;

      if (!response?.ok) {
        throw new Error(response?.error ?? 'Failed to recover deleted page.');
      }

      onSyncStateChanged(response.state);
      setFeedback({
        isError: false,
        text: response.detail ?? 'Recovered deleted page to OneNote.',
      });
    } catch (err) {
      setFeedback({
        isError: true,
        text: err instanceof Error ? err.message : 'Failed to recover deleted page.',
      });
    } finally {
      setRecoveringPageId(null);
    }
  }

  function handleToggleCheckbox(node: FileTreeNode) {
    setSelectionMap((prev) => toggleNodeSelection(roots, prev, node));
    setHasUnsavedChanges(true);
  }

  function handleToggleExpand(folderId: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }

  function handleToggleSubtreeExpand(folderNode: FileTreeNode) {
    const subtreeFolderIds = [folderNode.id, ...collectAllFolderIds(folderNode.children)];
    setExpandedIds((prev) => {
      const next = new Set(prev);
      const shouldExpand = !prev.has(folderNode.id);
      for (const id of subtreeFolderIds) {
        if (shouldExpand) {
          next.add(id);
        } else {
          next.delete(id);
        }
      }
      return next;
    });
  }

  function handleExpandAll() {
    setExpandedIds(new Set(collectAllFolderIds(roots)));
  }

  function handleCollapseAll() {
    setExpandedIds(new Set());
  }

  function handleTogglePageCheckbox(pageId: string) {
    setSelectedPageIds((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) {
        next.delete(pageId);
      } else {
        next.add(pageId);
      }
      return next;
    });
  }

  const allExpandableFolderIds = useMemo(() => collectAllFolderIds(roots), [roots]);
  const selectionSummary = useMemo(
    () => formatSelectionSummary(roots, selectionMap),
    [roots, selectionMap],
  );
  const filteredRoots = useMemo(
    () => filterTreeByQuery(roots, searchQuery.trim().toLowerCase()),
    [roots, searchQuery],
  );
  const totalFailedPagesCount = useMemo(
    () => livePages.filter((p) => p.status === 'Failed').length,
    [livePages],
  );

  const hasLoadedItems = roots.length > 0;
  const isEngineBusy =
    isSyncingNow ||
    (overview.phase !== 'Idle' && overview.phase !== 'Error');

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 id="main-heading" tabIndex={-1} className="text-2xl font-semibold text-slate-900">
            Sync Control
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Select folders and documents for automatic sync, trigger manual syncs, or click a
            document to inspect its pages.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-700 shadow-2xs">
            <span
              className={`h-2 w-2 rounded-full ${overview.phase === 'Error'
                ? 'bg-rose-500'
                : overview.phase !== 'Idle' || isSyncingNow
                  ? 'animate-pulse bg-blue-500'
                  : 'bg-emerald-500'
                }`}
              aria-hidden="true"
            />
            <span>Engine: {isSyncingNow ? 'Syncing...' : overview.phase}</span>
          </div>

          {totalFailedPagesCount > 0 ? (
            <button
              type="button"
              disabled={isEngineBusy || !overview.isConfigured}
              onClick={() => void handleRetryAllFailed()}
              className="min-h-9 rounded-md border border-rose-300 bg-rose-50 px-3.5 py-1.5 text-xs font-medium text-rose-700 transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Retry Failed ({totalFailedPagesCount})
            </button>
          ) : null}

          <button
            type="button"
            disabled={isEngineBusy || !overview.isConfigured}
            onClick={() => void handleTriggerGlobalSync()}
            className="inline-flex min-h-9 items-center gap-2 rounded-md bg-brand px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <LegacyIcon
              name="syncCycle"
              className={`h-3.5 w-3.5 ${isEngineBusy ? 'status-spin' : ''}`}
            />
            <span>{isEngineBusy ? 'Syncing...' : 'Sync Pending'}</span>
          </button>
        </div>
      </header>

      {!overview.remarkablePaired ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-amber-300 bg-amber-50 p-5 text-amber-950"
        >
          <div>
            <h2 className="text-sm font-semibold">reMarkable Account Not Paired</h2>
            <p className="mt-0.5 text-sm text-amber-900">
              Pair your reMarkable Cloud account first to load folders and select notebooks for
              OneNote synchronization.
            </p>
          </div>
          <button
            type="button"
            onClick={onOpenSetup}
            className="min-h-9 rounded-md bg-amber-800 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-amber-900"
          >
            Pair reMarkable Account
          </button>
        </div>
      ) : null}

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div className="min-w-56 flex-1">
            <label htmlFor="sync-control-search" className="visually-hidden">
              Search folders or documents
            </label>
            <input
              id="sync-control-search"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter folders or documents..."
              className="w-full max-w-sm rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-brand focus:ring-1 focus:ring-brand focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {allExpandableFolderIds.length > 0 ? (
              <>
                <button
                  type="button"
                  onClick={handleExpandAll}
                  className="min-h-8 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100"
                >
                  Expand All
                </button>
                <button
                  type="button"
                  onClick={handleCollapseAll}
                  className="min-h-8 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100"
                >
                  Collapse All
                </button>
              </>
            ) : null}

            <button
              type="button"
              data-tour="sync-control-load-btn"
              disabled={!overview.remarkablePaired || isLoading}
              onClick={() => void handleLoadFolders()}
              className="min-h-8 rounded-md border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-800 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-55"
            >
              {isLoading ? 'Loading Folders...' : 'Load Folders'}
            </button>

            <button
              type="button"
              data-tour="sync-control-save-btn"
              disabled={!hasLoadedItems || isSaving || !overview.remarkablePaired}
              onClick={() => void handleSaveSelection()}
              className={`min-h-8 rounded-md px-3.5 py-1 text-xs font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${saveSuccessFlash
                ? 'bg-emerald-600 hover:bg-emerald-700'
                : 'bg-brand hover:bg-brand-hover'
                }`}
            >
              {isSaving
                ? 'Saving...'
                : saveSuccessFlash
                  ? 'Selection Saved'
                  : hasUnsavedChanges
                    ? 'Save Selection *'
                    : 'Save Selection'}
            </button>
          </div>
        </div>

        {/* Split Layout: Main File Tree + Smooth Slide-In Pages Side Panel */}
        <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start">
          <div
            data-tour="sync-control-tree"
            className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white"
          >
            {isLoading ? (
              <progress
                aria-label="Loading cloud folder structure"
                className="block h-1 w-full overflow-hidden rounded-t-lg accent-brand"
              />
            ) : null}

            {!hasLoadedItems ? (
              <div className="flex min-h-96 items-center justify-center p-6 text-center text-sm text-slate-500">
                {overview.remarkablePaired
                  ? 'Select "Load Folders" to fetch your folder and notebook hierarchy from reMarkable Cloud.'
                  : 'Pair your reMarkable Cloud account in Account Setup to browse folders.'}
              </div>
            ) : filteredRoots.length === 0 ? (
              <div className="flex min-h-64 items-center justify-center p-6 text-center text-sm text-slate-500">
                No folders or documents match your search filter.
              </div>
            ) : (
              <div
                role="group"
                aria-label="reMarkable Cloud folder and document tree"
                className="scroll-region min-h-[550px] max-h-[calc(100vh-280px)] space-y-0.5 p-3"
              >
                {filteredRoots.map((node) => (
                  <TreeNodeRow
                    key={node.id}
                    node={node}
                    depth={0}
                    baseId={baseId}
                    selectionMap={selectionMap}
                    rollupMap={rollupMap}
                    expandedIds={expandedIds}
                    inspectedDocId={inspectedDocId}
                    disabled={!overview.remarkablePaired || isSaving}
                    isSyncingEngine={isEngineBusy}
                    onToggleCheckbox={handleToggleCheckbox}
                    onToggleExpand={handleToggleExpand}
                    onToggleSubtreeExpand={handleToggleSubtreeExpand}
                    onInspectDocument={handleInspectDocument}
                    onManualSyncNode={(targetNode) => void handleManualSyncNode(targetNode)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Pages Side Panel (Smooth Slide-In) */}
          <aside
            data-tour="sync-control-pages-panel"
            aria-label={
              inspectedDocNode
                ? `Pages in ${inspectedDocNode.visibleName}`
                : 'Document pages inspector'
            }
            aria-hidden={inspectedDocNode === null}
            inert={inspectedDocNode === null ? true : undefined}
            className={`pages-side-panel shrink-0 overflow-clip rounded-lg border border-slate-200 bg-slate-50/70 ${inspectedDocNode
              ? 'w-full opacity-100 translate-x-0 lg:w-[430px] xl:w-[470px]'
              : 'pointer-events-none h-0 w-0 translate-x-6 border-0 opacity-0'
              }`}
          >
            {inspectedDocNode ? (
              <div className="flex min-h-[550px] max-h-[calc(100vh-210px)] flex-col">
                <div className="flex items-start justify-between gap-3 border-b border-slate-200 bg-white p-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <LegacyIcon name="notebook" className="h-4 w-4 shrink-0 text-violet-500" />
                      <h2
                        className="truncate text-sm font-semibold text-slate-900"
                        title={inspectedDocNode.visibleName}
                      >
                        {inspectedDocNode.visibleName}
                      </h2>
                      <SyncStatusIcon state={inspectedDocRollup.visualState} />
                      {inspectedDocRollup.isOutOfDate ? (
                        <span
                          className="shrink-0 rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800"
                          title="This document was modified on your reMarkable tablet after the last upload to OneNote"
                        >
                          Out of date
                        </span>
                      ) : null}
                    </div>
                    <p
                      className="mt-1 truncate text-xs text-slate-500"
                      title={inspectedDocNode.virtualPath}
                    >
                      {inspectedDocNode.virtualPath}
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={() => setInspectedDocId(null)}
                    aria-label="Close pages panel"
                    className="inline-flex min-h-7 items-center rounded border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
                  >
                    Close
                  </button>
                </div>

                {/* Manual Sync Batch Toolbar */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white/80 px-4 py-2.5">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        setSelectedPageIds(new Set(activePages.map((p) => p.pageId)))
                      }
                      className="min-h-7 rounded border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100"
                    >
                      Select All
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedPageIds(new Set())}
                      className="min-h-7 rounded border border-slate-200 bg-white px-2 py-0.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100"
                    >
                      Select None
                    </button>
                  </div>

                  <button
                    type="button"
                    disabled={
                      selectedPageIds.size === 0 || isEngineBusy || !overview.isConfigured
                    }
                    onClick={() =>
                      void handleManualSyncSpecificPages(
                        Array.from(selectedPageIds).map((pageId) => ({
                          documentId: inspectedDocNode.id,
                          pageId,
                        })),
                      )
                    }
                    className="inline-flex min-h-7 items-center gap-1.5 rounded bg-brand px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <LegacyIcon name="syncCycle" className="h-3 w-3" />
                    <span>Sync Selected ({selectedPageIds.size})</span>
                  </button>
                </div>

                {/* Document Pages List */}
                <div className="scroll-region flex-1 divide-y divide-slate-200 p-3">
                  {inspectedDocPages.length === 0 ? (
                    <div className="py-10 text-center text-xs text-slate-500">
                      No pages indexed for this document yet. Click "Load Folders" or "Sync" to
                      fetch its pages.
                    </div>
                  ) : (
                    <>
                      {activePages.length === 0 ? (
                        <div className="py-6 text-center text-xs text-slate-500">
                          {deletedPages.length > 0
                            ? 'All pages in this document have been deleted on your tablet.'
                            : 'No active pages found in this document.'}
                        </div>
                      ) : (
                        activePages.map((page) => {
                          const isPageChecked = selectedPageIds.has(page.pageId);
                          const isActivelySyncing = isPageActivelySyncing(page.status);
                          const pageCbId = `${baseId}-pgcb-${page.pageId}`;

                          return (
                            <div
                              key={page.pageId}
                              className="flex items-start justify-between gap-3 rounded-md bg-white p-3 first:mt-0 mt-2 border border-slate-200/80 shadow-2xs"
                            >
                              <div className="flex min-w-0 flex-1 items-start gap-2.5">
                                <input
                                  id={pageCbId}
                                  type="checkbox"
                                  checked={isPageChecked}
                                  onChange={() => handleTogglePageCheckbox(page.pageId)}
                                  aria-label={`Select Page ${page.pageNumber}`}
                                  className="checkbox-custom mt-0.5 text-sm"
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <label
                                      htmlFor={pageCbId}
                                      className="cursor-pointer text-xs font-semibold text-slate-900"
                                    >
                                      Page {page.pageNumber}
                                    </label>
                                    <SyncStatusBadge status={page.status} />

                                    {page.originalPageNumber &&
                                      page.originalPageNumber !== page.pageNumber ? (
                                      <span
                                        className="inline-flex items-center rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-800"
                                        title={`Page was reordered on tablet: was Page ${page.originalPageNumber}, now Page ${page.pageNumber}`}
                                      >
                                        Moved: Page {page.originalPageNumber} &rarr; Page {page.pageNumber}
                                      </span>
                                    ) : null}

                                    {page.titleRenameOnly ? (
                                      <span
                                        className="inline-flex items-center rounded border border-blue-300 bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-800"
                                        title={`Page was reordered on tablet: pending OneNote title rename to Page ${page.pageNumber}`}
                                      >
                                        Reorder Pending
                                      </span>
                                    ) : null}

                                    {page.lastSyncTime &&
                                      Date.parse(page.lastModified) > Date.parse(page.lastSyncTime) + 1000 ? (
                                      <span
                                        className="inline-flex items-center rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
                                        title="This page was modified on your reMarkable tablet after the last upload to OneNote"
                                      >
                                        Out of date
                                      </span>
                                    ) : null}
                                  </div>

                                  <p className="mt-1 text-[11px] text-slate-500">
                                    {page.lastSyncTime
                                      ? `Last synced: ${formatSyncTimestamp(page.lastSyncTime)}`
                                      : `Modified: ${formatSyncTimestamp(page.lastModified)}`}{' '}
                                    |{' '}
                                    {page.fileSizeBytes === 0
                                      ? '0 KB (Blank / No strokes)'
                                      : formatFileSize(page.fileSizeBytes)}
                                  </p>

                                  {page.lastError ? (
                                    <p className="mt-1 text-[11px] font-medium text-rose-600">
                                      {page.lastError}
                                    </p>
                                  ) : null}

                                  {page.oneNotePageUrl ? (
                                    <a
                                      href={page.oneNotePageUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="mt-1.5 inline-block text-xs font-medium text-brand underline underline-offset-2 hover:text-brand-hover"
                                    >
                                      Open in OneNote
                                    </a>
                                  ) : null}
                                </div>
                              </div>

                              <div className="shrink-0">
                                {isActivelySyncing ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void handleCancelPageSync(page.documentId, page.pageId)
                                    }
                                    className="min-h-7 rounded border border-rose-200 bg-white px-2.5 py-1 text-xs font-medium text-rose-700 transition-colors hover:bg-rose-50"
                                  >
                                    Cancel
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    disabled={isEngineBusy || !overview.isConfigured}
                                    onClick={() =>
                                      void handleManualSyncSpecificPages([
                                        { documentId: page.documentId, pageId: page.pageId },
                                      ])
                                    }
                                    className="inline-flex min-h-7 items-center gap-1 rounded border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                                  >
                                    <LegacyIcon name="syncCycle" className="h-3 w-3 text-slate-500" />
                                    <span>Sync</span>
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })
                      )}

                      {/* Collapsible Deleted Pages Section */}
                      {deletedPages.length > 0 ? (
                        <div className="mt-4 border-t border-slate-200/80 pt-3">
                          <button
                            type="button"
                            onClick={() => setShowDeletedPages((prev) => !prev)}
                            className="flex w-full items-center justify-between rounded px-1.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-200/50 hover:text-slate-900"
                            aria-expanded={showDeletedPages}
                          >
                            <span className="flex items-center gap-1.5">
                              <span
                                className={`inline-block text-[10px] transition-transform ${showDeletedPages ? 'rotate-90' : ''
                                  }`}
                                aria-hidden="true"
                              >
                                &rsaquo;
                              </span>
                              <span>Deleted Pages ({deletedPages.length})</span>
                            </span>
                            <span className="text-[11px] font-normal text-slate-400">
                              {showDeletedPages ? 'Hide' : 'Show'}
                            </span>
                          </button>

                          {showDeletedPages ? (
                            <div className="mt-2 space-y-2">
                              {deletedPages.map((page) => {
                                const revSuffix = deletedPageRevLabels.get(page.pageId) ?? '';
                                const isRecovering = recoveringPageId === page.pageId;
                                const isExpired = Boolean(
                                  page.lastError &&
                                  (page.lastError.includes('expired') ||
                                    page.lastError.toLowerCase().includes('not found') ||
                                    page.lastError.includes('404')),
                                );

                                return (
                                  <div
                                    key={page.pageId}
                                    className="flex items-start justify-between gap-3 rounded-md border border-dashed border-rose-200 bg-rose-50/40 p-3 shadow-2xs"
                                  >
                                    <div className="min-w-0 flex-1">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-xs font-semibold text-slate-700">
                                          Page {page.pageNumber}{revSuffix}
                                        </span>
                                        <SyncStatusBadge status="Deleted" />
                                        <span
                                          className="inline-flex items-center rounded border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-800"
                                          title="This page was deleted on your reMarkable tablet"
                                        >
                                          Deleted on tablet
                                        </span>
                                        {page.lastSyncTime &&
                                          Date.parse(page.lastModified) >
                                          Date.parse(page.lastSyncTime) + 1000 ? (
                                          <span
                                            className="inline-flex items-center rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800"
                                            title="This page was modified on your reMarkable tablet after the last upload to OneNote"
                                          >
                                            Out of date
                                          </span>
                                        ) : null}
                                      </div>

                                      <p className="mt-1 text-[11px] text-slate-500">
                                        {page.lastSyncTime
                                          ? `Last synced: ${formatSyncTimestamp(page.lastSyncTime)}`
                                          : `Deleted: ${formatSyncTimestamp(page.lastModified)}`}{' '}
                                        |{' '}
                                        {page.fileSizeBytes === 0
                                          ? '0 KB (Blank / No strokes)'
                                          : formatFileSize(page.fileSizeBytes)}
                                      </p>

                                      {page.lastError ? (
                                        <p className="mt-1 text-[11px] font-medium text-rose-600">
                                          {page.lastError}
                                        </p>
                                      ) : null}

                                      {page.oneNotePageUrl ? (
                                        <a
                                          href={page.oneNotePageUrl}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="mt-1.5 inline-block text-xs font-medium text-brand underline underline-offset-2 hover:text-brand-hover"
                                        >
                                          Open in OneNote
                                        </a>
                                      ) : null}
                                    </div>

                                    <div className="shrink-0">
                                      <button
                                        type="button"
                                        disabled={
                                          isEngineBusy ||
                                          !overview.isConfigured ||
                                          isRecovering ||
                                          isExpired
                                        }
                                        onClick={() =>
                                          void handleRecoverPage(page.documentId, page.pageId)
                                        }
                                        title={
                                          isExpired
                                            ? 'Page content has expired on reMarkable Cloud and cannot be recovered'
                                            : 'Upload to dedicated (Recovered) OneNote section'
                                        }
                                        className="inline-flex min-h-7 items-center gap-1 rounded border border-rose-300 bg-white px-2.5 py-1 text-xs font-medium text-rose-700 transition-colors hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                                      >
                                        {isRecovering ? (
                                          <>
                                            <LegacyIcon
                                              name="syncCycle"
                                              className="h-3 w-3 text-rose-500 status-spin"
                                            />
                                            <span>Recovering...</span>
                                          </>
                                        ) : (
                                          <>
                                            <LegacyIcon
                                              name="syncCycle"
                                              className="h-3 w-3 text-rose-500"
                                            />
                                            <span>Recover</span>
                                          </>
                                        )}
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            ) : null}
          </aside>
        </div>

        {/* Footer Summary & Status Feedback */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-3 text-slate-600">
            <span className="font-medium">
              {hasLoadedItems ? selectionSummary : ''}
            </span>
            {hasLoadedItems ? (
              <span className="text-slate-400">
                Tip: Click any document name to slide open its page list.
              </span>
            ) : null}
          </div>

          <span
            aria-live="polite"
            className={`font-medium ${feedback?.isError ? 'text-red-700' : 'text-emerald-700'
              }`}
          >
            {feedback?.text ?? ''}
          </span>
        </div>
      </div>
    </div>
  );
}
