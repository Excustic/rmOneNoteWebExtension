import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useId, useMemo, useState } from 'react';
import { db } from '../../db/db';
import type { PageRecord, PageSyncStatus } from '../../db/models';
import { ext } from '../../shared/browser';
import { LegacyIcon } from '../../shared/legacyIcons';
import type { RuntimeResponse, SyncOverviewState } from '../../shared/messaging';

interface SyncStatusViewProps {
  overview: SyncOverviewState;
  onSyncStateChanged?: (nextOverview?: SyncOverviewState) => void;
}

type StatusFilter = 'All' | 'Pending' | 'Active' | 'Uploaded' | 'Failed' | 'Skipped';

const ACTIVE_STATUSES: readonly PageSyncStatus[] = [
  'Queued',
  'Converting',
  'Uploading',
  'Indexing',
];

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'Not yet synced';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  return new Date(parsed).toLocaleString();
}

function getStatusBadgeClasses(status: PageSyncStatus): string {
  switch (status) {
    case 'Uploaded':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700';
    case 'Pending':
      return 'border-amber-200 bg-amber-50 text-amber-700';
    case 'Queued':
      return 'border-blue-200 bg-blue-50 text-blue-700';
    case 'Converting':
      return 'border-sky-200 bg-sky-50 text-sky-700';
    case 'Uploading':
      return 'border-indigo-200 bg-indigo-50 text-indigo-700';
    case 'Indexing':
      return 'border-purple-200 bg-purple-50 text-purple-700';
    case 'Failed':
      return 'border-rose-200 bg-rose-50 text-rose-700';
    case 'Skipped':
    case 'Deleted':
    default:
      return 'border-slate-200 bg-slate-100 text-slate-600';
  }
}

