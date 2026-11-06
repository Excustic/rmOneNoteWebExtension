import { useCallback, useEffect, useState } from 'react';
import { ext } from '../shared/browser';
import {
  DEFAULT_SYNC_OVERVIEW,
  type RuntimeResponse,
  type SyncOverviewState,
} from '../shared/messaging';
import { dismissBackupImportWarning } from '../storage/syncLedger';
import { Sidebar } from './components/Sidebar';
import { useHashRoute } from './hooks/useHashRoute';
import { DashboardView } from './views/DashboardView';
import { FileBrowserView } from './views/FileBrowserView';
import { SettingsView } from './views/SettingsView';
import { SetupView } from './views/SetupView';
import { SyncStatusView } from './views/SyncStatusView';

export function OptionsApp() {
  const { route, navigate } = useHashRoute();
  const [overview, setOverview] = useState<SyncOverviewState>(DEFAULT_SYNC_OVERVIEW);

  const refreshOverview = useCallback(async () => {
    try {
      const response = (await ext.runtime.sendMessage({
        type: 'GET_SYNC_OVERVIEW',
      })) as RuntimeResponse | undefined;

      if (response?.ok) {
        setOverview(response.state);
      }
    } catch (err) {
      console.error('[rmOneNote] Failed to load sync overview in options:', err);
    }
  }, []);

  useEffect(() => {
    void refreshOverview();
  }, [refreshOverview]);

  const handleDismissBackupWarning = useCallback(async () => {
    await dismissBackupImportWarning();
    await refreshOverview();
  }, [refreshOverview]);

  function renderActiveView() {
    switch (route) {
      case 'setup':
        return <SetupView onCancel={() => navigate('dashboard')} />;
      case 'files':
        return <FileBrowserView />;
      case 'sync-status':
        return <SyncStatusView overview={overview} />;
      case 'settings':
        return (
          <SettingsView
            overview={overview}
            onOpenSetup={() => navigate('setup')}
            onBackupStateChanged={() => void refreshOverview()}
          />
        );
      case 'dashboard':
      default:
        return (
          <DashboardView
            overview={overview}
            onNavigate={navigate}
            onDismissBackupWarning={() => void handleDismissBackupWarning()}
          />
        );
    }
  }

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900">
      <a
        href="#main-heading"
        className="visually-hidden fixed top-3 left-3 z-50 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white shadow-md"
      >
        Skip to main content
      </a>

      <Sidebar activeRoute={route} isConfigured={overview.isConfigured} />

      <main className="flex-1 overflow-y-auto p-8 lg:p-10">
        <div className="mx-auto max-w-5xl">{renderActiveView()}</div>
      </main>
    </div>
  );
}
