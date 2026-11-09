# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Per-section page creation queue mutex (`sectionPagesMutex` in `syncEngine.ts`): enforces strict ascending chronological creation order on Microsoft Graph so pages are created in natural order (`Page 1`, `Page 2`, `Page 3`) without race conditions caused by smaller pages finishing faster than larger pages, while keeping single-page and distinct-notebook sync non-blocking.
- Configurable concurrent upload workers (`syncConcurrency`: range 1 to 5, default 3) in `UserPreferences` and `SettingsView.tsx`. Setting to 1 processes page conversion and upload workers strictly sequentially.
- Dedicated deleted pages inspection and recovery workflow in Sync Control (`SyncControlView.tsx`):
  - Excludes recognized deleted pages from standard selection checkboxes to prevent unintentional sync.
  - Collapsible, collapsed-by-default `Deleted Pages (n)` container beneath active pages.
  - Automatic revision disambiguation: labels deleted pages with identical numbers as `Page X (rev 1)`, `Page X (rev 2)` based on modification timestamp order.
  - "Recover" action button invoking `recoverDeletedPage`: uploads recovered pages directly into a dedicated `<SectionName> (Recovered)` OneNote section with disambiguated revision titles.
  - reMarkable Cloud retention limit and blob expiration detection: handles 404 errors for pruned CAS blobs, updates page state with clear expiration feedback, and disables pointless recovery retries.
- Interactive resizable table columns for the 30-day activity table in Dashboard view (`DashboardView.tsx`) with drag handles, double-click reset, minimum column width constraints, and persistent column widths in `localStorage`.
- Full text hover tooltips (`title` attribute) on truncated text cells across the Dashboard activity table and Sync Control tree nodes / side panel headers.
- Paginated OneNote section page listing (`OneNoteClient.listPages`): queries in batches of up to 100 (`$top=100`) and follows `@odata.nextLink` until the section is exhausted or a configurable ceiling is reached.
- New `maxSectionPagesQueryLimit` setting (default: 300, range: 20 – 1000) and `syncUnannotatedPdfPages` toggle (default: false) in `UserPreferences` and `SettingsView.tsx` with pragmatic documentation.
- Bulk duplicate purging in `syncEngine.ts`: finds and deletes all matching stale pages in a section upon re-sync instead of only the first match.
- Full document page indexing (Option B) in `metadataParser.ts`: resolves all pages declared in `cPages.pages` or PDF page maps, including unannotated pages (`0 KB (Blank / No strokes)`), ensuring complete document visibility in Sync Control.
- Selective unannotated page auto-sync: background sync automatically skips blank pages when `syncUnannotatedPdfPages` is disabled, while preserving on-demand manual sync for any page.
- Page deletion and reordering lifecycle strategies (`pageSyncStrategy`: `'mirror' | 'preserve'`):
  - `mirror` (default): Automatically purges OneNote pages when removed from reMarkable tablet, and renames OneNote page titles via fast-path JSON `PATCH` commands when pages are reordered without stroke modifications.
  - `preserve`: Keeps OneNote append-only/static without deletions, resolves colliding page numbers with incremental count suffixes (`Page X (1)`, `Page X (2)`), and records `originalPageNumber` on `PageRecord`.
- Lightweight OneNote page rename capability (`OneNoteClient.renamePage`): updates page titles via Microsoft Graph JSON `PATCH /pages/{id}/content` (`[{ target: "title", action: "replace", content: newTitle }]`) with retry and 404 handling.
- Non-colliding page title resolver (`resolveNonCollidingPageTitle`) for suffixing duplicate titles in preserve mode.
- Lifecycle strategy selection control in Settings view (`SettingsView.tsx`) with user-facing documentation of mirror vs preserve behaviors.
- Visual cues for document and page lifecycle statuses across Sync Control tree, pages inspector, and Dashboard table:
  - `Out of date` badge displayed on documents and individual pages whenever modified on the tablet after their last OneNote sync time.
  - `Moved: Page X -> Page Y` badge displaying original versus reordered tablet page positions.
  - `Deleted on tablet` badge marking pages removed on the tablet while preserved in OneNote.

