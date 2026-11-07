# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
