import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  FolderIcon,
  FileCodeIcon,
} from './ChatIcons';
import { useVoiceSession, voiceSessionStore, type VoiceTurnRecord } from '../../../lib/operator/voice/voiceSessionStore';
import { liveVoiceStageItem, mergeTimeline, voiceTurnsToChatItems } from './voiceTranscript';
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
import { ChatItemRow, ChatWorkGroup, groupTranscriptRows } from './ChatItemRow';
import { filterTranscriptForVisibility, readToolVisibility, TOOL_VISIBILITY_EVENT, type ToolVisibilityMode } from './toolVisibility';
import { QueuedRunsControl } from './QueuedRunsControl';
import { SideChatPane } from './SideChatPane';
import { TurnActivityStatus } from './TurnActivityStatus';
import { ChatComposer } from './ChatComposer';
import { SessionLifecycleBar } from './SessionLifecycleBar';
import { declarationFromCatalog } from './driverDeclaration';
import { getSavedSelectedModel, getSavedSelectedAgent } from './modelPersistence';
import type { DriverDeclaration, SessionProjection } from '../../../lib/session/types';
import { ChatPlanPanel, PlanActionPayload } from './ChatPlanPanel';
import { ThreadErrorBanner } from './ThreadErrorBanner';
import { openSettingsTab } from '../../../lib/settingsNav';
import { ChangedFilesCard } from './ChangedFilesCard';
import { HtmlRenderFrame } from './HtmlRenderFrame';
import { ComposerPendingUserInputPanel } from './ComposerPendingUserInputPanel';
import { ChatApprovalCard } from './ChatApprovalCard';
import { ThreadUsageCard } from './ThreadUsageCard';
import { bringBackAllowed, childApprovals, childStopIds, directMessageNotice } from './childApprovals';
import { compactSendText, fileRestoreAllowed } from './threadInteraction';
import { QuotaHandoffBanner } from '../../chat/QuotaHandoffBanner';
import { useTranscriptLiveEdge, useTranscriptMotion } from '../../../motion/useTranscriptMotion';
import { ThreadTurnRail } from './ThreadTurnRail';
import { composeRewoundPrompt, changedFilesForTurn } from './pane/threadTurnHelpers';
import { useThreadBranches } from './pane/useThreadBranches';
import { SingleThreadHeader } from './pane/SingleThreadHeader';

export { composeRewoundPrompt, changedFilesForTurn };

export interface SingleThreadPaneProps {
  thread: ExtendedChatThread;
  workspaceId: string | null;
  workspaceName?: string;
  workspaces?: Array<{ id: string; displayName?: string; name?: string }>;
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
  onStop: () => void;
  onStopThread?: (threadId: string) => void;
  onPickAttachments: (kind?: 'files' | 'folder') => void;
  onStageFiles: (files: File[]) => void;
  onStagePaths: (paths: string[]) => void;
  onRemoveAttachment: (resId: string) => void;
  onDropdownToggle?: (type: 'provider' | 'model' | 'mode') => void;
  onUpdateConfig: (patch: { provider?: ChatProvider; mode?: ChatMode; model?: string | null; effort?: string | null; plan?: boolean; agent?: string | null; connectionId?: string | null; workspaceId?: string | null }) => void;
  onApprovalDecision: (decision: 'allowOnce' | 'allowForSession' | 'deny' | 'denyAndStop', reqId: string) => void;
  embedded?: boolean;
}

