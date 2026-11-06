export type SyncPhase =
  | 'Idle'
  | 'Queued'
  | 'Converting'
  | 'Uploading'
  | 'Indexing'
  | 'Error';

export interface SyncOverviewState {
  isConfigured: boolean;
  phase: SyncPhase;
  lastSyncedAt: string | null;
  lastError: string | null;
  indexedPagesCount: number;
  needsBackupImport: boolean;
  missingHistoryCount: number;
}

export const DEFAULT_SYNC_OVERVIEW: SyncOverviewState = {
  isConfigured: false,
  phase: 'Idle',
  lastSyncedAt: null,
  lastError: null,
  indexedPagesCount: 0,
  needsBackupImport: false,
  missingHistoryCount: 0,
};

export type RuntimeRequest =
  | { type: 'GET_SYNC_OVERVIEW' }
  | { type: 'TRIGGER_MANUAL_SYNC' };

export type RuntimeResponse =
  | { ok: true; state: SyncOverviewState }
  | { ok: false; error: string };
