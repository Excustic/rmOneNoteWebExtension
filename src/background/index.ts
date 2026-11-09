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
import {
  cancelSyncItem,
  queueManualSyncItems,
  recoverDeletedPage,
  registerAutoSyncAlarmListeners,
  retryFailedPages,
  runSyncCycle,
  syncAutoSyncAlarmWithPreferences,
  type SyncCycleSummary,
  type SyncCycleTrigger,
} from '../sync';

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
  'CANCEL_SYNC_ITEM',
  'RETRY_FAILED_PAGES',
  'MANUAL_SYNC_ITEMS',
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

async function executeManagedSyncCycle(
  trigger: SyncCycleTrigger,
  forceTreeRefresh = false,
): Promise<{ state: SyncOverviewState; summary: SyncCycleSummary }> {
  await writePersistedOverview({ phase: 'Queued', lastError: null });

  try {
    const summary = await runSyncCycle({
      trigger,
      forceTreeRefresh,
      onPhaseChange: async (phase, detail) => {
        await writePersistedOverview({
          phase,
          ...(phase === 'Error' && detail ? { lastError: detail } : {}),
        });
      },
    });

    const firstFailure = summary.outcomes.find((item) => item.status === 'Failed');
    const state = await writePersistedOverview({
      phase: summary.failedCount > 0 && summary.uploadedCount === 0 ? 'Error' : 'Idle',
      lastError: firstFailure?.error ?? null,
      lastSyncedAt: summary.completedAt,
    });

    return { state, summary };
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : 'Unexpected sync engine failure.';
    await writePersistedOverview({
      phase: 'Error',
      lastError: errorMessage,
    });
    throw err;
  }
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
registerAutoSyncAlarmListeners(async () => {
  const auth = await getAuthStatusSummary();
  if (!auth.isConfigured) {
    return;
  }
  await executeManagedSyncCycle('alarm');
});

ext.runtime.onInstalled.addListener((details) => {
  void (async () => {
    try {
      const prefs = await ensureDefaultPreferences();
      await resetInProgressPages();
      await reconcileSyncLedgerToDexie();
      await syncAutoSyncAlarmWithPreferences(prefs);

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
      await syncAutoSyncAlarmWithPreferences();
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
          case 'CANCEL_SYNC_ITEM': {
            await cancelSyncItem(message.documentId, message.pageId);
            const state = await readSyncOverview();
            return {
              ok: true,
              state,
              detail: 'Sync item cancelled.',
            };
          }
          case 'RETRY_FAILED_PAGES': {
            const resetCount = await retryFailedPages({
              documentId: message.documentId,
              pageId: message.pageId,
            });
            if (message.runNow && resetCount > 0) {
              const { state, summary } = await executeManagedSyncCycle('retry');
              return {
                ok: true,
                state,
                syncSummary: summary,
                treeSync: summary.treeSync ?? undefined,
                detail: `Retried ${resetCount} page${resetCount === 1 ? '' : 's'} (${summary.uploadedCount} uploaded).`,
              };
            }
            const state = await readSyncOverview();
            return {
              ok: true,
              state,
              detail: `Re-queued ${resetCount} page${resetCount === 1 ? '' : 's'} for sync.`,
            };
          }
          case 'MANUAL_SYNC_ITEMS': {
            const queuedCount = await queueManualSyncItems({
              documentIds: message.documentIds,
              pages: message.pages,
            });
            if (message.runNow !== false && queuedCount > 0) {
              const { state, summary } = await executeManagedSyncCycle('manual');
              return {
                ok: true,
                state,
                syncSummary: summary,
                treeSync: summary.treeSync ?? undefined,
                detail: `Synced ${queuedCount} queued page${queuedCount === 1 ? '' : 's'} (${summary.uploadedCount} uploaded, ${summary.failedCount} failed).`,
              };
            }
            const state = await readSyncOverview();
            return {
              ok: true,
              state,
              detail: `Queued ${queuedCount} page${queuedCount === 1 ? '' : 's'} for synchronization.`,
            };
          }
          case 'RECOVER_DELETED_PAGE': {
            const recovery = await recoverDeletedPage(message.documentId, message.pageId);
            const state = await readSyncOverview();
            if (!recovery.ok) {
              return {
                ok: false,
                error: recovery.error ?? 'Failed to recover deleted page.',
              };
            }
            return {
              ok: true,
              state,
              detail: 'Recovered deleted page to dedicated (Recovered) OneNote section.',
            };
          }
          case 'TRIGGER_MANUAL_SYNC': {
            const { state, summary } = await executeManagedSyncCycle(
              'manual',
              Boolean(message.forceTreeRefresh),
            );
            const detail =
              summary.processedCount === 0
                ? 'All whitelisted pages are up to date.'
                : `Processed ${summary.processedCount} page${
                    summary.processedCount === 1 ? '' : 's'
                  }: ${summary.uploadedCount} uploaded, ${summary.failedCount} failed.`;
            return {
              ok: true,
              state,
              detail,
              treeSync: summary.treeSync ?? undefined,
              syncSummary: summary,
            };
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
