import React from 'react';
import './chat.css';
import {
  ChatProvider,
  ChatMode,
  ApprovalRequest,
  ExtendedChatThread,
  ChatAttachment,
  ModelOption,
  LiveChatRun,
  EffortChoice,
  DiffLine,
  DiffData,
  PROVIDER_CATALOG,
  MODE_LABELS,
  DEFAULT_EFFORT_CHOICES,
  formatTokens,
  formatBytes,
} from './chat/types';
import { ChatHome } from './chat/ChatHome';
import { AgentChatSurface } from './agents/AgentChatShell';
import { EffortPicker } from './chat/EffortPicker';
import { UnifiedDiffView } from './chat/UnifiedDiffView';
import { SpinnerIcon } from './chat/ChatIcons';
import { ThreadGrid } from './chat/ThreadGrid';
import { ChatComposer } from './chat/ChatComposer';
import { ChatRail } from './chat/ChatRail';
import { useChatSession } from './chat/useChatSession';
import type { DriverDeclaration, SessionProjection } from '../../lib/session/types';

export type {
  ChatProvider,
  ChatMode,
  ApprovalRequest,
  ExtendedChatThread,
  ChatAttachment,
  ModelOption,
  LiveChatRun,
  EffortChoice,
  DiffLine,
  DiffData,
};
export {
  PROVIDER_CATALOG,
  MODE_LABELS,
  DEFAULT_EFFORT_CHOICES,
  formatTokens,
  formatBytes,
  EffortPicker,
  UnifiedDiffView,
  ChatHome,
  ChatComposer,
  ThreadGrid,
  ChatRail,
};

export interface ChatViewProps {
  workspaceId: string | null;
  agentId?: string | null;
  agentName?: string;
  agentEngine?: string;
  engineLabel?: string;
  /** Optional thread to open when ChatView is embedded in a workspace pane. */
  threadId?: string | null;
  agents?: any[];
  workspaces?: any[];
  workspaceName?: string;
  embedded?: boolean;
  onThreadsChanged?: () => void;
  /** Session projections supplied by the parent, keyed by thread id. */
  sessionProjections?: Record<string, SessionProjection> | null;
  /** Driver declarations supplied by the parent, keyed by thread id. */
  driverDeclarations?: Record<string, DriverDeclaration> | null;
}

