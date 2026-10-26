import React from 'react';
import { SpinnerIcon } from './ChatIcons';
import { SingleThreadPane } from './SingleThreadPane';
import type {
  ExtendedChatThread,
  ChatAttachment,
  ModelOption,
  ChatProvider,
  ChatMode,
} from './types';
import type { PlanActionPayload } from './ChatPlanPanel';
import type { DriverDeclaration, SessionProjection } from '../../../lib/session/types';

export interface ThreadGridProps {
  gridThreadIds: string[];
  focusedThreadId: string | null;
  threadsMap: Record<string, ExtendedChatThread>;
  isRunning: Record<string, boolean>;
  attachmentsMap: Record<string, ChatAttachment[]>;
  promptMap: Record<string, string>;
  workspaceId: string | null;
  workspaceName?: string;
  workspaces?: Array<{ id: string; displayName?: string; name?: string }>;
  agentName?: string;
  engineLabel?: string;
  liveRunsCount: number;
  dynamicModelsMap: Record<string, ModelOption[]>;
  dynamicAgentsMap?: Record<string, any[]>;
  /** Session projections supplied by the caller, keyed by thread id. */
  sessionProjections?: Record<string, SessionProjection> | null;
  /** Driver declarations supplied by the caller, keyed by thread id. */
  driverDeclarations?: Record<string, DriverDeclaration> | null;
  isRefreshingModels?: boolean;
  onRefreshModels?: (provider: ChatProvider) => void;
  activeDropdown: { threadId: string; type: 'provider' | 'model' | 'mode' } | null;
  editingTitleId: string | null;
  titleInput: string;
  showHistoryPopover: boolean;
  knownThreadsList: ExtendedChatThread[];
  onFocusThread: (threadId: string) => void;
  onClosePane: (threadId: string) => void;
  onToggleSplit: () => void;
  onToggleHistory: () => void;
  onNewThread: () => void;
  onSelectHistoryThread: (id: string) => void;
  onPinThread: (id: string, e: React.MouseEvent) => void;
  onArchiveThread: (id: string, e: React.MouseEvent) => void;
  onStartRename: (id: string, currentTitle: string) => void;
  onSaveRename: (threadId: string) => void;
  onChangeTitleInput: (title: string) => void;
  onCancelRename: () => void;
  onChangePrompt: (threadId: string, val: string) => void;
  onSend: (threadId: string, overridePrompt?: string, planAction?: PlanActionPayload) => Promise<boolean | void> | void;
  onStop: (threadId: string) => void;
  onPickAttachments: (threadId: string, kind?: 'files' | 'folder') => void;
  onStageFiles: (threadId: string, files: File[]) => void;
  onStagePaths: (threadId: string, paths: string[]) => void;
  onRemoveAttachment: (threadId: string, resId: string) => void;
  onDropdownToggle: (threadId: string, type: 'provider' | 'model' | 'mode') => void;
  onUpdateConfig: (
    threadId: string,
    patch: { provider?: ChatProvider; mode?: ChatMode; model?: string | null; effort?: string | null; plan?: boolean; connectionId?: string | null; agent?: string | null; workspaceId?: string | null }
  ) => void;
  onApprovalDecision: (
    threadId: string,
    decision: 'allowOnce' | 'allowForSession' | 'deny' | 'denyAndStop',
    reqId: string
  ) => void;
  onDropThread?: (
    targetThreadId: string,
    droppedThreadId: string,
    position: 'before' | 'replace' | 'after'
  ) => void;
  embedded?: boolean;
}

