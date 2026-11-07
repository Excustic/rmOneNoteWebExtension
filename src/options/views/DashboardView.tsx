import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { db } from '../../db/db';
import type { PageRecord } from '../../db/models';
import { ext } from '../../shared/browser';
import { LegacyIcon } from '../../shared/legacyIcons';
import type { RuntimeResponse, SyncOverviewState } from '../../shared/messaging';
import type { OptionsRouteId } from '../../shared/routes';
import {
  formatFileSize,
  formatSyncTimestamp,
  isPageActivelySyncing,
  SyncStatusBadge,
} from '../components/SyncStatusIcon';

interface DashboardViewProps {
  overview: SyncOverviewState;
  onNavigate: (route: OptionsRouteId) => void;
  onDismissBackupWarning: () => void;
  onSyncStateChanged: (nextOverview?: SyncOverviewState) => void;
}

type ActivityFilter = 'all' | 'uploaded' | 'active' | 'failed';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function DashboardView({
  overview,
  onNavigate,
  onDismissBackupWarning,
  onSyncStateChanged,
}: DashboardViewProps) {
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [feedback, setFeedback] = useState<{ isError: boolean; text: string } | null>(null);

  const pages = useLiveQuery(async () => db.pages.toArray(), [], [] as PageRecord[]);

  const overallCounts = useMemo(() => {
    let uploaded = 0;
    let pending = 0;
    let active = 0;
    let failed = 0;
    for (const p of pages) {
      if (p.status === 'Uploaded') uploaded++;
      else if (p.status === 'Pending') pending++;
      else if (p.status === 'Failed') failed++;
      else if (isPageActivelySyncing(p.status)) active++;
    }
    return { uploaded, pending, active, failed, total: pages.length };
  }, [pages]);

  const recentItems = useMemo(() => {
    const cutoffMs = Date.now() - THIRTY_DAYS_MS;
    return pages
      .filter((p) => {
        if (isPageActivelySyncing(p.status) || p.status === 'Failed') {
          return true;
        }
        if (p.status === 'Uploaded' && p.lastSyncTime) {
          const syncedMs = Date.parse(p.lastSyncTime);
          return !Number.isNaN(syncedMs) && syncedMs >= cutoffMs;
        }
        return false;
      })
      .sort((a, b) => {
        const aActive = isPageActivelySyncing(a.status) ? 1 : 0;
        const bActive = isPageActivelySyncing(b.status) ? 1 : 0;
        if (aActive !== bActive) {
          return bActive - aActive;
        }
        const aTime = a.lastSyncTime ? Date.parse(a.lastSyncTime) : Date.parse(a.lastModified);
        const bTime = b.lastSyncTime ? Date.parse(b.lastSyncTime) : Date.parse(b.lastModified);
        return (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime);
      });
  }, [pages]);

  const recentCounts = useMemo(() => {
    const map: Record<ActivityFilter, number> = {
      all: recentItems.length,
      uploaded: 0,
      active: 0,
      failed: 0,
    };
    for (const item of recentItems) {
      if (item.status === 'Uploaded') map.uploaded++;
      else if (item.status === 'Failed') map.failed++;
      else if (isPageActivelySyncing(item.status)) map.active++;
    }
    return map;
  }, [recentItems]);

  const filteredRecentItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return recentItems.filter((item) => {
      if (filter === 'uploaded' && item.status !== 'Uploaded') return false;
      if (filter === 'failed' && item.status !== 'Failed') return false;
      if (filter === 'active' && !isPageActivelySyncing(item.status)) return false;
      if (q && !item.virtualPath.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [recentItems, filter, searchQuery]);

  async function handleManualSync() {
    setIsSyncing(true);
    setFeedback(null);
    try {
      const response = (await ext.runtime.sendMessage({
        type: 'TRIGGER_MANUAL_SYNC',
      })) as RuntimeResponse | undefined;

      if (!response?.ok) {
        throw new Error(response?.error ?? 'Manual sync failed.');
      }

      onSyncStateChanged(response.state);
      setFeedback({
        isError: false,
        text: response.detail ?? 'Manual sync cycle completed.',
      });
    } catch (err) {
      setFeedback({
        isError: true,
        text: err instanceof Error ? err.message : 'Failed to trigger manual sync.',
      });
    } finally {
      setIsSyncing(false);
    }
  }

  async function handleSyncSinglePage(documentId: string, pageId: string) {
    setIsSyncing(true);
    setFeedback(null);
    try {
      const response = (await ext.runtime.sendMessage({
        type: 'MANUAL_SYNC_ITEMS',
        pages: [{ documentId, pageId }],
        runNow: true,
      })) as RuntimeResponse | undefined;

      if (!response?.ok) {
        throw new Error(response?.error ?? 'Failed to sync page.');
      }

      onSyncStateChanged(response.state);
      setFeedback({
        isError: false,
        text: response.detail ?? 'Page synchronized.',
      });
    } catch (err) {
      setFeedback({
        isError: true,
        text: err instanceof Error ? err.message : 'Failed to sync page.',
      });
    } finally {
      setIsSyncing(false);
    }
  }

  async function handleCancelPage(documentId: string, pageId: string) {
    try {
      const response = (await ext.runtime.sendMessage({
        type: 'CANCEL_SYNC_ITEM',
        documentId,
        pageId,
      })) as RuntimeResponse | undefined;

      if (response?.ok) {
        onSyncStateChanged(response.state);
      }
    } catch (err) {
      console.error('[rmOneNote] Cancel item failed:', err);
    }
  }

  const isEngineBusy =
    isSyncing || (overview.phase !== 'Idle' && overview.phase !== 'Error');

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 id="main-heading" tabIndex={-1} className="text-2xl font-semibold text-slate-900">
            Dashboard
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Overview of your reMarkable Cloud connection, OneNote target notebook, and 30-day sync
            activity.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {overview.isConfigured ? (
            <>
              <button
                type="button"
                onClick={() => onNavigate('sync-control')}
                className="min-h-10 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-100"
              >
                Open Sync Control
              </button>
              <button
                type="button"
                disabled={isEngineBusy}
                onClick={() => void handleManualSync()}
                className="inline-flex min-h-10 items-center gap-2 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-55"
              >
                <LegacyIcon
                  name="syncCycle"
                  className={`h-4 w-4 ${isEngineBusy ? 'status-spin' : ''}`}
                />
                <span>{isEngineBusy ? 'Syncing...' : 'Sync Now'}</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => onNavigate('setup')}
              className="min-h-10 rounded-md bg-brand px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-hover"
            >
              Configure Accounts
            </button>
          )}
        </div>
      </header>

      {feedback ? (
        <div
          role="status"
          aria-live="polite"
          className={`rounded-lg border px-4 py-3 text-xs font-medium ${
            feedback.isError
              ? 'border-rose-200 bg-rose-50 text-rose-700'
              : 'border-slate-200 bg-white text-slate-700'
          }`}
        >
          {feedback.text}
        </div>
      ) : null}

      {overview.needsBackupImport ? (
        <div
          role="status"
          className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-amber-950"
        >
          <h2 className="text-sm font-semibold">Older Sync History Omitted from Browser Sync</h2>
          <p className="mt-1 text-sm leading-relaxed text-amber-900">
            {overview.missingHistoryCount} older synced page record
            {overview.missingHistoryCount === 1 ? ' was' : 's were'} omitted from cross-browser sync
            storage due to extension quota limits. Before syncing on this PC, export a database
            backup file from your previous browser and import it in Settings to avoid re-uploading
            older pages.
          </p>
          <div className="mt-3.5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => onNavigate('settings')}
              className="min-h-9 rounded-md bg-amber-900 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-950"
            >
              Import Backup in Settings
            </button>
            <button
              type="button"
              onClick={onDismissBackupWarning}
              className="min-h-9 rounded-md border border-amber-400 bg-white px-3.5 py-1.5 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-100"
            >
              Dismiss Warning
            </button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
              Pipeline State
            </h2>
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                overview.phase === 'Error'
                  ? 'bg-rose-500'
                  : isEngineBusy
                    ? 'animate-pulse bg-blue-500'
                    : 'bg-emerald-500'
              }`}
              aria-hidden="true"
            />
          </div>
          <p className="mt-2 text-xl font-semibold text-slate-900">
            {isSyncing ? 'Syncing...' : overview.phase}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {overview.lastSyncedAt
              ? `Last synced: ${formatSyncTimestamp(overview.lastSyncedAt)}`
              : 'No sync cycle completed yet.'}
          </p>
          {overview.lastError ? (
            <p className="mt-1.5 text-xs font-medium text-rose-600">{overview.lastError}</p>
          ) : null}
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Account Pairing
          </h2>
          <p className="mt-2 text-xl font-semibold text-slate-900">
            {overview.isConfigured
              ? 'Connected'
              : overview.remarkablePaired || overview.microsoftConnected
                ? '1 of 2 Connected'
                : 'Pending'}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {overview.isConfigured
              ? `reMarkable paired${overview.microsoftAccount ? ` | ${overview.microsoftAccount}` : ' | Microsoft connected'}`
              : `reMarkable: ${overview.remarkablePaired ? 'Paired' : 'Unpaired'} | Microsoft: ${overview.microsoftConnected ? 'Connected' : 'Pending'}`}
          </p>
        </article>

        <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-2xs">
          <h2 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Synced & Indexed Pages
          </h2>
          <p className="mt-2 text-xl font-semibold text-slate-900">
            {overallCounts.uploaded}{' '}
            <span className="text-sm font-normal text-slate-500">
              / {overview.indexedPagesCount} pages uploaded
            </span>
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {overallCounts.pending} pending | {overallCounts.failed} failed
          </p>
        </article>
      </div>

      {/* Synced Activity (Last 30 Days) */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-2xs">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 id="recent-activity-heading" className="text-base font-semibold text-slate-900">
              Synced Activity (Last 30 Days)
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Pages uploaded to OneNote in the past 30 days, plus any active or failed sync items.
            </p>
          </div>

          <div className="w-full sm:w-64">
            <label htmlFor="dashboard-activity-search" className="visually-hidden">
              Search recent synced items
            </label>
            <input
              id="dashboard-activity-search"
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search notebook or page..."
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-brand focus:ring-1 focus:ring-brand focus:outline-none"
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5" role="group" aria-label="Filter recent activity">
          {(
            [
              ['all', 'All (30 Days)'],
              ['uploaded', 'Uploaded'],
              ['active', 'Active'],
              ['failed', 'Failed'],
            ] as const
          ).map(([id, label]) => {
            const activeTab = filter === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={activeTab}
                onClick={() => setFilter(id)}
                className={`inline-flex min-h-8 items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  activeTab
                    ? 'bg-slate-900 text-white'
                    : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                <span>{label}</span>
                <span
                  className={`rounded-full px-1.5 py-0.2 text-[10px] ${
                    activeTab ? 'bg-slate-700 text-slate-100' : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {recentCounts[id]}
                </span>
              </button>
            );
          })}
        </div>

        <div
          tabIndex={0}
          role="region"
          aria-labelledby="recent-activity-heading"
          className="scroll-region mt-4 max-h-[480px] overflow-x-auto rounded-lg border border-slate-200"
        >
          <table className="w-full border-collapse text-left text-xs">
            <caption className="visually-hidden">
              Items synchronized with OneNote in the last 30 days
            </caption>
            <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">
              <tr>
                <th scope="col" className="px-4 py-3">
                  Notebook / Page
                </th>
                <th scope="col" className="px-4 py-3">
                  Status
                </th>
                <th scope="col" className="px-4 py-3">
                  Synced Time
                </th>
                <th scope="col" className="px-4 py-3">
                  OneNote Link
                </th>
                <th scope="col" className="px-4 py-3 text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 bg-white">
              {filteredRecentItems.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-500">
                    {recentItems.length === 0
                      ? 'No pages have been synced in the last 30 days yet. Select notebooks in Sync Control and click "Sync Now".'
                      : 'No recent activity items match the selected filter.'}
                  </td>
                </tr>
              ) : (
                filteredRecentItems.map((page) => {
                  const active = isPageActivelySyncing(page.status);
                  return (
                    <tr
                      key={`${page.documentId}:${page.pageId}`}
                      className="transition-colors hover:bg-slate-50/70"
                    >
                      <th scope="row" className="px-4 py-3 font-medium text-slate-900">
                        <div className="line-clamp-1 font-medium">{page.virtualPath}</div>
                        <div className="mt-0.5 text-[11px] font-normal text-slate-400">
                          Page ID: {page.pageId.slice(0, 8)}... |{' '}
                          {formatFileSize(page.fileSizeBytes)}
                        </div>
                      </th>
                      <td className="px-4 py-3">
                        <SyncStatusBadge status={page.status} />
                        {page.lastError ? (
                          <p className="mt-1 line-clamp-1 text-[11px] text-rose-600">
                            {page.lastError}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-slate-600">
                        {page.lastSyncTime
                          ? formatSyncTimestamp(page.lastSyncTime)
                          : `Modified: ${formatSyncTimestamp(page.lastModified)}`}
                      </td>
                      <td className="px-4 py-3">
                        {page.oneNotePageUrl ? (
                          <a
                            href={page.oneNotePageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-medium text-brand underline underline-offset-2 hover:text-brand-hover"
                          >
                            Open in OneNote
                          </a>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {active ? (
                          <button
                            type="button"
                            onClick={() => void handleCancelPage(page.documentId, page.pageId)}
                            className="min-h-7 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100"
                          >
                            Cancel
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={isEngineBusy || !overview.isConfigured}
                            onClick={() =>
                              void handleSyncSinglePage(page.documentId, page.pageId)
                            }
                            aria-label={`${page.status === 'Failed' ? 'Retry' : 'Re-sync'} ${page.virtualPath}`}
                            className="inline-flex min-h-7 items-center gap-1 rounded border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <LegacyIcon name="syncCycle" className="h-3 w-3 text-slate-500" />
                            <span>{page.status === 'Failed' ? 'Retry' : 'Sync'}</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
