import React, { useRef, useEffect, useState, useCallback } from 'react';
import { motion } from 'motion/react';
import { useReduceMotion } from '../../../motion/standard/context';
import { prefersReducedMotion } from '../../../motion/contract';
import { shift, tweens } from '../../../motion/standard/tokens';
import {
  FolderIcon,
  FileCodeIcon,
} from './ChatIcons';
import { useVoiceSession, voiceSessionStore, type VoiceTurnRecord } from '../../../lib/operator/voice/voiceSessionStore';
import {
  buildVoiceSessionBoundaryItem,
  flushPendingVoiceTranscriptTail,
  liveVoiceStageItem,
  mergeTimeline,
  voiceTurnsToChatItems,
} from './voiceTranscript';
import { VoiceTeleprompterDock } from './composer/VoiceTeleprompterDock';
import { VoiceTranscriptCard } from './VoiceTranscriptCard';
import {
  ensureVoiceCallReceiptsHook,
  listVoiceCallReceipts,
  type VoiceCallReceipt,
} from '../../../lib/operator/voice/voiceCallReceipts';
import { getActiveVoiceAudioTime } from '../../../lib/operator/voice/pcm24kPlayer';
import { clampVoicePlaybackSpeed } from '../../../lib/operator/voice/callResilience';
import { subscribeTrace } from '../../../lib/operator/trace/trace';
import { runOperatorTurn } from '../../../lib/operator';
import {
  ExtendedChatThread,
  ChatAttachment,
  ModelOption,
  ChatProvider,
  ChatMode,
  PROVIDER_CATALOG,
  getActivePlan,
} from './types';
import {
  invokeCommand,
  rewindThreadTranscript,
  restoreThreadCheckpoint,
  renameChatThread,
} from '../../../lib/ipc';
import { ChatItemRow, ChatWorkGroup, groupTranscriptRows, liveActivityRowIndex } from './ChatItemRow';
import { dedupeSubagentRuns, SubagentGroupRow } from './SubagentActivityCard';
import { matchSubagentRun } from './subagentRunHelpers';
import { filterTranscriptForVisibility, readToolVisibility, TOOL_VISIBILITY_EVENT, type ToolVisibilityMode } from './toolVisibility';
import { QueuedRunsControl, type QueuedRunRow } from './QueuedRunsControl';
import { SideChatPane } from './SideChatPane';
import { TurnActivityStatus } from './TurnActivityStatus';
import { ChatComposer } from './ChatComposer';
import { ConsultativeDraftCard } from './ConsultativeDraftCard';
import { ThemeHeroFigure } from '../../theme/ThemeHeroFigure';
import { ZedOrb, type ZedOrbState } from '../../ZedOrb';
import {
  loadOperatorConfig,
  saveOperatorConfig,
  sanitizeZedFigure,
  type ZedFigureId,
} from '../../../lib/operator/operatorConfig';
import {
  getVoicePalette,
  normalizeVoiceRgb,
} from '../../../lib/operator/config/voicePalettes';
import type { VoiceGlowPalette } from './composer/composerVoiceGlowShader';
import { SessionLifecycleBar } from './SessionLifecycleBar';
import { declarationFromCatalog } from './driverDeclaration';
import { getSavedSelectedModel, getSavedSelectedAgent } from './modelPersistence';
import type { DriverDeclaration, SessionProjection } from '../../../lib/session/types';
import { ChatPlanPanel, PlanActionPayload } from './ChatPlanPanel';
import { useThreadFailureBanner } from './ThreadErrorBanner';
import { HtmlRenderFrame } from './HtmlRenderFrame';
import { ComposerPendingUserInputPanel } from './ComposerPendingUserInputPanel';
import { ChatApprovalCard, type ApprovalDecision } from './ChatApprovalCard';
import { ThreadUsageCard } from './ThreadUsageCard';
import { bringBackAllowed, childApprovals, childStopIds, directMessageNotice } from './childApprovals';
import { compactSendText, fileRestoreAllowed } from './threadInteraction';
import { QuotaHandoffBanner } from '../../chat/QuotaHandoffBanner';
import { AgentReflectionCard } from './AgentReflectionCard';
import {
  buildTranscriptScrollKeys,
  useTranscriptLiveEdge,
  useTranscriptMotion,
} from '../../../motion/useTranscriptMotion';
import { ThreadTurnRail } from './ThreadTurnRail';
import {
  buildComposerChangedFilesProps,
  composeRewoundPrompt,
  changedFilesForTurn,
} from './pane/threadTurnHelpers';
import { useThreadBranches } from './pane/useThreadBranches';
import { SingleThreadHeader } from './pane/SingleThreadHeader';

export { composeRewoundPrompt, changedFilesForTurn };

export const INITIAL_VISIBLE_TRANSCRIPT_ROWS = 48;
export const INITIAL_VISIBLE_UNDERLYING_ITEMS = 150;

export function sliceTranscriptRowsByWindow(
  transcriptRows: ReturnType<typeof groupTranscriptRows>,
  visibleLimit: number
): ReturnType<typeof groupTranscriptRows> {
  const totalRows = transcriptRows.length;
  if (totalRows === 0 || visibleLimit >= totalRows) {
    if (visibleLimit > totalRows) return transcriptRows;
  }
  const scaledItemBudget = Math.max(
    INITIAL_VISIBLE_UNDERLYING_ITEMS,
    Math.round((visibleLimit / INITIAL_VISIBLE_TRANSCRIPT_ROWS) * INITIAL_VISIBLE_UNDERLYING_ITEMS)
  );
  let rowCount = 0;
  let itemCount = 0;
  let startIdx = totalRows;
  for (let i = totalRows - 1; i >= 0; i -= 1) {
    const row = transcriptRows[i]!;
    const weight = row.kind === 'work' || row.kind === 'subagentGroup' ? row.items.length : 1;
    if (rowCount >= visibleLimit) break;
    if (rowCount > 0 && itemCount + weight > scaledItemBudget) break;
    rowCount += 1;
    itemCount += weight;
    startIdx = i;
  }
  return startIdx <= 0 ? transcriptRows : transcriptRows.slice(startIdx);
}

