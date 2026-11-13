import { useCallback, useEffect, useState } from 'react';
import { ext, openOptionsAtRoute } from '../shared/browser';
import {
  DEFAULT_SYNC_OVERVIEW,
  type RuntimeResponse,
  type SyncOverviewState,
} from '../shared/messaging';
import { QuickStatusView } from './views/QuickStatusView';
import { UnconfiguredView } from './views/UnconfiguredView';

export function PopupApp() {
  const [overview, setOverview] = useState<SyncOverviewState>(DEFAULT_SYNC_OVERVIEW);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isAborting, setIsAborting] = useState(false);
  const [statusAnnouncement, setStatusAnnouncement] = useState('');

  useEffect(() => {
    let active = true;

    async function loadOverview() {
      try {
        const response = (await ext.runtime.sendMessage({
          type: 'GET_SYNC_OVERVIEW',
        })) as RuntimeResponse | undefined;

        if (active && response?.ok) {
          setOverview(response.state);
        }
      } catch (err) {
        console.error('[rmOneNote] Failed to query sync overview:', err);
      } finally {
        if (active) {
          setIsLoaded(true);
        }
      }
    }

    void loadOverview();

    return () => {
      active = false;
    };
  }, []);

  const handleManualSync = useCallback(async () => {
    setIsSyncing(true);
    try {
      const response = (await ext.runtime.sendMessage({
        type: 'TRIGGER_MANUAL_SYNC',
      })) as RuntimeResponse | undefined;

      if (response?.ok) {
        setOverview(response.state);
        setStatusAnnouncement('Manual sync check completed.');
      } else {
        setStatusAnnouncement(response?.error ?? 'Manual sync failed.');
      }
    } catch (err) {
      console.error('[rmOneNote] Manual sync trigger failed:', err);
      setStatusAnnouncement('Failed to reach background sync worker.');
    } finally {
      setIsSyncing(false);
    }
  }, []);

  const handleAbortSync = useCallback(async () => {
    setIsAborting(true);
    try {
      const response = (await ext.runtime.sendMessage({
        type: 'ABORT_SYNC',
      })) as RuntimeResponse | undefined;

      if (response?.ok) {
        setOverview(response.state);
        setIsSyncing(false);
        setStatusAnnouncement(response.detail ?? 'Sync aborted by user.');
      } else {
        setStatusAnnouncement(response?.error ?? 'Failed to abort sync.');
      }
    } catch (err) {
      console.error('[rmOneNote] Abort sync failed:', err);
      setStatusAnnouncement('Failed to reach background sync worker.');
    } finally {
      setIsAborting(false);
    }
  }, []);

  const isEngineBusy =
    isSyncing || (overview.phase !== 'Idle' && overview.phase !== 'Error');

  const handleOpenDashboard = useCallback(async () => {
    try {
      await ext.runtime.openOptionsPage();
    } catch {
      await openOptionsAtRoute('dashboard');
    }
  }, []);

  const handleOpenRoute = useCallback(async (route: string) => {
    await openOptionsAtRoute(route);
  }, []);

  return (
    <div className="flex min-h-[260px] flex-col bg-slate-50 text-slate-900">
      <header className="sidebar-region flex items-center justify-between border-b border-sidebar-border bg-sidebar px-4 py-3 text-white">
        <div className="flex items-center gap-3">
          <img
            src="/icons/icon-48.png"
            alt=""
            width={28}
            height={28}
            className="h-7 w-7 shrink-0 rounded object-contain"
          />
          <div>
            <h1 className="text-sm font-semibold leading-tight text-white">reMarkable Sync</h1>
            <p className="text-xs text-slate-400">OneNote Bridge</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleOpenDashboard()}
          className="min-h-6 rounded bg-sidebar-active px-2.5 py-1 text-xs font-medium text-slate-200 transition-colors hover:bg-sidebar-hover hover:text-white"
        >
          Open App
        </button>
      </header>

      <main className="flex flex-1 flex-col gap-3 p-4">
        {overview.needsBackupImport ? (
          <div
            role="status"
            className="rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-950"
          >
            <p className="font-semibold">Missing older sync history ({overview.missingHistoryCount})</p>
            <button
              type="button"
              onClick={() => void handleOpenRoute('settings')}
              className="mt-1 font-medium text-amber-900 underline underline-offset-2 hover:text-amber-950"
            >
              Import backup from previous PC
            </button>
          </div>
        ) : null}

        {!isLoaded ? (
          <div className="flex flex-1 items-center justify-center py-8 text-xs text-slate-500">
            Reading sync status...
          </div>
        ) : overview.isConfigured ? (
          <QuickStatusView
            overview={overview}
            isSyncing={isEngineBusy}
            isAborting={isAborting}
            onManualSync={() => void handleManualSync()}
            onAbortSync={() => void handleAbortSync()}
            onOpenRoute={(route) => void handleOpenRoute(route)}
          />
        ) : (
          <UnconfiguredView
            overview={overview}
            onStartSetup={() => void handleOpenRoute('setup')}
            onOpenDashboard={() => void handleOpenDashboard()}
          />
        )}
      </main>

      <div aria-live="polite" aria-atomic="true" className="visually-hidden">
        {statusAnnouncement}
      </div>

      <footer className="flex items-center justify-between border-t border-slate-200 bg-white px-4 py-2 text-[11px] text-slate-500">
        <span>v1.2.0</span>
        <button
          type="button"
          onClick={() => void handleOpenRoute('settings')}
          className="min-h-6 px-1 font-medium text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline"
        >
          Settings
        </button>
      </footer>
    </div>
  );
}
