import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { useReduceMotion } from '../../../motion/standard/context';
import { prefersReducedMotion } from '../../../motion/contract';
import { shift, tweens } from '../../../motion/standard/tokens';
import {
  PlusIcon,
  ArchiveIcon,
  CloseIcon,
  CheckIcon,
  CalendarIcon,
} from '../chat/ChatIcons';
import { AgentAutoPilot } from './AgentAutoPilot';
import { ChatItemRow, ChatWorkGroup, groupTranscriptRows, liveActivityRowIndex } from '../chat/ChatItemRow';
import { SubagentGroupRow } from '../chat/SubagentActivityCard';
import { TurnActivityStatus } from '../chat/TurnActivityStatus';
import { QueuedRunsControl, type QueuedRunRow } from '../chat/QueuedRunsControl';
import { ChatComposer } from '../chat/ChatComposer';
import { ConsultativeDraftCard } from '../chat/ConsultativeDraftCard';
import { buildComposerChangedFilesProps } from '../chat/pane/threadTurnHelpers';
import { SessionLifecycleBar } from '../chat/SessionLifecycleBar';
import { declarationFromCatalog } from '../chat/driverDeclaration';
import {
  getSavedSelectedModel,
  getSavedSelectedProvider,
  getSavedSelectedAgent,
} from '../chat/modelPersistence';
import type { DriverDeclaration, SessionProjection } from '../../../lib/session/types';
import { ArchivedChatsModal } from '../modals/ArchivedChatsModal';
import { QuotaHandoffBanner } from '../../chat/QuotaHandoffBanner';
import { useThreadFailureBanner } from '../chat/ThreadErrorBanner';
import { ThemeHeroFigure } from '../../theme/ThemeHeroFigure';
import {
  invokeCommand,
  listWorkspaceBranches,
  switchWorkspaceBranch,
  createWorkspaceBranch,
  renameChatThread,
} from '../../../lib/ipc';
import { useVoiceSession, voiceSessionStore, type VoiceTurnRecord } from '../../../lib/operator/voice/voiceSessionStore';
import { liveVoiceStageItem, mergeTimeline, voiceTurnsToChatItems } from '../chat/voiceTranscript';
import { subscribeTrace } from '../../../lib/operator/trace/trace';
import { runOperatorTurn } from '../../../lib/operator';
import {
  buildTranscriptScrollKeys,
  useTranscriptLiveEdge,
  useTranscriptMotion,
} from '../../../motion/useTranscriptMotion';
import type {
  ExtendedChatThread,
  ChatAttachment,
  ModelOption,
  ChatProvider,
  ChatMode,
} from '../chat/types';

export interface AgentChatTab {
  id: string;
  title: string;
  status?: string;
  running?: boolean;
  routineId?: string | null;
  placeCount?: number;
  updatedAtUnixMs?: number;
}

interface TeammateMessage {
  id: string;
  senderName: string;
  body: string;
  delivered: boolean;
  threadId?: string | null;
  targetAgentId?: string | null;
  direction?: string;
}

export interface AgentChatSurfaceProps {
  agentId: string;
  agentName: string;
  engineLabel: string;
  workspaceId?: string | null;
  workspaces?: any[];
  workspaceName?: string;
  defaultProvider?: ChatProvider;
  /** Draft config used by the composer only while no thread exists yet. */
  draftProvider?: ChatProvider;
  draftMode?: ChatMode;
  draftModel?: string | null;
  draftEffort?: string | null;
  draftAgent?: string | null;
  activeThread: ExtendedChatThread | null;
  tabs: AgentChatTab[];
  selectedId: string | null;
  isDraft: boolean;
  running: boolean;
  prompt: string;
  attachments: ChatAttachment[];
  totalTokens: number;
  dynamicModels: ModelOption[];
  dynamicAgents?: any[];
  ensureDynamicAgents?: (provider: ChatProvider) => void;
  /** Declaration supplied by the session layer for the active thread. */
  driverDeclaration?: DriverDeclaration | null;
  /** Projection supplied by the session layer for the active thread. */
  session?: SessionProjection | null;
  isRefreshingModels?: boolean;
  onRefreshModels?: (provider: ChatProvider) => void;
  onNew: () => void | Promise<string | null | void>;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onOpenArchived?: () => void;
  onReorder?: (draggedId: string, targetId: string, insertAfter: boolean) => void;
  onChangePrompt: (val: string) => void;
  onSend: () => void;
  onSendInitial?: (text: string) => void;
  onQueuePrompt?: (text: string, attachments?: ChatAttachment[]) => void;
  onUpdateQueuedRuns?: (nextQueue: QueuedRunRow[], removedAttachments?: ChatAttachment[]) => void;
  onSendNowQueuedRun?: (rowId: string) => void;
  onSteerPrompt?: (text: string, attachments?: ChatAttachment[]) => void | Promise<boolean | void>;
  onSetAttachments?: (items: ChatAttachment[]) => void;
  onStop: () => void;
  onPickAttachments: (kind?: 'files' | 'folder') => void;
  onStageFiles: (files: File[]) => void;
  onStagePaths: (paths: string[]) => void;
  onRemoveAttachment: (resId: string) => void;
  onUpdateConfig: (patch: {
    provider?: ChatProvider;
    mode?: ChatMode;
    model?: string | null;
    effort?: string | null;
    plan?: boolean;
    agent?: string | null;
    connectionId?: string | null;
    workspaceId?: string | null;
  }) => void;
  onApprovalDecision?: (decision: 'allowOnce' | 'allowForSession' | 'deny' | 'denyAndStop', reqId: string) => void;
}

