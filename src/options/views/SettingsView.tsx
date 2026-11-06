import { type ChangeEvent, type FormEvent, useEffect, useState } from 'react';
import { serializeDatabaseBackup } from '../../db/backup';
import type { SyncOverviewState } from '../../shared/messaging';
import {
  DEFAULT_USER_PREFERENCES,
  getPreferences,
  type UserPreferences,
  updatePreferences,
} from '../../storage/preferences';
import { importBackupAndReconcile } from '../../storage/syncLedger';

interface SettingsViewProps {
  overview: SyncOverviewState;
  onOpenSetup: () => void;
  onBackupStateChanged: () => void;
}

export function SettingsView({
  overview,
  onOpenSetup,
  onBackupStateChanged,
}: SettingsViewProps) {
  const [prefs, setPrefs] = useState<UserPreferences>(DEFAULT_USER_PREFERENCES);
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

  useEffect(() => {
    let active = true;
    void getPreferences().then((loaded) => {
      if (active) {
        setPrefs(loaded);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  async function handleSavePreferences(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setIsSaving(true);
    setSaveMessage(null);
    try {
      const saved = await updatePreferences(prefs);
      setPrefs(saved);
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
    <div className="space-y-6">
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

        <form className="mt-4 max-w-md space-y-4" onSubmit={(e) => void handleSavePreferences(e)}>
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
              Default OneNote section
            </label>
            <span id="target-section-hint" className="mt-0.5 block text-xs text-slate-500">
              Used when syncing root-level reMarkable notebooks that are not inside a folder.
            </span>
            <input
              id="target-section"
              name="targetSection"
              type="text"
              maxLength={49}
              required
              value={prefs.targetSection}
              onChange={(e) =>
                setPrefs((prev) => ({
                  ...prev,
                  targetSection: e.target.value,
                }))
              }
              aria-describedby="target-section-hint"
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-2xs"
            />
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
              className={`text-xs font-medium ${
                saveMessage?.isError ? 'text-red-700' : 'text-slate-600'
              }`}
            >
              {saveMessage?.text ?? ''}
            </p>
          </div>
        </form>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
        <h2 className="text-base font-semibold text-slate-900">
          Local Sync Database Backup & Transfer
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Browser sync storage holds the ~1,280 most recently synced pages. When setting up a new
          PC after exceeding that rolling window, export the local database JSON file from your
          previous PC and import it here so older synced pages are recognized immediately.
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
          className={`mt-3 text-xs font-medium ${
            backupFeedback?.isError ? 'text-red-700' : 'text-emerald-700'
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
