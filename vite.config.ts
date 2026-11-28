/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const BROWSER_LANE_API = process.env.KITE_BROWSER_API_URL || 'http://127.0.0.1:1421';

// Kite exclusively uses `@pierre/highlights` (`PREFERRED_DIFF_HIGHLIGHTER = 'highlights'`).
// `@pierre/diffs` dynamically imports Shiki/TextMate backends in both the main bundle
// and its `?worker` bundle, which otherwise emits ~700 unused grammar chunks (~22 MB).
const UNUSED_SHIKI_STUBS: Record<string, string> = {
  'shiki/langs': 'export const bundledLanguages = {};',
  'shiki/core':
    "export const createCssVariablesTheme = () => ({}); export const normalizeTheme = (t) => t; export const createHighlighterCore = async () => { throw new Error('Shiki highlighter is disabled in Kite production builds; use highlights.'); };",
  'shiki/textmate': 'export const EncodedTokenMetadata = {}; export const INITIAL = 0;',
  'shiki/wasm': 'export default null;',
  'shiki/engine/oniguruma': 'export const createOnigurumaEngine = async () => ({});',
  'shiki/engine/javascript': 'export const createJavaScriptRegexEngine = () => ({});',
  '@pierre/theming/themes': 'export const themes = { getTheme: () => undefined };',
};

function stripUnusedShikiPlugin(): Plugin {
  const prefix = '\0kite-stub:';
  return {
    name: 'kite-strip-unused-shiki',
    enforce: 'pre',
    resolveId(source) {
      if (Object.prototype.hasOwnProperty.call(UNUSED_SHIKI_STUBS, source)) {
        return `${prefix}${source}`;
      }
      return null;
    },
    load(id) {
      if (id.startsWith(prefix)) {
        return UNUSED_SHIKI_STUBS[id.slice(prefix.length)] ?? null;
      }
      return null;
    },
  };
}

export default defineConfig(({ command, mode }) => ({
  plugins: [react(), ...(command === 'build' ? [stripUnusedShikiPlugin()] : [])],
  clearScreen: false,
  worker: {
    format: 'es',
    plugins: () => (command === 'build' ? [stripUnusedShikiPlugin()] : []),
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
    reportCompressedSize: false,
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