export interface SingleThreadPaneProps {
  thread: ExtendedChatThread;
  workspaceId: string | null;
  workspaceName?: string;
  workspaces?: Array<{ id: string; displayName?: string; name?: string }>;
  agents?: Array<{ id: string; name?: string; engine?: string }>;
  agentName?: string;
  engineLabel?: string;
  isFocused: boolean;
  isMulti: boolean;
  running: boolean;
  prompt: string;
  attachments: ChatAttachment[];
  liveRunsCount: number;
  dynamicModels: ModelOption[];
  catalogState?: 'missing-binary' | 'signed-out' | 'loading' | 'empty' | null;
  dynamicAgents?: any[];
  ensureDynamicAgents?: (provider: ChatProvider) => void;
  /** Declaration supplied by the session layer for this thread. */
  driverDeclaration?: DriverDeclaration | null;
  /** Projection supplied by the session layer for this thread. */
  session?: SessionProjection | null;
  isRefreshingModels?: boolean;
  onRefreshModels?: (provider: ChatProvider) => void;
  activeDropdown?: { threadId: string; type: 'provider' | 'model' | 'mode' } | null;
  editingTitleId: string | null;
  titleInput: string;
  showHistoryPopover?: boolean;
  knownThreadsList?: ExtendedChatThread[];
  onFocus: () => void;
  onClosePane: () => void;
  onToggleSplit?: () => void;
  onToggleHistory?: () => void;
  onNewThread: () => void | Promise<string | null | undefined | void>;
  onSelectHistoryThread?: (id: string) => void;
  onPinThread?: (id: string, e: React.MouseEvent) => void;
  onArchiveThread?: (id: string, e: React.MouseEvent) => void;
  onStartRename: (id: string, title: string) => void;
  onSaveRename: () => void;
  onChangeTitleInput: (val: string) => void;
  onCancelRename: () => void;
  onChangePrompt: (val: string) => void;
  onSend: (overridePrompt?: string, planAction?: PlanActionPayload) => Promise<boolean | void> | void;
  onQueuePrompt?: (text: string, attachments?: ChatAttachment[]) => void;
  onUpdateQueuedRuns?: (nextQueue: QueuedRunRow[], removedAttachments?: ChatAttachment[]) => void;
  onSendNowQueuedRun?: (rowId: string) => void;
  onSteerPrompt?: (text: string, attachments?: ChatAttachment[]) => void | Promise<boolean | void>;
  onSetAttachments?: (items: ChatAttachment[]) => void;
  onStop: () => void;
  onStopThread?: (threadId: string) => void;
  onPickAttachments: (kind?: 'files' | 'folder') => void;
  onStageFiles: (files: File[]) => void;
  onStagePaths: (paths: string[]) => void;
  onRemoveAttachment: (resId: string) => void;
  onDropdownToggle?: (type: 'provider' | 'model' | 'mode') => void;
  onUpdateConfig: (patch: { provider?: ChatProvider; mode?: ChatMode; model?: string | null; effort?: string | null; plan?: boolean; agent?: string | null; connectionId?: string | null; workspaceId?: string | null }) => void;
  onApprovalDecision(decision: ApprovalDecision, reqId: string): void;
  onChildApprovalDecision?(
    childThreadId: string,
    decision: ApprovalDecision,
    reqId: string
  ): void;
  embedded?: boolean;
}

const VOICE_STAGE_QUICK_PROMPTS = [
  '¿Qué agentes están activos?',
  'Abre dos terminales',
  'Resume la terminal activa',
] as const;

interface SingleThreadTranscriptProps {
  threadId: string;
  activeWsId: string | null;
  timelineItems: ExtendedChatThread['items'];
  displayedRows: ReturnType<typeof groupTranscriptRows>;
  totalRows: number;
  liveWorkIdx: number;
  running: boolean;
  pendingApproval: ExtendedChatThread['pendingApproval'];
  quotaHandoffOffer: ExtendedChatThread['quotaHandoffOffer'];
  reflectionCandidate: ExtendedChatThread['reflectionCandidate'];
  dismissedReflectionNote: string | null;
  stoppedByBuilder: boolean;
  durationSeconds?: number | null;
  subagentRuns: ExtendedChatThread['subagentRuns'];
  swarmState: ExtendedChatThread['swarmState'];
  isFileRestoreAllowed: boolean;
  transcriptRef: React.RefObject<HTMLDivElement>;
  onScroll: React.UIEventHandler<HTMLDivElement>;
  onEnsureAllVisible: () => void;
  onShowEarlier: () => void;
  enterFor: (id: string) => boolean;
  onRewindTranscript: (messageId: string) => Promise<void>;
  onRestoreFiles: (messageId: string) => Promise<void>;
  onEditUserMessage: (text: string) => void;
  onDismissReflection: (note: string | null) => void;
  voiceTranscriptCard?: React.ReactNode;
}

/** Memoized transcript and turn-rail subtree so composer typing never re-renders message rows. */
const SingleThreadTranscript = React.memo(function SingleThreadTranscript({
  threadId,
  activeWsId,
  timelineItems,
  displayedRows,
  totalRows,
  liveWorkIdx,
  running,
  pendingApproval,
  quotaHandoffOffer,
  reflectionCandidate,
  dismissedReflectionNote,
  stoppedByBuilder,
  durationSeconds,
  subagentRuns,
  swarmState,
  isFileRestoreAllowed,
  transcriptRef,
  onScroll,
  onEnsureAllVisible,
  onShowEarlier,
  enterFor,
  onRewindTranscript,
  onRestoreFiles,
  onEditUserMessage,
  onDismissReflection,
  voiceTranscriptCard,
}: SingleThreadTranscriptProps) {
  const dedupedSubagentRuns = React.useMemo(
    () => dedupeSubagentRuns(subagentRuns),
    [subagentRuns]
  );
  return (
    <>
      <ThreadTurnRail
        items={timelineItems}
        running={running}
        transcriptRef={transcriptRef}
        onEnsureAllVisible={onEnsureAllVisible}
      />
      <div
        className="chat-transcript"
        ref={transcriptRef}
        onScroll={onScroll}
      >
        <div className="chat-transcript__column">
          {displayedRows.length < totalRows && (
            <div
              className="chat-transcript__earlier"
              style={{
                display: 'flex',
                justifyContent: 'center',
                padding: '12px 0',
              }}
            >
              <button
                type="button"
                className="secondary-button chat-transcript__earlier-btn"
                onClick={onShowEarlier}
                style={{
                  fontSize: '12px',
                  padding: '6px 14px',
                  borderRadius: 'var(--control-radius, 8px)',
                }}
              >
                Show earlier messages ({displayedRows.length} of {totalRows} shown)
              </button>
            </div>
          )}

          {displayedRows.map((row, rowIdx) => {
            const rowKey =
              row.kind === 'work' || row.kind === 'subagentGroup'
                ? row.id
                : row.item.id;
            return (
              <React.Fragment key={rowKey}>
                {row.kind === 'item' && row.item.kind === 'assistant' && /<html[\s\S]*<\/html>/i.test(row.item.text) ? (
                  <HtmlRenderFrame html={row.item.text.match(/<html[\s\S]*<\/html>/i)?.[0] ?? row.item.text} />
                ) : null}
                {row.kind === 'work' ? (
                  <ChatWorkGroup
                    items={row.items}
                    running={running && rowIdx === liveWorkIdx}
                    enterFor={enterFor}
                    interrupted={stoppedByBuilder && rowIdx === displayedRows.length - 1}
                  />
                ) : row.kind === 'subagentGroup' ? (
                  <SubagentGroupRow
                    items={row.items}
                    threadId={threadId}
                    workspaceId={activeWsId}
                    subagentRuns={dedupedSubagentRuns}
                    enterFor={enterFor}
                  />
                ) : (
                  <ChatItemRow
                    item={row.item}
                    threadId={threadId}
                    workspaceId={activeWsId}
                    matchedSubagentRun={
                      (row.item.kind === 'tool' || row.item.kind === 'command') &&
                      (row.item.toolKind === 'subagent' || Boolean(row.item.subagentMeta))
                        ? matchSubagentRun(row.item, dedupedSubagentRuns)
                        : null
                    }
                    swarmState={swarmState ?? null}
                    enter={enterFor(row.item.id)}
                    fileRestoreEnabled={isFileRestoreAllowed}
                    onRewindTranscript={onRewindTranscript}
                    onRestoreFiles={onRestoreFiles}
                    onEditUserMessage={onEditUserMessage}
                  />
                )}
              </React.Fragment>
            );
          })}

          {voiceTranscriptCard}

          <TurnActivityStatus
            running={running}
            pendingApproval={pendingApproval}
            items={timelineItems}
            swarmState={swarmState ?? null}
            interrupted={stoppedByBuilder && !running}
            durationSeconds={durationSeconds}
          />

          {/* Quota Handoff Banner */}
          {quotaHandoffOffer && (
            <QuotaHandoffBanner
              offer={quotaHandoffOffer}
              threadId={threadId}
            />
          )}

          {/* Memory Reflection Confirmation Card */}
          {reflectionCandidate && dismissedReflectionNote !== reflectionCandidate.note && (
            <AgentReflectionCard
              candidate={reflectionCandidate}
              onDismiss={() => onDismissReflection(reflectionCandidate?.note ?? null)}
            />
          )}
        </div>
      </div>
    </>
  );
});

