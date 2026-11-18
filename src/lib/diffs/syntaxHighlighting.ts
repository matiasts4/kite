import type { HighlighterTypes } from '@pierre/diffs';

/**
 * Use the lightweight WASM syntax highlighter (`highlights`) across diff views
 * so main-thread and worker passes stay fast inside desktop WebView windows.
 */
export const PREFERRED_DIFF_HIGHLIGHTER: HighlighterTypes = 'highlights';
