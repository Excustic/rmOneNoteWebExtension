import { type ChangeEvent, type FormEvent, useEffect, useState } from 'react';
import { serializeDatabaseBackup } from '../../db/backup';
import type { SyncOverviewState } from '../../shared/messaging';
import {
  DEFAULT_CONTAINER_WIDTH_PX,
  DEFAULT_USER_PREFERENCES,
  isLocalStorageOnly,
  MAX_CONTAINER_WIDTH_PX,
  MIN_CONTAINER_WIDTH_PX,
  onSyncStorageChanged,
  setLocalStorageOnly,
  type UserPreferences,
} from '../../storage/preferences';
import { importBackupAndReconcile } from '../../storage/syncLedger';
import { formatSyncTimestamp } from '../components/SyncStatusIcon';
import { useDataSource } from '../context/DataSourceContext';

interface SettingsViewProps {
  overview: SyncOverviewState;
  containerWidthPx?: number;
  onContainerWidthChange?: (widthPx: number, persist?: boolean) => void;
  onOpenSetup: () => void;
  onBackupStateChanged: () => void;
}

export function SettingsView({
  overview,
  containerWidthPx,
  onContainerWidthChange,
  onOpenSetup,
  onBackupStateChanged,
}: SettingsViewProps) {
  const { getPrefs, updatePrefs } = useDataSource();
  const [prefs, setPrefs] = useState<UserPreferences>(DEFAULT_USER_PREFERENCES);
  const [localWidth, setLocalWidth] = useState<number>(
    containerWidthPx ?? DEFAULT_CONTAINER_WIDTH_PX
  );
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{
    isError: boolean;
    text: string;
  } | null>(null);
  const [backupFeedback, setBackupFeedback] = useState<{
    isError: boolean;
    text: string;
  } | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [localStorageOnly, setLocalStorageOnlyState] = useState<boolean>(overview.localStorageOnly);
  const [isMigratingStorage, setIsMigratingStorage] = useState(false);
  const [storageFeedback, setStorageFeedback] = useState<{
    isError: boolean;
    text: string;
  } | null>(null);

  useEffect(() => {
    void isLocalStorageOnly().then((val) => setLocalStorageOnlyState(val));
  }, []);

  async function handleToggleLocalStorageOnly(e: ChangeEvent<HTMLInputElement>) {
    const nextVal = e.target.checked;
    setIsMigratingStorage(true);
    setStorageFeedback(null);
    try {
      await setLocalStorageOnly(nextVal);
      setLocalStorageOnlyState(nextVal);
      onBackupStateChanged();
      setStorageFeedback({
        isError: false,
        text: nextVal
          ? 'Local-only storage active. Settings and history will remain strictly on this device.'
          : 'Browser cloud sync active. Settings and history will sync across your browser profile.',
      });
    } catch (err) {
      setStorageFeedback({
        isError: true,
        text: err instanceof Error ? err.message : 'Failed to update storage mode.',
      });
    } finally {
      setIsMigratingStorage(false);
    }
  }

  useEffect(() => {
    if (typeof containerWidthPx === 'number') {
      setLocalWidth(containerWidthPx);
      setPrefs((prev) =>
        prev.containerWidthPx === containerWidthPx
          ? prev
          : { ...prev, containerWidthPx }
      );
    }
  }, [containerWidthPx]);

  useEffect(() => {
    let active = true;
    void getPrefs().then((loaded) => {
      if (active) {
        setPrefs(loaded);
        setLocalWidth(loaded.containerWidthPx);
      }
    });

    const unsubscribe = onSyncStorageChanged(() => {
      void getPrefs().then((loaded) => {
        if (active) {
          setPrefs(loaded);
          setLocalWidth(loaded.containerWidthPx);
        }
      });
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [getPrefs]);

  async function handleSavePreferences(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsSaving(true);
    setSaveMessage(null);
    try {
      const saved = await updatePrefs({
        ...prefs,
        containerWidthPx: localWidth,
      });
      setPrefs(saved);
      setLocalWidth(saved.containerWidthPx);
      onContainerWidthChange?.(saved.containerWidthPx, false);
      setSaveMessage({
        isError: false,
        text: 'Preferences saved to synced browser storage.',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save preferences.';
      setSaveMessage({
        isError: true,
        text: msg,
      });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleExportBackup() {
    setIsBusy(true);
    setBackupFeedback(null);
    try {
      const json = await serializeDatabaseBackup();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const stamp = new Date().toISOString().slice(0, 10);

      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `rm-onenote-sync-backup-${stamp}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);

      setBackupFeedback({
        isError: false,
        text: 'Database backup file exported.',
      });
    } catch (err) {
      setBackupFeedback({
        isError: true,
        text: err instanceof Error ? err.message : 'Failed to export database backup.',
      });
    } finally {
      setIsBusy(false);
    }
  }

  async function handleImportBackupFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) {
      return;
    }

    setIsBusy(true);
    setBackupFeedback(null);
    try {
      const rawJson = await file.text();
      const summary = await importBackupAndReconcile(rawJson);
      onBackupStateChanged();
      setBackupFeedback({
        isError: false,
        text: `Imported ${summary.pagesImported} pages, ${summary.documentsImported} documents, and ${summary.notebooksImported} cached notebooks.`,
      });
    } catch (err) {
      setBackupFeedback({
        isError: true,
        text: err instanceof Error ? err.message : 'Failed to import database backup.',
      });
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <div data-tour="settings-container" className="space-y-6">
      <header>
        <h1 id="main-heading" tabIndex={-1} className="text-2xl font-semibold text-slate-900">
          Settings
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Configure autonomous sync cadence, cross-browser preferences, and local database backups.
        </p>
      </header>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
        <h2 className="text-base font-semibold text-slate-900">Sync Schedule & Defaults</h2>
        <p className="mt-1 text-xs text-slate-500">
          Synced automatically across browsers signed into the same profile via extension sync
          storage.
        </p>

        <form className="mt-4 max-w-xl space-y-4" onSubmit={(e) => void handleSavePreferences(e)}>
          <div>
            <label
              htmlFor="sync-interval-minutes"
              className="block text-sm font-medium text-slate-700"
            >
              Sync interval (minutes)
            </label>
            <span id="sync-interval-hint" className="mt-0.5 block text-xs text-slate-500">
              Minimum interval supported by browser background alarms is 1 minute.
            </span>
            <input
              id="sync-interval-minutes"
              name="syncIntervalMinutes"
              type="number"
              min={1}
              max={1440}
              required
              value={prefs.syncIntervalMinutes}
              onChange={(e) =>
                setPrefs((prev) => ({
                  ...prev,
                  syncIntervalMinutes: Number(e.target.value) || 1,
                }))
              }
              aria-describedby="sync-interval-hint"
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-2xs"
            />
          </div>

          <div>
            <label htmlFor="target-section" className="block text-sm font-medium text-slate-700">
              Root notebooks Conversion
            </label>
            <span id="target-section-hint" className="mt-0.5 block text-xs text-slate-500">
              Choose a name for the OneNote notebook that will store the converted notebooks at root-level (homescreen). If left blank, each root notebook will be converted into its own OneNote notebook.
            </span>
            <input
              id="target-section"
              name="targetSection"
              type="text"
              maxLength={49}
              placeholder="Documents (leave blank for individual notebooks)"
              value={prefs.targetSection}
              onChange={(e) =>
                setPrefs((prev) => ({
                  ...prev,
                  targetSection: e.target.value,
                }))
              }
              aria-describedby="target-section-hint"
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-2xs placeholder:text-slate-400"
            />
          </div>

          <div>
            <label
              htmlFor="max-section-pages-query-limit"
              className="block text-sm font-medium text-slate-700"
            >
              OneNote section scan limit
            </label>
            <span
              id="max-section-pages-query-limit-hint"
              className="mt-0.5 block text-xs text-slate-500"
            >
              Notebook pages limit. Defaults to 300 pages (range: 20 – 1000). If limit is reached, synchronisation isn't guaranteed for all pages, and duplicates may appear.
            </span>
            <input
              id="max-section-pages-query-limit"
              name="maxSectionPagesQueryLimit"
              type="number"
              min={20}
              max={1000}
              step={10}
              required
              value={prefs.maxSectionPagesQueryLimit}
              onChange={(e) =>
                setPrefs((prev) => ({
                  ...prev,
                  maxSectionPagesQueryLimit: Number(e.target.value) || 300,
                }))
              }
              aria-describedby="max-section-pages-query-limit-hint"
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-2xs"
            />
          </div>

          <div data-tour="settings-lifecycle-strategy">
            <label
              htmlFor="page-sync-strategy"
              className="block text-sm font-medium text-slate-700"
            >
              Page Deletion &amp; Reordering Strategy
            </label>
            <span id="page-sync-strategy-hint" className="mt-0.5 block text-xs text-slate-500">
              Determines how deletions and page reordering on your reMarkable tablet are reflected in OneNote.
            </span>
            <select
              id="page-sync-strategy"
              name="pageSyncStrategy"
              value={prefs.pageSyncStrategy}
              onChange={(e) =>
                setPrefs((prev) => ({
                  ...prev,
                  pageSyncStrategy: e.target.value as 'mirror' | 'preserve',
                }))
              }
              aria-describedby="page-sync-strategy-hint"
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-2xs"
            >
              <option value="mirror">
                Mirror reMarkable lifecycle (Recommended)
              </option>
              <option value="preserve">
                Preserve OneNote history (Static / Append-only)
              </option>
            </select>
            <p className="mt-1 text-xs text-slate-500">
              {prefs.pageSyncStrategy === 'mirror'
                ? 'Mirror mode automatically deletes OneNote pages when they are removed on your tablet, and updates OneNote page titles when pages are reordered.'
                : 'Preserve mode keeps OneNote completely static. OneNote pages are never deleted, reordered pages do not overwrite existing pages (page title collisions are suffixed with count numbers), and tablet status is indicated in Sync Control.'}
            </p>
          </div>

          <div data-tour="settings-sync-concurrency">
            <label
              htmlFor="sync-concurrency-input"
              className="block text-sm font-medium text-slate-700"
            >
              Concurrent upload workers
            </label>
            <span id="sync-concurrency-hint" className="mt-0.5 block text-xs text-slate-500">
              Number of simultaneous page upload workers (range: 1 – 5, default: 3).
              Setting to 1 processes pages strictly sequentially one by one. A higher value may result in more frequent upload failures due to OneNote limits.
            </span>
            <input
              id="sync-concurrency-input"
              name="syncConcurrency"
              type="number"
              min={1}
              max={5}
              step={1}
              required
              value={prefs.syncConcurrency}
              onChange={(e) =>
                setPrefs((prev) => ({
                  ...prev,
                  syncConcurrency: Number(e.target.value) || 3,
                }))
              }
              aria-describedby="sync-concurrency-hint"
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-2xs"
            />
          </div>

          <div data-tour="settings-width-control">
            <label
              htmlFor="container-width-range"
              className="block text-sm font-medium text-slate-700"
            >
              Dashboard Width
            </label>
            <span id="container-width-hint" className="mt-0.5 block text-xs text-slate-500">
              Set the maximum container width. You can also drag the subtle edge dividers on either
              side of the main container ({MIN_CONTAINER_WIDTH_PX}px – {MAX_CONTAINER_WIDTH_PX}px).
            </span>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <input
                id="container-width-range"
                type="range"
                min={MIN_CONTAINER_WIDTH_PX}
                max={MAX_CONTAINER_WIDTH_PX}
                step={20}
                aria-describedby="container-width-hint"
                value={localWidth}
                onChange={(e) => {
                  const next = parseInt(e.target.value, 10) || DEFAULT_CONTAINER_WIDTH_PX;
                  setLocalWidth(next);
                  setPrefs((prev) => ({
                    ...prev,
                    containerWidthPx: next,
                  }));
                }}
                onPointerUp={() => onContainerWidthChange?.(localWidth, true)}
                onMouseUp={() => onContainerWidthChange?.(localWidth, true)}
                onTouchEnd={() => onContainerWidthChange?.(localWidth, true)}
                onKeyUp={(e) => {
                  if (
                    [
                      'ArrowLeft',
                      'ArrowRight',
                      'ArrowUp',
                      'ArrowDown',
                      'PageUp',
                      'PageDown',
                      'Home',
                      'End',
                    ].includes(e.key)
                  ) {
                    onContainerWidthChange?.(localWidth, true);
                  }
                }}
                style={{ width: '220px', cursor: 'pointer' }}
                className="accent-brand"
              />
              <span className="min-w-[4.25rem] text-right font-mono text-sm font-semibold text-slate-800">
                {localWidth}px
              </span>
              <button
                type="button"
                onClick={() => {
                  setLocalWidth(DEFAULT_CONTAINER_WIDTH_PX);
                  setPrefs((prev) => ({
                    ...prev,
                    containerWidthPx: DEFAULT_CONTAINER_WIDTH_PX,
                  }));
                  onContainerWidthChange?.(DEFAULT_CONTAINER_WIDTH_PX, true);
                }}
                className="rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100"
              >
                Reset to Default ({DEFAULT_CONTAINER_WIDTH_PX}px)
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <input
              id="auto-sync-enabled"
              name="autoSync"
              type="checkbox"
              checked={prefs.autoSync}
              onChange={(e) =>
                setPrefs((prev) => ({
                  ...prev,
                  autoSync: e.target.checked,
                }))
              }
              className="h-4 w-4 rounded border-slate-300 accent-brand"
            />
            <label
              htmlFor="auto-sync-enabled"
              className="py-1 text-sm font-medium text-slate-700"
            >
              Enable autonomous background sync
            </label>
          </div>

          <div className="flex items-center gap-2.5">
            <input
              id="auto-add-new-files"
              name="autoAddNewFiles"
              type="checkbox"
              checked={prefs.autoAddNewFiles}
              onChange={(e) =>
                setPrefs((prev) => ({
                  ...prev,
                  autoAddNewFiles: e.target.checked,
                }))
              }
              className="h-4 w-4 rounded border-slate-300 accent-brand"
            />
            <label
              htmlFor="auto-add-new-files"
              className="py-1 text-sm font-medium text-slate-700"
            >
              Automatically sync new notebooks created inside whitelisted folders
            </label>
          </div>

          <div className="flex items-center gap-2.5">
            <input
              id="sync-unannotated-pdf-pages"
              name="syncUnannotatedPdfPages"
              type="checkbox"
              checked={prefs.syncUnannotatedPdfPages}
              onChange={(e) =>
                setPrefs((prev) => ({
                  ...prev,
                  syncUnannotatedPdfPages: e.target.checked,
                }))
              }
              className="h-4 w-4 rounded border-slate-300 accent-brand"
            />
            <label
              htmlFor="sync-unannotated-pdf-pages"
              className="py-1 text-sm font-medium text-slate-700"
            >
              Auto-sync unannotated (blank) PDF background pages (disabled by default to save storage)
            </label>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={isSaving}
              className="min-h-9 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-60"
            >
              {isSaving ? 'Saving...' : 'Save Preferences'}
            </button>
            <p
              aria-live="polite"
              className={`text-xs font-medium ${saveMessage?.isError ? 'text-red-700' : 'text-slate-600'
                }`}
            >
              {saveMessage?.text ?? ''}
            </p>
          </div>
        </form>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">
            Browser Profile Cloud Storage &amp; Privacy
          </h2>
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${localStorageOnly
              ? 'border border-slate-300 bg-slate-100 text-slate-700'
              : 'border border-emerald-200 bg-emerald-50 text-emerald-700'
              }`}
          >
            {localStorageOnly ? 'Local Device Only' : 'Cloud Synced'}
          </span>
        </div>

        <p className="mt-1 text-sm text-slate-600">
          By default, extension preferences, notebook selection whitelist, and rolling sync history are
          synchronized across your devices using your browser account profile cloud (Google Chrome Sync or Firefox Sync).
        </p>

        <div className="mt-4 flex items-start gap-3">
          <input
            id="local-storage-only-toggle"
            name="localStorageOnly"
            type="checkbox"
            checked={localStorageOnly}
            disabled={isMigratingStorage}
            onChange={(e) => void handleToggleLocalStorageOnly(e)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-brand"
          />
          <div>
            <label
              htmlFor="local-storage-only-toggle"
              className="cursor-pointer text-sm font-medium text-slate-900"
            >
              Local-only storage mode (Opt out of browser profile cloud sync)
            </label>
            <p className="text-xs text-slate-500">
              When enabled, your preferences and sync records are stored strictly on this machine (storage.local).
              No settings or sync data will be sent to browser vendor account servers.
            </p>
            {!localStorageOnly && overview.cloudStorageUpdatedAt ? (
              <p className="mt-1 text-xs text-slate-400">
                Last browser cloud sync: {formatSyncTimestamp(overview.cloudStorageUpdatedAt)}
              </p>
            ) : null}
          </div>
        </div>

        {storageFeedback ? (
          <p
            role="status"
            className={`mt-3 text-xs font-medium ${storageFeedback.isError ? 'text-red-700' : 'text-emerald-700'
              }`}
          >
            {storageFeedback.text}
          </p>
        ) : null}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
        <h2 className="text-base font-semibold text-slate-900">
          Local Sync Database Backup & Transfer
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Migrate your sync history to a new device/browser.
          <br></br>
          <br></br>
          <b style={{ color: 'orange' }}>
            Note
          </b>
          <br></br>
          The extension supports up to 1280 pages in the browser's sync (cross-device) storage.
          When installing the extension on a new platform, you will be notified whether a local import is required to restore full sync history.
          If you ignore this notification, the extension will not remember older pages excluded from the sync storage.
        </p>

        {overview.needsBackupImport ? (
          <p
            role="status"
            className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs font-medium text-amber-950"
          >
            This browser detected {overview.missingHistoryCount} older synced page record
            {overview.missingHistoryCount === 1 ? '' : 's'} omitted from sync storage. Import a
            backup file from your previous PC below.
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={isBusy}
            onClick={() => void handleExportBackup()}
            className="min-h-9 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:opacity-60"
          >
            Export Database (.json)
          </button>

          <div>
            <input
              id="import-backup-input"
              name="backupFile"
              type="file"
              accept="application/json,.json"
              disabled={isBusy}
              onChange={(e) => void handleImportBackupFile(e)}
              className="peer sr-only"
            />
            <label
              htmlFor="import-backup-input"
              className="inline-flex min-h-9 cursor-pointer items-center rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand peer-disabled:cursor-not-allowed peer-disabled:opacity-60"
            >
              Import Database (.json)
            </label>
          </div>
        </div>

        <p
          aria-live="polite"
          className={`mt-3 text-xs font-medium ${backupFeedback?.isError ? 'text-red-700' : 'text-emerald-700'
            }`}
        >
          {backupFeedback?.text ?? ''}
        </p>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
        <h2 className="text-base font-semibold text-slate-900">Connected Accounts</h2>
        <p className="mt-1 text-sm text-slate-600">
          Re-run onboarding to pair a new reMarkable device token or refresh Microsoft Graph
          consent.
        </p>
        <button
          type="button"
          onClick={onOpenSetup}
          className="mt-4 min-h-9 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100"
        >
          Open Account Setup
        </button>
      </section>
    </div>
  );
}