function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return 'now';
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 60) return 'now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDays = Math.floor(diffHour / 24);
  return `${diffDays}d ago`;
}

interface AgentTranscriptMotionProps {
  reducedMotion: boolean;
  transcriptRef: React.RefObject<HTMLDivElement>;
  onScroll: React.UIEventHandler<HTMLDivElement>;
  children: React.ReactNode;
}

const AgentTranscriptMotion: React.FC<AgentTranscriptMotionProps> = ({
  reducedMotion,
  transcriptRef,
  onScroll,
  children,
}) => {
  const isPresent = useIsPresent();
  const nodeRef = useRef<HTMLDivElement | null>(null);

  const attachRef = useCallback(
    (node: HTMLDivElement | null) => {
      nodeRef.current = node;
      if (isPresent) {
        (transcriptRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }
    },
    [isPresent, transcriptRef]
  );

  useEffect(() => {
    const node = nodeRef.current as (HTMLDivElement & { inert?: boolean }) | null;
    if (node) {
      node.inert = !isPresent;
    }
    if (!isPresent && transcriptRef.current === nodeRef.current) {
      (transcriptRef as React.MutableRefObject<HTMLDivElement | null>).current = null;
    }
  }, [isPresent, transcriptRef]);

  return (
    <motion.div
      ref={attachRef}
      className="chat-transcript"
      aria-hidden={!isPresent || undefined}
      data-motion-present={isPresent ? 'true' : 'false'}
      style={
        isPresent
          ? undefined
          : {
              position: 'absolute',
              inset: 0,
              zIndex: 0,
              pointerEvents: 'none',
            }
      }
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: shift.handoff }}
      animate={{
        opacity: 1,
        y: 0,
        transition: reducedMotion ? tweens.instant : tweens.fade,
      }}
      exit={{
        opacity: 0,
        transition: reducedMotion ? tweens.instant : tweens.swap,
      }}
      onScroll={onScroll}
    >
      {children}
    </motion.div>
  );
};

interface AgentChatTranscriptContentProps {
  threadId: string;
  effectiveWsId: string | null;
  activeItems: ExtendedChatThread['items'];
  transcriptRows: ReturnType<typeof groupTranscriptRows>;
  liveAt: number;
  running: boolean;
  pendingApproval: ExtendedChatThread['pendingApproval'];
  swarmState: ExtendedChatThread['swarmState'];
  stoppedByBuilder: boolean;
  durationSeconds?: number | null;
  subagentRuns: ExtendedChatThread['subagentRuns'];
  quotaHandoffOffer: ExtendedChatThread['quotaHandoffOffer'];
  enterFor: (id: string) => boolean;
  onEditUserMessage: (text: string) => void;
}

const AgentChatTranscriptContent = React.memo(function AgentChatTranscriptContent({
  threadId,
  effectiveWsId,
  activeItems,
  transcriptRows,
  liveAt,
  running,
  pendingApproval,
  swarmState,
  stoppedByBuilder,
  durationSeconds,
  subagentRuns,
  quotaHandoffOffer,
  enterFor,
  onEditUserMessage,
}: AgentChatTranscriptContentProps) {
  return (
    <div className="chat-transcript__column">
      {transcriptRows.map((row, index, rows) => {
        const rowKey =
          row.kind === 'work' || row.kind === 'subagentGroup' ? row.id : row.item.id;
        return (
          <React.Fragment key={rowKey}>
            {index === liveAt ? (
              <TurnActivityStatus
                running={running}
                pendingApproval={pendingApproval}
                items={activeItems}
                swarmState={swarmState}
                interrupted={false}
                durationSeconds={durationSeconds}
              />
            ) : null}
            {row.kind === 'work' ? (
              <ChatWorkGroup
                items={row.items}
                running={running && index === liveAt}
                enterFor={enterFor}
                interrupted={stoppedByBuilder && index === rows.length - 1}
              />
            ) : row.kind === 'subagentGroup' ? (
              <SubagentGroupRow
                items={row.items}
                threadId={threadId}
                workspaceId={effectiveWsId}
                subagentRuns={subagentRuns}
                enterFor={enterFor}
              />
            ) : (
              <ChatItemRow
                item={row.item}
                threadId={threadId}
                workspaceId={effectiveWsId}
                subagentRuns={subagentRuns}
                swarmState={swarmState}
                enter={enterFor(row.item.id)}
                onEditUserMessage={onEditUserMessage}
              />
            )}
          </React.Fragment>
        );
      })}

      {liveAt < 0 || !running ? (
        <TurnActivityStatus
          running={running}
          pendingApproval={pendingApproval}
          items={activeItems}
          swarmState={swarmState}
          interrupted={stoppedByBuilder && !running}
          durationSeconds={durationSeconds}
        />
      ) : null}

      {/* Quota Handoff Banner */}
      {quotaHandoffOffer && (
        <QuotaHandoffBanner
          offer={quotaHandoffOffer}
          threadId={threadId}
        />
      )}
    </div>
  );
});

