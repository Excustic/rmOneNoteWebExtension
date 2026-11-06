import type { CloudTreeSyncResult } from '../remarkable/types';

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
};

export type RuntimeRequest =
  | { type: 'GET_SYNC_OVERVIEW' }
  | { type: 'TRIGGER_MANUAL_SYNC' }
  | { type: 'SYNC_REMARKABLE_TREE'; forceRefresh?: boolean }
  | { type: 'PAIR_REMARKABLE'; code: string }
  | { type: 'DISCONNECT_REMARKABLE' }
  | { type: 'VERIFY_REMARKABLE_SESSION' }
  | { type: 'SIGN_IN_MICROSOFT'; clientId?: string; tenantId?: string }
  | { type: 'SIGN_OUT_MICROSOFT' }
  | { type: 'VERIFY_MICROSOFT_SESSION' };

export type RuntimeResponse =
  | {
      ok: true;
      state: SyncOverviewState;
      detail?: string;
      treeSync?: CloudTreeSyncResult;
    }
  | { ok: false; error: string };
