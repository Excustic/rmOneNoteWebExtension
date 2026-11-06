# Project Backlog and Deferred Tasks

Items recorded during active development phases for implementation in upcoming UI polish milestones (Phase 8).

## File Browser UI (`src/options/views/FileBrowserView.tsx`)

- [ ] **Selected Document Count per Folder:** Display beside every folder how many documents inside that folder subtree are currently selected (for example, showing selected count alongside total descendant document count).
- [ ] **Tri-State Folder Checkboxes (`-` Partial Selection):** Ensure folders render an indeterminate `-` indicator whenever some (but not all) descendant documents are selected — whether directly inside the folder or nested in deeper subfolders — and a standard check mark when all descendant documents are selected, matching the tri-state logic in the legacy `rmOneNoteSync` application.
- [ ] **Visual Tree Guide Lines:** Add vertical/horizontal tree guide lines for expanded folder levels so nesting depth is immediately clear at a glance.
