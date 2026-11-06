import { resolve } from 'node:path';
import { crx } from '@crxjs/vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import manifest from './src/manifest';

export default defineConfig(({ mode }) => {
  const isFirefox = mode === 'firefox';
  const targetDir = isFirefox ? 'dist/firefox' : 'dist/chromium';

  return {
    plugins: [
      react(),
      tailwindcss(),
      crx({
        manifest,
        browser: isFirefox ? 'firefox' : 'chrome',
      }),
    ],
    build: {
      outDir: targetDir,
      emptyOutDir: true,
      target: 'esnext',
      rollupOptions: {
        input: {
          popup: resolve(__dirname, 'popup.html'),
          options: resolve(__dirname, 'options.html'),
        },
      },
    },
  };
});
