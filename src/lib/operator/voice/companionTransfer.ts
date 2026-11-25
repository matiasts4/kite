// Kite Code — Argos Cross-Window Singleton Voice Lock, Call Transfer & Visual Context Snapshot
// Coordinates exclusive microphone ownership across windows via localStorage + BroadcastChannel,
// handles live call transfers across Thread <-> Orb <-> Companion Bar, captures lightweight (<150 token)
// visual context snapshots, and provides IME-safe Alt+Space hotkey matching.

import { invokeFlatCommand, isTauriEnvironment } from '../../ipc';
import { ctxClient } from '../context/ctxClient';
import { voiceSessionStore, type VoiceSurface } from './voiceSessionStore';

export type CompanionCallSurface = 'thread' | 'orb' | 'companion';
export type ActiveVisualView =
  | 'threads'
  | 'code'
  | 'agents'
  | 'diffs'
  | 'tasks'
  | 'routines'
  | 'settings'
  | 'unknown';

export const VOICE_HOST_CLAIM_STORAGE_KEY = 'kite.argos.voiceHostClaim';
export const VOICE_COMPANION_CHANNEL_NAME = 'kite-argos-voice-companion';
export const VOICE_TRANSFER_WINDOW_EVENT = 'kite:argos-call-transfer';
export const VOICE_CONTEXT_ATTACHED_EVENT = 'kite:argos-context-attached';
export const COMPANION_GLOBAL_SHORTCUT_STORAGE_KEY = 'kite.argos.companionGlobalShortcut.v1';
export const DEFAULT_COMPANION_GLOBAL_SHORTCUT = 'Alt+Space';
export const COMPANION_GLOBAL_HOTKEY_EVENT = 'kite:companion-global-hotkey';
export const MAX_SELECTED_TEXT_CHARS = 600;
export const DEFAULT_VOICE_HOST_CLAIM_TTL_MS = 120_000;
export const MAX_VISUAL_CONTEXT_TOKENS = 149;

const VISUAL_SNAPSHOT_CHAR_BUDGET = 540; // ~135 tokens at 4 chars/token, strictly < 150 tokens
const APPROX_CHARS_PER_TOKEN = 4;

export interface VoiceHostSingletonClaim {
  windowId: string;
  threadId: string | null;
  surface: CompanionCallSurface;
  claimedAt: number;
  expiresAt: number;
}

export interface AcquireVoiceHostClaimOptions {
  surface?: CompanionCallSurface;
  force?: boolean;
  ttlMs?: number;
  nowMs?: number;
}

export interface AcquireVoiceHostClaimResult {
  acquired: boolean;
  claim: VoiceHostSingletonClaim | null;
  ownerWindowId: string | null;
  displacedPreviousOwner: boolean;
}

export interface VoiceCallTransferOptions {
  threadId?: string | null;
  windowId?: string;
  forceClaim?: boolean;
  nowMs?: number;
}

export interface VoiceCallTransferResult {
  targetSurface: CompanionCallSurface;
  storeSurface: VoiceSurface;
  threadId: string | null;
  windowId: string;
  claim: VoiceHostSingletonClaim | null;
  claimAcquired: boolean;
}

export interface VoiceCallTransferEvent {
  type: 'call-transfer' | 'claim-acquired' | 'claim-released' | 'context-attached';
  windowId: string;
  threadId: string | null;
  surface?: CompanionCallSurface;
  timestamp: number;
  claim?: VoiceHostSingletonClaim | null;
  snapshotSummary?: string;
}

export interface VisualContextSnapshot {
  activeTitle: string;
  activeSurface: string;
  activeView: ActiveVisualView;
  activeFilePath: string | null;
  selectedDiffPath: string | null;
  activeAgentId: string | null;
  selectedText: string;
  focusedElementLabel: string;
  boundThreadId: string | null;
  timestamp: number;
  estimatedTokens: number;
  summaryText: string;
}

