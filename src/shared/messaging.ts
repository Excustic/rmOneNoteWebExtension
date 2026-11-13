import type { CloudTreeSyncResult } from '../remarkable/types';
import type { SyncCycleSummary } from '../sync/types';

export type SyncPhase =
  | 'Idle'
  | 'Queued'
  | 'Converting'
  | 'Uploading'
  | 'Indexing'
  | 'Error';

export interface SyncOverviewState {
  isConfigured: boolean;
  remarkablePaired: boolean;
  microsoftConnected: boolean;
  microsoftAccount: string | null;
  phase: SyncPhase;
  lastSyncedAt: string | null;
  lastError: string | null;
  indexedPagesCount: number;
  needsBackupImport: boolean;
  missingHistoryCount: number;
  localStorageOnly: boolean;
  cloudStorageUpdatedAt: string | null;
}

export const DEFAULT_SYNC_OVERVIEW: SyncOverviewState = {
  isConfigured: false,
  remarkablePaired: false,
  microsoftConnected: false,
  microsoftAccount: null,
  phase: 'Idle',
  lastSyncedAt: null,
  lastError: null,
  indexedPagesCount: 0,
  needsBackupImport: false,
  missingHistoryCount: 0,
  localStorageOnly: false,
  cloudStorageUpdatedAt: null,
};

export type RuntimeRequest =
  | { type: 'GET_SYNC_OVERVIEW' }
  | { type: 'TRIGGER_MANUAL_SYNC'; forceTreeRefresh?: boolean }
  | { type: 'ABORT_SYNC' }
  | { type: 'CANCEL_SYNC_ITEM'; documentId: string; pageId: string }
  | { type: 'RETRY_FAILED_PAGES'; documentId?: string; pageId?: string; runNow?: boolean }
  | {
      type: 'MANUAL_SYNC_ITEMS';
      documentIds?: string[];
      pages?: Array<{ documentId: string; pageId: string }>;
      runNow?: boolean;
    }
  | { type: 'SYNC_REMARKABLE_TREE'; forceRefresh?: boolean }
  | { type: 'PAIR_REMARKABLE'; code: string }
  | { type: 'DISCONNECT_REMARKABLE' }
  | { type: 'VERIFY_REMARKABLE_SESSION' }
  | { type: 'SIGN_IN_MICROSOFT'; clientId?: string; tenantId?: string }
  | { type: 'SIGN_OUT_MICROSOFT' }
  | { type: 'VERIFY_MICROSOFT_SESSION' }
  | { type: 'RECOVER_DELETED_PAGE'; documentId: string; pageId: string };

export type RuntimeResponse =
  | {
      ok: true;
      state: SyncOverviewState;
      detail?: string;
      treeSync?: CloudTreeSyncResult;
      syncSummary?: SyncCycleSummary;
    }
  | { ok: false; error: string };
