export const DEFAULT_HTTP_TIMEOUT_MS = 60_000;

export function createAbortError(message = 'Operation aborted by user.'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function createTimeoutError(timeoutMs: number): Error {
  const err = new Error(`HTTP request timed out after ${Math.round(timeoutMs / 1000)}s.`);
  err.name = 'TimeoutError';
  return err;
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const candidate = err as { name?: unknown; message?: unknown };
  return (
    candidate.name === 'AbortError' ||
    candidate.message === 'Cancelled by user' ||
    candidate.message === 'Sync aborted by user.'
  );
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    if (signal.reason instanceof Error && isAbortError(signal.reason)) {
      throw signal.reason;
    }
    throw createAbortError();
  }
}

/**
 * Executes `fetchImpl` with optional caller `AbortSignal` plus a bounded request
 * timeout so stalled sockets on slow/broken networks cannot hang indefinitely.
 */
export async function fetchWithAbortAndTimeout(
  fetchImpl: typeof fetch,
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<Response> {
  const callerSignal = init.signal ?? undefined;
  throwIfAborted(callerSignal);

  const controller = new AbortController();
  let timedOut = false;

  const onCallerAbort = () => {
    controller.abort(createAbortError());
  };

  if (callerSignal) {
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  const timerId = setTimeout(() => {
    timedOut = true;
    controller.abort(createTimeoutError(timeoutMs));
  }, timeoutMs);

  try {
    return await fetchImpl(input, {
      ...init,
      signal: controller.signal,
    });
  } catch (err) {
    if (callerSignal?.aborted) {
      throw createAbortError();
    }
    if (timedOut) {
      throw createTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timerId);
    if (callerSignal) {
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }
}