### Fixed
- Recovered page containment and status tags:
  - When a deleted page was recovered, `recordSyncedPagesInLedger` triggered cross-PC ledger reconciliation, which unconditionally overwrote the page's status in IndexedDB from `'Deleted'` to `'Uploaded'`, moving it out of `Deleted Pages` back into the active pages list of the original notebook.
  - Updated `reconcileSyncLedgerToDexie` in `src/storage/syncLedger.ts` to preserve `status: 'Deleted'`, and removed ledger registration from `recoverDeletedPage` so tablet-deleted pages permanently stay confined to the `Deleted Pages` list.
  - Updated `SyncControlView.tsx` and `DashboardView.tsx` to omit the redundant grey `Deleted` badge once a page has been recovered to OneNote (`oneNotePageId !== null`), retaining only the red `Deleted on tablet` badge and the "Open in OneNote" direct link.
- Recover button silent message drop in background router:
  - The runtime background message router (`isRuntimeRequest` in `src/background/index.ts`) verified incoming messages against a `VALID_REQUEST_TYPES` set. `'RECOVER_DELETED_PAGE'` was omitted from this set, causing the background script to synchronously drop the message without invoking `recoverDeletedPage` and returning `undefined` to `SyncControlView.tsx`, triggering an immediate generic "Failed to recover deleted page" error.
  - Added `'RECOVER_DELETED_PAGE'` to the background router with a compile-time exhaustiveness check (`_exhaustiveRequestTypesCheck`) ensuring every `RuntimeRequest['type']` union variant must be present in the router list.
  - Added comprehensive `try ... catch` error logging and `lastError` persistence in `recoverDeletedPage` to ensure all recovery failures surface descriptive feedback in the UI.
  - Added spinning sync cycle icon animation while recovery is in flight on the Recover button.
- Out-of-order page uploads in multi-page OneNote sections:
  - While mutual exclusion existed on section page creation, workers with higher concurrency arrived out of sequence when smaller/simpler pages finished `.rm` download and conversion faster than earlier pages, causing Microsoft Graph to timestamp and order pages out of sequence (e.g. `Page 2` created before `Page 1`).
  - Implemented pre-created sequential in-order creation barriers per document (`pageCreationGates` in `syncEngine.ts`). Workers download and convert `.rm` files and background PDFs concurrently across workers, but each worker awaits the creation barrier of the preceding page of the same document before calling Microsoft Graph `uploadInkMlPage`.
  - Added unit test verifying strict chronological page creation ordering under artificial delays and high concurrency.
- Ghost selection counter in Sync Control toolbar ("Sync Selected (N)"):
  - Reconciled `selectedPageIds` against the current set of active pages (`activePages`) via a dynamic effect in `SyncControlView.tsx`. When pages are deleted or reordered on the tablet and `Load Folders` refreshes Dexie, stale deleted page IDs are automatically pruned from state so the button counter always exactly matches the number of checked active pages.
- Ambiguous `Pending` state for reordered pages:
  - Added clear `Reorder Pending` badge in `SyncControlView.tsx` and `DashboardView.tsx` when `page.titleRenameOnly` is true, informing the user that the page only needs a OneNote title rename rather than an ink re-upload.
- Clipped viewport height in Sync Control:
  - Replaced hardcoded `max-h-[600px]` constraints on the file tree container and the pages side panel with responsive `min-h-[550px] max-h-[calc(100vh-210px)]` sizing, allowing the tree and inspector views to dynamically stretch down to the bottom of the viewport with standard padding.
