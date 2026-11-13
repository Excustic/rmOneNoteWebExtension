import type { AuthStatusSummary } from '../../auth/authStore';
import { RmOneNoteDatabase } from '../../db/db';
import type { DocumentRecord, PageRecord } from '../../db/models';
import { computeEffectiveWhitelistedDocIds } from '../../remarkable/treeSync';
import type { SaveWhitelistSelectionResult } from '../../remarkable/types';
import type { RuntimeRequest, RuntimeResponse, SyncOverviewState } from '../../shared/messaging';
import type { SyncWhitelist, UserPreferences } from '../../storage/preferences';
import {
  DEMO_AUTH_SUMMARY,
  DEMO_DOCUMENTS,
  DEMO_NOTEBOOKS,
  DEMO_OVERVIEW,
  DEMO_PAGES,
  DEMO_PREFERENCES,
  DEMO_WHITELIST,
} from './demoData';

export const demoDb = new RmOneNoteDatabase('rmOneNoteDemoDb');

export async function seedDemoDatabase(): Promise<void> {
  await demoDb.transaction('rw', [demoDb.documents, demoDb.pages, demoDb.notebooks], async () => {
    await demoDb.documents.clear();
    await demoDb.pages.clear();
    await demoDb.notebooks.clear();

    await demoDb.documents.bulkPut(DEMO_DOCUMENTS);
    await demoDb.pages.bulkPut(DEMO_PAGES);
    await demoDb.notebooks.bulkPut(DEMO_NOTEBOOKS);
  });
}