export function SyncStatusView({ overview, onSyncStateChanged }: SyncStatusViewProps) {
  const tableCaptionId = useId();
  const [filter, setFilter] = useState<StatusFilter>('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [actingPageKey, setActingPageKey] = useState<string | null>(null);

  const pages = useLiveQuery(async () => {
    return db.pages.toArray();
  }, []);

  const counts = useMemo(() => {
    const list = pages ?? [];
    let pending = 0;
    let active = 0;
    let uploaded = 0;
    let failed = 0;
    let skipped = 0;

    for (const page of list) {
      if (page.status === 'Pending') pending++;
      else if (ACTIVE_STATUSES.includes(page.status)) active++;
      else if (page.status === 'Uploaded') uploaded++;
      else if (page.status === 'Failed') failed++;
      else skipped++;
    }

    return {
      all: list.length,
      pending,
      active,
      uploaded,
      failed,
      skipped,
    };
  }, [pages]);

  const filteredPages = useMemo(() => {
    if (!pages) return [];
    let result = pages;

    if (filter === 'Pending') {
      result = result.filter((p) => p.status === 'Pending');
    } else if (filter === 'Active') {
      result = result.filter((p) => ACTIVE_STATUSES.includes(p.status));
    } else if (filter === 'Uploaded') {
      result = result.filter((p) => p.status === 'Uploaded');
    } else if (filter === 'Failed') {
      result = result.filter((p) => p.status === 'Failed');
    } else if (filter === 'Skipped') {
      result = result.filter((p) => p.status === 'Skipped' || p.status === 'Deleted');
    }

    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      result = result.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.virtualPath.toLowerCase().includes(q) ||
          p.pageNumber.toLowerCase().includes(q),
      );
    }

    // Sort: Active first, then Failed, then Pending, then Uploaded, then Skipped
    const statusPriority: Record<PageSyncStatus, number> = {
      Converting: 1,
      Uploading: 2,
      Indexing: 3,
      Queued: 4,
      Failed: 5,
      Pending: 6,
      Uploaded: 7,
      Skipped: 8,
      Deleted: 9,
    };

    return [...result].sort((a, b) => {
      const diff = (statusPriority[a.status] ?? 99) - (statusPriority[b.status] ?? 99);
      if (diff !== 0) return diff;
      return a.virtualPath.localeCompare(b.virtualPath);
    });
  }, [pages, filter, searchQuery]);

  const handleManualSync = useCallback(async () => {
    setIsSyncing(true);
    setFeedback(null);
    try {
      const response = (await ext.runtime.sendMessage({
        type: 'TRIGGER_MANUAL_SYNC',
      })) as RuntimeResponse | undefined;

      if (response?.ok) {
        setFeedback(response.detail ?? 'Sync completed successfully.');
        onSyncStateChanged?.(response.state);
      } else {
        setFeedback(response?.error ?? 'Failed to execute sync cycle.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to reach background sync worker.';
      setFeedback(msg);
    } finally {
      setIsSyncing(false);
    }
  }, [onSyncStateChanged]);

  const handleRetryAllFailed = useCallback(async () => {
    setIsSyncing(true);
    setFeedback(null);
    try {
      const response = (await ext.runtime.sendMessage({
        type: 'RETRY_FAILED_PAGES',
        runNow: true,
      })) as RuntimeResponse | undefined;

      if (response?.ok) {
        setFeedback(response.detail ?? 'Failed pages re-queued and retried.');
        onSyncStateChanged?.(response.state);
      } else {
        setFeedback(response?.error ?? 'Retry operation failed.');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to retry failed pages.';
      setFeedback(msg);
    } finally {
      setIsSyncing(false);
    }
  }, [onSyncStateChanged]);

  const handleRetrySinglePage = useCallback(
    async (documentId: string, pageId: string) => {
      const key = `${documentId}:${pageId}`;
      setActingPageKey(key);
      try {
        const response = (await ext.runtime.sendMessage({
          type: 'RETRY_FAILED_PAGES',
          documentId,
          pageId,
          runNow: true,
        })) as RuntimeResponse | undefined;

        if (response?.ok) {
          onSyncStateChanged?.(response.state);
        } else {
          setFeedback(response?.error ?? 'Failed to retry page.');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error retrying page.';
        setFeedback(msg);
      } finally {
        setActingPageKey(null);
      }
    },
    [onSyncStateChanged],
  );

  const handleCancelSinglePage = useCallback(
    async (documentId: string, pageId: string) => {
      const key = `${documentId}:${pageId}`;
      setActingPageKey(key);
      try {
        const response = (await ext.runtime.sendMessage({
          type: 'CANCEL_SYNC_ITEM',
          documentId,
          pageId,
        })) as RuntimeResponse | undefined;

        if (response?.ok) {
          onSyncStateChanged?.(response.state);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error cancelling page.';
        setFeedback(msg);
      } finally {
        setActingPageKey(null);
      }
    },
    [onSyncStateChanged],
  );

  const isEngineActive = overview.phase !== 'Idle' || isSyncing;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 id="main-heading" tabIndex={-1} className="text-2xl font-semibold text-slate-900">
            Sync Status
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            Live page conversion states, background engine queue, and verified OneNote links.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-2xs">
            <span
              className={`h-2 w-2 rounded-full ${
                overview.phase === 'Error'
                  ? 'bg-rose-500'
                  : overview.phase !== 'Idle'
                    ? 'animate-pulse bg-blue-500'
                    : 'bg-emerald-500'
              }`}
              aria-hidden="true"
            />
            Engine: {overview.phase}
          </span>

          {counts.failed > 0 ? (
            <button
              type="button"
              disabled={isEngineActive}
              onClick={() => void handleRetryAllFailed()}
              className="min-h-9 rounded-md border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 transition-colors hover:bg-rose-100 disabled:opacity-50"
            >
              Retry Failed ({counts.failed})
            </button>
          ) : null}

          <button
            type="button"
            disabled={isEngineActive || !overview.isConfigured}
            onClick={() => void handleManualSync()}
            className="inline-flex min-h-9 items-center gap-2 rounded-md bg-brand px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <LegacyIcon
              name="syncCycle"
              className={`h-3.5 w-3.5 ${isEngineActive ? 'animate-spin' : ''}`}
            />
            <span>{isEngineActive ? 'Syncing...' : 'Sync Now'}</span>
          </button>
        </div>
      </header>

      {feedback ? (
        <div
          role="status"
          className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-700"
        >
          {feedback}
        </div>
      ) : null}

      {/* Filter Tabs and Search Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              ['All', counts.all],
              ['Pending', counts.pending],
              ['Active', counts.active],
              ['Uploaded', counts.uploaded],
              ['Failed', counts.failed],
              ['Skipped', counts.skipped],
            ] as const
          ).map(([tabKey, tabCount]) => {
            const isActive = filter === tabKey;
            return (
              <button
                key={tabKey}
                type="button"
                onClick={() => setFilter(tabKey)}
                className={`inline-flex min-h-8 items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-medium transition-colors ${
                  isActive
                    ? 'bg-slate-900 text-white shadow-2xs'
                    : 'border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`}
              >
                <span>{tabKey}</span>
                <span
                  className={`rounded-full px-1.5 py-0.2 text-[10px] ${
                    isActive ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  {tabCount}
                </span>
              </button>
            );
          })}
        </div>

        <div className="w-full sm:w-64">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search notebook or page..."
            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-900 shadow-2xs placeholder:text-slate-400 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>
      </div>

      {/* Pages Data Table */}
      <div
        tabIndex={0}
        role="region"
        aria-labelledby={tableCaptionId}
        className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-2xs"
      >
        <table className="w-full border-collapse text-left text-sm">
          <caption id={tableCaptionId} className="visually-hidden">
            Synchronized reMarkable pages and sync statuses
          </caption>
          <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide text-slate-600 uppercase">
            <tr>
              <th scope="col" className="px-5 py-3.5">
                Notebook / Page
              </th>
              <th scope="col" className="px-5 py-3.5">
                Stage
              </th>
              <th scope="col" className="px-5 py-3.5">
                Last Synced / Modified
              </th>
              <th scope="col" className="px-5 py-3.5">
                OneNote Link
              </th>
              <th scope="col" className="px-5 py-3.5 text-right">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {pages === undefined ? (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-sm text-slate-500">
                  Loading pages from local database...
                </td>
              </tr>
            ) : filteredPages.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-sm text-slate-500">
                  {pages.length === 0 ? (
                    <div className="space-y-2">
                      <p className="font-medium text-slate-700">No pages recorded in local sync database yet.</p>
                      <p className="text-xs text-slate-500">
                        Go to the File Browser, select folders or notebooks, and click &quot;Save Selection&quot; to populate pages.
                      </p>
                    </div>
                  ) : (
                    <p>No pages match the current filter (&quot;{filter}&quot;).</p>
                  )}
                </td>
              </tr>
            ) : (
              filteredPages.map((page: PageRecord) => {
                const pageKey = `${page.documentId}:${page.pageId}`;
                const isActing = actingPageKey === pageKey;

                return (
                  <tr key={pageKey} className="transition-colors hover:bg-slate-50/70">
                    <th scope="row" className="px-5 py-3.5 font-normal">
                      <div className="flex flex-col">
                        <span className="font-medium text-slate-900">{page.virtualPath}</span>
                        <span className="text-xs text-slate-400">
                          Page ID: {page.pageId.slice(0, 8)}... | Size: {formatBytes(page.fileSizeBytes)}
                        </span>
                      </div>
                    </th>

                    <td className="px-5 py-3.5">
                      <div className="flex flex-col gap-1">
                        <span
                          className={`inline-flex w-fit items-center rounded-md border px-2 py-0.5 text-xs font-medium ${getStatusBadgeClasses(
                            page.status,
                          )}`}
                        >
                          {page.status}
                        </span>
                        {page.lastError ? (
                          <span
                            title={page.lastError}
                            className="line-clamp-1 text-[11px] text-rose-600"
                          >
                            {page.lastError}
                          </span>
                        ) : null}
                      </div>
                    </td>

                    <td className="px-5 py-3.5 text-xs text-slate-600">
                      <div>
                        {page.status === 'Uploaded'
                          ? formatTimestamp(page.lastSyncTime)
                          : `Modified: ${formatTimestamp(page.lastModified)}`}
                      </div>
                    </td>

                    <td className="px-5 py-3.5 text-xs">
                      {page.oneNotePageUrl ? (
                        <a
                          href={page.oneNotePageUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-brand hover:underline"
                        >
                          Open in OneNote
                        </a>
                      ) : (
                        <span className="text-slate-400">-</span>
                      )}
                    </td>

                    <td className="px-5 py-3.5 text-right text-xs">
                      {page.status === 'Failed' ? (
                        <button
                          type="button"
                          disabled={isActing || isEngineActive}
                          onClick={() => void handleRetrySinglePage(page.documentId, page.pageId)}
                          className="rounded border border-rose-200 bg-white px-2 py-1 font-medium text-rose-700 transition-colors hover:bg-rose-50 disabled:opacity-50"
                        >
                          {isActing ? 'Retrying...' : 'Retry'}
                        </button>
                      ) : page.status === 'Pending' || ACTIVE_STATUSES.includes(page.status) ? (
                        <button
                          type="button"
                          disabled={isActing}
                          onClick={() => void handleCancelSinglePage(page.documentId, page.pageId)}
                          className="rounded border border-slate-200 bg-white px-2 py-1 font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50"
                        >
                          {isActing ? 'Cancelling...' : 'Cancel'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
