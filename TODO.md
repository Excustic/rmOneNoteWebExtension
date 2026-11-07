# Project Backlog and Deferred Tasks

Items recorded during active development phases for implementation in upcoming UI polish milestones (Phase 8).

## File Browser UI (`src/options/views/FileBrowserView.tsx`)

- [ ] **Selected Document Count per Folder:** Display beside every folder how many documents inside that folder subtree are currently selected (for example, showing selected count alongside total descendant document count).
- [ ] **Tri-State Folder Checkboxes (`-` Partial Selection):** Ensure folders render an indeterminate `-` indicator whenever some (but not all) descendant documents are selected — whether directly inside the folder or nested in deeper subfolders — and a standard check mark when all descendant documents are selected, matching the tri-state logic in the legacy `rmOneNoteSync` application.
- [ ] **Visual Tree Guide Lines:** Add vertical/horizontal tree guide lines for expanded folder levels so nesting depth is immediately clear at a glance.

## PDF Background Rendering (`src/converter/` & `src/onenote/`)

- [ ] **Annotated PDF Page Rasterization (`Option A`):** When syncing a reMarkable document backed by an underlying `<documentId>.pdf`, download the PDF binary, rasterize page `pageNumber - 1` to JPEG (`Quality = 85`) via `pdfjs-dist` + `OffscreenCanvas`, and attach it as the `"background"` multipart part (`<img data-render-src="name:background" ... />`) behind the InkML strokes in OneNote, matching legacy `PdfConverterService.cs`.

## Unified Sync Control & Queue Redesign (`src/options/views/`)

- [ ] **Merge File Browser and Sync Status into `Sync Control` Tab:** Replace the flat all-pages queue with a single `Sync Control` tab centered around the folder/document tree. Each tree item displays its last synced time, OneNote link, status icon (red X for failed, green tick for successful, blue circling arrows for uploading, yellow indicator for pending), and a manual sync trigger button.
- [ ] **Per-Document Page Inspector & Manual Sync:** Allow clicking a document to view its individual pages and trigger manual synchronization for specific pages, matching the legacy `ManualSyncWindow` workflow.
- [ ] **30-Day Synced Activity Side List:** Display a compact side list logging items synced within the last 30 days alongside the `Sync Control` tree.

## Layout & Container Sizing (`src/options/`)

- [ ] **Resizable Main Container Divider & Width Setting:** Implement a hold-and-drag divider (matching the `Noodle` project pattern) that dynamically resizes the main container width, alongside a persisted container width option in `SettingsView.tsx`.


