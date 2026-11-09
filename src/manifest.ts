/**
 * Cross-browser Manifest V3 builder.
 *
 * - Chromium targets (Chrome, Edge, Opera) use `background.service_worker`.
 * - Firefox MV3 uses event pages (`background.scripts`) and requires `browser_specific_settings.gecko`
 *   for `chrome.storage.sync` and `chrome.identity` redirect resolution.
 */
export function buildManifest(targetBrowser: 'chrome' | 'firefox'): Record<string, unknown> {
  const isFirefox = targetBrowser === 'firefox';

  const manifest: Record<string, unknown> = {
    manifest_version: 3,
    name: 'reMarkable to OneNote Sync',
    short_name: 'rmOneNote',
    version: '1.1.0',
    description:
      'Autonomous serverless sync between reMarkable Cloud notebooks and Microsoft OneNote.',
    icons: {
      '16': 'icons/icon-16.png',
      '48': 'icons/icon-48.png',
      '128': 'icons/icon-128.png',
    },
    action: {
      default_title: 'reMarkable to OneNote Sync',
      default_popup: 'popup.html',
      default_icon: {
        '16': 'icons/icon-16.png',
        '48': 'icons/icon-48.png',
        '128': 'icons/icon-128.png',
      },
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
