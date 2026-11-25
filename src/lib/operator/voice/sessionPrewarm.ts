// Kite Code — Voice Session Pre-Warming & Chat Catalog Cache
// Keeps chat catalog hot for 30s (invalidated on chat/thread mutations) and warms TLS/HTTP2
// connections + memory notes when a voice session opens, without modifying voiceSessionStore.ts.

import { invokeCommand, isTauriEnvironment } from '../../ipc';
import { fetchLiveChatCatalog, type ChatIndexEntry } from '../chatIndex';
import { loadOperatorConfig, loadZedMemoryNotes } from '../operatorConfig';
import { voiceSessionStore } from './voiceSessionStore';

const CHAT_CATALOG_TTL_MS = 30_000;

interface CachedCatalogEntry {
  entries: ChatIndexEntry[];
  fetchedAt: number;
}

const catalogCache = new Map<string, CachedCatalogEntry>();
let prewarmHookRegistered = false;
let lastPrewarmedAt = 0;

function catalogKey(workspaceId?: string | null): string {
  return (workspaceId || '').trim() || '__all__';
}

export function invalidateChatCatalogCache(workspaceId?: string | null): void {
  if (workspaceId) {
    catalogCache.delete(catalogKey(workspaceId));
  } else {
    catalogCache.clear();
  }
}

export async function getCachedLiveChatCatalog(
  workspaceId?: string,
  nowMs: number = Date.now()
): Promise<{ entries: ChatIndexEntry[] }> {
  const key = catalogKey(workspaceId);
  const cached = catalogCache.get(key);
  if (cached && nowMs - cached.fetchedAt < CHAT_CATALOG_TTL_MS) {
    return { entries: cached.entries };
  }

  const fresh = await fetchLiveChatCatalog(workspaceId);
  catalogCache.set(key, {
    entries: fresh.entries,
    fetchedAt: nowMs,
  });
  return fresh;
}

function resolvePrewarmEndpoints(): string[] {
  const urls: string[] = [];
  try {
    const cfg = loadOperatorConfig();
    if (cfg.activeProvider === 'opencode' && cfg.opencodeBaseUrl) {
      urls.push(cfg.opencodeBaseUrl.replace(/\/+$/, ''));
    } else if (cfg.activeProvider === 'vercel' && cfg.vercelBaseUrl) {
      urls.push(cfg.vercelBaseUrl.replace(/\/+$/, ''));
    } else if (cfg.activeProvider === 'cloudflare' && cfg.cloudflareBaseUrl) {
      urls.push(cfg.cloudflareBaseUrl.replace(/\/+$/, ''));
    } else if (cfg.activeProvider === 'grok' && cfg.grokBaseUrl) {
      urls.push(cfg.grokBaseUrl.replace(/\/+$/, ''));
    }
    if (cfg.ttsEngine === 'elevenlabs' && cfg.elevenlabsApiKey?.trim()) {
      urls.push('https://api.elevenlabs.io/v1/voices');
    }
  } catch {
    // ignore config read issues
  }
  return urls;
}

export async function prewarmVoiceSession(options?: {
  workspaceId?: string | null;
}): Promise<void> {
  try {
    loadOperatorConfig();
    loadZedMemoryNotes();
  } catch {
    // ignore local storage issues in non-browser tests
  }

  await getCachedLiveChatCatalog(options?.workspaceId || undefined).catch(() => ({
    entries: [],
  }));

  if (isTauriEnvironment()) {
    const endpoints = resolvePrewarmEndpoints();
    await Promise.allSettled(
      endpoints.map((url) =>
        invokeCommand('proxy_operator_http', {
          url,
          method: 'HEAD',
          headers: { Connection: 'keep-alive' },
          body: null,
          timeoutSecs: 5,
        }).catch(() => undefined)
      )
    );
  }
}

export function ensureVoiceSessionPrewarmHook(): void {
  if (prewarmHookRegistered) return;
  prewarmHookRegistered = true;

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const invalidateHandler = () => invalidateChatCatalogCache();
    window.addEventListener('kite:chat-updated', invalidateHandler);
    window.addEventListener('kite:thread-updated', invalidateHandler);
  }

  let prevPhase = voiceSessionStore.getSnapshot().phase;
  voiceSessionStore.subscribe(() => {
    const snap = voiceSessionStore.getSnapshot();
    const becameActive =
      (prevPhase === 'inactive' || prevPhase === 'stopping') &&
      (snap.phase === 'starting' || snap.phase === 'active');
    prevPhase = snap.phase;
    if (becameActive) {
      const now = Date.now();
      if (now - lastPrewarmedAt < 2000) return;
      lastPrewarmedAt = now;
      void prewarmVoiceSession().catch(() => {});
    }
  });
}

export function resetSessionPrewarmForTests(): void {
  catalogCache.clear();
  lastPrewarmedAt = 0;
}
