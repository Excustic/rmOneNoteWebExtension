import type { Storage } from 'webextension-polyfill';
import { ext } from '../shared/browser';
import { packUuidList, unpackUuidList } from './uuidCodec';

export const MIN_CONTAINER_WIDTH_PX = 760;
export const MAX_CONTAINER_WIDTH_PX = 2400;
export const DEFAULT_CONTAINER_WIDTH_PX = 1280;

export type PageSyncStrategy = 'mirror' | 'preserve';

export interface UserPreferences {
  /** Autonomous background alarm period in minutes (`>= 1`). */
  syncIntervalMinutes: number;
  /** Whether periodic `alarms` sync is enabled. */
  autoSync: boolean;
  /** Automatically include newly created notebooks inside whitelisted folders. */
  autoAddNewFiles: boolean;
  /** Fallback OneNote section name for root-level documents. */
  targetSection: string;
  /** Maximum per-page Graph API upload retry attempts before marking `Failed`. */
  maxRetries: number;
  /** Days to retain uploaded records during optional local cleanup. */
  cacheRetentionDays: number;
  /** Main Options page container max-width in CSS pixels. */
  containerWidthPx: number;
  /**
   * Maximum number of existing OneNote section pages to inspect (in $top=100 batches)
   * to find and deduplicate already-synced pages. Default 300.
   */
  maxSectionPagesQueryLimit: number;
  /**
   * Whether auto-sync uploads unannotated (blank) PDF background pages.
   * Default false (only upload pages with ink strokes).
   */
  syncUnannotatedPdfPages: boolean;
  /**
   * Strategy for handling deletions and page reordering on reMarkable:
   * - 'mirror': Automatically delete OneNote pages when deleted on tablet, and rename OneNote page titles when reordered.
   * - 'preserve': Keep OneNote static/append-only; never delete OneNote pages and append (1), (2) on page title conflicts.
   */
  pageSyncStrategy: PageSyncStrategy;
  /**
   * Number of concurrent upload workers (1 to 5).
   * Default 3. Setting to 1 uploads pages strictly sequentially.
   */
  syncConcurrency: number;
}

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  syncIntervalMinutes: 5,
  autoSync: true,
  autoAddNewFiles: true,
  targetSection: 'Documents',
  maxRetries: 3,
  cacheRetentionDays: 30,
  containerWidthPx: DEFAULT_CONTAINER_WIDTH_PX,
  maxSectionPagesQueryLimit: 300,
  syncUnannotatedPdfPages: false,
  pageSyncStrategy: 'mirror',
  syncConcurrency: 3,
};

export interface SyncWhitelist {
  /** Explicitly selected reMarkable document UUIDs. */
  syncFiles: string[];
  /** Selected reMarkable folder (`CollectionType`) UUIDs. */
  syncFolders: string[];
}

const PREFS_KEY = 'prefs';
const FILES_PREFIX = 'wl_files';
const FOLDERS_PREFIX = 'wl_folders';

/**
 * 320 packed 22-char Base64url UUIDs = 7,040 bytes per key, safely below the
 * cross-browser `storage.sync` 8,192-byte (`QUOTA_BYTES_PER_ITEM`) ceiling.
 */
export const WHITELIST_UUIDS_PER_CHUNK = 320;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizePreferences(raw: Partial<UserPreferences> | undefined): UserPreferences {
  if (!raw) {
    return { ...DEFAULT_USER_PREFERENCES };
  }

  const section =
    typeof raw.targetSection === 'string' && raw.targetSection.trim()
      ? raw.targetSection.trim()
      : DEFAULT_USER_PREFERENCES.targetSection;

  return {
    syncIntervalMinutes: clampInt(
      raw.syncIntervalMinutes,
      DEFAULT_USER_PREFERENCES.syncIntervalMinutes,
      1,
      1440,
    ),
    autoSync:
      typeof raw.autoSync === 'boolean' ? raw.autoSync : DEFAULT_USER_PREFERENCES.autoSync,
    autoAddNewFiles:
      typeof raw.autoAddNewFiles === 'boolean'
        ? raw.autoAddNewFiles
        : DEFAULT_USER_PREFERENCES.autoAddNewFiles,
    targetSection: section,
    maxRetries: clampInt(raw.maxRetries, DEFAULT_USER_PREFERENCES.maxRetries, 1, 10),
    cacheRetentionDays: clampInt(
      raw.cacheRetentionDays,
      DEFAULT_USER_PREFERENCES.cacheRetentionDays,
      1,
      365,
    ),
    containerWidthPx: clampInt(
      raw.containerWidthPx,
      DEFAULT_USER_PREFERENCES.containerWidthPx,
      MIN_CONTAINER_WIDTH_PX,
      MAX_CONTAINER_WIDTH_PX,
    ),
    maxSectionPagesQueryLimit: clampInt(
      raw.maxSectionPagesQueryLimit,
      DEFAULT_USER_PREFERENCES.maxSectionPagesQueryLimit,
      20,
      1000,
    ),
    syncUnannotatedPdfPages:
      typeof raw.syncUnannotatedPdfPages === 'boolean'
        ? raw.syncUnannotatedPdfPages
        : DEFAULT_USER_PREFERENCES.syncUnannotatedPdfPages,
    pageSyncStrategy:
      raw.pageSyncStrategy === 'preserve' ? 'preserve' : 'mirror',
    syncConcurrency: clampInt(
      raw.syncConcurrency,
      DEFAULT_USER_PREFERENCES.syncConcurrency,
      1,
      5,
    ),
  };
}