export interface CaptureVisualContextOptions {
  activeTitle?: string;
  activeSurface?: string;
  activeView?: ActiveVisualView;
  activeFilePath?: string | null;
  selectedDiffPath?: string | null;
  activeAgentId?: string | null;
  selectedText?: string;
  focusedElementLabel?: string;
  boundThreadId?: string | null;
  timestamp?: number;
  maxTokens?: number;
}

export interface CompanionHotkeyConfig {
  key?: string;
  code?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}

export type HotkeyKeyboardEventLike = Pick<
  KeyboardEvent,
  'key' | 'code' | 'altKey' | 'ctrlKey' | 'shiftKey' | 'metaKey' | 'isComposing' | 'keyCode' | 'repeat'
>;

let currentWindowIdMemo: string | null = null;
let activeCompanionSurface: CompanionCallSurface = 'orb';
let lastAttachedContextSnapshot: VisualContextSnapshot | null = null;

function safeGetLocalStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // Ignore restricted storage environments
  }
  return null;
}

function postCompanionBroadcast(event: VoiceCallTransferEvent): void {
  if (typeof BroadcastChannel !== 'undefined') {
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(VOICE_COMPANION_CHANNEL_NAME);
      channel.postMessage(event);
    } catch {
      // Safe fallback when BroadcastChannel throws or is unavailable
    } finally {
      try {
        channel?.close();
      } catch {}
    }
  }

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(
        new CustomEvent<VoiceCallTransferEvent>(VOICE_TRANSFER_WINDOW_EVENT, {
          detail: event,
        })
      );
    } catch {}
  }
}

