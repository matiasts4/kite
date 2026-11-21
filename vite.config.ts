/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const BROWSER_LANE_API = process.env.KITE_BROWSER_API_URL || 'http://127.0.0.1:1421';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  clearScreen: false,
  worker: {
    format: 'es',
  },
  define:
    mode === 'browser'
      ? {
          'import.meta.env.VITE_KITE_BROWSER_TEST': JSON.stringify('1'),
        }
      : {},
  optimizeDeps: {
    entries: ['index.html'],
  },
  server: {
    host: true,
    port: mode === 'browser' ? 1430 : 1420,
    strictPort: true,
    watch: {
      ignored: [
        '**/src-tauri/target/**',
        '**/crates/**/target/**',
        '**/.codegraph/**',
        '**/.kite/**',
        '**/test-results/**',
        '**/bench-results/**',
        '**/releases/**',
        '**/dist/**',
      ],
    },
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
          if (id.includes('vite/preload-helper') || id.includes('commonjsHelpers')) {
            return 'vendor-runtime';
          }
          if (!id.includes('node_modules')) return;
          if (id.includes('@xterm')) {
            return 'vendor-xterm';
          }
          if (/[\\/]node_modules[\\/]motion[\\/]/.test(id) || /[\\/]node_modules[\\/]framer-motion[\\/]/.test(id)) {
            return 'vendor-motion';
          }
          if (id.includes('@tauri-apps')) {
            return 'vendor-tauri';
          }
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return 'vendor-react';
          }
          return undefined;
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Motion adds transform/collect work to many suites; 5s is tight on a
    // loaded local machine, so allow slow UI interaction tests to finish.
    testTimeout: 15000,
    exclude: ['**/node_modules/**', '**/dist/**', '**/scratch/**', '**/scripts/**'],
  },
}));
