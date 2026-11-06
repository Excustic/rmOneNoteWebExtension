/**
 * Concurrency limiting, keyed mutexes, and Retry-After / exponential-backoff
 * throttling utilities for Microsoft Graph OneNote API calls.
 */

export const DEFAULT_GRAPH_CONCURRENCY_LIMIT = 3;
export const DEFAULT_PHANTOM_LINK_POLL_DELAYS_MS: readonly number[] = [
  2_000,
  4_000,
  8_000,
  15_000,
  20_000,
  25_000,
];

/**
 * Bounded async semaphore limiting the number of simultaneous in-flight Graph requests.
 */
export class AsyncSemaphore {
  private readonly maxPermits: number;
  private activeCount = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(maxPermits = DEFAULT_GRAPH_CONCURRENCY_LIMIT) {
    if (!Number.isInteger(maxPermits) || maxPermits < 1) {
      throw new RangeError(`AsyncSemaphore maxPermits must be >= 1, got ${maxPermits}.`);
    }
    this.maxPermits = maxPermits;
  }

  get inFlight(): number {
    return this.activeCount;
  }

  async acquire(): Promise<void> {
    if (this.activeCount < this.maxPermits) {
      this.activeCount += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    const next = this.waitQueue.shift();
    if (next) {
      next();
    } else {
      this.activeCount = Math.max(0, this.activeCount - 1);
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }
}

/**
 * Keyed async mutex preventing concurrent workers from racing to create duplicate
 * OneNote notebooks or sections with the same display name.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const currentGate = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const chained = previous.then(() => currentGate);
    this.tails.set(key, chained);

    await previous;
    try {
      return await task();
    } finally {
      releaseCurrent();
      if (this.tails.get(key) === chained) {
        this.tails.delete(key);
      }
    }
  }
}

/**
 * Checks whether an HTTP status code from Microsoft Graph is transient and retryable.
 * Matches `OneNoteClient.cs` (`429 TooManyRequests`, `500 InternalServerError`,
 * `503 ServiceUnavailable`, `504 GatewayTimeout`).
 */
export function isRetryableGraphStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 503 || status === 504;
}

/**
 * Parses an HTTP `Retry-After` header (either delta-seconds or HTTP-date) into milliseconds.
 */
export function parseRetryAfterMs(
  retryAfterHeader: string | null | undefined,
  nowMs = Date.now()
): number | null {
  if (!retryAfterHeader) {
    return null;
  }
  const trimmed = retryAfterHeader.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number.parseFloat(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
  }

  const parsedDateMs = Date.parse(trimmed);
  if (!Number.isNaN(parsedDateMs)) {
    return Math.max(0, parsedDateMs - nowMs);
  }

  return null;
}

export interface BackoffOptions {
  readonly retryAfterHeader?: string | null;
  readonly jitterMaxSeconds?: number;
  readonly randomFn?: () => number;
  readonly nowMs?: number;
}

/**
 * Computes exponential backoff with random jitter (`2^attempt + jitter` seconds),
 * honoring `Retry-After` whenever provided by Microsoft Graph.
 */
export function computeGraphBackoffMs(
  attemptIndex: number,
  options: BackoffOptions = {}
): number {
  const {
    retryAfterHeader = null,
    jitterMaxSeconds = 3,
    randomFn = Math.random,
    nowMs = Date.now(),
  } = options;

  const explicitRetryMs = parseRetryAfterMs(retryAfterHeader, nowMs);
  if (explicitRetryMs !== null) {
    return explicitRetryMs;
  }

  const baseSeconds = 2 ** Math.max(0, attemptIndex);
  const jitterSeconds = Math.max(0, randomFn()) * jitterMaxSeconds;
  return Math.round((baseSeconds + jitterSeconds) * 1000);
}

export function defaultSleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