const SingleThreadPaneInner: React.FC<SingleThreadPaneProps> = ({
  thread,
  workspaceId,
  workspaceName,
  workspaces,
  agents = [],
  agentName,
  engineLabel,
  isFocused,
  isMulti,
  embedded = false,
  running,
  prompt,
  attachments,
  liveRunsCount: _liveRunsCount,
  dynamicModels,
  catalogState = null,
  dynamicAgents = [],
  ensureDynamicAgents,
  driverDeclaration,
  session,
  editingTitleId,
  titleInput,
  onFocus,
  onClosePane,
  onToggleSplit: _onToggleSplit,
  onToggleHistory: _onToggleHistory,
  onNewThread,
  onSelectHistoryThread: _onSelectHistoryThread,
  onPinThread: _onPinThread,
  onArchiveThread: _onArchiveThread,
  onStartRename,
  onSaveRename,
  onChangeTitleInput,
  onCancelRename,
  onChangePrompt,
  onSend,
  onQueuePrompt,
  onUpdateQueuedRuns,
  onSendNowQueuedRun,
  onSteerPrompt,
  onSetAttachments,
  onStop,
  onStopThread,
  knownThreadsList = [],
  onPickAttachments,
  onStageFiles,
  onStagePaths,
  onRemoveAttachment,
  onDropdownToggle: _onDropdownToggle,
  onUpdateConfig,
  onApprovalDecision,
  onChildApprovalDecision,
  isRefreshingModels,
  onRefreshModels,
}) => {
  const activeWsId = thread.workspaceId || (embedded ? workspaceId : null);
  const currentWorkspace = activeWsId ? workspaces?.find((w) => w.id === activeWsId) : undefined;
  const effectiveWorkspaceName = activeWsId
    ? currentWorkspace?.displayName ||
      currentWorkspace?.name ||
      (embedded ? workspaceName : null) ||
      'Workspace'
    : null;

  const effectiveModel = thread.model || getSavedSelectedModel(thread.provider);
  const effectiveAgent = (thread as any).agent || (thread as any).workMode || getSavedSelectedAgent(thread.provider) || null;

  const declaration = React.useMemo(
    () =>
      driverDeclaration ??
      declarationFromCatalog({
        provider: thread.provider,
        selectedModel: effectiveModel,
        dynamicModels,
        dynamicAgents,
      }),
    [driverDeclaration, thread.provider, effectiveModel, dynamicModels, dynamicAgents]
  );

  const branchState = useThreadBranches({ workspaceId: activeWsId });

  const transcriptRef = useRef<HTMLDivElement>(null);
  const contextReduceMotion = useReduceMotion();
  const reduceMotion = contextReduceMotion || prefersReducedMotion();
  const [hiddenFromId, setHiddenFromId] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState<number>(INITIAL_VISIBLE_TRANSCRIPT_ROWS);
  const [dismissedReflectionNote, setDismissedReflectionNote] = useState<string | null>(null);

  const atLiveEdgeRef = useRef(true);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const transcriptItems = React.useMemo(() => {
    const safeItems = Array.isArray(thread.items) ? thread.items : [];
    if (!hiddenFromId) return safeItems;
    const index = safeItems.findIndex((item) => item.id === hiddenFromId && item.kind === 'user');
    if (index < 0) return safeItems;
    return safeItems.slice(0, index);
  }, [thread.items, hiddenFromId]);
  const transcriptItemIds = React.useMemo(
    () => transcriptItems.map((item) => item.id),
    [transcriptItems]
  );
  const enterFor = useTranscriptMotion(thread.id, transcriptItemIds);
  useEffect(() => {
    setHiddenFromId(null);
    setVisibleLimit(INITIAL_VISIBLE_TRANSCRIPT_ROWS);
  }, [thread.id]);
  const rewindFromMessage = useCallback(async (messageId: string) => {
    const result = await rewindThreadTranscript(thread.id, messageId);
    if (result?.error) throw new Error(result.error);
    setHiddenFromId(messageId);
  }, [thread.id]);
  const handleRestoreFiles = useCallback(async (messageId: string) => {
    const result = await restoreThreadCheckpoint(thread.id);
    if (!result?.restored || result.error) {
      throw new Error(result?.error || 'File restore did not run.');
    }
    await rewindFromMessage(messageId);
  }, [thread.id, rewindFromMessage]);
  const onChangePromptRef = useRef(onChangePrompt);
  onChangePromptRef.current = onChangePrompt;

  const handleEditUserMessage = useCallback((text: string) => {
    onChangePromptRef.current(composeRewoundPrompt(promptRef.current, text));
    const el = document.querySelector('.chat-composer textarea') as HTMLTextAreaElement | null;
    el?.focus();
  }, []);

  const providerMeta = (PROVIDER_CATALOG as Record<string, any>)[thread.provider] || PROVIDER_CATALOG.claude;
  const currentModelOption = dynamicModels.find((m) => m.id === thread.model);
  const currentModelName = currentModelOption?.name || (thread.model ? thread.model : 'Automatic');

  const totalTokens = (thread.usage?.inputTokens || 0) + (thread.usage?.outputTokens || 0);
  const directNotice = directMessageNotice(thread);
  const onUpdateConfigRef = useRef(onUpdateConfig);
  onUpdateConfigRef.current = onUpdateConfig;
  const handleSelectHeaderWorkspace = useCallback((wsId: string | null) => {
    onUpdateConfigRef.current({ workspaceId: wsId });
  }, []);
  const usageCardNode = React.useMemo(
    () => (
      <ThreadUsageCard
        reported={thread.usageReported}
        inputTokens={thread.usage?.inputTokens}
        outputTokens={thread.usage?.outputTokens}
        contextWindowTokens={thread.contextWindowTokens}
      />
    ),
    [
      thread.usageReported,
      thread.usage?.inputTokens,
      thread.usage?.outputTokens,
      thread.contextWindowTokens,
    ]
  );
  const stopRunning = () => {
    try {
      if (onStopThread) {
        for (const id of childStopIds(thread.id, knownThreadsList, thread.subagentRuns)) onStopThread(id);
      }
    } finally {
      onStop();
    }
  };
  const activePlan = getActivePlan(thread);
  const [dismissedPlanIds, setDismissedPlanIds] = useState<Set<string>>(new Set());
  const isPlanDismissed = activePlan ? dismissedPlanIds.has(activePlan.id) : false;

  const voice = useVoiceSession();
  const [voiceTurns, setVoiceTurns] = useState<VoiceTurnRecord[]>(() =>
    voice.getThreadVoiceTurns(thread.id)
  );
  const [voiceSessionEndedAt, setVoiceSessionEndedAt] = useState<number | undefined>(undefined);
  const [liveVoiceTurn, setLiveVoiceTurn] = useState<{
    turnId: string;
    stage: string;
    detail?: string;
  } | null>(null);

  useEffect(() => {
    setVoiceSessionEndedAt(undefined);
  }, [thread.id]);

  useEffect(() => {
    return voiceSessionStore.onSessionEnded(({ threadId: endedThreadId, turns }) => {
      if (endedThreadId !== thread.id) return;
      setVoiceSessionEndedAt(Date.now());
      const flushed = flushPendingVoiceTranscriptTail(
        voiceSessionStore.getSnapshot().interimTranscript || '',
        thread.id,
        turns
      );
      if (flushed) {
        voiceSessionStore.addThreadVoiceTurn(thread.id, flushed);
      }
    });
  }, [thread.id]);

  useEffect(() => {
    const vs = voiceSessionStore.getSnapshot();
    if (
      (vs.phase === 'active' || vs.phase === 'starting') &&
      (!vs.boundThreadId || vs.boundThreadId === thread.id)
    ) {
      voiceSessionStore.setActiveSurface('thread');
    }
    return () => {
      const latest = voiceSessionStore.getSnapshot();
      if (
        (latest.phase === 'active' || latest.phase === 'starting') &&
        latest.boundThreadId === thread.id
      ) {
        voiceSessionStore.setActiveSurface('orb');
      }
    };
  }, [thread.id, voice.phase, voice.boundThreadId]);

  useEffect(() => {
    setVoiceTurns(voice.getThreadVoiceTurns(thread.id));
  }, [thread.id, voice.phase, voice.turnsVersion]);

  useEffect(() => {
    return subscribeTrace((event) => {
      const isBound = voice.boundThreadId
        ? voice.boundThreadId === thread.id
        : voice.activeSurface === 'thread';
      if (!isBound) return;

      if (event.ev === 'turn.start') {
        setLiveVoiceTurn({
          turnId: event.turnId,
          stage: 'planning',
          detail: 'Pensando y planificando acciones…',
        });
      } else if (event.ev === 'plan.created') {
        const detail = (event as any).chatReachKind === 'read'
          ? 'Leyendo conversación anterior…'
          : (event as any).chatReachKind === 'index'
          ? 'Consultando índice de conversaciones…'
          : 'Planificando con ' + ((event as any).provider || 'asistente') + '…';
        setLiveVoiceTurn((prev) => (prev ? { ...prev, stage: 'planning', detail } : null));
      } else if (event.ev === 'action.start') {
        setLiveVoiceTurn((prev) =>
          prev ? { ...prev, stage: 'executing', detail: `Ejecutando ${(event as any).type}…` } : null
        );
      } else if (event.ev === 'action.verify') {
        setLiveVoiceTurn((prev) =>
          prev ? { ...prev, stage: 'verifying', detail: 'Verificando recibo…' } : null
        );
      } else if (event.ev === 'tts.speak') {
        setLiveVoiceTurn((prev) =>
          prev ? { ...prev, stage: 'speaking', detail: 'Sintetizando respuesta de voz…' } : null
        );
      } else if (event.ev === 'turn.end') {
        setLiveVoiceTurn(null);
        setVoiceTurns(voice.getThreadVoiceTurns(thread.id));
      }
    });
  }, [thread.id, voice.boundThreadId, voice.activeSurface]);

  const handleSendVoiceTurn = useCallback(async (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    const currentTitle = (thread.title || '').trim();
    if (!currentTitle || ['New Chat', 'New Agent Chat', 'Chat', 'Chat Thread'].includes(currentTitle)) {
      const firstLine = clean
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*(?:#+\s*|>\s*|[-*+]\s+)/, '').trim())
        .find((line) => line.length > 0);
      if (firstLine) {
        const derived = firstLine.length > 60 ? `${firstLine.slice(0, 59).trimEnd()}…` : firstLine;
        void renameChatThread(thread.id, derived)
          .then(() => {
            window.dispatchEvent(new CustomEvent('kite:threads-changed'));
          })
          .catch(() => undefined);
      }
    }
    try {
      setLiveVoiceTurn({
        turnId: `turn-${Date.now()}`,
        stage: 'planning',
        detail: 'Pensando…',
      });
      if (voiceSessionStore.hasTextTurnExecutor()) {
        await voiceSessionStore.submitTextTurn(clean, thread.id, thread.workspaceId ?? undefined);
        return;
      }
      const startedAt = Date.now();
      const res = await runOperatorTurn(clean, {
        workspaceId: thread.workspaceId ?? undefined,
        mode: 'thread',
        source: 'texto',
        ttsEnabled: !voice.speakerMuted,
        muted: voice.speakerMuted,
        history: voiceSessionStore.getConversationHistory(thread.id),
      });
      if (res) {
        voice.addThreadVoiceTurn(thread.id, {
          turnId: res.turnId,
          userPrompt: clean,
          source: 'texto',
          strategy: res.strategy,
          providerId: res.providerId,
          durationMs: res.durationMs,
          overallSuccess: res.overallSuccess,
          receipts: res.receipts,
          reply: res.reply,
          createdAt: startedAt,
          completedAt: Math.max(startedAt + 1, Date.now()),
        });
      }
    } catch (err: any) {
      console.warn('[SingleThreadPane] Failed to execute voice turn:', err);
    } finally {
      setLiveVoiceTurn(null);
    }
  }, [thread.id, thread.workspaceId, voice.speakerMuted]);

  const isVoiceActiveHere =
    (voice.phase === 'active' || voice.phase === 'starting') &&
    (voice.boundThreadId === thread.id || (voice.activeSurface === 'thread' && !voice.boundThreadId));

  const [voiceFigure, setVoiceFigure] = useState<ZedFigureId>(() =>
    sanitizeZedFigure(loadOperatorConfig().persona?.figure)
  );
  const [voiceRgbPalette, setVoiceRgbPalette] = useState(() =>
    getVoicePalette(loadOperatorConfig().persona?.voice).palette
  );
  const voicePalette: VoiceGlowPalette = normalizeVoiceRgb(voiceRgbPalette);

  useEffect(() => {
    const syncPersona = (event?: Event) => {
      const detail = (
        event as CustomEvent<{ persona?: { figure?: string; voice?: string } }> | undefined
      )?.detail;
      const cfg = loadOperatorConfig().persona;
      setVoiceFigure(sanitizeZedFigure(detail?.persona?.figure ?? cfg?.figure));
      setVoiceRgbPalette(getVoicePalette(detail?.persona?.voice ?? cfg?.voice).palette);
    };
    window.addEventListener('kite:operator-config-updated', syncPersona);
    window.addEventListener('kite:operator-config-changed', syncPersona);
    return () => {
      window.removeEventListener('kite:operator-config-updated', syncPersona);
      window.removeEventListener('kite:operator-config-changed', syncPersona);
    };
  }, []);

  const voiceHeroState: 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'muted' = voice.micMuted
    ? 'muted'
    : voice.isSpeaking || voice.activeTurnStage === 'speaking'
    ? 'speaking'
    : voice.activeTurnStage === 'planning' ||
      voice.activeTurnStage === 'executing' ||
      voice.activeTurnStage === 'verifying'
    ? 'thinking'
    : voice.isTranscribing
    ? 'transcribing'
    : 'listening';

  const voiceStageStyle = isVoiceActiveHere
    ? ({
        '--voice-deep-rgb': voiceRgbPalette.deep.join(', '),
        '--voice-core-rgb': voiceRgbPalette.core.join(', '),
        '--voice-glint-rgb': voiceRgbPalette.glint.join(', '),
        '--voice-level': String(
          Math.max(voice.liveAudioLevel ?? 0, voice.speakerAudioLevel ?? 0),
        ),
      } as React.CSSProperties)
    : undefined;

  const voiceOrbState: ZedOrbState =
    voiceHeroState === 'muted'
      ? 'muted'
      : voiceHeroState === 'speaking'
      ? 'speaking'
      : voiceHeroState === 'thinking' || voiceHeroState === 'transcribing'
      ? 'thinking'
      : 'listening';

  const voiceEyebrowLabel =
    voiceHeroState === 'muted'
      ? 'MICRÓFONO EN PAUSA'
      : voiceHeroState === 'speaking'
      ? 'RESPONDIENDO EN VOZ ALTA'
      : voiceHeroState === 'thinking'
      ? 'COORDINANDO EN KITE'
      : voiceHeroState === 'transcribing'
      ? 'TRANSCRIBIENDO VOZ'
      : 'SESIÓN DE VOZ · EN VIVO';

  const [latestThreadReceipt, setLatestThreadReceipt] = useState<VoiceCallReceipt | null>(null);

  // Voice turns are projected as regular chat items so they render with the exact same rows,
  // widths and spacing as any other conversation.
  const timelineItems = React.useMemo(() => {
    const projected = voiceTurnsToChatItems(voiceTurns, {
      includeSessionSummary: !isVoiceActiveHere && voiceTurns.length > 0 && !latestThreadReceipt,
      sessionEndedAt: voiceSessionEndedAt,
    });
    if (voiceTurns.length > 0) {
      const firstAt = voiceTurns.reduce(
        (min, t) => (t.createdAt > 0 ? Math.min(min, t.createdAt) : min),
        Number.POSITIVE_INFINITY
      );
      const startTs = Number.isFinite(firstAt) ? Math.max(1, firstAt - 1) : 1;
      projected.unshift(buildVoiceSessionBoundaryItem(thread.id, 'started', startTs));
      if (!isVoiceActiveHere) {
        const lastTurn = voiceTurns[voiceTurns.length - 1];
        const endTs = voiceSessionEndedAt ?? lastTurn?.completedAt ?? lastTurn?.createdAt ?? Date.now();
        const durationMs = Number.isFinite(firstAt) && endTs > firstAt ? endTs - firstAt : undefined;
        const summaryIdx = projected.findIndex((item) => item.id === 'voice-session-summary');
        const endItem = buildVoiceSessionBoundaryItem(thread.id, 'ended', endTs + 1, durationMs);
        if (summaryIdx >= 0) {
          projected.splice(summaryIdx, 0, endItem);
        } else {
          projected.push(endItem);
        }
      }
    }
    const merged = mergeTimeline(transcriptItems, projected);
    return liveVoiceTurn ? [...merged, liveVoiceStageItem(liveVoiceTurn)] : merged;
  }, [transcriptItems, voiceTurns, liveVoiceTurn, isVoiceActiveHere, voiceSessionEndedAt, thread.id, latestThreadReceipt]);

  const [voicePlaybackSpeed, setVoicePlaybackSpeed] = useState<number>(() =>
    clampVoicePlaybackSpeed(loadOperatorConfig().ttsRate || 1)
  );

  useEffect(() => {
    ensureVoiceCallReceiptsHook();
  }, []);

  useEffect(() => {
    const syncRate = () => {
      setVoicePlaybackSpeed(clampVoicePlaybackSpeed(loadOperatorConfig().ttsRate || 1));
    };
    window.addEventListener('kite:operator-config-updated', syncRate);
    return () => window.removeEventListener('kite:operator-config-updated', syncRate);
  }, []);

  const handleVoiceSpeedChange = useCallback((speed: number) => {
    const next = clampVoicePlaybackSpeed(speed);
    setVoicePlaybackSpeed(next);
    saveOperatorConfig({ ttsRate: next });
  }, []);

  useEffect(() => {
    let active = true;
    const refreshReceipt = async () => {
      try {
        const list = await listVoiceCallReceipts(15);
        if (!active) return;
        const match = list.find((item) => item.boundThreadId === thread.id) ?? null;
        setLatestThreadReceipt(match);
      } catch (err) {
        console.warn('[SingleThreadPane] Failed to load thread voice receipt:', err);
      }
    };
    void refreshReceipt();
    const handleUpdated = (ev: Event) => {
      const custom = ev as CustomEvent<VoiceCallReceipt>;
      if (custom.detail?.boundThreadId === thread.id) {
        setLatestThreadReceipt(custom.detail);
      }
    };
    window.addEventListener('kite:voice-receipt-updated', handleUpdated);
    return () => {
      active = false;
      window.removeEventListener('kite:voice-receipt-updated', handleUpdated);
    };
  }, [thread.id, voiceSessionEndedAt]);

  // A voice session always opens its own conversation: reuse the current thread only when it is
  // still blank, otherwise start a fresh thread and bind the session to it.
  const startVoiceMode = useCallback(async () => {
    const isBlank = transcriptItems.length === 0 && voiceTurns.length === 0 && !running;
    if (isBlank) {
      voiceSessionStore.startSession(thread.id, 'thread');
      return;
    }
    let targetId: string | null = thread.id;
    try {
      const created = await onNewThread();
      if (typeof created === 'string' && created) targetId = created;
    } catch (err) {
      console.warn('[SingleThreadPane] Could not open a new voice thread:', err);
    }
    voiceSessionStore.startSession(targetId, 'thread');
    if (targetId && targetId !== thread.id) {
      void renameChatThread(targetId, 'Sesión de voz')
        .then(() => window.dispatchEvent(new CustomEvent('kite:threads-changed')))
        .catch(() => undefined);
    }
  }, [thread.id, transcriptItems.length, voiceTurns.length, running, onNewThread]);

  const isDraft = timelineItems.length === 0 && !running;
  const [toolVisibility, setToolVisibility] = useState<ToolVisibilityMode>(() => readToolVisibility());
  const [queuedRuns, setQueuedRuns] = useState<QueuedRunRow[]>(thread.queuedRuns ?? []);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
  const savedDraftBeforeEditRef = useRef<{ prompt: string; attachments: ChatAttachment[] } | null>(null);
  const [sideQuestion, setSideQuestion] = useState<string | null>(null);
  useEffect(() => {
    setEditingQueuedId(null);
    savedDraftBeforeEditRef.current = null;
  }, [thread.id]);
  useEffect(() => {
    const onSide = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string; question?: string }>).detail;
      if (detail?.threadId === thread.id && detail.question) setSideQuestion(detail.question);
    };
    window.addEventListener('kite:side-chat', onSide);
    return () => window.removeEventListener('kite:side-chat', onSide);
  }, [thread.id]);
  useEffect(() => {
    setQueuedRuns(thread.queuedRuns ?? []);
  }, [thread.queuedRuns]);

  const commitQueuedRuns = useCallback(
    (next: QueuedRunRow[], removedAttachments?: ChatAttachment[]) => {
      setQueuedRuns(next);
      if (onUpdateQueuedRuns) {
        onUpdateQueuedRuns(next, removedAttachments);
      } else {
        void invokeCommand('update_chat_configuration', { threadId: thread.id, queuedRuns: next });
      }
    },
    [onUpdateQueuedRuns, thread.id]
  );

  const handleCancelQueueEdit = useCallback(() => {
    setEditingQueuedId(null);
    const saved = savedDraftBeforeEditRef.current;
    savedDraftBeforeEditRef.current = null;
    onChangePrompt(saved?.prompt ?? '');
    onSetAttachments?.(saved?.attachments ?? []);
  }, [onChangePrompt, onSetAttachments]);

  const handleStartQueueEdit = useCallback(
    (id: string) => {
      const row = queuedRuns.find((entry) => entry.id === id);
      if (!row) return;
      if (!editingQueuedId) {
        savedDraftBeforeEditRef.current = { prompt, attachments };
      }
      setEditingQueuedId(id);
      onChangePrompt(row.text);
      onSetAttachments?.(row.attachments ?? []);
    },
    [attachments, editingQueuedId, onChangePrompt, onSetAttachments, prompt, queuedRuns]
  );

  const handleRemoveQueuedRun = useCallback(
    (id: string) => {
      const row = queuedRuns.find((entry) => entry.id === id);
      if (editingQueuedId === id) {
        handleCancelQueueEdit();
      }
      const rest = queuedRuns.filter((entry) => entry.id !== id);
      const remainingIds = new Set(
        rest.flatMap((entry) => (entry.attachments ?? []).map((att) => att.resourceId))
      );
      const orphanAttachments = row?.attachments?.filter(
        (att) => !remainingIds.has(att.resourceId)
      );
      commitQueuedRuns(rest, orphanAttachments);
    },
    [commitQueuedRuns, editingQueuedId, handleCancelQueueEdit, queuedRuns]
  );

  const handleSendNowQueued = useCallback(
    (id: string) => {
      if (editingQueuedId === id) {
        handleCancelQueueEdit();
      }
      if (onSendNowQueuedRun) {
        onSendNowQueuedRun(id);
        return;
      }
      const row = queuedRuns.find((entry) => entry.id === id);
      const rest = queuedRuns.filter((entry) => entry.id !== id);
      commitQueuedRuns(rest);
      if (row?.text) {
        onChangePrompt(row.text);
      }
    },
    [commitQueuedRuns, editingQueuedId, handleCancelQueueEdit, onChangePrompt, onSendNowQueuedRun, queuedRuns]
  );

  const handleQueueFromComposer = useCallback(
    (text: string, queuedAttachments?: ChatAttachment[]) => {
      const atts = queuedAttachments ?? attachments;
      if (editingQueuedId) {
        const next = queuedRuns.map((entry) =>
          entry.id === editingQueuedId
            ? {
                ...entry,
                text,
                ...(atts.length > 0 ? { attachments: atts } : { attachments: undefined }),
              }
            : entry
        );
        setEditingQueuedId(null);
        const saved = savedDraftBeforeEditRef.current;
        savedDraftBeforeEditRef.current = null;
        commitQueuedRuns(next);
        onChangePrompt(saved?.prompt ?? '');
        onSetAttachments?.(saved?.attachments ?? []);
        return;
      }
      if (onQueuePrompt) {
        onQueuePrompt(text, atts);
        return;
      }
      const next: QueuedRunRow[] = [
        ...queuedRuns,
        {
          id: `q-${Date.now()}`,
          text,
          ...(atts.length > 0 ? { attachments: atts } : {}),
          createdAtUnixMs: Date.now(),
        },
      ];
      commitQueuedRuns(next);
      onChangePrompt('');
      onSetAttachments?.([]);
    },
    [attachments, commitQueuedRuns, editingQueuedId, onChangePrompt, onQueuePrompt, onSetAttachments, queuedRuns]
  );
  useEffect(() => {
    const onVisibility = (event: Event) => {
      const mode = (event as CustomEvent<ToolVisibilityMode>).detail;
      if (mode) setToolVisibility(mode);
    };
    window.addEventListener(TOOL_VISIBILITY_EVENT, onVisibility);
    return () => window.removeEventListener(TOOL_VISIBILITY_EVENT, onVisibility);
  }, []);
  const transcriptRows = React.useMemo(
    () => groupTranscriptRows(filterTranscriptForVisibility(timelineItems, toolVisibility)),
    [timelineItems, toolVisibility]
  );
  const totalRows = transcriptRows.length;
  const displayedRows = React.useMemo(
    () => sliceTranscriptRowsByWindow(transcriptRows, visibleLimit),
    [transcriptRows, visibleLimit]
  );
  const liveWorkIdx = React.useMemo(
    () => (running ? liveActivityRowIndex(displayedRows) : -1),
    [running, displayedRows]
  );
  const transcriptScrollKeys = React.useMemo(
    () =>
      buildTranscriptScrollKeys(
        timelineItems,
        `${displayedRows.length}:${running ? 1 : 0}:${Boolean(thread.pendingApproval)}:${Boolean(thread.quotaHandoffOffer)}:${liveVoiceTurn?.stage ?? ''}:${liveVoiceTurn?.detail ?? ''}`,
      ),
    [
      timelineItems,
      displayedRows.length,
      running,
      thread.pendingApproval,
      thread.quotaHandoffOffer,
      liveVoiceTurn?.stage,
      liveVoiceTurn?.detail,
    ],
  );
  const { handleScroll: handleTranscriptScroll, syncLiveEdge } = useTranscriptLiveEdge(
    transcriptRef,
    thread.id,
    atLiveEdgeRef,
    {
      contentKey: transcriptScrollKeys.contentKey,
      followTrigger: `${transcriptScrollKeys.followTrigger}:${voiceTurns.length}:${liveVoiceTurn?.turnId ?? ''}`,
    },
  );
  const handleEnsureAllVisible = useCallback(() => {
    setVisibleLimit(totalRows + 200);
  }, [totalRows]);
  const handleShowEarlier = useCallback(() => {
    if (!transcriptRef.current) {
      setVisibleLimit((prev) => prev + 200);
      return;
    }
    const prevScrollHeight = transcriptRef.current.scrollHeight;
    setVisibleLimit((prev) => prev + 200);
    requestAnimationFrame(() => {
      if (transcriptRef.current) {
        const diff = transcriptRef.current.scrollHeight - prevScrollHeight;
        transcriptRef.current.scrollTop += diff;
      }
    });
  }, []);
  const handleDismissReflection = useCallback((note: string | null) => {
    setDismissedReflectionNote(note);
  }, []);
  const composerChangedFilesProps = React.useMemo(
    () => buildComposerChangedFilesProps(transcriptItems, activeWsId, effectiveWorkspaceName),
    [transcriptItems, activeWsId, effectiveWorkspaceName]
  );
  const workspaceOptions = React.useMemo(
    () => workspaces?.map((w) => ({ id: w.id, name: w.displayName || w.name || 'Workspace' })),
    [workspaces]
  );
  const isFileRestoreAllowed = fileRestoreAllowed(
    Boolean(thread.providerCanRewind),
    Boolean(thread.isolatedCheckout),
  );
  const { failureBanner } = useThreadFailureBanner(thread, () => onSend());

  return (
    <section
      onClick={onFocus}
      className={
        embedded
          ? `code-thread-pane chat-surface chat-surface--thread agent-chat-surface${
              isMulti ? ' chat-surface--grid-pane' : ''
            }${isFocused ? ' chat-surface--grid-focused' : ''}`
          : agentName
          ? 'pane chat-surface chat-surface--thread agent-chat-surface min-h-0'
          : `pane chat-surface chat-surface--thread agent-chat-surface${
              isMulti ? ' chat-surface--grid-pane' : ''
            }${isFocused ? ' chat-surface--grid-focused' : ''}`
      }
    >
      {/* Thread Header — Thread mode only. Agent chats use the tab rail; embedded code panes use CodePaneHeader. */}
      {(agentName || embedded) ? <div className="chat-thread-header-area">{usageCardNode}</div> : null}
      {!agentName && !embedded && (
        <SingleThreadHeader
          thread={thread}
          effectiveWorkspaceName={effectiveWorkspaceName}
          workspaces={workspaces}
          currentWorkspaceId={activeWsId}
          onSelectWorkspace={handleSelectHeaderWorkspace}
          branchState={branchState}
          editingTitleId={editingTitleId}
          titleInput={titleInput}
          onStartRename={onStartRename}
          onSaveRename={onSaveRename}
          onChangeTitleInput={onChangeTitleInput}
          onCancelRename={onCancelRename}
          providerMeta={providerMeta}
          currentModelName={currentModelName}
          usageCard={usageCardNode}
          running={running}
          onNewThread={onNewThread}
          isMulti={isMulti}
          onClosePane={onClosePane}
        />
      )}

      {/* Frame containing Main Transcript */}
      <div className="chat-thread-frame">
        <div
          className={`chat-thread-main${isVoiceActiveHere ? ' chat-thread-main--voice-active' : ''}`}
          data-voice-stage={isVoiceActiveHere ? 'true' : undefined}
          data-voice-stage-state={isVoiceActiveHere ? voiceHeroState : undefined}
          style={voiceStageStyle}
        >
          {isVoiceActiveHere ? (
            <div
              className="chat-voice-atmosphere"
              data-testid="voice-stage-atmosphere"
              data-state={voiceHeroState}
              aria-hidden="true"
            >
              <div className="chat-voice-atmosphere__aurora" />
              <div className="chat-voice-atmosphere__grid" />
              <div className="chat-voice-atmosphere__vignette" />
            </div>
          ) : null}
          <div
            className={`chat-thread-layout${isDraft ? ' chat-thread-layout--draft' : ''}${
              isDraft && isVoiceActiveHere ? ' chat-thread-layout--voice-draft' : ''
            }`}
          >
            {/* Layout body: renders null when isDraft to prevent empty transcript pushing hero up */}
            <div className="chat-thread-layout__body">
              {isDraft ? null : (
                <SingleThreadTranscript
                  threadId={thread.id}
                  activeWsId={activeWsId ?? null}
                  timelineItems={timelineItems}
                  displayedRows={displayedRows}
                  totalRows={totalRows}
                  liveWorkIdx={liveWorkIdx}
                  running={running}
                  pendingApproval={thread.pendingApproval}
                  quotaHandoffOffer={thread.quotaHandoffOffer}
                  reflectionCandidate={thread.reflectionCandidate}
                  dismissedReflectionNote={dismissedReflectionNote}
                  stoppedByBuilder={Boolean(thread.stoppedByBuilder)}
                  durationSeconds={thread.usage?.durationSeconds}
                  subagentRuns={thread.subagentRuns}
                  swarmState={thread.swarmState ?? null}
                  isFileRestoreAllowed={isFileRestoreAllowed}
                  transcriptRef={transcriptRef}
                  onScroll={handleTranscriptScroll}
                  onEnsureAllVisible={handleEnsureAllVisible}
                  onShowEarlier={handleShowEarlier}
                  enterFor={enterFor}
                  onRewindTranscript={rewindFromMessage}
                  onRestoreFiles={handleRestoreFiles}
                  onEditUserMessage={handleEditUserMessage}
                  onDismissReflection={handleDismissReflection}
                  voiceTranscriptCard={
                    !isVoiceActiveHere && latestThreadReceipt ? (
                      <VoiceTranscriptCard receipt={latestThreadReceipt} />
                    ) : null
                  }
                />
              )}
            </div>

            {/* Draft hero rendered when empty */}
            {isDraft ? (
              <motion.div
                initial={reduceMotion ? false : { y: shift.handoff }}
                animate={{ y: 0 }}
                transition={reduceMotion ? tweens.instant : tweens.fade}
                className={`${agentName ? 'chat-draft-hero agent-chat-hero' : 'chat-draft-hero'}${
                  isVoiceActiveHere ? ' chat-draft-hero--voice' : ''
                } scroll-quiet`}
              >
                {isVoiceActiveHere ? (
                  <div
                    className="chat-voice-stage"
                    data-testid="thread-voice-hero"
                    data-state={voiceHeroState}
                    style={{ '--voice-level': String(voice.liveAudioLevel || 0) } as React.CSSProperties}
                  >
                    <div className="chat-voice-stage__frame">
                      <span className="chat-voice-stage__halo" aria-hidden="true" />
                      <span className="chat-voice-stage__orbit" aria-hidden="true" />
                      <span className="chat-voice-stage__sonar" aria-hidden="true" />
                      <span
                        className="chat-voice-stage__sonar chat-voice-stage__sonar--delayed"
                        aria-hidden="true"
                      />
                      <span className="chat-voice-stage__reticle" aria-hidden="true" />
                      <ZedOrb
                        figure={voiceFigure}
                        state={voiceOrbState}
                        size={128}
                        level={voice.liveAudioLevel}
                        interactive={true}
                        onClick={() => voice.toggleMicMuted()}
                        title={
                          voice.micMuted
                            ? 'Haz clic para reactivar el micrófono'
                            : 'Haz clic para pausar el micrófono'
                        }
                        ariaLabel={
                          voice.micMuted
                            ? 'Reactivar micrófono de la sesión de voz'
                            : 'Pausar micrófono de la sesión de voz'
                        }
                      />
                    </div>
                    <span
                      className="chat-voice-stage__eyebrow"
                      data-testid="thread-voice-eyebrow"
                    >
                      <span className="chat-voice-stage__dot" aria-hidden="true" />
                      <span>{voiceEyebrowLabel}</span>
                    </span>
                  </div>
                ) : (
                  <ThemeHeroFigure
                    mood={prompt.trim().length > 0 ? 'curious' : 'idle'}
                    triggerKey={thread.id}
                    variant="hero"
                  />
                )}
                <h1>
                  {isVoiceActiveHere ? (
                    voiceHeroState === 'muted' ? (
                      'Micrófono en pausa'
                    ) : voiceHeroState === 'speaking' ? (
                      'Respondiendo en voz alta'
                    ) : voiceHeroState === 'thinking' ? (
                      'Ejecutando en el espacio de trabajo'
                    ) : voiceHeroState === 'transcribing' ? (
                      'Transcribiendo tu orden…'
                    ) : effectiveWorkspaceName ? (
                      <>
                        Listo para coordinar en{' '}
                        <strong className="chat-draft-hero__folder">{effectiveWorkspaceName}</strong>
                      </>
                    ) : (
                      'Listo para coordinar'
                    )
                  ) : agentName ? (
                    'What should we build?'
                  ) : effectiveWorkspaceName ? (
                    <>
                      What are we shipping in{' '}
                      <strong className="chat-draft-hero__folder">{effectiveWorkspaceName}</strong>?
                    </>
                  ) : (
                    "What's on your mind?"
                  )}
                </h1>
                <p>
                  {isVoiceActiveHere
                    ? 'Habla con naturalidad o escribe abajo. Cada orden, terminal y resultado queda trazado en este hilo.'
                    : agentName
                    ? null
                    : effectiveWorkspaceName
                    ? 'Pick a model. Then say the work.'
                    : 'Pick a model. Then ask.'}
                </p>
                {isVoiceActiveHere && (
                  <div
                    className="chat-voice-stage__prompts"
                    data-testid="thread-voice-quick-prompts"
                    aria-label="Acciones rápidas de voz"
                  >
                    {VOICE_STAGE_QUICK_PROMPTS.map((suggestion, index) => (
                      <motion.button
                        key={suggestion}
                        type="button"
                        initial={reduceMotion ? false : { opacity: 0, y: 10, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        transition={
                          reduceMotion
                            ? tweens.instant
                            : { ...tweens.fade, delay: 0.08 + index * 0.045 }
                        }
                        className="chat-voice-prompt-chip"
                        disabled={voiceHeroState === 'thinking'}
                        onClick={() => void handleSendVoiceTurn(suggestion)}
                      >
                        {suggestion}
                      </motion.button>
                    ))}
                  </div>
                )}
                {!isVoiceActiveHere && !agentName && !effectiveWorkspaceName && (
                  <button
                    type="button"
                    className="secondary-button action-button--row chat-draft-hero__action"
                    onClick={() => {
                      window.dispatchEvent(
                        new CustomEvent('kite:add-workspace', { detail: { threadId: thread.id } })
                      );
                    }}
                  >
                    <FolderIcon size={13} />
                    <span>Add a folder</span>
                  </button>
                )}
              </motion.div>
            ) : null}

            {/* Composer Area with Proposed Plan Panel mounted directly above */}
            {activePlan && !isPlanDismissed && (
              <div style={{ width: '100%', display: 'flex', justifyContent: 'center', padding: '0 var(--space-6)', boxSizing: 'border-box' }}>
                <ChatPlanPanel
                  key={`plan-${thread.id}-${activePlan.id}`}
                  plan={activePlan}
                  disabled={running || thread.status === 'waiting'}
                  onSend={(text, planAction) => onSend(text, planAction)}
                  onDismiss={() => setDismissedPlanIds((prev) => new Set(prev).add(activePlan.id))}
                />
              </div>
            )}
            {activePlan && isPlanDismissed && (
              <div style={{ width: '100%', display: 'flex', justifyContent: 'center', padding: '0 var(--space-6) 6px', boxSizing: 'border-box' }}>
                <button
                  type="button"
                  onClick={() => setDismissedPlanIds((prev) => {
                    const next = new Set(prev);
                    next.delete(activePlan.id);
                    return next;
                  })}
                  style={{
                    background: 'var(--chip-fill)',
                    border: '1px solid var(--block-stroke)',
                    borderRadius: 'var(--radius-pill, 999px)',
                    padding: '3px 10px',
                    fontSize: '11px',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                  title="Show hidden artifact"
                >
                  <FileCodeIcon size={11} />
                  <span>View artifact: {activePlan.status === 'ready' ? 'Proposed Plan' : activePlan.status}</span>
                </button>
              </div>
            )}

            {session && <SessionLifecycleBar projection={session} />}

            {thread.pendingUserInput?.questions && thread.pendingUserInput.questions.length > 0 ? (
              <ComposerPendingUserInputPanel
                questions={thread.pendingUserInput.questions}
                onSubmit={(answers) => {
                  void invokeCommand('respond_chat_user_input', {
                    threadId: thread.id,
                    answers,
                  });
                }}
              />
            ) : null}
            {childApprovals(thread.id, knownThreadsList).map((child) => (
              <div key={child.threadId} className="child-thread-approval rounded-card" aria-label={child.title}>
                <strong>{child.title}</strong>
                <ChatApprovalCard
                  approval={child.approval}
                  onDecision={(decision, reqId) =>
                    onChildApprovalDecision
                      ? onChildApprovalDecision(child.threadId, decision, reqId)
                      : onApprovalDecision(decision, reqId)
                  }
                />
              </div>
            ))}
            {directNotice ? <p role="status">{directNotice}</p> : null}
            {sideQuestion ? (
              <SideChatPane
                question={sideQuestion}
                parentRunning={running}
                onClose={() => setSideQuestion(null)}
                onBringBack={(text) => {
                  if (!bringBackAllowed(running)) return;
                  onChangePrompt(text);
                  setSideQuestion(null);
                }}
              />
            ) : null}
            {failureBanner}

            <QueuedRunsControl
              rows={queuedRuns}
              expanded={queueExpanded}
              editingId={editingQueuedId}
              onToggle={() => setQueueExpanded((v) => !v)}
              onSendNow={handleSendNowQueued}
              onEdit={handleStartQueueEdit}
              onCancelEdit={handleCancelQueueEdit}
              onRemove={handleRemoveQueuedRun}
            />

            <ConsultativeDraftCard
              threadId={thread.id}
              onConfirm={() => handleSendVoiceTurn('confirmar')}
            />

            <VoiceTeleprompterDock
              open={isVoiceActiveHere}
              showUserTurns={false}
              lines={voice.liveTeleprompterLines ?? []}
              isThinking={Boolean(liveVoiceTurn && liveVoiceTurn.stage !== 'speaking')}
              isTranscribing={Boolean(voice.isTranscribing)}
              isListening={Boolean(voice.isListening && !voice.micMuted)}
              speakerMuted={voice.speakerMuted}
              micMuted={voice.micMuted}
              speakerLevel={voice.speakerAudioLevel ?? 0}
              micLevel={voice.liveAudioLevel ?? 0}
              voicePalette={voicePalette}
              startedAt={voice.startedAt}
              linkPhase={voice.phase === 'starting' ? 'connecting' : undefined}
              micPrompt={Boolean(voice.micFlatlined)}
              statusHint={voice.voiceError?.message || undefined}
              playbackSpeed={voicePlaybackSpeed}
              onChangePlaybackSpeed={handleVoiceSpeedChange}
              onToggleMicMuted={() => voice.toggleMicMuted()}
              onToggleSpeakerMuted={() => voice.toggleSpeakerMuted()}
              onEndSession={() => voice.stopSession()}
              showCallActions={false}
              getAudioTime={getActiveVoiceAudioTime}
            />

            {!isVoiceActiveHere && voice.inactivityNotice ? (
              <div
                data-testid="voice-inactivity-notice"
                role="status"
                className="kite-voice-inactivity-notice"
              >
                <span>{voice.inactivityNotice}</span>
                <button
                  type="button"
                  onClick={() => voice.setInactivityNotice(null)}
                  className="kite-voice-inactivity-notice__dismiss"
                >
                  Entendido
                </button>
              </div>
            ) : null}

            <ChatComposer
              hideVoiceFooterSpeedControl={true}
              threadId={thread.id}
              threadItems={transcriptItems}
              conversationStarted={!isDraft || queuedRuns.length > 0}
              {...composerChangedFilesProps}
              agentName={agentName}
              engineLabel={engineLabel}
              threadMode={thread.mode}
              threadPlan={thread.plan}
              threadProvider={thread.provider}
              threadModel={effectiveModel}
              threadEffort={thread.effort}
              threadAgent={effectiveAgent}
              threadConnectionId={thread.connectionId ?? null}
              catalogState={catalogState}
              onQueue={directNotice ? undefined : handleQueueFromComposer}
              onSteer={directNotice ? undefined : onSteerPrompt}
              editingQueuedId={editingQueuedId}
              onCancelQueueEdit={handleCancelQueueEdit}
              onEditLastQueued={
                queuedRuns.length > 0
                  ? () => handleStartQueueEdit(queuedRuns[queuedRuns.length - 1].id)
                  : undefined
              }
              threadBranch={branchState.gitBranch}
              branches={branchState.branches}
              threadWorkspaceId={activeWsId ?? null}
              threadWorkspaceName={effectiveWorkspaceName || 'Local'}
              workspaces={workspaceOptions}
              agents={agents}
              onSelectWorkspace={handleSelectHeaderWorkspace}
              onSwitchBranch={branchState.handleSwitchBranch}
              onCreateBranch={branchState.handleCreateBranch}
              running={running}
              prompt={prompt}
              attachments={attachments}
              totalTokens={totalTokens}
              declaration={declaration}
              ensureDynamicAgents={ensureDynamicAgents}
              isRefreshingModels={isRefreshingModels}
              onRefreshModels={onRefreshModels}
              onChangePrompt={onChangePrompt}
              onHeightChange={syncLiveEdge}
              onSend={directNotice ? () => undefined : () => onSend()}
              onFreshContext={() => {
                void invokeCommand('update_chat_configuration', {
                  threadId: thread.id,
                  freshContext: true,
                });
              }}
              onCompact={() => {
                if (directNotice) return;
                const text = compactSendText(thread.provider);
                if (!text) return;
                void onSend(text);
              }}
              onStop={stopRunning}
              onSendVoiceTurn={handleSendVoiceTurn}
              onStartVoiceMode={() => void startVoiceMode()}
              paused={
                !running &&
                (thread.turnFailure?.kind === 'usageLimit' ||
                  Boolean(thread.stoppedByBuilder) ||
                  queuedRuns.length > 0)
              }
              onPickAttachments={onPickAttachments}
              onStageFiles={onStageFiles}
              onStagePaths={onStagePaths}
              onRemoveAttachment={onRemoveAttachment}
              onUpdateConfig={onUpdateConfig}
              onSelectConnection={(connectionId) => onUpdateConfig({ connectionId })}
              pendingApproval={session?.pendingApprovals[0] ?? thread.pendingApproval}
              onApprovalDecision={onApprovalDecision}
            />

            <div aria-hidden="true" className="chat-thread-layout__tail" />
          </div>
        </div>
      </div>
    </section>
  );
};

export const SingleThreadPane = React.memo(SingleThreadPaneInner);
