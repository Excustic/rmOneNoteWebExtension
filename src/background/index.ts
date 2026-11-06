import { ext } from '../shared/browser';
import {
  DEFAULT_SYNC_OVERVIEW,
  type RuntimeRequest,
  type RuntimeResponse,
  type SyncOverviewState,
} from '../shared/messaging';

const OVERVIEW_STORAGE_KEY = 'syncOverview';

async function readSyncOverview(): Promise<SyncOverviewState> {
  const result = await ext.storage.local.get(OVERVIEW_STORAGE_KEY);
  const stored = result[OVERVIEW_STORAGE_KEY] as Partial<SyncOverviewState> | undefined;
  return {
    ...DEFAULT_SYNC_OVERVIEW,
    ...stored,
  };
}

async function writeSyncOverview(next: SyncOverviewState): Promise<SyncOverviewState> {
  await ext.storage.local.set({ [OVERVIEW_STORAGE_KEY]: next });
  return next;
}

// Register all MV3 event listeners synchronously at top level so restarted
// service workers / event pages never miss dispatched browser events.
ext.runtime.onInstalled.addListener((details) => {
  void (async () => {
    try {
      if (details.reason === 'install') {
        await writeSyncOverview(DEFAULT_SYNC_OVERVIEW);
      }
    } catch (err) {
      console.error('[rmOneNote] Failed to initialize storage on install:', err);
    }
  })();
});

ext.runtime.onMessage.addListener(
  (
    message: RuntimeRequest,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: RuntimeResponse) => void,
  ) => {
    (async () => {
      try {
        switch (message?.type) {
          case 'GET_SYNC_OVERVIEW': {
            const state = await readSyncOverview();
            sendResponse({ ok: true, state });
            return;
          }
          case 'TRIGGER_MANUAL_SYNC': {
            // TODO(Phase 7): Wire into autonomous sync pipeline once auth, cloud fetch, WASM, and MS Graph services are complete.
            const current = await readSyncOverview();
            const updated = await writeSyncOverview({
              ...current,
              phase: 'Idle',
              lastSyncedAt: new Date().toISOString(),
            });
            sendResponse({ ok: true, state: updated });
            return;
          }
          default: {
            sendResponse({ ok: false, error: 'Unsupported runtime message type.' });
          }
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown background error.';
        console.error('[rmOneNote] Message handler error:', err);
        sendResponse({ ok: false, error: errorMessage });
      }
    })();

    return true;
  },
);
