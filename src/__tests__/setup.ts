import 'fake-indexeddb/auto';

export const SYNC_QUOTA_BYTES = 102_400;
export const SYNC_QUOTA_BYTES_PER_ITEM = 8_192;

type StorageChangeRecord = Record<
  string,
  {
    oldValue?: unknown;
    newValue?: unknown;
  }
>;

type StorageChangedListener = (changes: StorageChangeRecord, areaName: string) => void;

const changeListeners = new Set<StorageChangedListener>();

function cloneValue<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function createStorageArea(areaName: 'sync' | 'local', enforceSyncQuotas: boolean) {
  const store = new Map<string, unknown>();

  function measureItemBytes(key: string, value: unknown): number {
    return key.length + JSON.stringify(value).length;
  }

  return {
    _rawStore: store,

    async get(
      keys?: string | string[] | Record<string, unknown> | null,
    ): Promise<Record<string, unknown>> {
      if (keys === null || keys === undefined) {
        const all: Record<string, unknown> = {};
        for (const [k, v] of store.entries()) {
          all[k] = cloneValue(v);
        }
        return all;
      }

      if (typeof keys === 'string') {
        const out: Record<string, unknown> = {};
        if (store.has(keys)) {
          out[keys] = cloneValue(store.get(keys));
        }
        return out;
      }

      if (Array.isArray(keys)) {
        const out: Record<string, unknown> = {};
        for (const k of keys) {
          if (store.has(k)) {
            out[k] = cloneValue(store.get(k));
          }
        }
        return out;
      }

      const out: Record<string, unknown> = {};
      for (const [k, fallback] of Object.entries(keys)) {
        out[k] = store.has(k) ? cloneValue(store.get(k)) : cloneValue(fallback);
      }
      return out;
    },

    async set(items: Record<string, unknown>): Promise<void> {
      if (enforceSyncQuotas) {
        const nextView = new Map(store);
        for (const [key, value] of Object.entries(items)) {
          if (value === undefined) {
            continue;
          }
          const itemBytes = measureItemBytes(key, value);
          if (itemBytes > SYNC_QUOTA_BYTES_PER_ITEM) {
            throw new Error(
              `QUOTA_BYTES_PER_ITEM quota exceeded for key "${key}": ${itemBytes} > ${SYNC_QUOTA_BYTES_PER_ITEM}`,
            );
          }
          nextView.set(key, value);
        }

        let totalBytes = 0;
        for (const [key, value] of nextView.entries()) {
          totalBytes += measureItemBytes(key, value);
        }
        if (totalBytes > SYNC_QUOTA_BYTES) {
          throw new Error(
            `QUOTA_BYTES quota exceeded in storage.sync: ${totalBytes} > ${SYNC_QUOTA_BYTES}`,
          );
        }
      }

      const changes: StorageChangeRecord = {};
      for (const [key, value] of Object.entries(items)) {
        if (value === undefined) {
          continue;
        }
        const hadPrev = store.has(key);
        const prev = store.get(key);
        const storedCopy = cloneValue(value);
        store.set(key, storedCopy);
        changes[key] = {
          ...(hadPrev ? { oldValue: cloneValue(prev) } : {}),
          newValue: cloneValue(storedCopy),
        };
      }

      if (Object.keys(changes).length > 0) {
        for (const listener of Array.from(changeListeners)) {
          listener(changes, areaName);
        }
      }
    },

    async remove(keys: string | string[]): Promise<void> {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes: StorageChangeRecord = {};

      for (const key of list) {
        if (store.has(key)) {
          const prev = store.get(key);
          store.delete(key);
          changes[key] = { oldValue: cloneValue(prev) };
        }
      }

      if (Object.keys(changes).length > 0) {
        for (const listener of Array.from(changeListeners)) {
          listener(changes, areaName);
        }
      }
    },

    async clear(): Promise<void> {
      const changes: StorageChangeRecord = {};
      for (const [key, prev] of store.entries()) {
        changes[key] = { oldValue: cloneValue(prev) };
      }
      store.clear();

      if (Object.keys(changes).length > 0) {
        for (const listener of Array.from(changeListeners)) {
          listener(changes, areaName);
        }
      }
    },
  };
}

const syncArea = createStorageArea('sync', true);
const localArea = createStorageArea('local', false);

type AlarmRecord = {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
};

type AlarmListener = (alarm: AlarmRecord) => void;

const alarmStore = new Map<string, AlarmRecord>();
const alarmListeners = new Set<AlarmListener>();

const mockBrowser = {
  runtime: {
    id: 'rm-onenote-sync@excustic.dev',
    getURL: (path: string) => `moz-extension://test-uuid/${path.replace(/^\//, '')}`,
    openOptionsPage: async () => undefined,
    sendMessage: async () => undefined,
    onInstalled: {
      addListener: () => undefined,
      removeListener: () => undefined,
    },
    onStartup: {
      addListener: () => undefined,
      removeListener: () => undefined,
    },
    onMessage: {
      addListener: () => undefined,
      removeListener: () => undefined,
    },
  },
  alarms: {
    create: (name: string, alarmInfo: { delayInMinutes?: number; periodInMinutes?: number }) => {
      const delayMs = (alarmInfo.delayInMinutes ?? alarmInfo.periodInMinutes ?? 1) * 60_000;
      alarmStore.set(name, {
        name,
        scheduledTime: Date.now() + delayMs,
        periodInMinutes: alarmInfo.periodInMinutes,
      });
    },
    clear: async (name?: string) => {
      if (!name) {
        const had = alarmStore.size > 0;
        alarmStore.clear();
        return had;
      }
      return alarmStore.delete(name);
    },
    get: async (name?: string) => {
      if (!name) {
        return undefined;
      }
      return alarmStore.get(name);
    },
    getAll: async () => Array.from(alarmStore.values()),
    onAlarm: {
      addListener: (fn: AlarmListener) => {
        alarmListeners.add(fn);
      },
      removeListener: (fn: AlarmListener) => {
        alarmListeners.delete(fn);
      },
    },
  },
  tabs: {
    create: async () => ({}),
  },
  permissions: {
    request: async () => true,
    contains: async () => true,
    remove: async () => true,
  },
  identity: {
    getRedirectURL: (path?: string) =>
      `https://testextensionid.chromiumapp.org/${(path ?? '').replace(/^\//, '')}`,
    launchWebAuthFlow: async () => 'https://testextensionid.chromiumapp.org/',
  },
  storage: {
    sync: syncArea,
    local: localArea,
    onChanged: {
      addListener: (fn: StorageChangedListener) => {
        changeListeners.add(fn);
      },
      removeListener: (fn: StorageChangedListener) => {
        changeListeners.delete(fn);
      },
    },
  },
};

const g = globalThis as unknown as {
  chrome: unknown;
  browser: unknown;
};

g.chrome = mockBrowser;
g.browser = mockBrowser;

export function resetMockBrowserStorage(): void {
  syncArea._rawStore.clear();
  localArea._rawStore.clear();
  changeListeners.clear();
  alarmStore.clear();
  alarmListeners.clear();
}

export function triggerMockAlarm(name: string): void {
  const alarm = alarmStore.get(name) ?? { name, scheduledTime: Date.now() };
  for (const listener of Array.from(alarmListeners)) {
    listener(alarm);
  }
}

export function resetMockLocalStorageOnly(): void {
  localArea._rawStore.clear();
}

export function getRawSyncStoreSnapshot(): Map<string, unknown> {
  return new Map(syncArea._rawStore);
}

