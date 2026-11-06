# reMarkable to OneNote Web Extension

Serverless Manifest V3 browser extension for autonomously syncing notebooks and handwritten ink from reMarkable Cloud to Microsoft OneNote across Chrome, Edge, Firefox, and Opera.

## Architecture Overview

This project migrates the desktop `rmOneNoteSync` daemon into a pure browser extension:

- **UI Layer:** React 19, TypeScript, and Tailwind CSS v4.
  - `popup.html` (`src/popup/`): Quick status summary, manual sync trigger, and account setup redirect.
  - `options.html` (`src/options/`): Full-tab management interface with hash-based routing (`#dashboard`, `#files`, `#sync-status`, `#logs`, `#settings`, `#setup`).
- **Background Engine:** Ephemeral-safe Manifest V3 background worker (`src/background/index.ts`), compiled as a Service Worker for Chromium (`Chrome`, `Edge`, `Opera`) and as an Event Page for Firefox MV3.
- **Planned Modules (Phases 2-7):**
  - `Dexie.js` (IndexedDB) for local sync delta tracking and `chrome.storage.sync` for user preferences.
  - reMarkable Cloud OTP pairing and Microsoft Graph PKCE authentication via `chrome.identity`.
  - In-memory `.rm` archive extraction (`JSZip`) and Rust `rmc` WebAssembly (`WASM`) InkML/HTML conversion.

## Prerequisites

- Node.js 22+
- `pnpm` 10+

## Development & Build Commands

Install dependencies:

```bash
pnpm install
```

Build both browser targets (`dist/chromium` and `dist/firefox`):

```bash
pnpm run build
```

Run Vite watch/dev server for a specific browser family:

```bash
# Chrome, Edge, Opera
pnpm run dev

# Firefox
pnpm run dev:firefox
```

Run strict TypeScript verification:

```bash
pnpm run typecheck
```

## Loading Unpacked Builds

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
