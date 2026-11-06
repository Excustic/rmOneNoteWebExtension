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
- **Planned Modules (Phases 3-7):**
  - reMarkable Cloud OTP pairing and Microsoft Graph PKCE authentication via `browser.identity`.
  - In-memory `.rm` archive extraction (`JSZip`) and Rust `rmc` WebAssembly (`WASM`) InkML/HTML conversion.

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
