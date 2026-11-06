import browser, { type Browser } from 'webextension-polyfill';

/**
 * Standardized Promise-based WebExtension namespace across Chrome, Edge, Firefox, and Opera.
 */
export const ext: Browser = browser;

/**
 * Opens the extension Options page at a specific hash route in a new browser tab.
 * Note: `tabs.create` does not require the `"tabs"` manifest permission.
 */
export async function openOptionsAtRoute(hashRoute: string): Promise<void> {
  const normalized = hashRoute.replace(/^#/, '');
  const url = ext.runtime.getURL(`options.html#${normalized}`);
  await ext.tabs.create({ url });
}
