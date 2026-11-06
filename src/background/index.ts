import {
  disconnectRemarkableDevice,
  fetchWithMicrosoftAuth,
  getAuthStatusSummary,
  getValidMicrosoftAccessToken,
  getValidRemarkableUserToken,
  pairRemarkableDevice,
  signInWithMicrosoftInteractive,
  signOutMicrosoft,
} from '../auth';
import { getIndexedPageCount, resetInProgressPages } from '../db/repository';
import {
  clearStoredCloudRootState,
  syncRemarkableCloudTree,
} from '../remarkable';
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
  'phase' | 'lastSyncedAt' | 'lastError'
>;

const DEFAULT_PERSISTED_OVERVIEW: PersistedOverviewFields = {
  phase: DEFAULT_SYNC_OVERVIEW.phase,
  lastSyncedAt: DEFAULT_SYNC_OVERVIEW.lastSyncedAt,
  lastError: DEFAULT_SYNC_OVERVIEW.lastError,
};

const VALID_REQUEST_TYPES = new Set<RuntimeRequest['type']>([
  'GET_SYNC_OVERVIEW',
  'TRIGGER_MANUAL_SYNC',
  'SYNC_REMARKABLE_TREE',
  'PAIR_REMARKABLE',
  'DISCONNECT_REMARKABLE',
  'VERIFY_REMARKABLE_SESSION',
  'SIGN_IN_MICROSOFT',
  'SIGN_OUT_MICROSOFT',
  'VERIFY_MICROSOFT_SESSION',
]);

async function readSyncOverview(): Promise<SyncOverviewState> {
  const [storedResult, indexedPagesCount, warning, auth] = await Promise.all([
    ext.storage.local.get(OVERVIEW_STORAGE_KEY),
    getIndexedPageCount(),
    getBackupImportWarningStatus(),
    getAuthStatusSummary(),
  ]);

  const stored = storedResult[OVERVIEW_STORAGE_KEY] as
    | Partial<PersistedOverviewFields>
    | undefined;

  return {
    ...DEFAULT_PERSISTED_OVERVIEW,
    ...stored,
    isConfigured: auth.isConfigured,
    remarkablePaired: auth.remarkablePaired,
    microsoftConnected: auth.microsoftConnected,
    microsoftAccount: auth.microsoftAccount,
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
    typeof candidate.type === 'string' &&
    VALID_REQUEST_TYPES.has(candidate.type as RuntimeRequest['type'])
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
          case 'PAIR_REMARKABLE': {
            await pairRemarkableDevice(message.code);
            const state = await readSyncOverview();
            return {
              ok: true,
              state,
              detail: 'reMarkable device token registered and session token verified.',
            };
          }
          case 'DISCONNECT_REMARKABLE': {
            await disconnectRemarkableDevice();
            await clearStoredCloudRootState();
            const state = await readSyncOverview();
            return {
              ok: true,
              state,
              detail: 'reMarkable device token removed from this browser.',
            };
          }
          case 'SYNC_REMARKABLE_TREE': {
            await reconcileSyncLedgerToDexie();
            const treeSync = await syncRemarkableCloudTree({
              forceRefresh: Boolean(message.forceRefresh),
            });
            const state = await readSyncOverview();
            const detail = `Loaded ${treeSync.totalItems} items (${treeSync.folderCount} folder${
              treeSync.folderCount === 1 ? '' : 's'
            }, ${treeSync.documentCount} document${
              treeSync.documentCount === 1 ? '' : 's'
            }).`;
            return {
              ok: true,
              state,
              detail,
              treeSync,
            };
          }
          case 'VERIFY_REMARKABLE_SESSION': {
            await getValidRemarkableUserToken({ forceRefresh: true });
            const state = await readSyncOverview();
            return {
              ok: true,
              state,
              detail: 'reMarkable user session token refreshed successfully.',
            };
          }
          case 'SIGN_IN_MICROSOFT': {
            const msAuth = await signInWithMicrosoftInteractive({
              clientId: message.clientId,
              tenantId: message.tenantId,
            });
            const state = await readSyncOverview();
            const accountLabel = msAuth.accountName ? ` as ${msAuth.accountName}` : '';
            return {
              ok: true,
              state,
              detail: `Connected to Microsoft OneNote${accountLabel}.`,
            };
          }
          case 'SIGN_OUT_MICROSOFT': {
            await signOutMicrosoft();
            const state = await readSyncOverview();
            return {
              ok: true,
              state,
              detail: 'Signed out of Microsoft OneNote.',
            };
          }
          case 'VERIFY_MICROSOFT_SESSION': {
            await getValidMicrosoftAccessToken({ forceRefresh: true });
            const graphProbe = await fetchWithMicrosoftAuth(
              'https://graph.microsoft.com/v1.0/me/onenote/notebooks?$top=1&$select=id,displayName',
            );
            if (!graphProbe.ok) {
              throw new Error(
                `Microsoft Graph OneNote probe returned HTTP ${graphProbe.status}.`,
              );
            }
            const state = await readSyncOverview();
            return {
              ok: true,
              state,
              detail: 'Silent token refresh and OneNote Graph API probe succeeded.',
            };
          }
          case 'TRIGGER_MANUAL_SYNC': {
            const auth = await getAuthStatusSummary();
            await reconcileSyncLedgerToDexie();

            let treeSync = undefined;
            if (auth.remarkablePaired) {
              await writePersistedOverview({ phase: 'Queued', lastError: null });
              treeSync = await syncRemarkableCloudTree();
            }
            if (auth.microsoftConnected) {
              await getValidMicrosoftAccessToken();
            }

            // TODO(Phase 7): Execute WASM conversion and Microsoft Graph upload pipeline for Pending pages.
            const updated = await writePersistedOverview({
              phase: 'Idle',
              lastError: null,
              lastSyncedAt: new Date().toISOString(),
            });
            return { ok: true, state: updated, treeSync };
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
