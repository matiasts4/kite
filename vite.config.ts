/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BROWSER_LANE_API = process.env.KITE_BROWSER_API_URL || 'http://127.0.0.1:1421';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  clearScreen: false,
  define:
    mode === 'browser'
      ? {
          'import.meta.env.VITE_KITE_BROWSER_TEST': JSON.stringify('1'),
        }
      : {},
  server: {
    host: true,
    port: mode === 'browser' ? 1430 : 1420,
    strictPort: true,
    proxy:
      mode === 'browser'
        ? {
            '/api': {
              target: BROWSER_LANE_API,
              changeOrigin: true,
            },
          }
        : undefined,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            return 'vendor';
          }
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/scratch/**', '**/scripts/**'],
  },
}));
