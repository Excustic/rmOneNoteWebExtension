import type { SyncWhitelist } from '../storage/preferences';
import type { FileTreeNode } from './types';

export type TriStateSelection = boolean | null;
export type SelectionMap = Record<string, TriStateSelection>;

export interface FolderSubtreeCounts {
  directFolders: number;
  directDocuments: number;
  totalDocuments: number;
  selectedDocuments: number;
}

/**
 * Safely reads a tri-state value (`true`, `false`, or `null` for indeterminate)
 * from `SelectionMap` without coalescing `null` (indeterminate) to `false`.
 */
export function getNodeSelectionState(
  selectionMap: Readonly<SelectionMap>,
  nodeId: string,
): TriStateSelection {
  return Object.prototype.hasOwnProperty.call(selectionMap, nodeId)
    ? selectionMap[nodeId]
    : false;
}

/**
 * Computes direct child counts and recursive descendant document selection counts
 * for a folder (`CollectionType`) node.
 */
export function getFolderSubtreeCounts(
  node: FileTreeNode,
  selectionMap: Readonly<SelectionMap>,
): FolderSubtreeCounts {
  let directFolders = 0;
  let directDocuments = 0;
  let totalDocuments = 0;
  let selectedDocuments = 0;

  for (const child of node.children) {
    if (child.type === 'CollectionType') {
      directFolders++;
    } else {
      directDocuments++;
    }
  }

  const walkSubtree = (current: FileTreeNode): void => {
    for (const child of current.children) {
      if (child.type === 'CollectionType') {
        walkSubtree(child);
      } else {
        totalDocuments++;
        if (getNodeSelectionState(selectionMap, child.id) === true) {
          selectedDocuments++;
        }
      }
    }
  };

  if (node.type === 'CollectionType') {
    walkSubtree(node);
  }

  return {
    directFolders,
    directDocuments,
    totalDocuments,
    selectedDocuments,
  };
}

function recomputeFolderStatesBottomUp(
  nodes: readonly FileTreeNode[],
  nextMap: SelectionMap,
): void {
  for (const node of nodes) {
    if (node.type === 'CollectionType' && node.children.length > 0) {
      recomputeFolderStatesBottomUp(node.children, nextMap);

      const counts = getFolderSubtreeCounts(node, nextMap);
      if (counts.totalDocuments > 0) {
        if (counts.selectedDocuments === 0) {
          nextMap[node.id] = false;
        } else if (counts.selectedDocuments === counts.totalDocuments) {
          nextMap[node.id] = true;
        } else {
          nextMap[node.id] = null;
        }
      } else {
        const childStates = node.children.map((child) => getNodeSelectionState(nextMap, child.id));
        const allChecked = childStates.every((state) => state === true);
        const allUnchecked = childStates.every((state) => state === false);
        nextMap[node.id] = allChecked ? true : allUnchecked ? false : null;
      }
    }
  }
}

/**
 * Computes initial tri-state checkbox states (`true`, `false`, or `null` for indeterminate)
 * from a hierarchical `FileTreeNode[]` tree and persisted `SyncWhitelist`.
 */
export function deriveInitialSelectionMap(
  roots: readonly FileTreeNode[],
  whitelist: SyncWhitelist,
  autoAddNewFiles: boolean,
): SelectionMap {
  const filesSet = new Set(whitelist.syncFiles.map((id) => id.trim().toLowerCase()));
  const foldersSet = new Set(whitelist.syncFolders.map((id) => id.trim().toLowerCase()));
  const map: SelectionMap = {};

  const populateInitialStates = (
    node: FileTreeNode,
    hasWhitelistedAncestor: boolean,
  ): void => {
    const idLower = node.id.toLowerCase();
    const isFolder = node.type === 'CollectionType';

    if (!isFolder) {
      map[node.id] = filesSet.has(idLower) || (autoAddNewFiles && hasWhitelistedAncestor);
      return;
    }

    const folderExplicitlySelected = foldersSet.has(idLower) || hasWhitelistedAncestor;
    map[node.id] = folderExplicitlySelected;

    for (const child of node.children) {
      populateInitialStates(child, folderExplicitlySelected);
    }
  };

  for (const root of roots) {
    populateInitialStates(root, false);
  }

  recomputeFolderStatesBottomUp(roots, map);
  return map;
}

