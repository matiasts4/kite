import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  PlusIcon,
  ArchiveIcon,
  CloseIcon,
  CheckIcon,
  CalendarIcon,
} from '../chat/ChatIcons';
import { ChatItemRow, ChatWorkGroup, groupTranscriptRows } from '../chat/ChatItemRow';
import { ChatComposer } from '../chat/ChatComposer';
import { ArchivedChatsModal } from '../modals/ArchivedChatsModal';
import { QuotaHandoffBanner } from '../../chat/QuotaHandoffBanner';
import { invokeCommand } from '../../../lib/ipc';
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
}

export interface AgentChatSurfaceProps {
  agentId: string;
  agentName: string;
  engineLabel: string;
  defaultProvider?: ChatProvider;
  activeThread: ExtendedChatThread | null;
  tabs: AgentChatTab[];
  selectedId: string | null;
  isDraft: boolean;
  running: boolean;
  prompt: string;
  attachments: ChatAttachment[];
  totalTokens: number;
  dynamicModels: ModelOption[];
  isRefreshingModels?: boolean;
  onRefreshModels?: (provider: ChatProvider) => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onOpenArchived?: () => void;
  onReorder?: (draggedId: string, targetId: string, insertAfter: boolean) => void;
  onChangePrompt: (val: string) => void;
  onSend: () => void;
  onSendInitial?: (text: string) => void;
  onStop: () => void;
  onPickAttachments: (kind?: 'files' | 'folder') => void;
  onStageFiles: (files: File[]) => void;
  onStagePaths: (paths: string[]) => void;
  onRemoveAttachment: (resId: string) => void;
  onUpdateConfig: (patch: { provider?: ChatProvider; mode?: ChatMode; model?: string | null; effort?: string | null }) => void;
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

export const AgentChatSurface: React.FC<AgentChatSurfaceProps> = ({
  agentId,
  agentName,
  engineLabel,
  defaultProvider,
  activeThread,
  tabs,
  selectedId,
  isDraft,
  running,
  prompt,
  attachments,
  totalTokens,
  dynamicModels,
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
  onStop,
  onPickAttachments,
  onStageFiles,
  onStagePaths,
  onRemoveAttachment,
  onUpdateConfig,
  onApprovalDecision,
}) => {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState<string>('');
  const [archivedModalOpen, setArchivedModalOpen] = useState(false);

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

  // Auto-scroll transcript on new items or streaming
  useEffect(() => {
    const scroller = transcriptRef.current;
    if (scroller && atLiveEdgeRef.current) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, [activeThread?.items.length, activeThread?.items[activeThread.items.length - 1]?.text]);

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
    <div className="_surface_85ff1_11">
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

      {/* Main Agent Chat Body — Direct layout matching Se in AgentChatSurface-BBtggayP.js */}
      <section aria-label={`${agentName} chat`} className="_body_85ff1_45">
        {/* 1. Collapsible Teammate inbox strip */}
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
                  className="secondary-button"
                  style={{ height: '24px', fontSize: '11px', padding: '0 8px' }}
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
                {inboxData.messages.map((msg) => (
                  <li key={msg.id} className="agent-inbox__message">
                    <strong className="agent-inbox__sender">{msg.senderName}</strong>
                    <span className="agent-inbox__delivery">
                      {' · '}{msg.delivered ? 'Delivered' : 'Waiting for delivery'}
                    </span>
                    <p className="agent-inbox__body">{msg.body}</p>
                  </li>
                ))}
              </ol>
            )}
            <div className="agent-inbox__actions">
              <button
                type="button"
                className="secondary-button"
                style={{ height: '24px', fontSize: '11px', padding: '0 8px' }}
                onClick={() => void fetchInbox()}
                disabled={inboxLoading}
              >
                Refresh inbox
              </button>
              {inboxData?.nextCursor && (
                <button
                  type="button"
                  className="secondary-button"
                  style={{ height: '24px', fontSize: '11px', padding: '0 8px' }}
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
        <div className={`chat-thread-layout _layout_85ff1_81 scroll-quiet${isDraft ? ' chat-thread-layout--draft' : ''}`}>
          <div className="chat-thread-layout__body">
            {isDraft || !activeThread ? null : (
              <div
                className="chat-transcript"
                ref={transcriptRef}
                onScroll={(e) => {
                  const { scrollHeight, scrollTop, clientHeight } = e.currentTarget;
                  atLiveEdgeRef.current = scrollHeight - scrollTop - clientHeight <= 48;
                }}
              >
                <div className="chat-transcript__column">
                  {groupTranscriptRows(activeThread.items).map((row) =>
                    row.kind === 'work' ? (
                      <ChatWorkGroup key={row.id} items={row.items} running={running} />
                    ) : (
                      <ChatItemRow key={row.item.id} item={row.item} threadId={activeThread.id} />
                    )
                  )}

                  {(running || activeThread.status === 'waiting') && (() => {
                    const activeTool = [...activeThread.items]
                      .reverse()
                      .find((it) => (it.kind === 'tool' || it.kind === 'command') && (it.streaming || it.status === 'running'));
                    const isStreamingAssistant = activeThread.items.some(
                      (it) => it.kind === 'assistant' && it.streaming && it.text.trim().length > 0
                    );
                    const stageLabel = activeThread.pendingApproval
                      ? `Waiting for approval · ${activeThread.pendingApproval.title || activeThread.pendingApproval.toolName}`
                      : activeTool
                        ? `Executing ${activeTool.title || activeTool.toolName || 'tool'}…`
                        : isStreamingAssistant
                          ? 'Generating response…'
                          : 'Thinking…';
                    return (
                      <div className={`chat-working-row ${activeThread.pendingApproval ? 'chat-working-row--waiting' : ''}`}>
                        <span className="chat-working-row__dots">
                          <i />
                          <i />
                          <i />
                        </span>
                        <span className="chat-working-row__stage">{stageLabel}</span>
                      </div>
                    );
                  })()}

                  {/* Quota Handoff Banner */}
                  {activeThread.quotaHandoffOffer && (
                    <QuotaHandoffBanner
                      offer={activeThread.quotaHandoffOffer}
                      threadId={activeThread.id}
                    />
                  )}
                </div>
              </div>
            )}
          </div>

          {isDraft ? (
            <div className="chat-draft-hero agent-chat-hero scroll-quiet">
              <h1>What should we build?</h1>
            </div>
          ) : null}

          <ChatComposer
            threadId={activeThread?.id || 'draft'}
            agentName={agentName}
            engineLabel={engineLabel}
            threadMode={activeThread?.mode || 'acceptEdits'}
            threadProvider={activeThread?.provider || defaultProvider || 'antigravity'}
            threadModel={activeThread?.model || null}
            threadEffort={activeThread?.effort || null}
            running={running}
            prompt={prompt}
            attachments={attachments}
            totalTokens={totalTokens}
            dynamicModels={dynamicModels}
            isRefreshingModels={isRefreshingModels}
            onRefreshModels={onRefreshModels}
            onChangePrompt={onChangePrompt}
            onSend={() => {
              if (isDraft && !activeThread && onSendInitial) {
                onSendInitial(prompt);
              } else {
                onSend();
              }
            }}
            onStop={onStop}
            onPickAttachments={onPickAttachments}
            onStageFiles={onStageFiles}
            onStagePaths={onStagePaths}
            onRemoveAttachment={onRemoveAttachment}
            onUpdateConfig={onUpdateConfig}
            pendingApproval={activeThread?.pendingApproval}
            onApprovalDecision={onApprovalDecision}
          />

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
