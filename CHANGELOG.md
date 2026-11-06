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