function setSubtreeState(
  node: FileTreeNode,
  target: boolean,
  nextMap: SelectionMap,
): void {
  nextMap[node.id] = target;
  for (const child of node.children) {
    setSubtreeState(child, target, nextMap);
  }
}

/**
 * Toggles a folder or document checkbox in a tri-state hierarchy:
 * - Unchecked (`false`) or indeterminate (`null`) transitions to checked (`true`).
 * - Checked (`true`) transitions to unchecked (`false`).
 * Cascades downward to all descendants and bubbles indeterminate states upward to ancestors.
 */
export function toggleNodeSelection(
  roots: readonly FileTreeNode[],
  currentMap: Readonly<SelectionMap>,
  targetNode: FileTreeNode,
): SelectionMap {
  const nextMap: SelectionMap = { ...currentMap };
  const currentState = getNodeSelectionState(nextMap, targetNode.id);
  const nextChecked = currentState !== true;

  setSubtreeState(targetNode, nextChecked, nextMap);
  recomputeFolderStatesBottomUp(roots, nextMap);
  return nextMap;
}

/**
 * Extracts `SyncWhitelist` (`syncFiles` and `syncFolders`) from the current `SelectionMap`.
 * Only fully selected folders (`state === true`) are stored in `syncFolders` so partially
 * selected (`indeterminate`) folders do not auto-sync unselected sibling notebooks.
 */
export function extractWhitelistFromSelection(
  roots: readonly FileTreeNode[],
  selectionMap: Readonly<SelectionMap>,
): SyncWhitelist {
  const syncFiles: string[] = [];
  const syncFolders: string[] = [];

  const walk = (nodes: readonly FileTreeNode[]): void => {
    for (const node of nodes) {
      if (getNodeSelectionState(selectionMap, node.id) === true) {
        if (node.type === 'CollectionType') {
          syncFolders.push(node.id);
        } else {
          syncFiles.push(node.id);
        }
      }
      if (node.children.length > 0) {
        walk(node.children);
      }
    }
  };

  walk(roots);
  return { syncFiles, syncFolders };
}

export function formatFolderItemCount(node: FileTreeNode): string {
  if (node.type !== 'CollectionType' || node.children.length === 0) {
    return '';
  }

  let folderCount = 0;
  let docCount = 0;
  for (const child of node.children) {
    if (child.type === 'CollectionType') {
      folderCount++;
    } else {
      docCount++;
    }
  }

  const parts: string[] = [];
  if (folderCount > 0) {
    parts.push(`${folderCount} folder${folderCount === 1 ? '' : 's'}`);
  }
  if (docCount > 0) {
    parts.push(`${docCount} document${docCount === 1 ? '' : 's'}`);
  }

  return parts.length > 0 ? `(${parts.join(', ')})` : '';
}

export function formatSelectionSummary(
  roots: readonly FileTreeNode[],
  selectionMap: Readonly<SelectionMap>,
): string {
  const { syncFiles, syncFolders } = extractWhitelistFromSelection(roots, selectionMap);
  const folderCount = syncFolders.length;
  const docCount = syncFiles.length;

  if (folderCount === 0 && docCount === 0) {
    return 'No items selected';
  }

  const parts: string[] = [];
  if (folderCount > 0) {
    parts.push(`${folderCount} folder${folderCount === 1 ? '' : 's'}`);
  }
  if (docCount > 0) {
    parts.push(`${docCount} document${docCount === 1 ? '' : 's'}`);
  }

  return `Selected: ${parts.join(', ')}`;
}
