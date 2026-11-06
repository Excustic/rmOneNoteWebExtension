/**
 * Cross-browser WebExtension namespace resolver.
 *
 * Chrome, Edge, Opera, and Firefox 115+ (MV3) all expose Promise-based APIs on
 * `chrome.*`, while Firefox also exposes `browser.*`. Resolving `browser ?? chrome`
 * avoids pulling in external polyfill dependencies for standard MV3 APIs.
 */
declare global {
  var browser: typeof chrome | undefined;
}

export const ext: typeof chrome = globalThis.browser ?? globalThis.chrome;

/**
 * Opens the extension Options page at a specific hash route in a new browser tab.
 * Note: `tabs.create` does not require the `"tabs"` manifest permission.
 */
export async function openOptionsAtRoute(hashRoute: string): Promise<void> {
  const normalized = hashRoute.replace(/^#/, '');
  const url = ext.runtime.getURL(`options.html#${normalized}`);
  await ext.tabs.create({ url });
}

