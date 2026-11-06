/**
 * Cross-browser Manifest V3 builder.
 *
 * - Chromium targets (Chrome, Edge, Opera) use `background.service_worker`.
 * - Firefox MV3 uses event pages (`background.scripts`) and requires `browser_specific_settings.gecko`
 *   for `chrome.storage.sync` and `chrome.identity` redirect resolution.
 *
 * NOTE: `icons` and `action.default_icon` are intentionally omitted until curated
 * 16x16, 48x48, and 128x128 PNG assets are added to `public/icons/`.
 */
export function buildManifest(targetBrowser: 'chrome' | 'firefox'): Record<string, unknown> {
  const isFirefox = targetBrowser === 'firefox';

  const manifest: Record<string, unknown> = {
    manifest_version: 3,
    name: 'reMarkable to OneNote Sync',
    short_name: 'rmOneNote',
    version: '0.1.0',
    description:
      'Autonomous serverless sync between reMarkable Cloud notebooks and Microsoft OneNote.',
    action: {
      default_title: 'reMarkable to OneNote Sync',
      default_popup: 'popup.html',
    },
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
    background: isFirefox
      ? {
          scripts: ['src/background/index.ts'],
          type: 'module',
        }
      : {
          service_worker: 'src/background/index.ts',
          type: 'module',
        },
    permissions: ['storage', 'alarms', 'identity'],
    host_permissions: [
      'https://webapp-prod.cloud.remarkable.engineering/*',
      'https://internal.cloud.remarkable.com/*',
      'https://*.storage.googleapis.com/*',
      'https://graph.microsoft.com/*',
      'https://login.microsoftonline.com/*',
    ],
  };

  if (isFirefox) {
    manifest.browser_specific_settings = {
      gecko: {
        id: 'rm-onenote-sync@excustic.dev',
        strict_min_version: '115.0',
        data_collection_permissions: {
          required: ['none'],
        },
      },
    };
  }

  return manifest;
}
