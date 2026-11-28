import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ctxClient } from '../context/ctxClient';
import { voiceSessionStore } from './voiceSessionStore';
import {
  VOICE_COMPANION_CHANNEL_NAME,
  VOICE_HOST_CLAIM_STORAGE_KEY,
  acquireVoiceHostClaim,
  attachContextSnapshotToVoiceTurn,
  captureVisualContextSnapshot,
  clearLastAttachedContextSnapshot,
  COMPANION_GLOBAL_SHORTCUT_STORAGE_KEY,
  DEFAULT_COMPANION_GLOBAL_SHORTCUT,
  getActiveCompanionSurface,
  getActiveVoiceHostClaim,
  getLastAttachedContextSnapshot,
  loadCompanionGlobalShortcut,
  matchesCompanionHotkey,
  registerOsCompanionGlobalShortcut,
  releaseVoiceHostClaim,
  resetCompanionTransferForTests,
  saveCompanionGlobalShortcut,
  subscribeCompanionTransferEvents,
  transferVoiceCallSurface,
  type VoiceCallTransferEvent,
} from './companionTransfer';

class MockBroadcastChannel {
  static instances: MockBroadcastChannel[] = [];
  readonly name: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  closed = false;

  constructor(name: string) {
    this.name = name;
    MockBroadcastChannel.instances.push(this);
  }

  postMessage(data: unknown) {
    for (const inst of MockBroadcastChannel.instances) {
      if (inst !== this && !inst.closed && inst.name === this.name && inst.onmessage) {
        inst.onmessage(new MessageEvent('message', { data }));
      }
    }
  }

  close() {
    this.closed = true;
  }
}

