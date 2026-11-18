import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages serves project sites from /<repo>/; a relative base keeps the
// build usable both at the repository sub-path and at a custom domain root.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1400,
  },
  worker: { format: 'es' },
  optimizeDeps: {
    exclude: ['pdfjs-dist'],
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'NŌTA',
        short_name: 'NŌTA',
        description: 'Offline-first handwriting notes for Apple Pencil',
        start_url: './index.html',
        scope: './',
        display: 'standalone',
        orientation: 'any',
        background_color: '#faf8f4',
        theme_color: '#faf8f4',
        categories: ['productivity', 'education'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm,mjs}'],
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        navigateFallback: 'index.html',
        // The same server also answers /pair, /setup and /ca. Without this the
        // installed app would answer those navigations with its own shell, and
        // the laptop's pairing page would open as the app instead of the page.
        navigateFallbackDenylist: [/(^|\/)(pair|setup|ca|profile)(\/|$)/, /(^|\/)api\//],
        cleanupOutdatedCaches: true,
        // A new build has to take control even if nobody taps the update banner
        // (dismissing it used to leave the iPad on the old build until the app
        // was removed from the home screen).
        skipWaiting: true,
        clientsClaim: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    host: true,
  },
});