- Deleted page ghost resurrection and vanishing bug in mirror mode:
  - Previously, purging a page from OneNote in `mirror` mode completely deleted the record from IndexedDB (`database.pages.delete`). This caused the page to disappear from the user's Deleted Pages view and lose its metadata (`pageNumber`, `fileSizeBytes`, `contentHash`).
  - Because the page remained in the `storage.sync` ledger, subsequent reconciliations resurrected it as a headless stub with `pageNumber: ''`, appearing in the UI as a blank `Page ` (0 KB).
  - Implemented `removeSyncedPagesFromLedger` (`syncLedger.ts`) to cleanly evict purged pages from the `storage.sync` ledger upon OneNote deletion.
  - Updated `syncEngine.ts` to preserve local page records in IndexedDB with `status: 'Deleted'`, clearing only OneNote references (`oneNotePageId: null`) while keeping `pageNumber`, file size, and stroke hashes intact so they remain available in the Deleted Pages list for inspection and recovery.
  - Added self-healing cleanup in `treeSync.ts` to automatically prune any headless orphan stubs with empty page numbers on the next `Load Folders`, and filtered empty page numbers in `SyncControlView.tsx`.
  - Updated `treeSync.ts` to permanently preserve tablet-deleted pages in Dexie as `status: 'Deleted'`, removing the erroneous branch that bulk-deleted them whenever `oneNotePageId` became `null`.
  - Excluded deleted pages from the document page count badge (`computeRollupForPages` in `SyncControlView.tsx`), ensuring the tree title only counts active pages (e.g. `2 pages` instead of `3 pages`).
- Vertical (portrait) PDF ink alignment: generalized physical 226 DPI himetric scaling factor (`2540 / 226`) and centered page bounding box (`-pageHalfWidth` to `+pageHalfWidth`, `yMin: 0`) across all annotated PDF pages, resolving horizontal ink shift when annotating vertical/portrait PDFs in OneNote.
- OneNote duplicate page accumulation: resolved 20-page cutoff where Graph's default `$top=20` pagination caused older or newly appended pages to be invisible to the deduplication check, causing repeated uploads.

## [1.0.0] - 2026-11-09

