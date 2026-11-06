import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { getAllDocuments } from '../../db/repository';
import {
  buildFileTreeHierarchy,
  deriveInitialSelectionMap,
  extractWhitelistFromSelection,
  type FileTreeNode,
  formatFolderItemCount,
  formatSelectionSummary,
  type SelectionMap,
  saveWhitelistAndReconcilePages,
  toggleNodeSelection,
} from '../../remarkable';
import { ext } from '../../shared/browser';
import { LegacyIcon } from '../../shared/legacyIcons';
import type { RuntimeResponse, SyncOverviewState } from '../../shared/messaging';
import {
  getPreferences,
  getWhitelist,
  onSyncStorageChanged,
} from '../../storage/preferences';

interface FileBrowserViewProps {
  overview: SyncOverviewState;
  onOpenSetup: () => void;
  onSyncStateChanged: (nextOverview?: SyncOverviewState) => void;
}

const REMARKABLE_HOST_ORIGINS = [
  'https://webapp-prod.cloud.remarkable.engineering/*',
  'https://internal.cloud.remarkable.com/*',
  'https://*.storage.googleapis.com/*',
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

interface TreeNodeRowProps {
  node: FileTreeNode;
  depth: number;
  baseId: string;
  selectionMap: Readonly<SelectionMap>;
  expandedIds: ReadonlySet<string>;
  disabled: boolean;
  onToggleCheckbox: (node: FileTreeNode) => void;
  onToggleExpand: (folderId: string) => void;
  onToggleSubtreeExpand: (folderNode: FileTreeNode) => void;
}

function TreeNodeRow({
  node,
  depth,
  baseId,
  selectionMap,
  expandedIds,
  disabled,
  onToggleCheckbox,
  onToggleExpand,
  onToggleSubtreeExpand,
}: TreeNodeRowProps) {
  const isFolder = node.type === 'CollectionType';
  const hasChildren = isFolder && node.children.length > 0;
  const hasChildFolders = hasChildren && node.children.some((c) => c.type === 'CollectionType' && c.children.length > 0);
  const isExpanded = expandedIds.has(node.id);
  const state = selectionMap[node.id] ?? false;

  const checkboxId = `${baseId}-cb-${node.id}`;
  const labelTextId = `${baseId}-lbl-${node.id}`;
  const groupId = `${baseId}-grp-${node.id}`;
  const itemCountText = formatFolderItemCount(node);

  return (
    <div>
      <div
        className="flex items-center justify-between gap-2 rounded-md pr-2 transition-colors hover:bg-slate-50"
        style={{ paddingInlineStart: `${depth * 1.25}rem` }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {hasChildren ? (
            <button
              type="button"
              aria-expanded={isExpanded}
              aria-controls={groupId}
              aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${node.visibleName}`}
              onClick={() => onToggleExpand(node.id)}
              className="inline-flex min-h-11 min-w-8 shrink-0 items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-200/70 hover:text-slate-800"
            >
              <LegacyIcon
                name="chevronDown"
                className={`h-4 w-4 transition-transform ${
                  isExpanded ? 'rotate-0' : '-rotate-90'
                }`}
              />
            </button>
          ) : (
            <span className="inline-block w-8 shrink-0" aria-hidden="true" />
          )}

          <input
            ref={(el) => {
              if (el) {
                el.indeterminate = state === null;
              }
            }}
            id={checkboxId}
            type="checkbox"
            checked={state === true}
            disabled={disabled}
            onChange={() => onToggleCheckbox(node)}
            className="checkbox-custom text-base"
          />

          <label
            htmlFor={checkboxId}
            className={`inline-flex min-h-11 min-w-0 flex-1 items-center gap-2.5 py-1.5 pl-2 select-none ${
              disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
            }`}
          >
            <LegacyIcon
              name={isFolder ? 'folder' : 'notebook'}
              className={`h-4 w-4 shrink-0 ${
                isFolder ? 'text-amber-500' : 'text-violet-500'
              }`}
            />
            <span id={labelTextId} className="truncate text-sm font-medium text-slate-900">
              {node.visibleName}
            </span>
            {itemCountText ? (
              <span className="shrink-0 text-xs text-slate-500">{itemCountText}</span>
            ) : null}
          </label>
        </div>

        {hasChildFolders ? (
          <button
            type="button"
            onClick={() => onToggleSubtreeExpand(node)}
            aria-label={`${isExpanded ? 'Collapse Subtree' : 'Expand Subtree'} in ${node.visibleName}`}
            className="min-h-7 shrink-0 rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
          >
            {isExpanded ? 'Collapse Subtree' : 'Expand Subtree'}
          </button>
        ) : null}
      </div>

      {hasChildren && isExpanded ? (
        <div id={groupId} role="group" aria-labelledby={labelTextId}>
          {node.children.map((child) => (
            <TreeNodeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              baseId={baseId}
              selectionMap={selectionMap}
              expandedIds={expandedIds}
              disabled={disabled}
              onToggleCheckbox={onToggleCheckbox}
              onToggleExpand={onToggleExpand}
              onToggleSubtreeExpand={onToggleSubtreeExpand}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function FileBrowserView({
  overview,
  onOpenSetup,
  onSyncStateChanged,
}: FileBrowserViewProps) {
  const baseId = useId();
  const [roots, setRoots] = useState<FileTreeNode[]>([]);
  const [selectionMap, setSelectionMap] = useState<SelectionMap>({});
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccessFlash, setSaveSuccessFlash] = useState(false);
  const [feedback, setFeedback] = useState<{ isError: boolean; text: string } | null>(null);

  const hasUnsavedRef = useRef(hasUnsavedChanges);
  hasUnsavedRef.current = hasUnsavedChanges;
  const flashTimerRef = useRef<number | null>(null);

  const hydrateFromLocalCache = useCallback(async (preserveExpanded = false) => {
    const [docs, whitelist, prefs] = await Promise.all([
      getAllDocuments(),
      getWhitelist(),
      getPreferences(),
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
      // Expand root-level folders with children by default for immediate scanability.
      const topFolderIds = nextRoots
        .filter((node) => node.type === 'CollectionType' && node.children.length > 0)
        .map((node) => node.id);
      setExpandedIds(new Set(topFolderIds));
    }
  }, []);

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

  async function handleLoadFolders() {
    const permissionPromise = requestHostOriginsFromGesture(REMARKABLE_HOST_ORIGINS);
    setIsLoading(true);
    setFeedback(null);

    try {
      const granted = await permissionPromise;
      if (!granted) {
        throw new Error(
          'Host permission for reMarkable Cloud was denied. Allow access when prompted or enable Permissions in about:addons.',
        );
      }

      const response = (await ext.runtime.sendMessage({
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
      const result = await saveWhitelistAndReconcilePages(nextWhitelist);
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
        text: `Selection saved to synced preferences (${docCount} document${
          docCount === 1 ? '' : 's'
        } selected, ${result.pendingPagesCount} page${
          result.pendingPagesCount === 1 ? '' : 's'
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

  const allExpandableFolderIds = useMemo(() => collectAllFolderIds(roots), [roots]);
  const selectionSummary = useMemo(
    () => formatSelectionSummary(roots, selectionMap),
    [roots, selectionMap],
  );
  const hasLoadedItems = roots.length > 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 id="main-heading" tabIndex={-1} className="text-2xl font-semibold text-slate-900">
          File Browser
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Browse your reMarkable Cloud folder hierarchy and select notebooks to sync into OneNote.
        </p>
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

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 id="cloud-tree-heading" className="text-base font-semibold text-slate-900">
              Select folders and documents to sync with OneNote
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Checking a folder selects all notebooks inside it and enables automatic inclusion of
              new notebooks when Auto-Add is active.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {allExpandableFolderIds.length > 0 ? (
              <>
                <button
                  type="button"
                  onClick={handleExpandAll}
                  className="min-h-9 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100"
                >
                  Expand All
                </button>
                <button
                  type="button"
                  onClick={handleCollapseAll}
                  className="min-h-9 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100"
                >
                  Collapse All
                </button>
              </>
            ) : null}

            <button
              type="button"
              disabled={!overview.remarkablePaired || isLoading}
              onClick={() => void handleLoadFolders()}
              className="min-h-9 rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-55"
            >
              {isLoading ? 'Loading Folders...' : 'Load Folders'}
            </button>

            <button
              type="button"
              disabled={!hasLoadedItems || isSaving || !overview.remarkablePaired}
              onClick={() => void handleSaveSelection()}
              className={`min-h-9 rounded-md px-4 py-1.5 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
                saveSuccessFlash
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

        <div className="relative mt-4 min-h-96 rounded-lg border border-slate-200 bg-white">
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
          ) : (
            <div
              role="group"
              aria-labelledby="cloud-tree-heading"
              className="max-h-[540px] overflow-y-auto p-3"
            >
              {roots.map((node) => (
                <TreeNodeRow
                  key={node.id}
                  node={node}
                  depth={0}
                  baseId={baseId}
                  selectionMap={selectionMap}
                  expandedIds={expandedIds}
                  disabled={!overview.remarkablePaired || isSaving}
                  onToggleCheckbox={handleToggleCheckbox}
                  onToggleExpand={handleToggleExpand}
                  onToggleSubtreeExpand={handleToggleSubtreeExpand}
                />
              ))}
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="font-medium text-slate-600">
            {hasLoadedItems ? selectionSummary : ''}
          </span>

          <span
            aria-live="polite"
            className={`font-medium ${
              feedback?.isError ? 'text-red-700' : 'text-emerald-700'
            }`}
          >
            {feedback?.text ?? ''}
          </span>
        </div>
      </div>
    </div>
  );
}
