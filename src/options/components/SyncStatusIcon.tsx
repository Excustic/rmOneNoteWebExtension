import type { PageSyncStatus } from '../../db/models';
import { LegacyIcon } from '../../shared/legacyIcons';

export type VisualSyncState = 'uploading' | 'failed' | 'pending' | 'uploaded' | 'idle';

const ACTIVE_STAGE_SET = new Set<PageSyncStatus>([
  'Converting',
  'Uploading',
  'Indexing',
]);

export function isPageActivelySyncing(status: PageSyncStatus): boolean {
  return ACTIVE_STAGE_SET.has(status) || status === 'Queued';
}

export function mapPageStatusToVisualState(status: PageSyncStatus): VisualSyncState {
  if (ACTIVE_STAGE_SET.has(status)) {
    return 'uploading';
  }
  if (status === 'Failed') {
    return 'failed';
  }
  if (status === 'Pending' || status === 'Queued') {
    return 'pending';
  }
  if (status === 'Uploaded') {
    return 'uploaded';
  }
  return 'idle';
}

const VISUAL_STATE_LABELS: Record<VisualSyncState, string> = {
  uploading: 'Uploading to OneNote',
  failed: 'Sync failed',
  pending: 'Pending sync',
  uploaded: 'Synced to OneNote',
  idle: 'Not synced',
};

interface SyncStatusIconProps {
  state: VisualSyncState;
  showLabelForSr?: boolean;
}

export function SyncStatusIcon({ state, showLabelForSr = true }: SyncStatusIconProps) {
  if (state === 'idle') {
    return null;
  }

  const srText = showLabelForSr ? (
    <span className="visually-hidden">{VISUAL_STATE_LABELS[state]}</span>
  ) : null;

  switch (state) {
    case 'uploaded':
      return (
        <>
          <span className="status-icon-check" aria-hidden="true" />
          {srText}
        </>
      );
    case 'failed':
      return (
        <>
          <span className="status-icon-failed" aria-hidden="true" />
          {srText}
        </>
      );
    case 'uploading':
      return (
        <>
          <span
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-blue-200 bg-blue-50 text-blue-600"
            aria-hidden="true"
          >
            <LegacyIcon name="syncCycle" className="status-spin h-3.5 w-3.5 text-blue-600" />
          </span>
          {srText}
        </>
      );
    case 'pending':
      return (
        <>
          <span className="status-icon-pending" aria-hidden="true" />
          {srText}
        </>
      );
  }
}

const STATUS_BADGE_CLASSES: Record<PageSyncStatus, string> = {
  Pending: 'bg-amber-50 text-amber-800 border-amber-200',
  Queued: 'bg-amber-100 text-amber-900 border-amber-300',
  Converting: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  Uploading: 'bg-blue-50 text-blue-700 border-blue-200',
  Indexing: 'bg-purple-50 text-purple-700 border-purple-200',
  Uploaded: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  Failed: 'bg-rose-50 text-rose-700 border-rose-200',
  Skipped: 'bg-slate-100 text-slate-600 border-slate-200',
  Deleted: 'bg-slate-100 text-slate-400 border-slate-200',
};

const STATUS_DISPLAY_LABELS: Record<PageSyncStatus, string> = {
  Pending: 'Pending',
  Queued: 'Queued',
  Converting: 'Converting',
  Uploading: 'Uploading',
  Indexing: 'Verifying Link',
  Uploaded: 'Uploaded',
  Failed: 'Failed',
  Skipped: 'Not Queued',
  Deleted: 'Deleted',
};

export function SyncStatusBadge({ status }: { status: PageSyncStatus }) {
  const visualState = mapPageStatusToVisualState(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[status]}`}
    >
      <SyncStatusIcon state={visualState} showLabelForSr={false} />
      <span>{STATUS_DISPLAY_LABELS[status]}</span>
    </span>
  );
}

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeStyle: 'medium',
});

const compactDateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeStyle: 'short',
});

export function formatSyncTimestamp(isoString: string | null, compact = false): string {
  if (!isoString) {
    return 'Never';
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return 'Never';
  }
  return compact ? compactDateFormatter.format(date) : dateFormatter.format(date);
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  return `${(kb / 1024).toFixed(1)} MB`;
}
