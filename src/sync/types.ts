import type { RmOneNoteDatabase } from '../db/db';
import type { OneNoteDirectoryCache, OneNoteClient } from '../onenote';
import type { CloudTreeSyncResult } from '../remarkable/types';
import type { SyncPhase } from '../shared/messaging';

export type SyncCycleTrigger = 'manual' | 'alarm' | 'startup' | 'retry';

export interface PageSyncOutcome {
  documentId: string;
  pageId: string;
  virtualPath: string;
  status: 'Uploaded' | 'Skipped' | 'Failed';
  oneNotePageId: string | null;
  oneNotePageUrl: string | null;
  error: string | null;
}

export interface SyncCycleSummary {
  trigger: SyncCycleTrigger;
  startedAt: string;
  completedAt: string;
  treeSync: CloudTreeSyncResult | null;
  processedCount: number;
  uploadedCount: number;
  skippedCount: number;
  failedCount: number;
  outcomes: PageSyncOutcome[];
}

export interface RunSyncCycleOptions {
  trigger?: SyncCycleTrigger;
  forceTreeRefresh?: boolean;
  concurrency?: number;
  database?: RmOneNoteDatabase;
  fetchImpl?: typeof fetch;
  oneNoteClient?: OneNoteClient;
  directoryCache?: OneNoteDirectoryCache;
  /** Overrides Phantom Link verification poll delays (mainly for tests). */
  phantomLinkPollDelaysMs?: readonly number[];
  onPhaseChange?: (phase: SyncPhase, detail?: string) => Promise<void> | void;
}