export async function getPreferences(): Promise<UserPreferences> {
  const stored = await ext.storage.sync.get(PREFS_KEY);
  return normalizePreferences(stored[PREFS_KEY] as Partial<UserPreferences> | undefined);
}

export async function updatePreferences(
  patch: Partial<UserPreferences>,
): Promise<UserPreferences> {
  const current = await getPreferences();
  const next = normalizePreferences({ ...current, ...patch });
  await ext.storage.sync.set({ [PREFS_KEY]: next });
  return next;
}

export async function ensureDefaultPreferences(): Promise<UserPreferences> {
  const stored = await ext.storage.sync.get(PREFS_KEY);
  if (stored[PREFS_KEY] !== undefined) {
    return normalizePreferences(stored[PREFS_KEY] as Partial<UserPreferences>);
  }
  await ext.storage.sync.set({ [PREFS_KEY]: DEFAULT_USER_PREFERENCES });
  return { ...DEFAULT_USER_PREFERENCES };
}

async function readChunkedUuidList(prefix: string): Promise<string[]> {
  const countKey = `${prefix}_n`;
  const countResult = await ext.storage.sync.get(countKey);
  const chunkCount = countResult[countKey];

  if (typeof chunkCount !== 'number' || chunkCount <= 0) {
    return [];
  }

  const chunkKeys = Array.from({ length: chunkCount }, (_, i) => `${prefix}_${i}`);
  const chunksObj = await ext.storage.sync.get(chunkKeys);

  const ids: string[] = [];
  for (const key of chunkKeys) {
    const packed = chunksObj[key];
    if (typeof packed === 'string' && packed.length > 0) {
      ids.push(...unpackUuidList(packed));
    }
  }
  return ids;
}

function prepareChunkedUuidWrite(
  prefix: string,
  uuids: readonly string[],
  previousChunkCount: number,
): { toSet: Record<string, unknown>; toRemove: string[] } {
  const deduped = Array.from(new Set(uuids.map((id) => id.trim().toLowerCase())));
  const chunkCount = Math.ceil(deduped.length / WHITELIST_UUIDS_PER_CHUNK);

  const toSet: Record<string, unknown> = {
    [`${prefix}_n`]: chunkCount,
  };

  for (let i = 0; i < chunkCount; i++) {
    const slice = deduped.slice(
      i * WHITELIST_UUIDS_PER_CHUNK,
      (i + 1) * WHITELIST_UUIDS_PER_CHUNK,
    );
    toSet[`${prefix}_${i}`] = packUuidList(slice);
  }

  const toRemove: string[] = [];
  for (let i = chunkCount; i < previousChunkCount; i++) {
    toRemove.push(`${prefix}_${i}`);
  }

  return { toSet, toRemove };
}

export async function getWhitelist(): Promise<SyncWhitelist> {
  const [syncFiles, syncFolders] = await Promise.all([
    readChunkedUuidList(FILES_PREFIX),
    readChunkedUuidList(FOLDERS_PREFIX),
  ]);

  return { syncFiles, syncFolders };
}

export async function setWhitelist(whitelist: SyncWhitelist): Promise<SyncWhitelist> {
  const prevCounts = await ext.storage.sync.get([`${FILES_PREFIX}_n`, `${FOLDERS_PREFIX}_n`]);
  const prevFilesCount =
    typeof prevCounts[`${FILES_PREFIX}_n`] === 'number'
      ? (prevCounts[`${FILES_PREFIX}_n`] as number)
      : 0;
  const prevFoldersCount =
    typeof prevCounts[`${FOLDERS_PREFIX}_n`] === 'number'
      ? (prevCounts[`${FOLDERS_PREFIX}_n`] as number)
      : 0;

  const filesPlan = prepareChunkedUuidWrite(FILES_PREFIX, whitelist.syncFiles, prevFilesCount);
  const foldersPlan = prepareChunkedUuidWrite(
    FOLDERS_PREFIX,
    whitelist.syncFolders,
    prevFoldersCount,
  );

  await ext.storage.sync.set({
    ...filesPlan.toSet,
    ...foldersPlan.toSet,
  });

  const staleKeys = [...filesPlan.toRemove, ...foldersPlan.toRemove];
  if (staleKeys.length > 0) {
    await ext.storage.sync.remove(staleKeys);
  }

  return getWhitelist();
}

export function onSyncStorageChanged(
  listener: (changes: Record<string, Storage.StorageChange>) => void,
): () => void {
  const handler = (changes: Record<string, Storage.StorageChange>, areaName: string) => {
    if (areaName === 'sync') {
      listener(changes);
    }
  };
  ext.storage.onChanged.addListener(handler);
  return () => {
    ext.storage.onChanged.removeListener(handler);
  };
}