export const ChatView: React.FC<ChatViewProps> = (props) => {
  const {
    workspaceId,
    agentId,
    agentName,
    engineLabel,
  } = props;

  const session = useChatSession(props);

  // Loading indicator for initial state
  if (session.isLoadingInitial) {
    return (
      <div className="pane chat-surface" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', width: '100%' }}>
        <SpinnerIcon size={24} style={{ color: 'var(--text-secondary)' }} />
      </div>
    );
  }

  // Agent chat mode -> Dedicated AgentChatSurface (no ThreadGrid, no SingleThreadPane)
  if (agentId) {
    const activeThreadId = session.focusedThreadId || session.knownThreadsList[0]?.id || null;
    const activeThread = activeThreadId ? session.threadsMap[activeThreadId] ?? null : null;
    const draftKey = activeThreadId || `draft-${agentId}`;
    const effectiveProvider = activeThread?.provider || session.draftConfig.provider;
    const isDraft = !activeThread || (activeThread.items.length === 0 && !session.isRunning[activeThread.id]);
    const running = activeThread ? Boolean(session.isRunning[activeThread.id]) : false;
    const prompt = session.promptMap[draftKey] || '';
    const attachments = session.attachmentsMap[draftKey] || [];
    const totalTokens = activeThread ? ((activeThread.usage?.inputTokens || 0) + (activeThread.usage?.outputTokens || 0)) : 0;
    const dynamicModels = session.dynamicModelsMap[effectiveProvider] || [];
    const dynamicAgents = session.dynamicAgentsMap[effectiveProvider] || [];

    return (
      <AgentChatSurface
        agentId={agentId}
        agentName={agentName || 'Agent'}
        engineLabel={engineLabel || 'Agent'}
        workspaceId={workspaceId}
        workspaces={props.workspaces}
        workspaceName={props.workspaceName}
        defaultProvider={session.defaultProvider}
        draftProvider={session.draftConfig.provider}
        draftMode={session.draftConfig.mode}
        draftModel={session.draftConfig.model}
        draftEffort={session.draftConfig.effort}
        draftAgent={session.draftConfig.agent}
        activeThread={activeThread}
        tabs={session.knownThreadsList.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          running: Boolean(session.isRunning[t.id]),
          routineId: (t as any).routineId ?? (t as any).routine_id ?? null,
          placeCount: (t as any).place_display_names?.length || (t as any).placeDisplayNames?.length || 1,
          updatedAtUnixMs: (t as any).updatedAt ?? (t as any).createdAt ?? Date.now(),
        }))}
        selectedId={activeThreadId}
        isDraft={isDraft}
        running={running}
        prompt={prompt}
        attachments={attachments}
        totalTokens={totalTokens}
        dynamicModels={dynamicModels}
        dynamicAgents={dynamicAgents}
        driverDeclaration={
          activeThreadId ? props.driverDeclarations?.[activeThreadId] ?? null : null
        }
        session={activeThreadId ? props.sessionProjections?.[activeThreadId] ?? null : null}
        onNew={() => void session.handleCreateNewThread()}
        onSelect={(id) => void session.handleLoadThread(id)}
        onRename={(id, title) => void session.handleRenameThread(id, title)}
        onArchive={(id) => void session.handleArchiveThread(id)}
        onReorder={(draggedId, targetId, insertAfter) => {
          const current = [...session.knownThreadsList];
          const fromIdx = current.findIndex((t) => t.id === draggedId);
          if (fromIdx === -1) return;
          const [draggedItem] = current.splice(fromIdx, 1);
          const targetIdx = current.findIndex((t) => t.id === targetId);
          if (targetIdx === -1) return;
          const insertIdx = insertAfter ? targetIdx + 1 : targetIdx;
          current.splice(insertIdx, 0, draggedItem);
          session.setKnownThreadsList(current);
          void session.persistAgentTabOrder(current.map((t) => t.id));
        }}
        onChangePrompt={(val) => session.setPromptMap((prev) => ({ ...prev, [draftKey]: val }))}
        onSend={() => activeThreadId && void session.handleSendPrompt(activeThreadId)}
        onSendInitial={(text) => {
          session.setPromptMap((prev) => ({ ...prev, [draftKey]: '' }));
          void session.handleStartThreadFromHome(text);
        }}
        onStop={() => activeThreadId && void session.handleCancelTurn(activeThreadId)}
        onPickAttachments={(kind) => void session.handlePickAttachments(draftKey, kind)}
        onStageFiles={(files) => void session.handleStageFiles(draftKey, files)}
        onStagePaths={(paths) => void session.stageDroppedAttachments(draftKey, paths)}
        onRemoveAttachment={(resId) => void session.handleRemoveAttachment(draftKey, resId)}
        isRefreshingModels={session.isRefreshingModels}
        onRefreshModels={session.refreshModels}
        onUpdateConfig={(patch) =>
          activeThread
            ? void session.handleUpdateConfig(activeThread.id, patch)
            : session.handleDraftConfigChange(patch)
        }
        onApprovalDecision={(dec, reqId) => activeThreadId && void session.handleApproval(activeThreadId, dec, reqId)}
      />
    );
  }

  // When there are no threads in the grid -> Render default empty state
  if (session.gridThreadIds.length === 0) {
    return (
      <section
        aria-label="No thread selected"
        className="pane chat-surface chat-surface--empty"
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          className="chat-empty-state"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <p
            className="chat-empty-state__line"
            style={{
              fontSize: '14px',
              color: 'var(--text-secondary, #888)',
              margin: 0,
            }}
          >
            Pick a thread to continue.
          </p>
          <button
            type="button"
            className="secondary-button"
            onClick={session.handleCreateNewThread}
            style={{
              padding: '8px 16px',
              fontSize: '13px',
              borderRadius: '6px',
            }}
          >
            New thread
          </button>
        </div>
      </section>
    );
  }

  const currentWs = props.workspaces?.find((w) => w.id === workspaceId);
  const effectiveWorkspaceName = props.workspaceName || currentWs?.displayName || currentWs?.name;

  const threadGrid = (
    <ThreadGrid
      gridThreadIds={session.gridThreadIds}
      focusedThreadId={session.focusedThreadId}
      threadsMap={session.threadsMap}
      isRunning={session.isRunning}
      attachmentsMap={session.attachmentsMap}
      promptMap={session.promptMap}
      workspaceId={workspaceId}
      workspaceName={effectiveWorkspaceName}
      workspaces={props.workspaces}
      agentName={undefined}
      engineLabel={undefined}
      liveRunsCount={session.liveRuns.length}
      dynamicModelsMap={session.dynamicModelsMap}
      dynamicAgentsMap={session.dynamicAgentsMap}
      sessionProjections={props.sessionProjections}
      driverDeclarations={props.driverDeclarations}
      isRefreshingModels={session.isRefreshingModels}
      onRefreshModels={session.refreshModels}
      activeDropdown={session.activeDropdown}
      editingTitleId={session.editingTitleId}
      titleInput={session.titleInput}
      showHistoryPopover={session.showHistoryPopover}
      knownThreadsList={session.knownThreadsList}
      embedded={props.embedded}
      onFocusThread={(tid) => {
        session.setFocusedThreadId(tid);
        void session.persistGrid(session.gridThreadIds, tid);
      }}
      onClosePane={session.handleClosePane}
      onToggleSplit={session.handleToggleSplit}
      onToggleHistory={() => session.setShowHistoryPopover((v) => !v)}
      onNewThread={session.handleCreateNewThread}
      onSelectHistoryThread={(id) => void session.handleLoadThread(id)}
      onPinThread={(id, e) => void session.handlePinThread(id, e)}
      onArchiveThread={(id, e) => void session.handleArchiveThread(id, e)}
      onStartRename={(id, currentTitle) => {
        session.setEditingTitleId(id);
        session.setTitleInput(currentTitle);
      }}
      onSaveRename={(tid) => void session.handleRenameThread(tid)}
      onChangeTitleInput={session.setTitleInput}
      onCancelRename={() => session.setEditingTitleId(null)}
      onChangePrompt={(tid, val) => session.setPromptMap((prev) => ({ ...prev, [tid]: val }))}
      onSend={(tid, overridePrompt, planAction) => session.handleSendPrompt(tid, overridePrompt, undefined, planAction)}
      onStop={(tid) => void session.handleCancelTurn(tid)}
      onPickAttachments={(tid, kind) => void session.handlePickAttachments(tid, kind)}
      onStageFiles={(tid, files) => void session.handleStageFiles(tid, files)}
      onStagePaths={(tid, paths) => void session.stageDroppedAttachments(tid, paths)}
      onRemoveAttachment={(tid, resId) => void session.handleRemoveAttachment(tid, resId)}
      onDropdownToggle={(tid, type) => {
        session.setActiveDropdown((prev) =>
          prev?.threadId === tid && prev?.type === type ? null : { threadId: tid, type }
        );
      }}
      onUpdateConfig={(tid, patch) => void session.handleUpdateConfig(tid, patch)}
      onApprovalDecision={(tid, decision, reqId) => void session.handleApproval(tid, decision, reqId)}
      onDropThread={session.handleDropThread}
    />
  );

  return (
    <div
      className="pane chat-surface chat-surface--thread"
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      {threadGrid}
    </div>
  );
};
