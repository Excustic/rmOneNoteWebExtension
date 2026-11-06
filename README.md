# reMarkable to OneNote Web Extension

Serverless Manifest V3 browser extension for autonomously syncing notebooks and handwritten ink from reMarkable Cloud to Microsoft OneNote across Chrome, Edge, Firefox, and Opera.

## Architecture Overview

This project migrates the desktop `rmOneNoteSync` daemon into a pure browser extension:

- **UI Layer:** React 19, TypeScript, and Tailwind CSS v4.
  - `popup.html` (`src/popup/`): Quick status summary, manual sync trigger, and account setup redirect.
  - `options.html` (`src/options/`): Full-tab management interface with hash-based routing (`#dashboard`, `#files`, `#sync-status`, `#settings`, `#setup`).
- **Background Engine:** Ephemeral-safe Manifest V3 background worker (`src/background/index.ts`), compiled as a Service Worker for Chromium (`Chrome`, `Edge`, `Opera`) and as an Event Page for Firefox MV3 via `webextension-polyfill`.
- **Storage & State Layer (`src/db/`, `src/storage/`):**
  - `Dexie.js` (IndexedDB) for local document tree, per-page sync deltas, OneNote notebook/section caching, and portable `.json` database backup/restore.
  - `browser.storage.sync` with 1-to-1 Base64url UUID packing for folder/file whitelists, user preferences, and a 1,280-page cross-PC rolling sync ledger with eviction detection.
- **Authentication Layer (`src/auth/`):**
  - reMarkable Cloud 8-character OTP device pairing (`/token/json/2/device/new`), JWT `exp`-aware session token caching (`/token/json/2/user/new`), and transparent HTTP 401 refresh-and-retry interceptor.
  - Microsoft Entra ID OAuth 2.0 Authorization Code + S256 PKCE via `browser.identity.launchWebAuthFlow`, refresh token persistence in `browser.storage.local`, and silent HTTP 401 Graph API interceptor.
- **reMarkable Sync15 Client (`src/remarkable/`):**
  - Native read-only Sync15 protocol client (`/sync/v4/root` and `/sync/v3/files/<hash>` with `rm-filename` headers), incremental SHA-256 tree & page delta indexing into IndexedDB, tri-state folder/notebook whitelisting (`FileBrowserView.tsx`), and direct in-memory `Uint8Array` `.rm` page retrieval (`downloadPageRmBytes`).
- **InkML & HTML Converter (`src/converter/`):**
  - Pure native TypeScript port of `rmscene` + `rmc` (`inmkl.py`): decodes `.rm` v6 CRDT `SceneTree` blocks, Type Folio `RootTextBlock` formatting, 64-bit paragraph anchors, OS 3.6+ dynamic RGBA highlight/shader strokes, and legacy `.rm` v3/v5 strokes directly in memory into OneNote-compatible `application/inkml+xml` and `text/html` payloads (`convertRmPage`, `downloadAndConvertRmPage`) without WebAssembly or Python runtime overhead.
- **Microsoft Graph OneNote Client (`src/onenote/`):**
  - Native TypeScript client (`OneNoteClient`) with RFC 7578 binary `multipart/form-data` payload framing (`presentation` HTML + `presentation-onenote-inkml` XML), `AsyncSemaphore` concurrency limiting (max 3 concurrent Graph requests), `Retry-After` and jittered exponential backoff on HTTP `429`/`500`/`503`/`504`, Phantom Link verification polling (`getPageWithPhantomLinkVerification`), and `KeyedMutex`-protected `OneNoteDirectoryCache` backed by `Dexie.notebooks`.
- **Autonomous Sync Engine (`src/sync/`):**
  - `runSyncCycle` drives the full pipeline (ledger reconcile -> Sync15 tree diff -> `.rm` download -> InkML/HTML conversion -> OneNote create-or-update -> Phantom Link verification -> rolling ledger). Triggered manually from the UI or periodically by `browser.alarms`; only one cycle runs at a time.
- **Planned Modules (Phase 8):**
  - Full dashboard/status UI polish, OSS documentation, and CI/CD workflows.

## Prerequisites

- Node.js 22+
- `pnpm` 10+

## Development & Build Commands

Install dependencies:

```bash
pnpm install
```

Launch live-reloading browser sessions with persistent local profiles (`.dev-profile/chromium` and `.dev-profile/firefox`, preserving OAuth tokens and IndexedDB across restarts):

```bash
# Launch Chromium with the extension installed and persistent profile
pnpm run dev

# Launch Firefox with the extension installed and persistent profile
pnpm run dev:firefox
```

Build production unpacked bundles (`dist/chromium` and `dist/firefox`):

```bash
pnpm run build
```

Run strict TypeScript verification and unit tests:

```bash
pnpm run typecheck
pnpm test
```

## Loading Production Builds Manually

### Chrome / Edge / Opera
1. Navigate to `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose `dist/chromium`.

### Firefox
1. Navigate to `about:debugging#/runtime/this-firefox`.
2. Select **Load Temporary Add-on...**.
3. Choose `dist/firefox/manifest.json`.

## License

Released under the [GNU General Public License v3.0](LICENSE).
