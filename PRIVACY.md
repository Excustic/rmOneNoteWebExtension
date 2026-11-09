# Privacy Policy for reMarkable to OneNote Sync

Last updated: November 10, 2026

## Overview

reMarkable to OneNote Sync is an open-source, serverless browser extension that enables users to synchronize handwritten notebooks and annotated documents from reMarkable Cloud into Microsoft OneNote.

We believe strongly in user privacy. The extension operates entirely inside your local browser environment. There are no intermediate developer servers, no analytics, and no tracking services.

---

## Data Collection and Processing

### 1. No Data Collection by Developers
The developers of this extension do not collect, view, store, sell, or transmit any of your personal data, credentials, or document contents to any external developer server or third party.

### 2. Direct End-to-End API Communication
All data synchronization occurs directly between your browser and the official services you connect:
* **reMarkable Cloud**: Communicates with `webapp-prod.cloud.remarkable.engineering`, `internal.cloud.remarkable.com`, and Google Cloud Storage (blob CAS) over encrypted HTTPS to download your documents, metadata, and stroke files.
* **Microsoft OneNote / Microsoft Graph**: Communicates with `graph.microsoft.com` and `login.microsoftonline.com` over encrypted HTTPS to upload converted notes directly into your personal Microsoft OneNote notebooks.

### 3. Credentials and Authentication
* **reMarkable Authentication**: Your reMarkable device pairing token and short-lived user tokens are stored locally on your device in your browser's sandboxed storage (`chrome.storage.local`).
* **Microsoft Authentication**: Authentication is conducted securely via Microsoft Entra ID OAuth 2.0 (`chrome.identity.launchWebAuthFlow`). Access and refresh tokens are stored locally in sandboxed browser storage. Credentials are never sent anywhere other than official Microsoft login endpoints.

### 4. Local Storage
* **IndexedDB (Dexie.js)**: Document tree hierarchies, page numbers, sizes, and synchronization status timestamps are cached locally on your device to enable fast diffing and prevent redundant downloads.
* **chrome.storage.sync / chrome.storage.local**: Your configuration preferences (e.g. sync intervals, target notebook name, folder selection whitelist) are stored in browser extension storage.

---

## Data Sharing and Third Parties

The extension does not share, monetize, or transfer your data to any third parties. Data is transferred strictly between the user's browser and:
* **reMarkable AS** (reMarkable Cloud API)
* **Microsoft Corporation** (Microsoft Graph API)

---

## Contact & Source Code

This extension is free and open-source software. You can inspect the source code, verify all network requests, or report issues on GitHub:

* **Repository:** [https://github.com/Excustic/rmOneNoteWebExtension](https://github.com/Excustic/rmOneNoteWebExtension)