export const AgentChatSurface: React.FC<AgentChatSurfaceProps> = ({
  agentId,
  agentName,
  engineLabel,
  workspaceId,
  workspaces,
  workspaceName,
  defaultProvider,
  draftProvider,
  draftMode,
  draftModel,
  draftEffort,
  draftAgent,
  activeThread,
  tabs,
  selectedId,
  isDraft,
  running,
  prompt,
  attachments,
  totalTokens,
  dynamicModels,
  dynamicAgents = [],
  ensureDynamicAgents,
  driverDeclaration,
  session,
  isRefreshingModels,
  onRefreshModels,
  onNew,
  onSelect,
  onRename,
  onArchive,
  onOpenArchived,
  onReorder,
  onChangePrompt,
  onSend,
  onSendInitial,
  onQueuePrompt,
  onUpdateQueuedRuns,
  onSendNowQueuedRun,
  onSteerPrompt,
  onSetAttachments,
  onStop,
  onPickAttachments,
  onStageFiles,
  onStagePaths,
  onRemoveAttachment,
  onUpdateConfig,
  onApprovalDecision,
}) => {
  const effectiveWsId = activeThread?.workspaceId || workspaceId;
  const { failureBanner } = useThreadFailureBanner(activeThread, onSend);
  const currentWorkspace = workspaces?.find((w) => w.id === effectiveWsId);
  const effectiveWorkspaceName =
    currentWorkspace?.displayName ||
    currentWorkspace?.name ||
    workspaceName ||
    (effectiveWsId ? 'Workspace' : null);

  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [branches, setBranches] = useState<string[]>([]);

  useEffect(() => {
    if (!effectiveWsId) {
      setGitBranch(null);
      setBranches([]);
      return;
    }
    let active = true;
    void invokeCommand<{ isRepo: boolean; branch?: string }>(
      'read_workspace_changes',
      { workspaceId: effectiveWsId }
    )
      .then((res) => {
        if (!active || !res) return;
        if (res.branch) setGitBranch(res.branch);
      })
      .catch(() => {});

    void listWorkspaceBranches(effectiveWsId)
      .then((res) => {
        if (!active || !res) return;
        if (res.branches) setBranches(res.branches);
        if (res.current) setGitBranch(res.current);
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [effectiveWsId]);

  const handleSwitchBranch = async (b: string) => {
    if (!effectiveWsId) return;
    try {
      const res = await switchWorkspaceBranch(effectiveWsId, b);
      if (res?.current) setGitBranch(res.current);
      if (res?.branches) setBranches(res.branches);
    } catch (err) {
      console.error('[AgentChatShell] failed to switch branch:', err);
    }
  };

  const handleCreateBranch = async (name: string) => {
    if (!effectiveWsId || !name.trim()) return;
    try {
      const res = await createWorkspaceBranch(effectiveWsId, name.trim());
      if (res?.current) setGitBranch(res.current);
      if (res?.branches) setBranches(res.branches);
    } catch (err) {
      console.error('[AgentChatShell] failed to create branch:', err);
    }
  };

  const handleSelectWorkspace = (wsId: string | null) => {
    onUpdateConfig({ workspaceId: wsId });
  };
  const savedProvider = getSavedSelectedProvider();
  const effectiveProvider: ChatProvider =
    activeThread?.provider ??
    draftProvider ??
    defaultProvider ??
    (savedProvider && ['claude', 'codex', 'cursor', 'grok', 'opencode', 'antigravity'].includes(savedProvider)
      ? (savedProvider as ChatProvider)
      : 'antigravity');
  const effectiveModel =
    (activeThread ? activeThread.model ?? null : draftModel ?? null) || getSavedSelectedModel(effectiveProvider);
  const effectiveAgent =
    (activeThread ? (activeThread as any).agent || (activeThread as any).workMode || null : draftAgent ?? null) ||
    getSavedSelectedAgent(effectiveProvider);

  const declaration = React.useMemo(
    () =>
      driverDeclaration ??
      declarationFromCatalog({
        provider: effectiveProvider,
        selectedModel: effectiveModel,
        dynamicModels,
        dynamicAgents,
      }),
    [driverDeclaration, effectiveProvider, effectiveModel, dynamicModels, dynamicAgents]
  );

  const transcriptRef = useRef<HTMLDivElement>(null);
  const contextReduceMotion = useReduceMotion();
  const reducedMotion = contextReduceMotion || prefersReducedMotion();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>('');
  const [archivedModalOpen, setArchivedModalOpen] = useState(false);

  const [queuedRuns, setQueuedRuns] = useState<QueuedRunRow[]>(activeThread?.queuedRuns ?? []);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [editingQueuedId, setEditingQueuedId] = useState<string | null>(null);
  const savedDraftBeforeEditRef = useRef<{ prompt: string; attachments: ChatAttachment[] } | null>(null);

  useEffect(() => {
    setEditingQueuedId(null);
    savedDraftBeforeEditRef.current = null;
  }, [activeThread?.id]);

  useEffect(() => {
    setQueuedRuns(activeThread?.queuedRuns ?? []);
  }, [activeThread?.queuedRuns]);

  const commitQueuedRuns = useCallback(
    (next: QueuedRunRow[], removedAttachments?: ChatAttachment[]) => {
      setQueuedRuns(next);
      if (onUpdateQueuedRuns) {
        onUpdateQueuedRuns(next, removedAttachments);
      } else if (activeThread?.id) {
        void invokeCommand('update_chat_configuration', {
          threadId: activeThread.id,
          queuedRuns: next,
        });
      }
    },
    [activeThread?.id, onUpdateQueuedRuns]
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

  // Tab dragging state
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null);
  const [dragInsertAfter, setDragInsertAfter] = useState<boolean>(false);

  // Context menu state for tabs
  const [contextMenu, setContextMenu] = useState<{
    id: string;
    title: string;
    x: number;
    y: number;
  } | null>(null);

  // Teammate inbox state
  const [inboxData, setInboxData] = useState<{
    profileId: string;
    messages: TeammateMessage[];
    nextCursor: string | null;
  } | null>(null);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [inboxError, setInboxError] = useState(false);
  const [deliveryPaused, setDeliveryPaused] = useState(false);
  const inboxRunRef = useRef(0);

  const fetchInbox = useCallback(async (beforeSequence: string | null = null) => {
    if (!agentId) return;
    const runId = ++inboxRunRef.current;
    setInboxLoading(true);
    setInboxError(false);
    try {
      const [res, pref] = await Promise.all([
        invokeCommand<{ schemaVersion: number; profileId: string; messages: TeammateMessage[]; nextCursor: string | null }>('agent_message_inbox', {
          request: { schemaVersion: 1, profileId: agentId, beforeSequence },
        }),
        invokeCommand<{ schemaVersion: number; enabled: boolean; readOnly: boolean; revision: string }>('agent_messaging_preference'),
      ]);
      if (runId === inboxRunRef.current) {
        setInboxData(res);
        setDeliveryPaused(!pref?.enabled);
      }
    } catch {
      if (runId === inboxRunRef.current) {
        setInboxError(true);
      }
    } finally {
      if (runId === inboxRunRef.current) {
        setInboxLoading(false);
      }
    }
  }, [agentId]);

  useEffect(() => {
    const handleMessagingChanged = () => void fetchInbox();
    window.addEventListener('kite:agent-messaging-changed', handleMessagingChanged);
    return () => {
      inboxRunRef.current += 1;
      window.removeEventListener('kite:agent-messaging-changed', handleMessagingChanged);
    };
  }, [fetchInbox]);

  useEffect(() => {
    if (contextMenu) {
      const handleOutside = () => setContextMenu(null);
      window.addEventListener('click', handleOutside);
      window.addEventListener('contextmenu', handleOutside);
      return () => {
        window.removeEventListener('click', handleOutside);
        window.removeEventListener('contextmenu', handleOutside);
      };
    }
  }, [contextMenu]);

  const atLiveEdgeRef = useRef(true);
  const threadId = activeThread?.id ?? null;
  const effectiveThreadId = activeThread?.id || 'draft';
  const activeItems = Array.isArray(activeThread?.items) ? activeThread.items : [];
  const voice = useVoiceSession();
  const [voiceTurns, setVoiceTurns] = useState<VoiceTurnRecord[]>(() =>
    voice.getThreadVoiceTurns(effectiveThreadId)
  );
  const [liveVoiceTurn, setLiveVoiceTurn] = useState<{
    turnId: string;
    stage: string;
    detail?: string;
  } | null>(null);

  useEffect(() => {
    const vs = voiceSessionStore.getSnapshot();
    if (
      (vs.phase === 'active' || vs.phase === 'starting') &&
      (!vs.boundThreadId || vs.boundThreadId === effectiveThreadId)
    ) {
      voiceSessionStore.setActiveSurface('thread');
    }
    return () => {
      const latest = voiceSessionStore.getSnapshot();
      if (
        (latest.phase === 'active' || latest.phase === 'starting') &&
        latest.boundThreadId === effectiveThreadId
      ) {
        voiceSessionStore.setActiveSurface('orb');
      }
    };
  }, [effectiveThreadId, voice.phase, voice.boundThreadId]);

  useEffect(() => {
    setVoiceTurns(voice.getThreadVoiceTurns(effectiveThreadId));
  }, [effectiveThreadId, voice.phase, voice.turnsVersion]);

  useEffect(() => {
    return subscribeTrace((event) => {
      const isBound = voice.boundThreadId
        ? voice.boundThreadId === effectiveThreadId
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
        setVoiceTurns(voice.getThreadVoiceTurns(effectiveThreadId));
      }
    });
  }, [effectiveThreadId, voice.boundThreadId, voice.activeSurface]);

  const handleSendVoiceTurn = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean) return;
      try {
        setLiveVoiceTurn({
          turnId: `turn-${Date.now()}`,
          stage: 'planning',
          detail: 'Pensando…',
        });
        if (voiceSessionStore.hasTextTurnExecutor()) {
          await voiceSessionStore.submitTextTurn(clean, effectiveThreadId, effectiveWsId ?? undefined);
          return;
        }
        const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const startedAt = Date.now();
        voiceSessionStore.addThreadVoiceTurn(effectiveThreadId, {
          turnId,
          userPrompt: clean,
          source: 'texto',
          createdAt: startedAt,
        });
        const res = await runOperatorTurn(clean, {
          turnId,
          workspaceId: effectiveWsId ?? undefined,
          mode: 'thread',
          source: 'texto',
          ttsEnabled: !voice.speakerMuted,
          muted: voice.speakerMuted,
          history: voiceSessionStore.getConversationHistory(effectiveThreadId),
        });
        if (res) {
          voiceSessionStore.addThreadVoiceTurn(effectiveThreadId, {
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
      } catch (err) {
        console.warn('[AgentChatShell] Failed to execute voice turn:', err);
      } finally {
        setLiveVoiceTurn(null);
      }
    },
    [effectiveThreadId, effectiveWsId, voice.speakerMuted]
  );

  const timelineItems = React.useMemo(() => {
    const merged = mergeTimeline(activeItems, voiceTurnsToChatItems(voiceTurns));
    return liveVoiceTurn ? [...merged, liveVoiceStageItem(liveVoiceTurn)] : merged;
  }, [activeItems, voiceTurns, liveVoiceTurn]);
  const effectiveIsDraft = isDraft && voiceTurns.length === 0 && !liveVoiceTurn;

  const startVoiceMode = useCallback(async () => {
    const isBlank = Boolean(activeThread?.id) && activeItems.length === 0 && voiceTurns.length === 0 && !running;
    if (isBlank && activeThread?.id) {
      voiceSessionStore.startSession(activeThread.id, 'thread');
      return;
    }
    let targetId: string | null = activeThread?.id || 'draft';
    try {
      const created = await onNew();
      if (typeof created === 'string' && created) targetId = created;
    } catch (err) {
      console.warn('[AgentChatShell] Could not open a new voice thread:', err);
    }
    voiceSessionStore.startSession(targetId, 'thread');
    if (targetId && targetId !== 'draft' && targetId !== activeThread?.id) {
      void renameChatThread(targetId, 'Sesión de voz')
        .then(() => window.dispatchEvent(new CustomEvent('kite:threads-changed')))
        .catch(() => undefined);
    }
  }, [activeThread?.id, activeItems.length, voiceTurns.length, running, onNew]);
  const enterFor = useTranscriptMotion(
    threadId,
    React.useMemo(() => timelineItems.map((item) => item.id), [timelineItems]),
  );
  const activeTranscriptRows = React.useMemo(
    () => groupTranscriptRows(timelineItems),
    [timelineItems],
  );
  const activeLiveAt = React.useMemo(
    () => (running || Boolean(liveVoiceTurn) ? liveActivityRowIndex(activeTranscriptRows) : -1),
    [running, liveVoiceTurn, activeTranscriptRows],
  );
  const composerChangedFilesProps = React.useMemo(
    () => buildComposerChangedFilesProps(timelineItems, effectiveWsId, effectiveWorkspaceName),
    [timelineItems, effectiveWsId, effectiveWorkspaceName],
  );
  const composerWorkspaces = React.useMemo(
    () => workspaces?.map((w) => ({ id: w.id, name: w.displayName || w.name || 'Workspace' })),
    [workspaces],
  );
  const transcriptScrollKeys = React.useMemo(
    () =>
      buildTranscriptScrollKeys(
        timelineItems,
        `${running ? 1 : 0}:${Boolean(activeThread?.pendingApproval)}:${Boolean(activeThread?.quotaHandoffOffer)}:${liveVoiceTurn?.stage ?? ''}:${liveVoiceTurn?.detail ?? ''}`,
      ),
    [timelineItems, running, activeThread?.pendingApproval, activeThread?.quotaHandoffOffer, liveVoiceTurn?.stage, liveVoiceTurn?.detail],
  );
  const { handleScroll: handleTranscriptScroll, syncLiveEdge } = useTranscriptLiveEdge(
    transcriptRef,
    threadId,
    atLiveEdgeRef,
    {
      contentKey: transcriptScrollKeys.contentKey,
      followTrigger: transcriptScrollKeys.followTrigger,
    },
  );
  const onChangePromptRef = useRef(onChangePrompt);
  onChangePromptRef.current = onChangePrompt;

  const handleEditUserMessage = useCallback(
    (text: string) => {
      onChangePromptRef.current(text);
      const el = document.querySelector('.chat-composer textarea') as HTMLTextAreaElement | null;
      if (el) {
        el.focus();
        el.setSelectionRange(text.length, text.length);
      }
    },
    [],
  );

  const handleStartRename = (id: string, currentTitle: string) => {
    setEditingId(id);
    setEditingTitle(currentTitle);
  };

  const handleSaveRename = (e: React.FormEvent, id: string) => {
    e.preventDefault();
    const trimmed = editingTitle.trim();
    if (trimmed) {
      onRename(id, trimmed);
    }
    setEditingId(null);
  };

  return (
    <div className="_surface_85ff1_11 agent-chat-surface">
      {/* Agent Chat Rail */}
      <aside aria-label={`${agentName} chat history`} className="_rail_33zx5_27">
        {tabs.length === 0 ? (
          <p className="_empty_33zx5_631">No chats yet — start one with {agentName}.</p>
        ) : (
          <nav aria-label={`${agentName} chats`} className="_list_33zx5_149">
            <ul>
              {tabs.map((tab) => {
                const selected = tab.id === selectedId;
                const isEditing = editingId === tab.id;
                const isDragOver = dragOverTabId === tab.id;

                const statusDotClass = tab.running
                  ? '_dotRunning_33zx5_341'
                  : tab.status === 'waiting'
                  ? '_dotWaiting_33zx5_343'
                  : tab.status === 'error' || tab.status === 'failed'
                  ? '_dotFailed_33zx5_345'
                  : null;

                const statusText = tab.running
                  ? 'Working'
                  : tab.status === 'waiting'
                  ? 'Needs you'
                  : tab.status === 'error' || tab.status === 'failed'
                  ? 'Failed'
                  : formatRelativeTime(tab.updatedAtUnixMs);

                const locationLabel = tab.placeCount && tab.placeCount > 1
                  ? `Home + ${tab.placeCount - 1} places`
                  : 'Home';

                return (
                  <li
                    key={tab.id}
                    className={`_row_33zx5_181${selected ? ' _selected_33zx5_211' : ''}${
                      isDragOver ? (dragInsertAfter ? ' _dropAfter_33zx5' : ' _dropBefore_33zx5') : ''
                    }`}
                    draggable={!isEditing}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', tab.id);
                      setDraggedTabId(tab.id);
                    }}
                    onDragEnd={() => {
                      setDraggedTabId(null);
                      setDragOverTabId(null);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (draggedTabId && draggedTabId !== tab.id) {
                        const rect = e.currentTarget.getBoundingClientRect();
                        const after = e.clientY > rect.top + rect.height / 2;
                        setDragOverTabId(tab.id);
                        setDragInsertAfter(after);
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (draggedTabId && draggedTabId !== tab.id && onReorder) {
                        onReorder(draggedTabId, tab.id, dragInsertAfter);
                      }
                      setDraggedTabId(null);
                      setDragOverTabId(null);
                    }}
                  >
                    {isEditing ? (
                      <form
                        className="_renameForm_33zx5_533"
                        onSubmit={(e) => handleSaveRename(e, tab.id)}
                      >
                        <label className="_renameLabel_33zx5_553">
                          <span className="_srOnly_33zx5_649">Chat title</span>
                          <input
                            autoFocus
                            maxLength={1024}
                            value={editingTitle}
                            onChange={(e) => setEditingTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') setEditingId(null);
                            }}
                          />
                        </label>
                        <button
                          type="submit"
                          aria-label="Save chat title"
                          className="_renameAction_33zx5_585"
                          disabled={!editingTitle.trim()}
                        >
                          <CheckIcon size={13} />
                        </button>
                        <button
                          type="button"
                          aria-label="Cancel chat rename"
                          className="_renameAction_33zx5_585"
                          onClick={() => setEditingId(null)}
                        >
                          <CloseIcon size={13} />
                        </button>
                      </form>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="_selectButton_33zx5_229"
                          aria-current={selected ? 'page' : undefined}
                          onClick={() => onSelect(tab.id)}
                          onDoubleClick={() => handleStartRename(tab.id, tab.title)}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            setContextMenu({
                              id: tab.id,
                              title: tab.title,
                              x: e.clientX,
                              y: e.clientY,
                            });
                          }}
                          title={`${tab.title} · ${locationLabel} · ${statusText}`}
                        >
                          {statusDotClass && <i aria-hidden="true" className={statusDotClass} />}
                          <span className="_title_33zx5_289">{tab.title || 'New chat'}</span>
                          <span className="_meta_33zx5_411">
                            <span className="_location_33zx5_435">{locationLabel}</span>
                            {tab.routineId ? (
                              <span
                                className="_scheduled_33zx5_437"
                                aria-label="Scheduled"
                                role="img"
                                title="Scheduled"
                                style={{ display: 'inline-flex', alignItems: 'center', marginLeft: 4 }}
                              >
                                <CalendarIcon size={11} strokeWidth={2} />
                              </span>
                            ) : null}
                            <span className="_status_33zx5_439">{statusText}</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="_closeButton_33zx5_467"
                          aria-label={`Archive ${tab.title}`}
                          title={`Archive ${tab.title}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onArchive(tab.id);
                          }}
                        >
                          <CloseIcon size={11} strokeWidth={2.5} />
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </nav>
        )}

        {/* Rail bottom actions: New chat and Archived chats */}
        <button
          type="button"
          className="_newButton_33zx5_83"
          aria-label={`New chat with ${agentName}`}
          title={`New chat with ${agentName}`}
          onClick={onNew}
        >
          <PlusIcon size={13} strokeWidth={2.5} />
        </button>

        <button
          type="button"
          className="_newButton_33zx5_83"
          aria-label={`Archived chats with ${agentName}`}
          title="Archived chats"
          onClick={() => {
            if (onOpenArchived) onOpenArchived();
            else setArchivedModalOpen(true);
          }}
        >
          <ArchiveIcon size={12} />
        </button>
      </aside>

      {/* Main agent chat body */}
      <section aria-label={`${agentName} chat`} className="_body_85ff1_45">
        {/* 1. Thread AutoPilot & Collapsible Teammate inbox strip */}
        <div className="agent-chat-autopilot-bar">
          <span className="agent-chat-autopilot-bar__label">Thread Autonomy</span>
          <AgentAutoPilot
            surface="thread"
            profile={{ id: agentId, name: agentName, engine: effectiveProvider }}
            threadId={activeThread?.id ?? null}
            workspaceId={effectiveWsId ?? null}
            threadRunning={running}
            threadItems={timelineItems}
            onSubmitThreadPrompt={async (nextPrompt) => {
              if (activeThread?.id) {
                try {
                  await invokeCommand('start_agent_chat_turn', {
                    threadId: activeThread.id,
                    agentId,
                    prompt: nextPrompt,
                    attachments: [],
                  });
                } catch {
                  onChangePrompt(nextPrompt);
                  onSend();
                }
              } else if (onSendInitial) {
                onSendInitial(nextPrompt);
              } else {
                onChangePrompt(nextPrompt);
                onSend();
              }
            }}
          />
        </div>
        <details className="agent-inbox-strip" onToggle={(e) => e.currentTarget.open && void fetchInbox()}>
          <summary>Teammate inbox</summary>
          <section aria-label="Teammate inbox" className="agent-inbox">
            {deliveryPaused && (
              <p className="agent-inbox__note">Delivery paused. Accepted messages are kept here.</p>
            )}
            {inboxLoading && (
              <p className="agent-inbox__note" role="status">Loading messages…</p>
            )}
            {inboxError && (
              <p className="agent-inbox__note agent-inbox__note--error" role="alert">
                Messages could not be loaded.{' '}
                <button
                  type="button"
                  className="secondary-button agent-inbox__btn"
                  onClick={() => void fetchInbox()}
                  disabled={inboxLoading}
                >
                  Retry
                </button>
              </p>
            )}
            {!inboxLoading && !inboxError && (!inboxData || inboxData.messages.length === 0) && (
              <p className="agent-inbox__note">No teammate messages yet.</p>
            )}
            {inboxData && inboxData.messages.length > 0 && (
              <ol className="agent-inbox__messages">
                {inboxData.messages.map((msg) => {
                  const directionLabel =
                    msg.direction === 'outgoing'
                      ? 'Sent'
                      : msg.direction === 'incoming'
                        ? 'Received'
                        : null;
                  const messageContent = (
                    <>
                      <span className="agent-inbox__meta">
                        <strong className="agent-inbox__sender">{msg.senderName}</strong>
                        {directionLabel && (
                          <span className="agent-inbox__direction">{' · '}{directionLabel}</span>
                        )}
                        <span className="agent-inbox__delivery">
                          {' · '}{msg.delivered ? 'Delivered' : 'Waiting for delivery'}
                        </span>
                        {msg.threadId && (
                          <span className="agent-inbox__thread-cue">Open thread →</span>
                        )}
                      </span>
                      <p className="agent-inbox__body">{msg.body}</p>
                    </>
                  );

                  return (
                    <li key={msg.id} className="agent-inbox__message">
                      {msg.threadId ? (
                        <button
                          type="button"
                          className="agent-inbox__message-btn rounded-control"
                          aria-label={`Open thread for message from ${msg.senderName}`}
                          onClick={() => {
                            const targetThreadId = msg.threadId;
                            if (!targetThreadId) return;
                            if (tabs.some((tab) => tab.id === targetThreadId)) {
                              onSelect(targetThreadId);
                              return;
                            }
                            window.dispatchEvent(
                              new CustomEvent('kite:select-thread', {
                                detail: { threadId: targetThreadId, mode: 'chat' },
                              })
                            );
                          }}
                        >
                          {messageContent}
                        </button>
                      ) : (
                        messageContent
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
            <div className="agent-inbox__actions">
              <button
                type="button"
                className="secondary-button agent-inbox__btn"
                onClick={() => void fetchInbox()}
                disabled={inboxLoading}
              >
                Refresh inbox
              </button>
              {inboxData?.nextCursor && (
                <button
                  type="button"
                  className="secondary-button agent-inbox__btn"
                  onClick={() => void fetchInbox(inboxData.nextCursor)}
                  disabled={inboxLoading}
                >
                  Older messages
                </button>
              )}
            </div>
          </section>
        </details>

        {/* 2. Notice if created by routine */}
        {(activeThread as any)?.routineId ? (
          <div className="_readOnlyNote_85ff1_113">
            This chat was created by a routine. Review it here; start a new chat to reply.
          </div>
        ) : null}

        {/* 3. Direct conversation layout */}
        <div className={`chat-thread-layout _layout_85ff1_81 scroll-quiet${effectiveIsDraft ? ' chat-thread-layout--draft' : ''}`}>
          <div className="chat-thread-layout__body">
            <AnimatePresence initial={false}>
              {effectiveIsDraft ? null : (
                <AgentTranscriptMotion
                  key={effectiveThreadId}
                  reducedMotion={reducedMotion}
                  transcriptRef={transcriptRef}
                  onScroll={handleTranscriptScroll}
                >
                  <AgentChatTranscriptContent
                    threadId={effectiveThreadId}
                    effectiveWsId={effectiveWsId ?? null}
                    activeItems={timelineItems}
                    transcriptRows={activeTranscriptRows}
                    liveAt={activeLiveAt}
                    running={running}
                    pendingApproval={activeThread?.pendingApproval}
                    swarmState={activeThread?.swarmState}
                    stoppedByBuilder={Boolean(activeThread?.stoppedByBuilder)}
                    durationSeconds={activeThread?.usage?.durationSeconds}
                    subagentRuns={activeThread?.subagentRuns}
                    quotaHandoffOffer={activeThread?.quotaHandoffOffer}
                    enterFor={enterFor}
                    onEditUserMessage={handleEditUserMessage}
                  />
                </AgentTranscriptMotion>
              )}
            </AnimatePresence>
          </div>

          {effectiveIsDraft ? (
            <motion.div
              key="agent-draft-hero"
              initial={reducedMotion ? false : { opacity: 0, y: shift.handoff }}
              animate={{ opacity: 1, y: 0 }}
              transition={reducedMotion ? tweens.instant : tweens.fade}
              className="chat-draft-hero agent-chat-hero scroll-quiet"
            >
              <ThemeHeroFigure variant="hero" />
              <h1>What should we build?</h1>
              <p>Pick a thread above or start typing below to hand real work to {agentName}.</p>
            </motion.div>
          ) : null}

          <div className="chat-thread-layout__composer">
            {session && <SessionLifecycleBar projection={session} />}
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
              threadId={effectiveThreadId}
              onConfirm={() => handleSendVoiceTurn('confirmar')}
            />

            <ChatComposer
              threadId={effectiveThreadId}
              threadItems={timelineItems}
              conversationStarted={!effectiveIsDraft || queuedRuns.length > 0}
              {...composerChangedFilesProps}
              agentName={agentName}
              engineLabel={engineLabel}
              threadMode={activeThread ? activeThread.mode : draftMode ?? 'acceptEdits'}
              threadProvider={effectiveProvider}
              threadModel={effectiveModel}
              threadEffort={activeThread ? activeThread.effort || null : draftEffort ?? null}
              threadPlan={activeThread ? Boolean((activeThread as any).plan) : false}
              threadAgent={effectiveAgent}
              threadBranch={gitBranch}
              branches={branches}
              threadWorkspaceId={effectiveWsId ?? null}
              threadWorkspaceName={effectiveWorkspaceName || 'Local'}
              workspaces={composerWorkspaces}
              onSwitchBranch={handleSwitchBranch}
              onCreateBranch={handleCreateBranch}
              onSelectWorkspace={handleSelectWorkspace}
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
              onQueue={activeThread ? handleQueueFromComposer : undefined}
              onSteer={activeThread ? onSteerPrompt : undefined}
              editingQueuedId={editingQueuedId}
              onCancelQueueEdit={handleCancelQueueEdit}
              onEditLastQueued={
                queuedRuns.length > 0
                  ? () => handleStartQueueEdit(queuedRuns[queuedRuns.length - 1].id)
                  : undefined
              }
              paused={
                !running &&
                (activeThread?.turnFailure?.kind === 'usageLimit' ||
                  Boolean(activeThread?.stoppedByBuilder) ||
                  queuedRuns.length > 0)
              }
              onSend={() => {
                if (isDraft && !activeThread && onSendInitial) {
                  onSendInitial(prompt);
                } else {
                  onSend();
                }
              }}
              onStop={onStop}
              onSendVoiceTurn={handleSendVoiceTurn}
              onStartVoiceMode={() => void startVoiceMode()}
              onPickAttachments={onPickAttachments}
              onStageFiles={onStageFiles}
              onStagePaths={onStagePaths}
              onRemoveAttachment={onRemoveAttachment}
              onUpdateConfig={onUpdateConfig}
              pendingApproval={session?.pendingApprovals[0] ?? activeThread?.pendingApproval}
              onApprovalDecision={onApprovalDecision}
            />
          </div>

          <div aria-hidden="true" className="chat-thread-layout__tail" />
        </div>
      </section>

      {/* Context Menu for rail tabs */}
      {contextMenu &&
        createPortal(
          <div
            className="chat-context-menu"
            style={{
              position: 'fixed',
              top: `${contextMenu.y}px`,
              left: `${contextMenu.x}px`,
              zIndex: 9999,
            }}
          >
            <div
              className="chat-context-menu-item"
              onClick={() => {
                handleStartRename(contextMenu.id, contextMenu.title);
                setContextMenu(null);
              }}
            >
              Rename…
            </div>
            <div
              className="chat-context-menu-item chat-context-menu-item--danger"
              onClick={() => {
                onArchive(contextMenu.id);
                setContextMenu(null);
              }}
            >
              Archive
            </div>
          </div>,
          document.querySelector('.app-frame--scaled') ?? document.body
        )}

      {/* Archived Chats Modal for this Agent */}
      <ArchivedChatsModal
        isOpen={archivedModalOpen}
        onClose={() => setArchivedModalOpen(false)}
        profileId={agentId}
        onRestored={(restoredId) => {
          setArchivedModalOpen(false);
          if (restoredId) {
            onSelect(restoredId);
          } else {
            onNew();
          }
        }}
      />
    </div>
  );
};

// Backwards-compatible export for AgentChatShell
export const AgentChatShell = AgentChatSurface;
export const AgentChatRail: React.FC<{
  agentName: string;
  tabs: AgentChatTab[];
  selectedId: string | null;
  onNew: () => void;
  onSelect: (id: string) => void;
}> = ({ agentName, tabs, selectedId, onNew, onSelect }) => (
  <aside aria-label={`${agentName} chat history`} className="_rail_33zx5_27">
    {tabs.length === 0 ? (
      <p className="_empty_33zx5_631">No chats yet — start one with {agentName}.</p>
    ) : (
      <nav aria-label={`${agentName} chats`} className="_list_33zx5_149">
        <ul>
          {tabs.map((tab) => {
            const selected = tab.id === selectedId;
            return (
              <li key={tab.id} className={selected ? '_row_33zx5_181 _selected_33zx5_211' : '_row_33zx5_181'}>
                <button
                  type="button"
                  className="_selectButton_33zx5_229"
                  aria-current={selected ? 'page' : undefined}
                  onClick={() => onSelect(tab.id)}
                >
                  <span className="_title_33zx5_289">{tab.title || 'New chat'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    )}
    <button
      type="button"
      className="_newButton_33zx5_83"
      aria-label={`New chat with ${agentName}`}
      title="New chat"
      onClick={onNew}
    >
      <PlusIcon size={13} strokeWidth={2.5} />
    </button>
  </aside>
);
