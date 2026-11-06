# Chrome Web Store Listing — reMarkable to OneNote Sync

> Last Updated: 2026-11-06

## Store Listing

**Extension Name** [REQUIRED]
reMarkable to OneNote Sync

**Short Description** [REQUIRED]
Automatically syncs handwritten notebooks from your reMarkable Cloud account into Microsoft OneNote in the background.

**Detailed Description** [REQUIRED]
Keep your handwritten reMarkable notebooks backed up and searchable inside Microsoft OneNote without running a background desktop app.

Connect your reMarkable account and your Microsoft account once, choose which folders you want to sync, and your updated pages transfer automatically on your chosen schedule.
Preserve editable vector ink and clean page layouts directly inside your OneNote sections.
Check sync progress at any time from the toolbar popup or inspect page-level sync history in the full dashboard tab.

How to get started:
1. Open the extension popup and select Complete Setup.
2. Enter an 8-character pairing code from my.remarkable.com and sign in with your Microsoft account.
3. Choose the reMarkable folders you want synced and set your preferred sync interval.

Privacy first: Your notebooks and sign-in credentials stay in your browser and transfer directly between your reMarkable Cloud account and your Microsoft OneNote account. No intermediate servers ever see your notes.

Support and source code: Report issues or contribute via the project GitHub repository.

**Category** [REQUIRED]
Productivity

**Single Purpose** [REQUIRED]
Synchronizes handwritten notebooks and pages from a user's reMarkable Cloud account into their Microsoft OneNote notebooks.

**Primary Language** [REQUIRED]
English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128x128 PNG | Created | `public/icons/icon-128.png` |
| Screenshot 1 [REQUIRED] | 1280x800 or 640x400 | Not created | |
| Screenshot 2 [RECOMMENDED] | 1280x800 or 640x400 | Not created | |
| Screenshot 3 [RECOMMENDED] | 1280x800 or 640x400 | Not created | |
| Small Promo Tile [RECOMMENDED] | 440x280 | Not created | |

### Screenshot Notes
- Screenshot 1: Full-tab Dashboard and Sync Status view showing synced notebooks and verified OneNote links.
- Screenshot 2: File Browser view demonstrating selective folder whitelisting.
- Screenshot 3: Compact toolbar Popup showing live sync progress and manual sync button.

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Stores user sync preferences, folder whitelists, and recent page sync ledger across devices (`storage.sync`), and persists authentication tokens and background sync status locally (`storage.local`). |
| `alarms` | permissions | Triggers periodic background synchronization checks at the user-configured interval without keeping the service worker permanently awake. |
| `identity` | permissions | Executes Microsoft OAuth 2.0 PKCE sign-in via `chrome.identity.launchWebAuthFlow` so users can authorize OneNote notebook uploads. |
| `https://webapp-prod.cloud.remarkable.engineering/*` | host_permissions | Exchanges the user's one-time pairing code for a reMarkable device token and refreshes short-lived session tokens. |
| `https://internal.cloud.remarkable.com/*` | host_permissions | Retrieves the user's reMarkable document metadata tree to detect updated notebooks and pages. |
| `https://*.storage.googleapis.com/*` | host_permissions | Downloads pre-signed notebook archive blobs issued by reMarkable Cloud storage for in-memory page conversion. |
| `https://graph.microsoft.com/*` | host_permissions | Uploads converted HTML and InkML notebook pages into the user's Microsoft OneNote notebooks and sections. |
| `https://login.microsoftonline.com/*` | host_permissions | Exchanges and refreshes OAuth 2.0 PKCE tokens for Microsoft Graph OneNote API access. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

All authentication credentials and notebook contents remain strictly inside the user's local browser storage and transit directly between reMarkable Cloud APIs and Microsoft Graph APIs. No developer-operated server collects, logs, or receives user data.

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL** [REQUIRED]
Pending GitHub repository publication (will be hosted via GitHub Pages / repository `PRIVACY.md` in Phase 8).

## Distribution

**Visibility**: Public
**Regions**: All regions

## Developer Info

**Publisher Name** [REQUIRED]
Excustic

**Contact Email** [REQUIRED]
Michaelkushnir123233@gmail.com

**Support URL / Email** [RECOMMENDED]
https://github.com/Excustic/rmOneNoteWebExtension/issues

**Homepage URL** [RECOMMENDED]
https://github.com/Excustic/rmOneNoteWebExtension

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 0.1.0 | 2026-11-06 | Phases 1-3 MV3 cross-browser scaffold, IndexedDB + rolling sync ledger, reMarkable OTP pairing, and Microsoft PKCE authentication | Draft |

## Review Notes

### Known Issues / Limitations
- Screenshots (`1280x800` or `640x400`) and Small Promo Tile (`440x280`) will be captured in Phase 8 once all UI views are finalized.
- After Chrome Web Store publication, register the store-assigned `https://<extension-id>.chromiumapp.org/` redirect URI in the Microsoft Entra App Registration.

