import { fetchWithRemarkableAuth } from '../auth/remarkableAuth';
import { parseSync15Index } from './indexParser';
import {
  REMARKABLE_SYNC_FILES_URL,
  REMARKABLE_SYNC_ROOT_URL,
  type Sync15IndexEntry,
  type Sync15RootPointer,
} from './types';

function buildSync15FileUrl(hash: string): string {
  const trimmed = hash.trim();
  if (!trimmed) {
    throw new Error('Cannot fetch reMarkable Sync15 blob with an empty hash.');
  }
  return `${REMARKABLE_SYNC_FILES_URL}/${encodeURIComponent(trimmed)}`;
}

/**
 * Fetches the current root pointer (`hash` and `generation`) from `GET /sync/v4/root`.
 * Treats HTTP 404 as an empty reMarkable Cloud account (`hash: ""`, `generation: 0`).
 */
export async function fetchSync15RootPointer(
  fetchImpl: typeof fetch = fetch,
): Promise<Sync15RootPointer> {
  let response: Response;
  try {
    response = await fetchWithRemarkableAuth(
      REMARKABLE_SYNC_ROOT_URL,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      },
      fetchImpl,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Network error contacting reMarkable Sync15 root endpoint: ${detail}`,
    );
  }

  if (response.status === 404) {
    return {
      hash: '',
      generation: 0,
      schemaVersion: 3,
    };
  }

  if (!response.ok) {
    throw new Error(
      `Failed to read reMarkable Sync15 root pointer (HTTP ${response.status}).`,
    );
  }

  const payload = (await response.json()) as Partial<Sync15RootPointer>;
  return {
    hash: typeof payload.hash === 'string' ? payload.hash.trim() : '',
    generation:
      typeof payload.generation === 'number' && Number.isFinite(payload.generation)
        ? payload.generation
        : 0,
    schemaVersion:
      typeof payload.schemaVersion === 'number' && Number.isFinite(payload.schemaVersion)
        ? payload.schemaVersion
        : undefined,
  };
}

/**
 * Downloads a UTF-8 text blob (`.docSchema`, `.metadata`, `.content`, `.pagedata`)
 * from `GET /sync/v3/files/<hash>` with the mandatory `rm-filename` header.
 */
export async function fetchSync15BlobText(
  hash: string,
  rmFilename: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchWithRemarkableAuth(
    buildSync15FileUrl(hash),
    {
      method: 'GET',
      headers: {
        'rm-filename': rmFilename,
      },
    },
    fetchImpl,
  );

  if (!response.ok) {
    throw new Error(
      `Failed to download reMarkable blob "${rmFilename}" (HTTP ${response.status}).`,
    );
  }

  return response.text();
}

/**
 * Downloads a binary blob (such as `<docId>/<pageId>.rm`) directly into an in-memory
 * `Uint8Array` via `GET /sync/v3/files/<hash>` without touching disk or zip archives.
 */
export async function fetchSync15BlobBytes(
  hash: string,
  rmFilename: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const response = await fetchWithRemarkableAuth(
    buildSync15FileUrl(hash),
    {
      method: 'GET',
      headers: {
        'rm-filename': rmFilename,
      },
    },
    fetchImpl,
  );

  if (!response.ok) {
    throw new Error(
      `Failed to download reMarkable binary "${rmFilename}" (HTTP ${response.status}).`,
    );
  }

  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

export async function fetchRootIndexEntries(
  rootHash: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Sync15IndexEntry[]> {
  if (!rootHash.trim()) {
    return [];
  }
  const raw = await fetchSync15BlobText(rootHash, 'root.docSchema', fetchImpl);
  return parseSync15Index(raw).entries;
}

export async function fetchDocumentIndexEntries(
  documentId: string,
  docSchemaHash: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Sync15IndexEntry[]> {
  const raw = await fetchSync15BlobText(
    docSchemaHash,
    `${documentId}.docSchema`,
    fetchImpl,
  );
  return parseSync15Index(raw).entries;
}

export interface DownloadBlobOptions {
  /**
   * Pre-resolved SHA-256 blob hash (e.g. `PageRecord.contentHash`), allowing single-GET
   * binary retrieval without re-fetching `root.docSchema` and `<docId>.docSchema`.
   */
  knownBlobHash?: string;
  fetchImpl?: typeof fetch;
}

async function resolveDocumentSubblobHash(
  documentId: string,
  logicalFilename: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const root = await fetchSync15RootPointer(fetchImpl);
  if (!root.hash) {
    throw new Error(
      `reMarkable Cloud is empty while looking up "${logicalFilename}".`,
    );
  }

  const rootEntries = await fetchRootIndexEntries(root.hash, fetchImpl);
  const docEntry = rootEntries.find((entry) => entry.id === documentId);
  if (!docEntry) {
    throw new Error(
      `Document "${documentId}" was not found in reMarkable Cloud root index.`,
    );
  }

  const docEntries = await fetchDocumentIndexEntries(documentId, docEntry.hash, fetchImpl);
  const blobEntry = docEntries.find((entry) => entry.id === logicalFilename);
  if (!blobEntry) {
    throw new Error(
      `Blob "${logicalFilename}" was not found inside document "${documentId}".`,
    );
  }

  return blobEntry.hash;
}

/**
 * Downloads a single `.rm` page binary (`<documentId>/<pageId>.rm`) straight into
 * a `Uint8Array` in memory for Phase 5 Rust `rmc` WASM conversion.
 */
export async function downloadPageRmBytes(
  documentId: string,
  pageId: string,
  options: DownloadBlobOptions = {},
): Promise<Uint8Array> {
  const { knownBlobHash, fetchImpl = fetch } = options;
  const logicalFilename = `${documentId}/${pageId}.rm`;
  const targetHash =
    knownBlobHash && knownBlobHash.trim().length > 0
      ? knownBlobHash.trim()
      : await resolveDocumentSubblobHash(documentId, logicalFilename, fetchImpl);

  return fetchSync15BlobBytes(targetHash, logicalFilename, fetchImpl);
}

/**
 * Downloads any companion file inside a document sub-index (e.g. `<documentId>.pagedata`
 * or `<documentId>.pdf`) directly into a `Uint8Array` in memory.
 */
export async function downloadDocumentBlobBytes(
  documentId: string,
  logicalFilename: string,
  options: DownloadBlobOptions = {},
): Promise<Uint8Array> {
  const { knownBlobHash, fetchImpl = fetch } = options;
  const targetHash =
    knownBlobHash && knownBlobHash.trim().length > 0
      ? knownBlobHash.trim()
      : await resolveDocumentSubblobHash(documentId, logicalFilename, fetchImpl);

  return fetchSync15BlobBytes(targetHash, logicalFilename, fetchImpl);
}

