/**
 * Public barrel exports for Microsoft Graph OneNote API client, multipart builder,
 * rate-limiting / throttling helpers, and persistent directory cache.
 */

export { OneNoteDirectoryCache } from './directoryCache';
export {
  buildUpdateInkMlMultipart,
  buildUploadInkMlMultipart,
  type EncodedMultipartPayload,
  encodeMultipartFormData,
  ensurePresentationHtmlTitle,
  type MultipartFormPart,
} from './multipart';
export {
  extractOneNotePageId,
  OneNoteClient,
  type OneNoteClientOptions,
  OneNoteGraphError,
  parseVirtualPathToOneNoteTarget,
  resolveOneNoteLinkUrl,
  sanitizeOneNoteDisplayName,
} from './oneNoteClient';
export {
  AsyncSemaphore,
  type BackoffOptions,
  computeGraphBackoffMs,
  DEFAULT_GRAPH_CONCURRENCY_LIMIT,
  DEFAULT_PHANTOM_LINK_POLL_DELAYS_MS,
  defaultSleepMs,
  isRetryableGraphStatus,
  KeyedMutex,
  parseRetryAfterMs,
} from './throttle';
export {
  type ODataCollectionResponse,
  ONENOTE_GRAPH_BASE_URL,
  type OneNoteLinks,
  type OneNoteNotebook,
  type OneNotePage,
  type OneNoteSection,
  type OneNoteTargetPath,
  type OneNoteUrl,
  type ResolvedOneNoteTarget,
  type UpdateInkMlPageParams,
  type UploadInkMlPageParams,
  type VerifiedOneNotePageResult,
} from './types';
