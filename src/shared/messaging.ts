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
}

export const DEFAULT_SYNC_OVERVIEW: SyncOverviewState = {
  isConfigured: false,
  phase: 'Idle',
  lastSyncedAt: null,
  lastError: null,
};

export type RuntimeRequest =
  | { type: 'GET_SYNC_OVERVIEW' }
  | { type: 'TRIGGER_MANUAL_SYNC' };

export type RuntimeResponse =
  | { ok: true; state: SyncOverviewState }
  | { ok: false; error: string };