describe('companionTransfer — Singleton Voice Lock, Call Transfer & Visual Context', () => {
  const originalBroadcastChannel = globalThis.BroadcastChannel;

  beforeEach(() => {
    MockBroadcastChannel.instances = [];
    (globalThis as unknown as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel =
      MockBroadcastChannel as unknown as typeof BroadcastChannel;
    voiceSessionStore.stopSession();
    voiceSessionStore.setMicMuted(false);
    voiceSessionStore.setSpeakerMuted(false);
    voiceSessionStore.registerTextTurnExecutor(null);
    ctxClient.resetForTests();
    resetCompanionTransferForTests();
    clearLastAttachedContextSnapshot();
    localStorage.clear();
  });

  afterEach(() => {
    (globalThis as unknown as { BroadcastChannel: typeof BroadcastChannel }).BroadcastChannel =
      originalBroadcastChannel;
    vi.restoreAllMocks();
  });

  it('coordinates cross-window singleton voice host claims in localStorage', () => {
    const t0 = 1_000_000;
    const claimA = acquireVoiceHostClaim('win-a', 'thread-1', {
      surface: 'companion',
      nowMs: t0,
      ttlMs: 10_000,
    });
    expect(claimA.acquired).toBe(true);
    expect(claimA.claim?.windowId).toBe('win-a');
    expect(claimA.claim?.threadId).toBe('thread-1');

    const storedRaw = localStorage.getItem(VOICE_HOST_CLAIM_STORAGE_KEY);
    expect(storedRaw).toBeTruthy();

    // Another window cannot steal an active claim without force
    const claimBBlocked = acquireVoiceHostClaim('win-b', 'thread-2', {
      surface: 'orb',
      nowMs: t0 + 1_000,
    });
    expect(claimBBlocked.acquired).toBe(false);
    expect(claimBBlocked.ownerWindowId).toBe('win-a');

    // Non-owner cannot release window A's claim
    expect(releaseVoiceHostClaim('win-b', t0 + 1_000)).toBe(false);
    expect(getActiveVoiceHostClaim(t0 + 1_000)?.windowId).toBe('win-a');

    // Once expired, window B can acquire cleanly
    const claimBAfterExpiry = acquireVoiceHostClaim('win-b', 'thread-2', {
      surface: 'orb',
      nowMs: t0 + 15_000,
    });
    expect(claimBAfterExpiry.acquired).toBe(true);
    expect(claimBAfterExpiry.ownerWindowId).toBe('win-b');

    // Owner releases cleanly
    expect(releaseVoiceHostClaim('win-b', t0 + 16_000)).toBe(true);
    expect(getActiveVoiceHostClaim(t0 + 16_000)).toBeNull();
  });

  it('broadcasts transfer and claim events over BroadcastChannel and falls back safely when absent', () => {
    const received: VoiceCallTransferEvent[] = [];
    const unsubscribe = subscribeCompanionTransferEvents((ev) => received.push(ev));

    transferVoiceCallSurface('companion', {
      threadId: 'thread-bc',
      windowId: 'win-sender',
    });

    expect(
      received.some(
        (ev) =>
          ev.type === 'call-transfer' &&
          ev.windowId === 'win-sender' &&
          ev.surface === 'companion' &&
          ev.threadId === 'thread-bc'
      )
    ).toBe(true);
    expect(MockBroadcastChannel.instances.some((c) => c.name === VOICE_COMPANION_CHANNEL_NAME)).toBe(
      true
    );
    unsubscribe();

    // Safe fallback when BroadcastChannel is undefined
    (globalThis as unknown as { BroadcastChannel: undefined }).BroadcastChannel = undefined;
    expect(() => {
      const unsubNoBc = subscribeCompanionTransferEvents(() => {});
      transferVoiceCallSurface('orb', { threadId: 'thread-no-bc', windowId: 'win-fallback' });
      releaseVoiceHostClaim('win-fallback');
      unsubNoBc();
    }).not.toThrow();
  });

  it('transfers live call across Thread <-> Orb <-> Companion Bar without dropping session', () => {
    // Start in companion bar
    const toCompanion = transferVoiceCallSurface('companion', {
      threadId: 'thread-live',
      windowId: 'win-main',
    });
    expect(toCompanion.targetSurface).toBe('companion');
    expect(toCompanion.storeSurface).toBe('orb');
    expect(voiceSessionStore.getSnapshot().phase).toBe('active');
    expect(voiceSessionStore.getSnapshot().boundThreadId).toBe('thread-live');
    expect(getActiveCompanionSurface()).toBe('companion');

    // Transfer to thread
    const toThread = transferVoiceCallSurface('thread', {
      windowId: 'win-main',
    });
    expect(toThread.targetSurface).toBe('thread');
    expect(toThread.storeSurface).toBe('thread');
    expect(voiceSessionStore.getSnapshot().activeSurface).toBe('thread');
    expect(voiceSessionStore.getSnapshot().boundThreadId).toBe('thread-live');
    expect(getActiveVoiceHostClaim()?.surface).toBe('thread');

    // Transfer to floating orb
    const toOrb = transferVoiceCallSurface('orb', {
      windowId: 'win-main',
    });
    expect(toOrb.targetSurface).toBe('orb');
    expect(toOrb.storeSurface).toBe('orb');
    expect(voiceSessionStore.getSnapshot().activeSurface).toBe('orb');
    expect(getActiveVoiceHostClaim()?.surface).toBe('orb');
  });

  it('captures lightweight (<150 token) visual context snapshots and attaches them to voice turns', async () => {
    const hugeSelection = 'const x = 1; '.repeat(120);
    const snapshot = captureVisualContextSnapshot({
      activeTitle: 'Editor · companionTransfer.ts',
      activeSurface: 'code',
      selectedText: hugeSelection,
      focusedElementLabel: 'Terminal principal',
      boundThreadId: 'thread-ctx-1',
      timestamp: 123456,
    });

    expect(snapshot.activeTitle).toBe('Editor · companionTransfer.ts');
    expect(snapshot.activeSurface).toBe('code');
    expect(snapshot.focusedElementLabel).toBe('Terminal principal');
    expect(snapshot.boundThreadId).toBe('thread-ctx-1');
    expect(snapshot.estimatedTokens).toBeLessThan(150);
    expect(snapshot.summaryText.length).toBeLessThanOrEqual(540);

    const executor = vi.fn().mockResolvedValue(undefined);
    voiceSessionStore.registerTextTurnExecutor(executor);

    const res = await attachContextSnapshotToVoiceTurn(snapshot, {
      threadId: 'thread-ctx-1',
      promptText: 'Explica esta selección',
      submit: true,
    });

    expect(res.attached).toBe(true);
    expect(res.submitted).toBe(true);
    expect(getLastAttachedContextSnapshot()).toEqual(snapshot);
    expect(await ctxClient.shareGet('visual-context:thread-ctx-1')).toBe(snapshot.summaryText);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0][0]).toContain('[Contexto visual actual]');
    expect(executor.mock.calls[0][0]).toContain('Explica esta selección');
    expect(executor.mock.calls[0][1]).toBe('thread-ctx-1');
  });

  it('matches Alt+Space hotkey cleanly while ignoring IME composition and repeats', () => {
    expect(
      matchesCompanionHotkey({
        key: ' ',
        code: 'Space',
        altKey: true,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
        isComposing: false,
        keyCode: 32,
        repeat: false,
      })
    ).toBe(true);

    // Non-breaking space produced by Alt+Space on some OS layouts
    expect(
      matchesCompanionHotkey({
        key: '\u00a0',
        code: 'Space',
        altKey: true,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
        isComposing: false,
        keyCode: 32,
        repeat: false,
      })
    ).toBe(true);

    // Rejects IME composition
    expect(
      matchesCompanionHotkey({
        key: ' ',
        code: 'Space',
        altKey: true,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
        isComposing: true,
        keyCode: 229,
        repeat: false,
      })
    ).toBe(false);

    // Rejects auto-repeat
    expect(
      matchesCompanionHotkey({
        key: ' ',
        code: 'Space',
        altKey: true,
        ctrlKey: false,
        shiftKey: false,
        metaKey: false,
        isComposing: false,
        keyCode: 32,
        repeat: true,
      })
    ).toBe(false);

    // Custom override string
    expect(
      matchesCompanionHotkey(
        {
          key: 'k',
          code: 'KeyK',
          altKey: false,
          ctrlKey: true,
          shiftKey: true,
          metaKey: false,
          isComposing: false,
          keyCode: 75,
          repeat: false,
        },
        'Ctrl+Shift+K'
      )
    ).toBe(true);
  });

  it('enriches visual context snapshot with activeView, file/diff path, agentId, and 600-char selection cap while keeping summaryText < 150 tokens', () => {
    const longSelection = 'a'.repeat(750);
    const snapshot = captureVisualContextSnapshot({
      activeTitle: 'Diffs · window.rs',
      activeSurface: 'companion',
      activeView: 'diffs',
      activeFilePath: 'src-tauri/src/window.rs',
      selectedDiffPath: 'src-tauri/src/window.rs',
      activeAgentId: 'agent-argos',
      selectedText: longSelection,
      boundThreadId: 'thread-s8',
    });

    expect(snapshot.activeView).toBe('diffs');
    expect(snapshot.activeFilePath).toBe('src-tauri/src/window.rs');
    expect(snapshot.selectedDiffPath).toBe('src-tauri/src/window.rs');
    expect(snapshot.activeAgentId).toBe('agent-argos');
    expect(snapshot.selectedText.length).toBeLessThanOrEqual(600);
    expect(snapshot.selectedText.length).toBeGreaterThan(240);
    expect(snapshot.summaryText.length).toBeLessThanOrEqual(540);
    expect(snapshot.estimatedTokens).toBeLessThan(150);
    expect(snapshot.summaryText).toContain('window.rs');
  });

  it('persists companion global shortcut and falls back cleanly when Tauri runtime is absent', async () => {
    expect(loadCompanionGlobalShortcut()).toBe(DEFAULT_COMPANION_GLOBAL_SHORTCUT);
    saveCompanionGlobalShortcut('Ctrl+Shift+Space');
    expect(localStorage.getItem(COMPANION_GLOBAL_SHORTCUT_STORAGE_KEY)).toBe('Ctrl+Shift+Space');
    expect(loadCompanionGlobalShortcut()).toBe('Ctrl+Shift+Space');

    const reg = await registerOsCompanionGlobalShortcut('Ctrl+Shift+Space');
    expect(reg.registered).toBe(false);
    expect(reg.fallback).toBe('window-local');
    expect(reg.shortcut).toBe('Ctrl+Shift+Space');
  });
});
