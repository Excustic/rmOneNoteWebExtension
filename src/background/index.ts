import { getIndexedPageCount, resetInProgressPages } from '../db/repository';
import { ext } from '../shared/browser';
import {
  DEFAULT_SYNC_OVERVIEW,
  type RuntimeRequest,
  type RuntimeResponse,
  type SyncOverviewState,
} from '../shared/messaging';
import { ensureDefaultPreferences } from '../storage/preferences';
import {
  getBackupImportWarningStatus,
  reconcileSyncLedgerToDexie,
  registerSyncLedgerAutoReconcile,
} from '../storage/syncLedger';

const OVERVIEW_STORAGE_KEY = 'syncOverview';

type PersistedOverviewFields = Pick<
  SyncOverviewState,
  'isConfigured' | 'phase' | 'lastSyncedAt' | 'lastError'
>;

const DEFAULT_PERSISTED_OVERVIEW: PersistedOverviewFields = {
  isConfigured: DEFAULT_SYNC_OVERVIEW.isConfigured,
  phase: DEFAULT_SYNC_OVERVIEW.phase,
  lastSyncedAt: DEFAULT_SYNC_OVERVIEW.lastSyncedAt,
  lastError: DEFAULT_SYNC_OVERVIEW.lastError,
};

async function readSyncOverview(): Promise<SyncOverviewState> {
  const [storedResult, indexedPagesCount, warning] = await Promise.all([
    ext.storage.local.get(OVERVIEW_STORAGE_KEY),
    getIndexedPageCount(),
    getBackupImportWarningStatus(),
  ]);

  const stored = storedResult[OVERVIEW_STORAGE_KEY] as
    | Partial<PersistedOverviewFields>
    | undefined;

  return {
    ...DEFAULT_PERSISTED_OVERVIEW,
    ...stored,
    indexedPagesCount,
    needsBackupImport: warning.needsBackupImport,
    missingHistoryCount: warning.missingHistoryCount,
  };
}

async function writePersistedOverview(
  patch: Partial<PersistedOverviewFields>,
): Promise<SyncOverviewState> {
  const currentResult = await ext.storage.local.get(OVERVIEW_STORAGE_KEY);
  const current = currentResult[OVERVIEW_STORAGE_KEY] as
    | Partial<PersistedOverviewFields>
    | undefined;

  const next: PersistedOverviewFields = {
    ...DEFAULT_PERSISTED_OVERVIEW,
    ...current,
    ...patch,
  };

  await ext.storage.local.set({ [OVERVIEW_STORAGE_KEY]: next });
  return readSyncOverview();
}

function isRuntimeRequest(msg: unknown): msg is RuntimeRequest {
  if (typeof msg !== 'object' || msg === null) {
    return false;
  }
  const candidate = msg as { type?: unknown };
  return (
    candidate.type === 'GET_SYNC_OVERVIEW' || candidate.type === 'TRIGGER_MANUAL_SYNC'
  );
}

// Register all MV3 event listeners synchronously at top level so restarted
// service workers / event pages never miss dispatched browser events.
registerSyncLedgerAutoReconcile();

ext.runtime.onInstalled.addListener((details) => {
  void (async () => {
    try {
      await ensureDefaultPreferences();
      await resetInProgressPages();
      await reconcileSyncLedgerToDexie();

      if (details.reason === 'install') {
        await writePersistedOverview(DEFAULT_PERSISTED_OVERVIEW);
      }
    } catch (err) {
      console.error('[rmOneNote] Failed to initialize storage on install:', err);
    }
  })();
});

ext.runtime.onStartup.addListener(() => {
  void (async () => {
    try {
      await resetInProgressPages();
      await reconcileSyncLedgerToDexie();
    } catch (err) {
      console.error('[rmOneNote] Startup recovery failed:', err);
    }
  })();
});

ext.runtime.onMessage.addListener(
  (message: unknown): Promise<RuntimeResponse> | undefined => {
    if (!isRuntimeRequest(message)) {
      return undefined;
    }

    return (async (): Promise<RuntimeResponse> => {
      try {
        switch (message.type) {
          case 'GET_SYNC_OVERVIEW': {
            const state = await readSyncOverview();
            return { ok: true, state };
          }
          case 'TRIGGER_MANUAL_SYNC': {
            // TODO(Phase 7): Wire into autonomous sync pipeline once auth, cloud fetch, WASM, and MS Graph services are complete.
            await reconcileSyncLedgerToDexie();
            const updated = await writePersistedOverview({
              phase: 'Idle',
              lastSyncedAt: new Date().toISOString(),
            });
            return { ok: true, state: updated };
          }
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : 'Unknown background error.';
        console.error('[rmOneNote] Message handler error:', err);
        return { ok: false, error: errorMessage };
      }
    })();
  },
);