export function getCurrentCompanionWindowId(): string {
  if (currentWindowIdMemo) return currentWindowIdMemo;
  if (typeof window !== 'undefined') {
    const existing = (window as unknown as { __kiteCompanionWindowId?: string })
      .__kiteCompanionWindowId;
    if (typeof existing === 'string' && existing.trim()) {
      currentWindowIdMemo = existing;
      return existing;
    }
  }
  const generated =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? `win-${crypto.randomUUID()}`
      : `win-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  currentWindowIdMemo = generated;
  if (typeof window !== 'undefined') {
    (window as unknown as { __kiteCompanionWindowId?: string }).__kiteCompanionWindowId =
      generated;
  }
  return generated;
}

export function getActiveCompanionSurface(): CompanionCallSurface {
  return activeCompanionSurface;
}

export function getActiveVoiceHostClaim(
  nowMs: number = Date.now()
): VoiceHostSingletonClaim | null {
  const storage = safeGetLocalStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(VOICE_HOST_CLAIM_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<VoiceHostSingletonClaim>;
    if (
      typeof parsed?.windowId !== 'string' ||
      !parsed.windowId.trim() ||
      typeof parsed.expiresAt !== 'number' ||
      !Number.isFinite(parsed.expiresAt)
    ) {
      storage.removeItem(VOICE_HOST_CLAIM_STORAGE_KEY);
      return null;
    }
    if (parsed.expiresAt <= nowMs) {
      storage.removeItem(VOICE_HOST_CLAIM_STORAGE_KEY);
      return null;
    }
    const surface: CompanionCallSurface =
      parsed.surface === 'thread' || parsed.surface === 'companion' ? parsed.surface : 'orb';
    return {
      windowId: parsed.windowId,
      threadId: typeof parsed.threadId === 'string' ? parsed.threadId : null,
      surface,
      claimedAt: typeof parsed.claimedAt === 'number' ? parsed.claimedAt : nowMs,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

export function acquireVoiceHostClaim(
  windowId: string,
  threadId: string | null = null,
  options: AcquireVoiceHostClaimOptions = {}
): AcquireVoiceHostClaimResult {
  const cleanWindowId = (windowId || '').trim() || getCurrentCompanionWindowId();
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs =
    typeof options.ttlMs === 'number' && options.ttlMs > 0
      ? options.ttlMs
      : DEFAULT_VOICE_HOST_CLAIM_TTL_MS;
  const surface: CompanionCallSurface = options.surface ?? activeCompanionSurface;

  const existing = getActiveVoiceHostClaim(nowMs);
  if (existing && existing.windowId !== cleanWindowId && !options.force) {
    return {
      acquired: false,
      claim: existing,
      ownerWindowId: existing.windowId,
      displacedPreviousOwner: false,
    };
  }

  const nextClaim: VoiceHostSingletonClaim = {
    windowId: cleanWindowId,
    threadId: threadId ?? null,
    surface,
    claimedAt: nowMs,
    expiresAt: nowMs + ttlMs,
  };

  const storage = safeGetLocalStorage();
  if (storage) {
    try {
      storage.setItem(VOICE_HOST_CLAIM_STORAGE_KEY, JSON.stringify(nextClaim));
    } catch {
      // Ignore storage quota issues while keeping in-memory behavior intact
    }
  }

  const displacedPreviousOwner = Boolean(existing && existing.windowId !== cleanWindowId);

  postCompanionBroadcast({
    type: 'claim-acquired',
    windowId: cleanWindowId,
    threadId: nextClaim.threadId,
    surface,
    timestamp: nowMs,
    claim: nextClaim,
  });

  return {
    acquired: true,
    claim: nextClaim,
    ownerWindowId: cleanWindowId,
    displacedPreviousOwner,
  };
}

export function releaseVoiceHostClaim(
  windowId: string,
  nowMs: number = Date.now()
): boolean {
  const cleanWindowId = (windowId || '').trim();
  if (!cleanWindowId) return false;

  const existing = getActiveVoiceHostClaim(nowMs);
  if (!existing || existing.windowId !== cleanWindowId) {
    return false;
  }

  const storage = safeGetLocalStorage();
  if (storage) {
    try {
      storage.removeItem(VOICE_HOST_CLAIM_STORAGE_KEY);
    } catch {}
  }

  postCompanionBroadcast({
    type: 'claim-released',
    windowId: cleanWindowId,
    threadId: existing.threadId,
    surface: existing.surface,
    timestamp: Date.now(),
    claim: null,
  });

  return true;
}

function toStoreSurface(targetSurface: CompanionCallSurface): VoiceSurface {
  return targetSurface === 'thread' ? 'thread' : 'orb';
}

export function transferVoiceCallSurface(
  targetSurface: CompanionCallSurface,
  options: VoiceCallTransferOptions = {}
): VoiceCallTransferResult {
  const snapshot = voiceSessionStore.getSnapshot();
  const resolvedThreadId =
    options.threadId !== undefined ? options.threadId : snapshot.boundThreadId;
  const resolvedWindowId = (options.windowId || '').trim() || getCurrentCompanionWindowId();
  const nowMs = options.nowMs ?? Date.now();
  const storeSurface = toStoreSurface(targetSurface);

  activeCompanionSurface = targetSurface;

  if (snapshot.phase === 'inactive' || snapshot.phase === 'stopping') {
    voiceSessionStore.startSession(resolvedThreadId, storeSurface);
  } else {
    if (options.threadId !== undefined && options.threadId !== snapshot.boundThreadId) {
      voiceSessionStore.setBoundThreadId(options.threadId ?? null);
    }
    voiceSessionStore.setActiveSurface(storeSurface);
  }

  const claimResult = acquireVoiceHostClaim(resolvedWindowId, resolvedThreadId ?? null, {
    surface: targetSurface,
    force: options.forceClaim ?? true,
    nowMs,
  });

  postCompanionBroadcast({
    type: 'call-transfer',
    windowId: resolvedWindowId,
    threadId: resolvedThreadId ?? null,
    surface: targetSurface,
    timestamp: nowMs,
    claim: claimResult.claim,
  });

  return {
    targetSurface,
    storeSurface,
    threadId: resolvedThreadId ?? null,
    windowId: resolvedWindowId,
    claim: claimResult.claim,
    claimAcquired: claimResult.acquired,
  };
}

export function subscribeCompanionTransferEvents(
  listener: (event: VoiceCallTransferEvent) => void
): () => void {
  const onWindowTransfer = (ev: Event) => {
    const detail = (ev as CustomEvent<VoiceCallTransferEvent>).detail;
    if (detail) listener(detail);
  };

  if (typeof window !== 'undefined') {
    window.addEventListener(VOICE_TRANSFER_WINDOW_EVENT, onWindowTransfer);
  }

  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(VOICE_COMPANION_CHANNEL_NAME);
      channel.onmessage = (msg: MessageEvent<VoiceCallTransferEvent>) => {
        if (msg?.data) {
          if (msg.data.type === 'call-transfer' && msg.data.surface) {
            activeCompanionSurface = msg.data.surface;
          }
          listener(msg.data);
        }
      };
    } catch {
      channel = null;
    }
  }

  const onStorage = (ev: StorageEvent) => {
    if (ev.key !== VOICE_HOST_CLAIM_STORAGE_KEY) return;
    const claim = getActiveVoiceHostClaim();
    if (!claim) {
      listener({
        type: 'claim-released',
        windowId: '',
        threadId: null,
        timestamp: Date.now(),
        claim: null,
      });
      return;
    }
    listener({
      type: 'claim-acquired',
      windowId: claim.windowId,
      threadId: claim.threadId,
      surface: claim.surface,
      timestamp: claim.claimedAt,
      claim,
    });
  };

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', onStorage);
  }

  return () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener(VOICE_TRANSFER_WINDOW_EVENT, onWindowTransfer);
      window.removeEventListener('storage', onStorage);
    }
    try {
      channel?.close();
    } catch {}
  };
}

function truncateClean(value: string, maxChars: number): string {
  const collapsed = (value || '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= maxChars) return collapsed;
  if (maxChars <= 1) return collapsed.slice(0, Math.max(0, maxChars));
  return `${collapsed.slice(0, maxChars - 1).trimEnd()}…`;
}

function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

function readSelectionFromDom(): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return '';
  try {
    const active = document.activeElement as
      | (HTMLElement & { value?: string; selectionStart?: number | null; selectionEnd?: number | null })
      | null;
    if (
      active &&
      (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') &&
      typeof active.value === 'string' &&
      typeof active.selectionStart === 'number' &&
      typeof active.selectionEnd === 'number' &&
      active.selectionEnd > active.selectionStart
    ) {
      return active.value.slice(active.selectionStart, active.selectionEnd);
    }
    const sel = window.getSelection?.();
    return sel ? sel.toString() : '';
  } catch {
    return '';
  }
}

function readFocusedElementLabelFromDom(): string {
  if (typeof document === 'undefined') return '';
  try {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body || active === document.documentElement) return '';
    const aria = active.getAttribute('aria-label');
    if (aria?.trim()) return aria.trim();
    const title = active.getAttribute('title');
    if (title?.trim()) return title.trim();
    const placeholder = active.getAttribute('placeholder');
    if (placeholder?.trim()) return placeholder.trim();
    const testId = active.getAttribute('data-testid');
    if (testId?.trim()) return testId.trim();
    return active.tagName ? active.tagName.toLowerCase() : '';
  } catch {
    return '';
  }
}

function readActiveTitleFromDom(): string {
  if (typeof document === 'undefined') return 'Kite Code';
  try {
    const viewTitleEl = document.querySelector(
      '[data-active-view-title], [aria-current="page"], main h1, h1'
    );
    const heading = viewTitleEl?.textContent?.trim();
    if (heading) return heading;
    return document.title?.trim() || 'Kite Code';
  } catch {
    return 'Kite Code';
  }
}

function normalizeActiveView(raw?: string | null): ActiveVisualView {
  const clean = (raw || '').trim().toLowerCase();
  if (clean === 'chat' || clean === 'threads') return 'threads';
  if (clean === 'code') return 'code';
  if (clean === 'agent' || clean === 'agents') return 'agents';
  if (clean === 'diffs') return 'diffs';
  if (clean === 'tasks') return 'tasks';
  if (clean === 'routines') return 'routines';
  if (clean === 'settings') return 'settings';
  return 'unknown';
}

function readActiveViewFromDom(): ActiveVisualView {
  if (typeof document === 'undefined') return 'unknown';
  try {
    const attrEl = document.querySelector('[data-active-view], [data-work-mode]');
    const attrVal =
      attrEl?.getAttribute('data-active-view') || attrEl?.getAttribute('data-work-mode');
    const normalized = normalizeActiveView(attrVal);
    if (normalized !== 'unknown') return normalized;
    const savedMode = safeGetLocalStorage()?.getItem('kite.workMode');
    return normalizeActiveView(savedMode);
  } catch {
    return 'unknown';
  }
}

function readDataAttrFromDom(selector: string, attr: string): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const el = document.querySelector(selector);
    const val = el?.getAttribute(attr)?.trim();
    return val || null;
  } catch {
    return null;
  }
}

export function captureVisualContextSnapshot(
  options: CaptureVisualContextOptions = {}
): VisualContextSnapshot {
  const voiceState = voiceSessionStore.getSnapshot();
  const timestamp = options.timestamp ?? Date.now();
  const maxTokens = Math.min(
    MAX_VISUAL_CONTEXT_TOKENS,
    Math.max(32, options.maxTokens ?? MAX_VISUAL_CONTEXT_TOKENS)
  );
  const maxChars = Math.min(VISUAL_SNAPSHOT_CHAR_BUDGET, maxTokens * APPROX_CHARS_PER_TOKEN);

  const activeTitle = truncateClean(
    options.activeTitle ?? readActiveTitleFromDom(),
    80
  ) || 'Kite Code';
  const activeSurface = truncateClean(
    options.activeSurface ?? activeCompanionSurface ?? voiceState.activeSurface ?? 'companion',
    32
  ) || 'companion';
  const activeView = options.activeView ?? readActiveViewFromDom();
  const activeFilePath =
    options.activeFilePath !== undefined
      ? options.activeFilePath
      : readDataAttrFromDom('[data-active-file-path]', 'data-active-file-path');
  const selectedDiffPath =
    options.selectedDiffPath !== undefined
      ? options.selectedDiffPath
      : readDataAttrFromDom('[data-selected-diff-path]', 'data-selected-diff-path');
  const activeAgentId =
    options.activeAgentId !== undefined
      ? options.activeAgentId
      : readDataAttrFromDom('[data-active-agent-id]', 'data-active-agent-id');
  const boundThreadId =
    options.boundThreadId !== undefined ? options.boundThreadId : voiceState.boundThreadId;
  const focusedElementLabel = truncateClean(
    options.focusedElementLabel ?? readFocusedElementLabelFromDom(),
    64
  );

  // Cap structured selection snippet at <= 600 chars while keeping summaryText <= 540 chars (<150 tokens)
  const selectedText = truncateClean(
    options.selectedText ?? readSelectionFromDom(),
    MAX_SELECTED_TEXT_CHARS
  );

  const metaParts: string[] = [
    `Vista: ${activeTitle}`,
    `Superficie: ${activeSurface}`,
  ];
  if (activeView !== 'unknown') metaParts.push(`Modo: ${activeView}`);
  const fileContext = selectedDiffPath || activeFilePath;
  if (fileContext) metaParts.push(`Archivo: ${truncateClean(fileContext, 72)}`);
  if (activeAgentId) metaParts.push(`Agente: ${truncateClean(activeAgentId, 32)}`);
  if (boundThreadId) metaParts.push(`Hilo: ${truncateClean(boundThreadId, 36)}`);
  if (focusedElementLabel) metaParts.push(`Foco: ${focusedElementLabel}`);

  const metaLine = metaParts.join(' | ');
  const remainingForSelection = Math.max(0, maxChars - metaLine.length - 16);
  const summarySelection =
    selectedText && remainingForSelection > 12
      ? truncateClean(selectedText, Math.min(240, remainingForSelection))
      : '';

  let summaryText = summarySelection
    ? `${metaLine} | Selección: "${summarySelection}"`
    : metaLine;

  if (summaryText.length > maxChars) {
    summaryText = truncateClean(summaryText, maxChars);
  }

  return {
    activeTitle,
    activeSurface,
    activeView,
    activeFilePath: activeFilePath ?? null,
    selectedDiffPath: selectedDiffPath ?? null,
    activeAgentId: activeAgentId ?? null,
    selectedText,
    focusedElementLabel,
    boundThreadId: boundThreadId ?? null,
    timestamp,
    estimatedTokens: estimateTokenCount(summaryText),
    summaryText,
  };
}

export async function attachContextSnapshotToVoiceTurn(
  snapshot: VisualContextSnapshot,
  options: {
    threadId?: string | null;
    promptText?: string;
    submit?: boolean;
  } = {}
): Promise<{
  attached: boolean;
  snapshot: VisualContextSnapshot;
  formattedContext: string;
  submitted: boolean;
}> {
  const targetThreadId =
    options.threadId !== undefined
      ? options.threadId
      : snapshot.boundThreadId ?? voiceSessionStore.getSnapshot().boundThreadId;
  lastAttachedContextSnapshot = snapshot;

  const shareKey = `visual-context:${targetThreadId || 'companion'}`;
  await ctxClient.sharePut(shareKey, snapshot.summaryText, 300_000);

  const formattedContext = `[Contexto visual actual]\n${snapshot.summaryText}`;

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    try {
      window.dispatchEvent(
        new CustomEvent(VOICE_CONTEXT_ATTACHED_EVENT, {
          detail: { snapshot, threadId: targetThreadId, formattedContext },
        })
      );
    } catch {}
  }

  postCompanionBroadcast({
    type: 'context-attached',
    windowId: getCurrentCompanionWindowId(),
    threadId: targetThreadId ?? null,
    surface: activeCompanionSurface,
    timestamp: Date.now(),
    snapshotSummary: snapshot.summaryText,
  });

  let submitted = false;
  const cleanPrompt = (options.promptText || '').trim();
  if (
    options.submit &&
    cleanPrompt &&
    targetThreadId &&
    voiceSessionStore.hasTextTurnExecutor()
  ) {
    submitted = await voiceSessionStore.submitTextTurn(
      `${formattedContext}\n\n${cleanPrompt}`,
      targetThreadId
    );
  }

  return {
    attached: true,
    snapshot,
    formattedContext,
    submitted,
  };
}

export function getLastAttachedContextSnapshot(): VisualContextSnapshot | null {
  return lastAttachedContextSnapshot;
}

export function clearLastAttachedContextSnapshot(): void {
  lastAttachedContextSnapshot = null;
}

function parseHotkeyString(spec: string): CompanionHotkeyConfig {
  const parts = spec
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const config: CompanionHotkeyConfig = {
    altKey: false,
    ctrlKey: false,
    shiftKey: false,
    metaKey: false,
  };
  for (const part of parts) {
    if (part === 'alt' || part === 'option') config.altKey = true;
    else if (part === 'ctrl' || part === 'control') config.ctrlKey = true;
    else if (part === 'shift') config.shiftKey = true;
    else if (part === 'meta' || part === 'cmd' || part === 'super') config.metaKey = true;
    else if (part === 'space' || part === 'spacebar') {
      config.key = ' ';
      config.code = 'Space';
    } else {
      config.key = part;
    }
  }
  return config;
}

export function matchesCompanionHotkey(
  event: HotkeyKeyboardEventLike,
  override?: CompanionHotkeyConfig | string
): boolean {
  if (!event) return false;
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.repeat) return false;

  const parsed: CompanionHotkeyConfig =
    typeof override === 'string'
      ? parseHotkeyString(override)
      : override ?? {
          key: ' ',
          code: 'Space',
          altKey: true,
          ctrlKey: false,
          shiftKey: false,
          metaKey: false,
        };

  const wantAlt = Boolean(parsed.altKey);
  const wantCtrl = Boolean(parsed.ctrlKey);
  const wantShift = Boolean(parsed.shiftKey);
  const wantMeta = Boolean(parsed.metaKey);

  if (
    Boolean(event.altKey) !== wantAlt ||
    Boolean(event.ctrlKey) !== wantCtrl ||
    Boolean(event.shiftKey) !== wantShift ||
    Boolean(event.metaKey) !== wantMeta
  ) {
    return false;
  }

  const targetCode = (parsed.code || '').toLowerCase();
  const targetKey = (parsed.key || '').toLowerCase();
  const evCode = (event.code || '').toLowerCase();
  const evKey = (event.key || '').toLowerCase();

  const isSpaceTarget =
    targetCode === 'space' || targetKey === ' ' || targetKey === 'space' || targetKey === 'spacebar';

  if (isSpaceTarget) {
    return (
      evCode === 'space' ||
      evKey === ' ' ||
      evKey === 'spacebar' ||
      evKey === '\u00a0'
    );
  }

  if (targetCode && evCode && targetCode === evCode) return true;
  if (targetKey && evKey && targetKey === evKey) return true;
  return false;
}

export interface CompanionShortcutRegistrationStatus {
  shortcut: string;
  registered: boolean;
  supported: boolean;
  fallback: string;
  error?: string | null;
}

export function loadCompanionGlobalShortcut(): string {
  const storage = safeGetLocalStorage();
  if (!storage) return DEFAULT_COMPANION_GLOBAL_SHORTCUT;
  try {
    const saved = storage.getItem(COMPANION_GLOBAL_SHORTCUT_STORAGE_KEY)?.trim();
    return saved || DEFAULT_COMPANION_GLOBAL_SHORTCUT;
  } catch {
    return DEFAULT_COMPANION_GLOBAL_SHORTCUT;
  }
}

export function saveCompanionGlobalShortcut(shortcut: string): string {
  const clean = (shortcut || '').trim() || DEFAULT_COMPANION_GLOBAL_SHORTCUT;
  const storage = safeGetLocalStorage();
  if (storage) {
    try {
      storage.setItem(COMPANION_GLOBAL_SHORTCUT_STORAGE_KEY, clean);
    } catch {}
  }
  return clean;
}

export async function registerOsCompanionGlobalShortcut(
  shortcut?: string
): Promise<CompanionShortcutRegistrationStatus> {
  const clean = saveCompanionGlobalShortcut(shortcut || loadCompanionGlobalShortcut());
  let inTauri = false;
  try {
    inTauri = typeof isTauriEnvironment === 'function' && isTauriEnvironment();
  } catch {
    inTauri = false;
  }

  if (!inTauri) {
    return {
      shortcut: clean,
      registered: false,
      supported: false,
      fallback: 'window-local',
      error: null,
    };
  }

  try {
    const res = await invokeFlatCommand<CompanionShortcutRegistrationStatus>(
      'register_companion_global_shortcut',
      { shortcut: clean }
    );
    if (res && typeof res.shortcut === 'string') {
      return res;
    }
  } catch (err: any) {
    return {
      shortcut: clean,
      registered: false,
      supported: true,
      fallback: 'window-local',
      error: err?.message || String(err),
    };
  }

  return {
    shortcut: clean,
    registered: false,
    supported: true,
    fallback: 'window-local',
    error: null,
  };
}

export function resetCompanionTransferForTests(): void {
  currentWindowIdMemo = null;
  activeCompanionSurface = 'orb';
  lastAttachedContextSnapshot = null;
  const storage = safeGetLocalStorage();
  if (storage) {
    try {
      storage.removeItem(VOICE_HOST_CLAIM_STORAGE_KEY);
    } catch {}
  }
  if (typeof window !== 'undefined') {
    delete (window as unknown as { __kiteCompanionWindowId?: string }).__kiteCompanionWindowId;
  }
}