export const SingleThreadPane: React.FC<SingleThreadPaneProps> = ({
  thread,
  workspaceId,
  workspaceName,
  workspaces,
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
  isRefreshingModels,
  onRefreshModels,
}) => {
  const activeWsId = thread.workspaceId || workspaceId;
  const currentWorkspace = workspaces?.find((w) => w.id === activeWsId);
  const effectiveWorkspaceName =
    currentWorkspace?.displayName ||
    currentWorkspace?.name ||
    workspaceName ||
    (activeWsId ? 'Workspace' : null);

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
  const [hiddenFromId, setHiddenFromId] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState<number>(200);

  const atLiveEdgeRef = useRef(true);
  const transcriptItems = React.useMemo(() => {
    if (!hiddenFromId) return thread.items;
    const index = thread.items.findIndex((item) => item.id === hiddenFromId && item.kind === 'user');
    if (index < 0) return thread.items;
    return thread.items.slice(0, index);
  }, [thread.items, hiddenFromId]);
  const enterFor = useTranscriptMotion(
    thread.id,
    transcriptItems.map((item) => item.id),
  );
  useEffect(() => {
    setHiddenFromId(null);
  }, [thread.id]);
  const rewindFromMessage = useCallback(async (messageId: string) => {
    const result = await rewindThreadTranscript(thread.id, messageId);
    if (result?.error) throw new Error(result.error);
    setHiddenFromId(messageId);
  }, [thread.id]);
  useTranscriptLiveEdge(transcriptRef, thread.id, atLiveEdgeRef);

  const providerMeta = (PROVIDER_CATALOG as Record<string, any>)[thread.provider] || PROVIDER_CATALOG.claude;
  const currentModelOption = dynamicModels.find((m) => m.id === thread.model);
  const currentModelName = currentModelOption?.name || (thread.model ? thread.model : 'Automatic');

  const totalTokens = (thread.usage?.inputTokens || 0) + (thread.usage?.outputTokens || 0);
  const directNotice = directMessageNotice(thread);
  const renderUsageCard = () => (
    <ThreadUsageCard
      reported={thread.usageReported}
      inputTokens={thread.usage?.inputTokens}
      outputTokens={thread.usage?.outputTokens}
      contextWindowTokens={thread.contextWindowTokens}
    />
  );
  const stopRunning = () => {
    try {
      if (onStopThread) {
        for (const id of childStopIds(thread.id, knownThreadsList)) onStopThread(id);
      }
    } finally {
      onStop();
    }
  };
  const activePlan = getActivePlan(thread);
  const [dismissedPlanIds, setDismissedPlanIds] = useState<Set<string>>(new Set());
  const [failureDismissed, setFailureDismissed] = useState(false);
  const isPlanDismissed = activePlan ? dismissedPlanIds.has(activePlan.id) : false;

  const voice = useVoiceSession();
  const [voiceTurns, setVoiceTurns] = useState<VoiceTurnRecord[]>(() =>
    voice.getThreadVoiceTurns(thread.id)
  );
  const [liveVoiceTurn, setLiveVoiceTurn] = useState<{
    turnId: string;
    stage: string;
    detail?: string;
  } | null>(null);

  useEffect(() => {
    const vs = voiceSessionStore.getSnapshot();
    if (vs.phase === 'active' || vs.phase === 'starting') {
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
  }, [thread.id]);

  useEffect(() => {
    setVoiceTurns(voice.getThreadVoiceTurns(thread.id));
  }, [thread.id, voice.phase, voice.turnsVersion]);

  useEffect(() => {
    return subscribeTrace((event) => {
      const isBound = voice.boundThreadId === thread.id || voice.activeSurface === 'thread';
      if (!isBound && voice.boundThreadId !== null) return;

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
      const res = await runOperatorTurn(clean, {
        workspaceId: thread.workspaceId ?? undefined,
        source: 'texto',
        ttsEnabled: !voice.speakerMuted,
        muted: voice.speakerMuted,
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
          createdAt: Date.now(),
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

  // Voice turns are projected as regular chat items so they render with the exact same rows,
  // widths and spacing as any other conversation.
  const timelineItems = React.useMemo(() => {
    const merged = mergeTimeline(transcriptItems, voiceTurnsToChatItems(voiceTurns));
    return liveVoiceTurn ? [...merged, liveVoiceStageItem(liveVoiceTurn)] : merged;
  }, [transcriptItems, voiceTurns, liveVoiceTurn]);

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
  const [queuedRuns, setQueuedRuns] = useState(thread.queuedRuns ?? []);
  const [sideQuestion, setSideQuestion] = useState<string | null>(null);
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
  useEffect(() => {
    const onVisibility = (event: Event) => {
      const mode = (event as CustomEvent<ToolVisibilityMode>).detail;
      if (mode) setToolVisibility(mode);
    };
    window.addEventListener(TOOL_VISIBILITY_EVENT, onVisibility);
    return () => window.removeEventListener(TOOL_VISIBILITY_EVENT, onVisibility);
  }, []);
  const transcriptRows = groupTranscriptRows(filterTranscriptForVisibility(timelineItems, toolVisibility));
  const totalRows = transcriptRows.length;
  const displayedRows =
    totalRows > visibleLimit
      ? transcriptRows.slice(totalRows - visibleLimit)
      : transcriptRows;
  const failureBanner = thread.turnFailure && !failureDismissed ? (
    <ThreadErrorBanner
      failure={thread.turnFailure}
      onDismiss={() => setFailureDismissed(true)}
      onResume={() => onSend()}
      onResumeAtReset={(resetAtUnixMs) => {
        const delay = Math.max(0, resetAtUnixMs - Date.now());
        window.setTimeout(() => onSend(), delay);
      }}
      onSignIn={() => {
        openSettingsTab('quotas', thread.provider);
      }}
    />
  ) : null;

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
      {(agentName || embedded) ? <div className="chat-thread-header-area">{renderUsageCard()}</div> : null}
      {!agentName && !embedded && (
        <SingleThreadHeader
          thread={thread}
          effectiveWorkspaceName={effectiveWorkspaceName}
          workspaces={workspaces}
          currentWorkspaceId={activeWsId}
          onSelectWorkspace={(wsId) => onUpdateConfig({ workspaceId: wsId })}
          branchState={branchState}
          editingTitleId={editingTitleId}
          titleInput={titleInput}
          onStartRename={onStartRename}
          onSaveRename={onSaveRename}
          onChangeTitleInput={onChangeTitleInput}
          onCancelRename={onCancelRename}
          providerMeta={providerMeta}
          currentModelName={currentModelName}
          usageCard={renderUsageCard()}
          running={running}
          onNewThread={onNewThread}
          isMulti={isMulti}
          onClosePane={onClosePane}
        />
      )}

      {/* Frame containing Main Transcript */}
      <div className="chat-thread-frame">
        <div className="chat-thread-main">
          <div className={`chat-thread-layout${isDraft ? ' chat-thread-layout--draft' : ''}`}>
            {/* Layout body: renders null when isDraft to prevent empty transcript pushing hero up */}
            <div className="chat-thread-layout__body">
              {failureBanner}
              {isDraft ? null : (
                <>
                  <ThreadTurnRail
                    items={timelineItems}
                    running={running}
                    transcriptRef={transcriptRef}
                    onEnsureAllVisible={() => setVisibleLimit(totalRows + 200)}
                  />
                  <div
                    className="chat-transcript"
                    ref={transcriptRef}
                    onScroll={(e) => {
                      const { scrollHeight, scrollTop, clientHeight } = e.currentTarget;
                      atLiveEdgeRef.current = scrollHeight - scrollTop - clientHeight <= 48;
                    }}
                  >
                    <div className="chat-transcript__column">
                      {displayedRows.length < transcriptRows.length && (
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
                            onClick={() => {
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
                            }}
                            style={{
                              fontSize: '12px',
                              padding: '6px 14px',
                              borderRadius: 'var(--control-radius, 8px)',
                            }}
                          >
                            Show earlier messages ({displayedRows.length} of {transcriptRows.length} shown)
                          </button>
                        </div>
                      )}

                      {displayedRows.map((row) => {
                        const rowKey = row.kind === 'work' ? row.id : row.item.id;
                        return (
                          <React.Fragment key={rowKey}>
                            {row.kind !== 'work' && row.item.kind === 'assistant' && /<html[\s\S]*<\/html>/i.test(row.item.text) ? (
                              <HtmlRenderFrame html={row.item.text.match(/<html[\s\S]*<\/html>/i)?.[0] ?? row.item.text} />
                            ) : null}
                            {row.kind === 'work' ? (
                              <ChatWorkGroup
                                items={row.items}
                                running={running}
                                enterFor={enterFor}
                                interrupted={Boolean(thread.stoppedByBuilder)}
                              />
                            ) : (
                              <ChatItemRow
                                item={row.item}
                                threadId={thread.id}
                                workspaceId={thread.workspaceId ?? workspaceId ?? null}
                                subagentRuns={thread.subagentRuns ?? null}
                                swarmState={thread.swarmState ?? null}
                                enter={enterFor(row.item.id)}
                                fileRestoreEnabled={fileRestoreAllowed(
                                  Boolean(thread.providerCanRewind),
                                  Boolean(thread.isolatedCheckout),
                                )}
                                onRewindTranscript={(messageId) => rewindFromMessage(messageId)}
                                onRestoreFiles={async (messageId) => {
                                  const result = await restoreThreadCheckpoint(thread.id);
                                  if (!result?.restored || result.error) {
                                    throw new Error(result?.error || 'File restore did not run.');
                                  }
                                  await rewindFromMessage(messageId);
                                }}
                                onEditUserMessage={(text) => {
                                  onChangePrompt(composeRewoundPrompt(prompt, text));
                                  const el = document.querySelector('.chat-composer textarea') as HTMLTextAreaElement | null;
                                  el?.focus();
                                }}
                              />
                            )}
                          </React.Fragment>
                        );
                      })}

                      <TurnActivityStatus
                        running={running}
                        pendingApproval={thread.pendingApproval}
                        items={transcriptItems}
                        swarmState={thread.swarmState ?? null}
                        interrupted={Boolean(thread.stoppedByBuilder) && !running}
                        durationSeconds={thread.usage?.durationSeconds}
                      />

                      {/* Quota Handoff Banner */}
                      {thread.quotaHandoffOffer && (
                        <QuotaHandoffBanner
                          offer={thread.quotaHandoffOffer}
                          threadId={thread.id}
                        />
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Draft hero rendered when empty */}
            {isDraft ? (
              <div className={agentName ? 'chat-draft-hero agent-chat-hero scroll-quiet' : 'chat-draft-hero scroll-quiet'}>
                <h1>
                  {isVoiceActiveHere ? (
                    voice.micMuted ? (
                      'Microphone muted'
                    ) : (
                      'Listening...'
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
                    ? 'Speak or type. Zed replies with voice and logs each action in this conversation.'
                    : agentName
                    ? null
                    : effectiveWorkspaceName
                    ? 'Pick a model. Then say the work.'
                    : 'Pick a model. Then ask.'}
                </p>
                {!agentName && !effectiveWorkspaceName && (
                  <button
                    type="button"
                    className="secondary-button action-button--row chat-draft-hero__action"
                    onClick={() => {
                      window.dispatchEvent(new CustomEvent('kite:add-workspace'));
                    }}
                  >
                    <FolderIcon size={13} />
                    <span>Add a folder</span>
                  </button>
                )}
              </div>
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
                <ChatApprovalCard approval={child.approval} onDecision={onApprovalDecision} />
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
            <QueuedRunsControl
              rows={queuedRuns}
              expanded={false}
              onToggle={() => undefined}
              onSendNow={(id) => {
                const row = queuedRuns.find((entry) => entry.id === id);
                const rest = queuedRuns.filter((entry) => entry.id !== id);
                setQueuedRuns(rest);
                void invokeCommand('update_chat_configuration', { threadId: thread.id, queuedRuns: rest });
                if (row?.text) onChangePrompt(row.text);
              }}
              onEdit={(id) => {
                const row = queuedRuns.find((entry) => entry.id === id);
                if (row) onChangePrompt(row.text);
              }}
              onRemove={(id) => {
                const rest = queuedRuns.filter((entry) => entry.id !== id);
                setQueuedRuns(rest);
                void invokeCommand('update_chat_configuration', { threadId: thread.id, queuedRuns: rest });
              }}
            />
            <ChangedFilesCard
              files={changedFilesForTurn(transcriptItems)}
              onOpenTurnDiff={() => {
                window.dispatchEvent(new CustomEvent('kite:open-right-dock-diffs'));
                window.dispatchEvent(new CustomEvent('kite:open-diffs'));
              }}
              onOpenFile={(path) => {
                window.dispatchEvent(new CustomEvent('kite:open-file', { detail: { path } }));
                window.dispatchEvent(new CustomEvent('kite:open-right-dock-file', { detail: { path } }));
              }}
            />

            <ChatComposer
              threadId={thread.id}
              threadItems={transcriptItems}
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
              onQueue={directNotice ? () => undefined : (text) => {
                const next = [...queuedRuns, { id: `q-${Date.now()}`, text }];
                setQueuedRuns(next);
                void invokeCommand('update_chat_configuration', { threadId: thread.id, queuedRuns: next });
              }}
              threadBranch={branchState.gitBranch}
              branches={branchState.branches}
              threadWorkspaceName={effectiveWorkspaceName || 'Local'}
              workspaces={workspaces?.map((w) => ({ id: w.id, name: w.displayName || w.name || 'Workspace' }))}
              onSelectWorkspace={(wsId) => onUpdateConfig({ workspaceId: wsId })}
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
              paused={!running && thread.turnFailure?.kind === 'usageLimit'}
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