export function createDemoDataSource(
  onOverviewChange?: (overview: SyncOverviewState) => void,
) {
  let overview: SyncOverviewState = { ...DEMO_OVERVIEW };
  let prefs: UserPreferences = { ...DEMO_PREFERENCES };
  let whitelist: SyncWhitelist = {
    syncFiles: [...DEMO_WHITELIST.syncFiles],
    syncFolders: [...DEMO_WHITELIST.syncFolders],
  };
  let authSummary: AuthStatusSummary = { ...DEMO_AUTH_SUMMARY };
  let activeSyncTimer: ReturnType<typeof setTimeout> | null = null;

  function clearActiveSyncTimer() {
    if (activeSyncTimer !== null) {
      clearTimeout(activeSyncTimer);
      activeSyncTimer = null;
    }
  }

  function notifyOverview(next: SyncOverviewState) {
    overview = next;
    onOverviewChange?.(next);
  }

  async function handleSendMessage(request: RuntimeRequest): Promise<RuntimeResponse> {
    switch (request.type) {
      case 'GET_SYNC_OVERVIEW': {
        return { ok: true, state: overview };
      }

      case 'TRIGGER_MANUAL_SYNC': {
        notifyOverview({ ...overview, phase: 'Uploading' });

        const pendingOrFailed = await demoDb.pages
          .filter((p) => p.status === 'Pending' || p.status === 'Failed' || p.status === 'Queued')
          .toArray();

        // Simulate fast transition to uploaded
        clearActiveSyncTimer();
        activeSyncTimer = setTimeout(async () => {
          activeSyncTimer = null;
          const nowIso = new Date().toISOString();
          for (const page of pendingOrFailed) {
            await demoDb.pages.update([page.documentId, page.pageId], {
              status: 'Uploaded',
              lastSyncTime: nowIso,
              lastError: null,
              oneNotePageUrl: page.oneNotePageUrl ?? 'https://onedrive.live.com/redir?page=demo-synced',
            });
          }
          notifyOverview({
            ...overview,
            phase: 'Idle',
            lastSyncedAt: nowIso,
            lastError: null,
          });
        }, 700);

        return {
          ok: true,
          state: { ...overview, phase: 'Uploading' },
          detail: 'Manual sync started in demo mode.',
        };
      }

      case 'MANUAL_SYNC_ITEMS': {
        notifyOverview({ ...overview, phase: 'Uploading' });
        const pagesToUpdate: PageRecord[] = [];

        if (request.pages && request.pages.length > 0) {
          for (const p of request.pages) {
            const found = await demoDb.pages.get([p.documentId, p.pageId]);
            if (found) pagesToUpdate.push(found);
          }
        } else if (request.documentIds && request.documentIds.length > 0) {
          for (const docId of request.documentIds) {
            const docPages = await demoDb.pages.where('documentId').equals(docId).toArray();
            pagesToUpdate.push(...docPages);
          }
        }

        clearActiveSyncTimer();
        activeSyncTimer = setTimeout(async () => {
          activeSyncTimer = null;
          const nowIso = new Date().toISOString();
          for (const page of pagesToUpdate) {
            await demoDb.pages.update([page.documentId, page.pageId], {
              status: 'Uploaded',
              lastSyncTime: nowIso,
              lastError: null,
              oneNotePageUrl: page.oneNotePageUrl ?? 'https://onedrive.live.com/redir?page=demo-synced',
            });
          }
          notifyOverview({
            ...overview,
            phase: 'Idle',
            lastSyncedAt: nowIso,
            lastError: null,
          });
        }, 700);

        return {
          ok: true,
          state: { ...overview, phase: 'Uploading' },
          detail: 'Selected pages syncing in demo mode.',
        };
      }

      case 'RETRY_FAILED_PAGES': {
        const failedPages = await demoDb.pages.where('status').equals('Failed').toArray();
        notifyOverview({ ...overview, phase: 'Uploading' });

        clearActiveSyncTimer();
        activeSyncTimer = setTimeout(async () => {
          activeSyncTimer = null;
          const nowIso = new Date().toISOString();
          for (const page of failedPages) {
            await demoDb.pages.update([page.documentId, page.pageId], {
              status: 'Uploaded',
              lastSyncTime: nowIso,
              lastError: null,
              oneNotePageUrl: page.oneNotePageUrl ?? 'https://onedrive.live.com/redir?page=demo-synced',
            });
          }
          notifyOverview({
            ...overview,
            phase: 'Idle',
            lastSyncedAt: nowIso,
            lastError: null,
          });
        }, 700);

        return {
          ok: true,
          state: { ...overview, phase: 'Uploading' },
          detail: 'Retried failed pages in demo mode.',
        };
      }

      case 'ABORT_SYNC': {
        clearActiveSyncTimer();
        notifyOverview({
          ...overview,
          phase: 'Idle',
          lastError: 'Sync aborted by user.',
        });
        return { ok: true, state: overview, detail: 'Sync aborted in demo mode.' };
      }

      case 'CANCEL_SYNC_ITEM': {
        await demoDb.pages.update([request.documentId, request.pageId], {
          status: 'Pending',
        });
        return { ok: true, state: overview };
      }

      case 'PAIR_REMARKABLE': {
        authSummary = {
          ...authSummary,
          remarkablePaired: true,
          remarkablePairedAt: new Date().toISOString(),
        };
        const nextConfigured = authSummary.remarkablePaired && authSummary.microsoftConnected;
        notifyOverview({
          ...overview,
          remarkablePaired: true,
          isConfigured: nextConfigured,
        });
        return {
          ok: true,
          state: overview,
          detail: 'reMarkable paired successfully (simulated).',
        };
      }

      case 'VERIFY_REMARKABLE_SESSION': {
        return { ok: true, state: overview, detail: 'reMarkable session verified (simulated).' };
      }

      case 'DISCONNECT_REMARKABLE': {
        authSummary = { ...authSummary, remarkablePaired: false, remarkablePairedAt: null };
        notifyOverview({
          ...overview,
          remarkablePaired: false,
          isConfigured: false,
        });
        return { ok: true, state: overview, detail: 'Disconnected reMarkable (demo).' };
      }

      case 'SIGN_IN_MICROSOFT': {
        authSummary = {
          ...authSummary,
          microsoftConnected: true,
          microsoftAccount: 'demo.student@university.edu',
        };
        const nextConfigured = authSummary.remarkablePaired && authSummary.microsoftConnected;
        notifyOverview({
          ...overview,
          microsoftConnected: true,
          microsoftAccount: 'demo.student@university.edu',
          isConfigured: nextConfigured,
        });
        return {
          ok: true,
          state: overview,
          detail: 'Connected to Microsoft OneNote (simulated).',
        };
      }

      case 'VERIFY_MICROSOFT_SESSION': {
        return { ok: true, state: overview, detail: 'Microsoft session verified (simulated).' };
      }

      case 'SIGN_OUT_MICROSOFT': {
        authSummary = {
          ...authSummary,
          microsoftConnected: false,
          microsoftAccount: null,
        };
        notifyOverview({
          ...overview,
          microsoftConnected: false,
          microsoftAccount: null,
          isConfigured: false,
        });
        return { ok: true, state: overview, detail: 'Signed out of Microsoft (demo).' };
      }

      case 'SYNC_REMARKABLE_TREE': {
        return { ok: true, state: overview, detail: 'Cloud folder hierarchy refreshed (demo).' };
      }

      default:
        return { ok: true, state: overview };
    }
  }

  async function getAllDocs(): Promise<DocumentRecord[]> {
    const docs = await demoDb.documents.toArray();
    return docs.sort((a, b) => a.visibleName.localeCompare(b.visibleName));
  }

  async function getPrefs(): Promise<UserPreferences> {
    return { ...prefs };
  }

  async function updatePrefs(patch: Partial<UserPreferences>): Promise<UserPreferences> {
    prefs = { ...prefs, ...patch };
    return { ...prefs };
  }

  async function getWl(): Promise<SyncWhitelist> {
    return {
      syncFiles: [...whitelist.syncFiles],
      syncFolders: [...whitelist.syncFolders],
    };
  }

  async function setWl(nextWl: SyncWhitelist): Promise<SyncWhitelist> {
    whitelist = {
      syncFiles: [...nextWl.syncFiles],
      syncFolders: [...nextWl.syncFolders],
    };
    return { ...whitelist };
  }

  async function saveWhitelist(nextWl: SyncWhitelist): Promise<SaveWhitelistSelectionResult> {
    whitelist = {
      syncFiles: [...nextWl.syncFiles],
      syncFolders: [...nextWl.syncFolders],
    };

    const activeDocs = await demoDb.documents.toArray();
    const { effectiveDocIdsLower } = computeEffectiveWhitelistedDocIds(
      activeDocs,
      whitelist,
      prefs.autoAddNewFiles,
    );

    let pendingCount = 0;
    let skippedCount = 0;

    await demoDb.transaction('rw', demoDb.pages, async () => {
      const allPages = await demoDb.pages.toArray();
      for (const page of allPages) {
        const isWhitelisted = effectiveDocIdsLower.has(page.documentId.toLowerCase());
        if (isWhitelisted) {
          if (page.status === 'Skipped') {
            await demoDb.pages.update([page.documentId, page.pageId], { status: 'Pending' });
            pendingCount += 1;
          } else if (page.status === 'Pending') {
            pendingCount += 1;
          }
        } else {
          if (page.status === 'Pending' || page.status === 'Queued') {
            await demoDb.pages.update([page.documentId, page.pageId], { status: 'Skipped' });
            skippedCount += 1;
          }
        }
      }
    });

    return {
      savedWhitelist: { ...whitelist },
      updatedPagesCount: pendingCount + skippedCount,
      pendingPagesCount: pendingCount,
    };
  }

  async function getAuthSummary(): Promise<AuthStatusSummary> {
    return { ...authSummary };
  }

  function setInitialSetupState(unconfigured: boolean) {
    if (unconfigured) {
      authSummary = {
        ...authSummary,
        remarkablePaired: false,
        remarkablePairedAt: null,
        microsoftConnected: false,
        microsoftAccount: null,
        isConfigured: false,
      };
      notifyOverview({
        ...overview,
        remarkablePaired: false,
        microsoftConnected: false,
        microsoftAccount: null,
        isConfigured: false,
      });
    } else {
      authSummary = { ...DEMO_AUTH_SUMMARY };
      notifyOverview({ ...DEMO_OVERVIEW });
    }
  }

  return {
    isDemo: true,
    db: demoDb,
    sendMessage: handleSendMessage,
    getOverview: () => overview,
    setOverview: notifyOverview,
    getAllDocs,
    getPrefs,
    updatePrefs,
    getWl,
    setWl,
    saveWhitelist,
    getAuthSummary,
    setInitialSetupState,
  };
}
