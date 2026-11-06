# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial Vite + React + TypeScript Manifest V3 scaffold (`pnpm` workspace).
- Dual-target MV3 build pipeline outputting `dist/chromium` (Chrome, Edge, Opera service worker) and `dist/firefox` (Firefox MV3 event page + Gecko add-on metadata).
- Tailwind CSS v4 configuration aligned with the legacy Avalonia UI palette (`#1a1d2e` dark sidebar, `#2563eb` primary action).
- Extension Popup (`popup.html`) quick-status shell and Options Page (`options.html`) hash-routed multi-view shell (`Dashboard`, `File Browser`, `Sync Status`, `Logs`, `Settings`, `Setup`).
- Ephemeral-safe MV3 background entrypoint (`src/background/index.ts`) with top-level event listener registration.