export interface GridCellRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function computeThreadGridRects(
  width: number,
  height: number,
  count: number,
  gap = 8
): GridCellRect[] {
  if (count <= 1 || width <= 0 || height <= 0) {
    return [{ left: 0, top: 0, width: Math.max(0, width), height: Math.max(0, height) }];
  }
  if (count === 2) {
    const colWidth = Math.max(0, Math.floor((width - gap) / 2));
    return [
      { left: 0, top: 0, width: colWidth, height },
      { left: colWidth + gap, top: 0, width: Math.max(0, width - colWidth - gap), height },
    ];
  }
  if (count === 3) {
    const colWidth = Math.max(0, Math.floor((width - 2 * gap) / 3));
    return [
      { left: 0, top: 0, width: colWidth, height },
      { left: colWidth + gap, top: 0, width: colWidth, height },
      { left: (colWidth + gap) * 2, top: 0, width: Math.max(0, width - 2 * (colWidth + gap)), height },
    ];
  }
  if (count === 4) {
    const colWidth = Math.max(0, Math.floor((width - gap) / 2));
    const rowHeight = Math.max(0, Math.floor((height - gap) / 2));
    return [
      { left: 0, top: 0, width: colWidth, height: rowHeight },
      { left: colWidth + gap, top: 0, width: Math.max(0, width - colWidth - gap), height: rowHeight },
      { left: 0, top: rowHeight + gap, width: colWidth, height: Math.max(0, height - rowHeight - gap) },
      { left: colWidth + gap, top: rowHeight + gap, width: Math.max(0, width - colWidth - gap), height: Math.max(0, height - rowHeight - gap) },
    ];
  }
  if (count === 5) {
    const rowHeight = Math.max(0, Math.floor((height - gap) / 2));
    const topColWidth = Math.max(0, Math.floor((width - gap) / 2));
    const bottomColWidth = Math.max(0, Math.floor((width - 2 * gap) / 3));
    return [
      { left: 0, top: 0, width: topColWidth, height: rowHeight },
      { left: topColWidth + gap, top: 0, width: Math.max(0, width - topColWidth - gap), height: rowHeight },
      { left: 0, top: rowHeight + gap, width: bottomColWidth, height: Math.max(0, height - rowHeight - gap) },
      { left: bottomColWidth + gap, top: rowHeight + gap, width: bottomColWidth, height: Math.max(0, height - rowHeight - gap) },
      { left: (bottomColWidth + gap) * 2, top: rowHeight + gap, width: Math.max(0, width - 2 * (bottomColWidth + gap)), height: Math.max(0, height - rowHeight - gap) },
    ];
  }
  // 6 cells (3 top, 3 bottom)
  const rowHeight = Math.max(0, Math.floor((height - gap) / 2));
  const colWidth = Math.max(0, Math.floor((width - 2 * gap) / 3));
  return [
    { left: 0, top: 0, width: colWidth, height: rowHeight },
    { left: colWidth + gap, top: 0, width: colWidth, height: rowHeight },
    { left: (colWidth + gap) * 2, top: 0, width: Math.max(0, width - 2 * (colWidth + gap)), height: rowHeight },
    { left: 0, top: rowHeight + gap, width: colWidth, height: Math.max(0, height - rowHeight - gap) },
    { left: colWidth + gap, top: rowHeight + gap, width: colWidth, height: Math.max(0, height - rowHeight - gap) },
    { left: (colWidth + gap) * 2, top: rowHeight + gap, width: Math.max(0, width - 2 * (colWidth + gap)), height: Math.max(0, height - rowHeight - gap) },
  ];
}

