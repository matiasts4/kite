import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  extractTerminalLinks,
  getTerminalWebLinksTarget,
  setTerminalWebLinksTarget,
  openTerminalWebLink,
  openBrowserInRightDock,
  openExternalLink,
  TERMINAL_WEB_LINKS_TARGET_STORAGE_KEY,
  TERMINAL_WEB_LINKS_TARGET_CHANGED_EVENT,
  OPEN_RIGHT_DOCK_BROWSER_EVENT,
} from './terminalLinkNav';
import * as ipcModule from './ipc';

describe('terminalLinkNav - Link Extraction & Preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('extractTerminalLinks', () => {
    it('returns empty array on blank text', () => {
      expect(extractTerminalLinks('')).toEqual([]);
      expect(extractTerminalLinks('   ')).toEqual([]);
    });

    it('extracts http and https URLs correctly', () => {
      const text = 'Server started at http://localhost:5173/ and docs at https://vitejs.dev/guide/';
      const links = extractTerminalLinks(text);

      expect(links).toHaveLength(2);
      expect(links[0]).toEqual({
        kind: 'web',
        text: 'http://localhost:5173/',
        start: 18,
        end: 40,
      });
      expect(links[1]).toEqual({
        kind: 'web',
        text: 'https://vitejs.dev/guide/',
        start: 53,
        end: 78,
      });
    });

    it('extracts www. URLs correctly', () => {
      const text = 'Visit www.google.com for more info';
      const links = extractTerminalLinks(text);

      expect(links).toHaveLength(1);
      expect(links[0]).toEqual({
        kind: 'web',
        text: 'www.google.com',
        start: 6,
        end: 20,
      });
    });

    it('strips trailing punctuation from URLs', () => {
      const text = 'Check (https://example.com/test), or https://example.com/demo; see: [https://example.com/item].';
      const links = extractTerminalLinks(text);

      expect(links).toHaveLength(3);
      expect(links[0].text).toBe('https://example.com/test');
      expect(links[1].text).toBe('https://example.com/demo');
      expect(links[2].text).toBe('https://example.com/item');
    });

    it('extracts file paths correctly', () => {
      const text = 'Build error at src/components/views/TerminalView.tsx:42:10 in project';
      const links = extractTerminalLinks(text);

      expect(links).toHaveLength(1);
      expect(links[0]).toEqual({
        kind: 'file',
        text: 'src/components/views/TerminalView.tsx:42:10',
        start: 15,
        end: 58,
      });
    });

    it('extracts Windows paths correctly', () => {
      const text = 'File written to C:\\Users\\Developer\\project\\main.rs:15';
      const links = extractTerminalLinks(text);

      expect(links).toHaveLength(1);
      expect(links[0]).toEqual({
        kind: 'file',
        text: 'C:\\Users\\Developer\\project\\main.rs:15',
        start: 16,
        end: 53,
      });
    });

    it('does NOT fragment a web URL that contains file extensions or slash paths', () => {
      const text = 'Downloaded from https://raw.githubusercontent.com/user/repo/main/src/index.ts successfully';
      const links = extractTerminalLinks(text);

      expect(links).toHaveLength(1);
      expect(links[0].kind).toBe('web');
      expect(links[0].text).toBe('https://raw.githubusercontent.com/user/repo/main/src/index.ts');
    });

    it('extracts both file paths and web links in the same logical line without collision', () => {
      const text = 'Error in ./src/utils.ts:10. Read the docs: https://example.com/docs';
      const links = extractTerminalLinks(text);

      expect(links).toHaveLength(2);
      expect(links[0]).toEqual({
        kind: 'file',
        text: './src/utils.ts:10',
        start: 9,
        end: 26,
      });
      expect(links[1]).toEqual({
        kind: 'web',
        text: 'https://example.com/docs',
        start: 43,
        end: 67,
      });
    });
  });

  describe('preferences', () => {
    it('defaults to internal web links target', () => {
      expect(getTerminalWebLinksTarget()).toBe('internal');
    });

    it('persists and retrieves external preference', () => {
      setTerminalWebLinksTarget('external');
      expect(getTerminalWebLinksTarget()).toBe('external');
      expect(localStorage.getItem(TERMINAL_WEB_LINKS_TARGET_STORAGE_KEY)).toBe('external');
    });

    it('dispatches changed event when target is updated', () => {
      let eventFired = false;
      let detailValue = '';
      const listener = (e: Event) => {
        eventFired = true;
        detailValue = (e as CustomEvent).detail;
      };
      window.addEventListener(TERMINAL_WEB_LINKS_TARGET_CHANGED_EVENT, listener);

      setTerminalWebLinksTarget('external');
      expect(eventFired).toBe(true);
      expect(detailValue).toBe('external');

      window.removeEventListener(TERMINAL_WEB_LINKS_TARGET_CHANGED_EVENT, listener);
    });
  });

  describe('routing & opening', () => {
    it('openBrowserInRightDock dispatches OPEN_RIGHT_DOCK_BROWSER_EVENT', () => {
      let dispatchedDetail: any = null;
      const listener = (e: Event) => {
        dispatchedDetail = (e as CustomEvent).detail;
      };
      window.addEventListener(OPEN_RIGHT_DOCK_BROWSER_EVENT, listener);

      openBrowserInRightDock({ url: 'https://vitejs.dev', workspaceId: 'ws-123' });
      expect(dispatchedDetail).toEqual({ url: 'https://vitejs.dev', workspaceId: 'ws-123' });

      window.removeEventListener(OPEN_RIGHT_DOCK_BROWSER_EVENT, listener);
    });

    it('openTerminalWebLink routes to internal browser by default', () => {
      let dispatchedDetail: any = null;
      const listener = (e: Event) => {
        dispatchedDetail = (e as CustomEvent).detail;
      };
      window.addEventListener(OPEN_RIGHT_DOCK_BROWSER_EVENT, listener);

      openTerminalWebLink('https://example.com', 'ws-test');
      expect(dispatchedDetail).toEqual({ url: 'https://example.com', workspaceId: 'ws-test' });

      window.removeEventListener(OPEN_RIGHT_DOCK_BROWSER_EVENT, listener);
    });

    it('openTerminalWebLink prepends https:// to www. addresses', () => {
      let dispatchedDetail: any = null;
      const listener = (e: Event) => {
        dispatchedDetail = (e as CustomEvent).detail;
      };
      window.addEventListener(OPEN_RIGHT_DOCK_BROWSER_EVENT, listener);

      openTerminalWebLink('www.example.com', 'ws-test');
      expect(dispatchedDetail.url).toBe('https://www.example.com');

      window.removeEventListener(OPEN_RIGHT_DOCK_BROWSER_EVENT, listener);
    });

    it('openTerminalWebLink routes to external link when preference is external', () => {
      setTerminalWebLinksTarget('external');

      vi.spyOn(ipcModule, 'isTauriEnvironment').mockReturnValue(false);
      const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

      openTerminalWebLink('https://github.com');
      expect(openSpy).toHaveBeenCalledWith('https://github.com', '_blank', 'noopener,noreferrer');
    });

    it('openExternalLink calls invokeCommand in Tauri environment', () => {
      vi.spyOn(ipcModule, 'isTauriEnvironment').mockReturnValue(true);
      const invokeSpy = vi.spyOn(ipcModule, 'invokeCommand').mockResolvedValue(null);

      openExternalLink('https://tauri.app');
      expect(invokeSpy).toHaveBeenCalledWith('open_external_link', { url: 'https://tauri.app' });
    });
  });
});
