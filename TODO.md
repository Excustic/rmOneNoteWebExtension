# Project Backlog and Deferred Tasks

Items recorded during active development phases.

## Sync Control & File Tree UI (`src/options/views/SyncControlView.tsx`)

- [x] **Selected Document Count per Folder:** Display beside every folder how many documents inside that folder subtree are currently selected (`selected/total selected`).
- [x] **Tri-State Folder Checkboxes (`-` Partial Selection):** Ensure folders render an indeterminate `-` indicator whenever some (but not all) descendant documents are selected — whether directly inside the folder or nested in deeper subfolders — and a standard check mark when all descendant documents are selected, matching the tri-state logic in the legacy `rmOneNoteSync` application.
- [x] **Visual Tree Guide Lines:** Add vertical/horizontal tree guide lines for expanded folder levels so nesting depth is immediately clear at a glance.

## PDF Background Rendering (`src/converter/` & `src/onenote/`)

- [x] **Annotated PDF Page Background Sync (`Option 1 - pdf-lib`):** When syncing a reMarkable document backed by an underlying `<documentId>.pdf`, download the PDF binary, slice the target 0-based `pdfPageIndex` (resolved from `cPages.pages[].redir.value` or page order) into a standalone 1-page PDF using `pdf-lib`, and attach it as the `"background"` multipart part (`Content-Type: application/pdf`, `<img data-render-src="name:background" ... />`) behind the InkML strokes in OneNote.

## Unified Sync Control & Queue Redesign (`src/options/views/`)

- [x] **Merge File Browser and Sync Status into `Sync Control` Tab:** Replace the flat all-pages queue with a single `Sync Control` tab centered around the folder/document tree. Each tree item displays its last synced time, OneNote link, status icon (red X for failed, green tick for successful, blue circling arrows for uploading, yellow indicator for pending), and a manual sync trigger button.
- [x] **Per-Document Page Inspector & Manual Sync:** Allow clicking a document row to slide in a Pages Side Panel listing its individual pages with status, timestamp, OneNote link, and manual synchronization triggers, matching the legacy `ManualSyncWindow` workflow.
- [x] **30-Day Synced Activity List on Dashboard:** Display the filterable list of pages synced within the last 30 days on `DashboardView.tsx`.

## Layout & Container Sizing (`src/options/`)

- [x] **Resizable Main Container Divider & Width Setting:** Implement a hold-and-drag divider (matching the `Noodle` project pattern) that dynamically resizes the main container width, alongside a persisted container width option in `SettingsView.tsx`.

## Onboarding & Interactive Tour (`src/options/tour/` & `src/options/demo/`)

- [x] **Interactive Onboarding Tour & Demo Mode:** Guided walkthrough explaining account setup, dashboard metrics, sync control features (folder tree navigation, slide-in pages panel, manual syncing), emphasizing automatic future syncs for selected folders. Includes dedicated mock database and simulated messaging so users can interact with live-feeling UI controls safely, auto-prompting on initial launch and replayable from the sidebar.

## DevOps & CI/CD Pipeline (`.github/workflows/` & `scripts/`)

- [x] **Continuous Integration & Extension Packaging Pipeline:** GitHub Actions workflow (`ci.yml`) triggering on pushes and pull requests to run TypeScript typechecking (`pnpm run typecheck`), Vitest unit tests (`pnpm test`), dual-target compilation (`pnpm run build`), and packaging (`pnpm run package`). Generates separate distribution archives for Chrome, Firefox (`.zip` and `.xpi`), Edge, and Opera with SHA-256 checksums, uploaded as workflow artifacts and published to GitHub Releases on version tags.