### Added
- Initial Vite + React + TypeScript Manifest V3 scaffold (`pnpm` workspace).
- Dual-target MV3 build pipeline via `vite-plugin-web-extension` outputting `dist/chromium` (Chrome, Edge, Opera service worker) and `dist/firefox` (Firefox MV3 event page + Gecko add-on metadata).
- Persistent browser runner profiles (`.dev-profile/chromium` and `.dev-profile/firefox` with `keepProfileChanges: true`) so `pnpm run dev` and `pnpm run dev:firefox` launch real browser windows and retain auth state across sessions.
- Tailwind CSS v4 configuration aligned with the legacy Avalonia UI palette (`#1a1d2e` dark sidebar, `#2563eb` primary action).
- Extension Popup (`popup.html`) quick-status shell and Options Page (`options.html`) hash-routed multi-view shell (`Dashboard`, `File Browser`, `Sync Status`, `Settings`, `Setup`).
- Ephemeral-safe MV3 background entrypoint (`src/background/index.ts`) with top-level event listener registration and `webextension-polyfill` cross-browser API normalization.
- Local IndexedDB storage layer (`Dexie.js` v4 in `src/db/`) covering `documents`, `pages` (`[documentId+pageId]` composite primary key), and `notebooks` (persistent OneNote notebook and section cache), plus MV3 worker crash recovery (`resetInProgressPages`).
- Stateless 1-to-1 Base64url codecs (`src/storage/uuidCodec.ts`) mapping 36-char UUIDs to 22-char tokens and 36-byte page sync ledger tuples to 48-char records.
- Synced preferences and 8 KB-safe chunked folder/document whitelists in `browser.storage.sync` (`src/storage/preferences.ts`).
- Bounded 1,280-entry cross-PC rolling sync ledger (`src/storage/syncLedger.ts`) with monotonic `evictedCount` tracking, cold-start missing-history warning banners, and portable `.json` database backup export/import (`src/db/backup.ts`).
- Vitest + `fake-indexeddb` unit test suite (`src/__tests__/`) enforcing `storage.sync` byte quotas, codec bijections, Dexie merges, and multi-PC ledger reconciliation.
- Autonomous reMarkable Cloud authentication (`src/auth/remarkableAuth.ts`): 8-character OTP pairing against `/token/json/2/device/new`, JWT `exp`-aware short-lived user session token caching, and transparent HTTP 401 refresh-and-retry fetch interceptor.
- Microsoft Entra ID OAuth 2.0 Authorization Code + S256 PKCE flow (`src/auth/microsoftAuth.ts`, `src/auth/pkce.ts`) via `browser.identity.launchWebAuthFlow`, persistent refresh token rotation in `browser.storage.local`, and silent HTTP 401 refresh-and-retry Graph interceptor.
- Interactive Account Setup onboarding UI (`src/options/views/SetupView.tsx`) displaying the live browser Redirect URI with copy button, optional Azure Client ID / Tenant ID configuration, `.env.example` template, and one-click session verification probes.
- Curated application logo (`16x16`, `48x48`, `128x128`, and `256x256` PNGs in `public/icons/`) and legacy vector menu/tree icons (`src/shared/legacyIcons.tsx`) ported from `rmOneNoteSync`, wired into `manifest.ts`, `Sidebar.tsx`, and `PopupApp.tsx`.
- Native TypeScript reMarkable Sync15 read-only client (`src/remarkable/`): `/sync/v4/root` generation checks, `v3`/`v4` `.docSchema` index parsing, `.metadata` and firmware 3.x CRDT `cPages` ordering, incremental SHA-256 delta mirroring into `Dexie.documents` and `Dexie.pages`, automatic inclusion of new notebooks inside whitelisted folders, and single-GET in-memory `Uint8Array` `.rm` page downloads (`downloadPageRmBytes`).
- Interactive File Browser UI (`src/options/views/FileBrowserView.tsx`) with live `Load Folders`, custom CSS-masked tri-state folder/notebook checkboxes, collapsible folder groups, and `Save Selection` synced to `browser.storage.sync`.
- Native TypeScript `.rm` binary to OneNote InkML + Presentation HTML converter (`src/converter/`): full v6 tagged-block CRDT `SceneTree` and `TextDocument` decoder (`rmParser.ts`, `binaryReader.ts`, `crdtSequence.ts`, `textLayout.ts`), legacy `.rm` v3/v5 stroke compatibility, dynamic RGBA highlight/shader palette support (`writingTools.ts`), and stateless concurrency-safe `convertRmPage` / `downloadAndConvertRmPage` exporters (`inkmlExporter.ts`).
- Project backlog file (`TODO.md`) tracking deferred File Browser UI refinements and optional annotated PDF background rasterization.
- Microsoft Graph OneNote client (`src/onenote/`): RFC 7578 binary `multipart/form-data` encoder (`multipart.ts`), bounded concurrency `AsyncSemaphore` (max 3 simultaneous Graph calls) and `Retry-After` / exponential backoff retry engine (`throttle.ts`), `OneNoteClient` (`oneNoteClient.ts`) with Phantom Link verification polling (`getPageWithPhantomLinkVerification`), update-via-create-and-delete (`updateInkMlPage`), virtual path sanitization (`parseVirtualPathToOneNoteTarget`), and `KeyedMutex`-guarded `OneNoteDirectoryCache` (`directoryCache.ts`).
- Autonomous background sync engine (`src/sync/`): single-flight `runSyncCycle` orchestrating ledger reconciliation, Sync15 tree diffing, bounded-concurrency (3 workers) `.rm` download and InkML conversion, OneNote notebook/section resolution, create-or-PATCH page upload, Phantom Link verification, and rolling ledger recording. Includes per-page cancellation (`CANCEL_SYNC_ITEM`), failed page re-queueing (`RETRY_FAILED_PAGES`), manual document/page sync override (`MANUAL_SYNC_ITEMS`), and `browser.alarms` periodic scheduling that follows `autoSync` / `syncIntervalMinutes` preference changes.
- Byte-for-byte Python `rmc` InkML + HTML parity (`src/converter/`): exact IEEE-754 `Math.fround` float32 pressure/width arithmetic, `parseCrdtSequence` self-reference cycle guard (`nextIds.set(item.itemId, null)`), and exact XML attribute ordering verified against `test_v_3_18.rm`.
- Unified `Sync Control` view (`src/options/views/SyncControlView.tsx`, `src/options/components/SyncStatusIcon.tsx`): combines the hierarchical reMarkable folder/document tree with per-item status icons (uploaded, failed, active uploading, pending), last synced timestamps, OneNote links, manual sync buttons, visual tree guide lines, deep multi-level tri-state folder checkboxes (`-` indeterminate), `selected/total` folder document counters, and a slide-in Pages Side Panel for per-page inspection and manual sync.
- Dashboard 30-day synced activity history (`src/options/views/DashboardView.tsx`): filterable log of all pages uploaded within the last 30 days with OneNote deep links and manual `Re-sync` actions.
- Resizable main container width divider and preference (`src/options/OptionsApp.tsx`, `src/options/views/SettingsView.tsx`, `src/storage/preferences.ts`): hold-and-drag vertical resize divider (`760px` to `2400px`, default `1280px`) with keyboard separator controls and synced slider/numeric setting.
- Annotated PDF page background synchronization (`src/converter/pdfExtractor.ts`, `src/remarkable/metadataParser.ts`, `src/onenote/multipart.ts`, `src/sync/syncEngine.ts`): detects `<documentId>.pdf` attachments and firmware 3.x `cPages.pages[].redir.value` page redirection mappings, slices the exact 1-page PDF in memory via `pdf-lib`, and uploads it as an `application/pdf` multipart background rendered via Microsoft Graph `<img data-render-src="name:background" />` behind the InkML ink layer.
- Interactive Onboarding Tour and safe Demo Mode (`src/options/tour/`, `src/options/demo/`, `src/options/context/`): 15-step guided walkthrough highlighting Account Setup, Dashboard metrics, and Sync Control (emphasizing automatic future syncing for selected folders). Uses an isolated demo database (`rmOneNoteDemoDb`) and simulated messenger via `DataSourceContext` so users can test live buttons, tree expansions, and manual syncing without modifying real accounts or files.
- Sidebar "Take Interactive Tour" button (`src/options/components/Sidebar.tsx`) and first-launch tour prompt with persistent completion state.
- Automated CI/CD pipeline (`.github/workflows/ci.yml`): automated TypeScript typechecking, Vitest unit test suite execution, dual-target MV3 compilation, and extension bundle packaging on every push and pull request, with automated GitHub Releases on semantic version tags.
- Cross-browser distribution packaging script (`scripts/package.mjs`, `package` npm script): zero-dependency standard-library packager generating production-ready distribution archives for Google Chrome, Microsoft Edge, Opera, and Mozilla Firefox (`.zip` and `.xpi`), along with cryptographic SHA-256 checksums in `artifacts/SHA256SUMS.txt`.

### Fixed
- Landscape PDF ink alignment: physical 226 DPI (`2540/226` himetric) conversion factor and full-page bounding box covering negative horizontal offsets so strokes on horizontal PDF pages land on their exact grid coordinates.
- Re-sync page replacement: Microsoft Graph ignores InkML on `PATCH /pages/{id}/content` and appends duplicate PDF printouts; re-syncs now create a fresh page via `POST` before deleting the superseded page ID.
- Options page sidebar scrolling: pinned sidebar to `h-screen overflow-hidden` and tightened vertical spacing, ensuring only the main content area scrolls on taller views like Settings.
- Onboarding tour interaction and alignment: resolved spotlight misalignment when the "Both Accounts Connected" banner appears on Slide 4 using RAF tracking, removed full-screen backdrop click interceptor and blur, auto-expanded demo folders for notebook inspection, expanded dashboard overview focus to all three panels, added container divider and load folders slides, generalized holistic settings slide, and spotlighted the sidebar tour button.
