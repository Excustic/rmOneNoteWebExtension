import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import webExtension from 'vite-plugin-web-extension';
import { buildManifest } from './src/manifest';

export default defineConfig(({ command, mode }) => {
  const isFirefox = mode === 'firefox';
  const targetBrowser = isFirefox ? 'firefox' : 'chrome';
  const outDir = isFirefox ? 'dist/firefox' : 'dist/chromium';

  const profileDir = resolve(
    __dirname,
    isFirefox ? '.dev-profile/firefox' : '.dev-profile/chromium',
  );

  if (command === 'serve') {
    // Ensure persistent browser profile directory exists before web-ext launches
    // so authentication tokens and IndexedDB state survive across dev sessions.
    mkdirSync(profileDir, { recursive: true });
  }

  return {
    plugins: [
      react(),
      tailwindcss(),
      webExtension({
        manifest: () => buildManifest(targetBrowser),
        browser: targetBrowser,
        webExtConfig: {
          target: isFirefox ? 'firefox-desktop' : 'chromium',
          keepProfileChanges: true,
          firefoxProfile: profileDir,
          chromiumProfile: profileDir,
          profileCreateIfMissing: true,
        },
      }),
    ],
    build: {
      outDir,
      emptyOutDir: true,
      modulePreload: false,
      target: 'esnext',
    },
  };
});