export const ThreadGrid: React.FC<ThreadGridProps> = ({
  gridThreadIds,
  focusedThreadId,
  threadsMap,
  isRunning,
  attachmentsMap,
  promptMap,
  workspaceId,
  workspaceName,
  workspaces,
  agentName,
  engineLabel,
  liveRunsCount,
  dynamicModelsMap,
  dynamicAgentsMap,
  sessionProjections,
  driverDeclarations,
  isRefreshingModels,
  onRefreshModels,
  activeDropdown,
  editingTitleId,
  titleInput,
  showHistoryPopover,
  knownThreadsList,
  embedded = false,
  onFocusThread,
  onClosePane,
  onToggleSplit,
  onToggleHistory,
  onNewThread,
  onSelectHistoryThread,
  onPinThread,
  onArchiveThread,
  onStartRename,
  onSaveRename,
  onChangeTitleInput,
  onCancelRename,
  onChangePrompt,
  onSend,
  onStop,
  onPickAttachments,
  onStageFiles,
  onStagePaths,
  onRemoveAttachment,
  onDropdownToggle,
  onUpdateConfig,
  onApprovalDecision,
  onDropThread,
}) => {
  const isMulti = gridThreadIds.length > 1;
  const canvasRef = React.useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = React.useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });
  const [dropTarget, setDropTarget] = React.useState<{
    threadId: string;
    position: 'before' | 'replace' | 'after';
  } | null>(null);

  React.useLayoutEffect(() => {
    if (!canvasRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setDimensions({ width, height });
      }
    });
    observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (!isMulti) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
        const activeTag = document.activeElement?.tagName?.toLowerCase();
        if (activeTag === 'input' || activeTag === 'textarea') return;
        e.preventDefault();
        e.stopPropagation();
        onClosePane(focusedThreadId || gridThreadIds[0]);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMulti, focusedThreadId, gridThreadIds, onClosePane]);

  const rects = React.useMemo(() => {
    return computeThreadGridRects(
      dimensions.width || 1000,
      dimensions.height || 800,
      Math.min(gridThreadIds.length, 6)
    );
  }, [dimensions.width, dimensions.height, gridThreadIds.length]);

  const handleDragOverCell = (e: React.DragEvent, tid: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const cellRect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - cellRect.left) / cellRect.width;
    const position = ratio < 0.28 ? 'before' : ratio > 0.72 ? 'after' : 'replace';
    setDropTarget({ threadId: tid, position });
  };

  const handleDropCell = (e: React.DragEvent, tid: string) => {
    e.preventDefault();
    const droppedId =
      e.dataTransfer.getData('application/x-kite-thread') ||
      e.dataTransfer.getData('text/plain');
    if (droppedId && dropTarget && onDropThread) {
      onDropThread(tid, droppedId, dropTarget.position);
    }
    setDropTarget(null);
  };

  return (
    <div
      className={`thread-grid ${isMulti ? 'thread-grid--multi' : ''}`}
      data-thread-count={gridThreadIds.length}
      style={{ flex: 1, minHeight: 0, position: 'relative', width: '100%', height: '100%' }}
    >
      <div
        ref={canvasRef}
        className="thread-grid__canvas"
        style={{ width: '100%', height: '100%', position: 'relative' }}
      >
        {gridThreadIds.map((tid, idx) => {
          const thread = threadsMap[tid];
          const isFocused = focusedThreadId === tid;
          const running = !!isRunning[tid];
          const attachments = attachmentsMap[tid] || [];
          const prompt = promptMap[tid] || '';
          const rect = rects[idx];
          const cellStyle: React.CSSProperties = rect
            ? {
                position: 'absolute',
                left: `${rect.left}px`,
                top: `${rect.top}px`,
                width: `${rect.width}px`,
                height: `${rect.height}px`,
              }
            : {
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
              };

          if (!thread) {
            return (
              <div
                key={tid}
                className="thread-grid__cell"
                data-thread-grid-cell={tid}
                style={{
                  ...cellStyle,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text-secondary)',
                }}
              >
                <SpinnerIcon size={24} style={{ color: 'var(--text-secondary)' }} />
              </div>
            );
          }

          return (
            <div
              key={tid}
              className={`thread-grid__cell ${isFocused ? 'thread-grid__cell--focused' : ''}`}
              data-thread-grid-cell={tid}
              style={cellStyle}
              onDragOver={(e) => handleDragOverCell(e, tid)}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(e) => handleDropCell(e, tid)}
            >
              {dropTarget && dropTarget.threadId === tid && (
                <div
                  className={`thread-grid__drop thread-grid__drop--${dropTarget.position}`}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    zIndex: 100,
                    pointerEvents: 'none',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: 'rgba(59, 130, 246, 0.15)',
                    border: '2px dashed var(--accent, #3b82f6)',
                    borderRadius: '8px',
                  }}
                >
                  <span
                    className="thread-grid__drop-label"
                    style={{
                      backgroundColor: 'var(--composer, #1e1e1e)',
                      color: 'var(--text-primary, #fafafa)',
                      padding: '6px 14px',
                      borderRadius: '6px',
                      fontSize: '12px',
                      fontWeight: 600,
                      boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
                    }}
                  >
                    {dropTarget.position === 'before'
                      ? 'Split left'
                      : dropTarget.position === 'after'
                      ? 'Split right'
                      : 'Replace'}
                  </span>
                </div>
              )}
              <SingleThreadPane
                thread={thread}
                workspaceId={workspaceId}
                workspaceName={workspaceName}
                workspaces={workspaces}
                agentName={agentName}
                engineLabel={engineLabel}
                isFocused={isFocused}
                isMulti={isMulti}
                embedded={embedded}
                running={running}
                prompt={prompt}
                attachments={attachments}
                liveRunsCount={liveRunsCount}
                dynamicModels={dynamicModelsMap[thread.provider] || []}
                dynamicAgents={dynamicAgentsMap?.[thread.provider] || []}
                driverDeclaration={driverDeclarations?.[tid] ?? null}
                session={sessionProjections?.[tid] ?? null}
                isRefreshingModels={isRefreshingModels}
                onRefreshModels={onRefreshModels}
                activeDropdown={activeDropdown}
                editingTitleId={editingTitleId}
                titleInput={titleInput}
                showHistoryPopover={showHistoryPopover}
                knownThreadsList={knownThreadsList}
                onFocus={() => onFocusThread(tid)}
                onClosePane={() => onClosePane(tid)}
                onToggleSplit={onToggleSplit}
                onToggleHistory={onToggleHistory}
                onNewThread={onNewThread}
                onSelectHistoryThread={onSelectHistoryThread}
                onPinThread={onPinThread}
                onArchiveThread={onArchiveThread}
                onStartRename={onStartRename}
                onSaveRename={() => onSaveRename(tid)}
                onChangeTitleInput={onChangeTitleInput}
                onCancelRename={onCancelRename}
                onChangePrompt={(val) => onChangePrompt(tid, val)}
                onSend={(overridePrompt, planAction) => onSend(tid, overridePrompt, planAction)}
                onStop={() => onStop(tid)}
                onPickAttachments={(kind) => onPickAttachments(tid, kind)}
                onStageFiles={(files) => onStageFiles(tid, files)}
                onStagePaths={(paths) => onStagePaths(tid, paths)}
                onRemoveAttachment={(resId) => onRemoveAttachment(tid, resId)}
                onDropdownToggle={(type) => onDropdownToggle(tid, type)}
                onUpdateConfig={(patch) => onUpdateConfig(tid, patch)}
                onApprovalDecision={(decision, reqId) => onApprovalDecision(tid, decision, reqId)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};
