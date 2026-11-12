import React from 'react';
import {
  ColumnsGlyph,
  RowsGlyph,
  WrapTextGlyph,
  FolderTreeGlyph,
  ChevronsUpDownGlyph,
  ChevronsDownUpGlyph,
  CheckGlyph,
  ListGlyph,
} from '../../dockIcons';
import {
  FolderIcon,
  CheckIcon,
  FileTextIcon,
  ChevronDownIcon,
  MoreHorizontalIcon,
} from '../files/FileIcons';
import { RefreshIcon } from '../../code/codeIcons';
import { useDiffsMenuPresence } from './diffsMotion';

export interface DiffsToolbarProps {
  workspaces?: Array<{ id: string; name?: string; displayName?: string }>;
  currentWsId: string | null;
  activeWorkspaceName: string | null;
  onSelectWorkspaceId: (id: string) => void;
  filter: 'all' | 'staged' | 'unstaged';
  setFilter: (f: 'all' | 'staged' | 'unstaged') => void;
  allFilesCount: number;
  stagedFilesCount: number;
  unstagedFilesCount: number;
  gitLoading: boolean;
  onRefresh: () => void;
  isNarrow: boolean;
  viewMode: 'focused' | 'stream';
  setViewMode: React.Dispatch<React.SetStateAction<'focused' | 'stream'>>;
  layout: 'unified' | 'split';
  setLayout: (l: 'unified' | 'split') => void;
  wordWrap: boolean;
  setWordWrap: React.Dispatch<React.SetStateAction<boolean>>;
  fileTreeOpen: boolean;
  setFileTreeOpen: React.Dispatch<React.SetStateAction<boolean>>;
  allCollapsed: boolean;
  onToggleAllCollapse: () => void;
  displayedFilesCount: number;
}

export const DiffsToolbar: React.FC<DiffsToolbarProps> = ({
  workspaces,
  currentWsId,
  activeWorkspaceName,
  onSelectWorkspaceId,
  filter,
  setFilter,
  allFilesCount,
  stagedFilesCount,
  unstagedFilesCount,
  gitLoading,
  onRefresh,
  isNarrow,
  viewMode,
  setViewMode,
  layout,
  setLayout,
  wordWrap,
  setWordWrap,
  fileTreeOpen,
  setFileTreeOpen,
  allCollapsed,
  onToggleAllCollapse,
  displayedFilesCount,
}) => {
  const [isFolderMenuOpen, setIsFolderMenuOpen] = React.useState<boolean>(false);
  const folderMenuPresence = useDiffsMenuPresence(isFolderMenuOpen);

  const moreMenuRef = React.useRef<HTMLDivElement>(null);
  const [moreMenuOpen, setMoreMenuOpen] = React.useState<boolean>(false);
  const moreMenuPresence = useDiffsMenuPresence(moreMenuOpen);

  React.useEffect(() => {
    if (!moreMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMoreMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [moreMenuOpen]);

  return (
    <nav className="diffs-toolbar" aria-label="Diffs toolbar">
      {/* Left: Folder Picker & Filter Pills */}
      <div className="diffs-toolbar-left">
        {workspaces && workspaces.length > 0 && (
          <div style={{ position: 'relative' }}>
            <button
              type="button"
              className="_folderButton"
              aria-expanded={isFolderMenuOpen}
              aria-haspopup="menu"
              aria-label={`Folder, ${activeWorkspaceName ?? 'none'}`}
              onClick={() => setIsFolderMenuOpen((prev) => !prev)}
              title="Switch diff folder"
              style={{
                height: '24px',
                padding: '0 8px',
                fontSize: '11px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                borderRadius: 'var(--radius-chip, 12px)',
                background: 'var(--block-fill, rgba(255, 255, 255, 0.05))',
                border: '1px solid var(--block-stroke, rgba(255, 255, 255, 0.08))',
                color: 'var(--text-primary, #f1f5f9)',
                cursor: 'pointer',
                maxWidth: '160px',
              }}
            >
              <FolderIcon size={12} style={{ color: 'var(--accent, #6366f1)', flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {activeWorkspaceName ?? 'Select folder'}
              </span>
              <ChevronDownIcon size={10} style={{ opacity: 0.6, flexShrink: 0 }} />
            </button>

            {folderMenuPresence.mounted && (
              <>
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: 49 }}
                  onClick={() => setIsFolderMenuOpen(false)}
                />
                <div
                  role="menu"
                  aria-label="Select workspace folder"
                  className={`ui-menu diffs-overflow-menu diffs-overflow-menu--anchor-left scroll-quiet${
                    folderMenuPresence.motionClass ? ` ${folderMenuPresence.motionClass}` : ''
                  }`}
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 4px)',
                    marginTop: 0,
                    zIndex: 50,
                    minWidth: '200px',
                  }}
                >
                  <div className="ui-menu__header" style={{ padding: '6px 10px' }}>
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: '11px',
                        color: 'var(--text-primary, #f0f6fc)',
                      }}
                    >
                      Show diffs from
                    </div>
                  </div>
                  <div
                    style={{
                      height: '1px',
                      background: 'var(--separator, rgba(255,255,255,0.08))',
                      margin: '4px 0',
                    }}
                  />
                  {workspaces.map((ws) => (
                    <button
                      key={ws.id}
                      type="button"
                      role="menuitem"
                      className={`ui-menu__row${ws.id === currentWsId ? ' active' : ''}`}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '8px',
                        padding: '6px 10px',
                        background: ws.id === currentWsId ? 'var(--hover-fill, rgba(255,255,255,0.08))' : 'transparent',
                        border: 'none',
                        color: 'var(--text-primary, #f0f6fc)',
                        fontSize: '11px',
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                      onClick={() => {
                        onSelectWorkspaceId(ws.id);
                        setIsFolderMenuOpen(false);
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <FolderIcon size={12} style={{ color: 'var(--accent, #6366f1)' }} />
                        <span>{ws.displayName ?? ws.name ?? 'Workspace'}</span>
                      </span>
                      {ws.id === currentWsId && <CheckIcon size={11} />}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        <button
          type="button"
          className={`diffs-filter-pill ${filter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
        >
          <span>All</span>
          <span style={{ opacity: 0.7, fontFamily: 'var(--font-mono, monospace)' }}>
            ({allFilesCount})
          </span>
        </button>
        <button
          type="button"
          className={`diffs-filter-pill ${filter === 'staged' ? 'active' : ''}`}
          onClick={() => setFilter('staged')}
        >
          <span>Staged</span>
          <span style={{ opacity: 0.7, fontFamily: 'var(--font-mono, monospace)' }}>
            ({stagedFilesCount})
          </span>
        </button>
        <button
          type="button"
          className={`diffs-filter-pill ${filter === 'unstaged' ? 'active' : ''}`}
          onClick={() => setFilter('unstaged')}
        >
          <span>Unstaged</span>
          <span style={{ opacity: 0.7, fontFamily: 'var(--font-mono, monospace)' }}>
            ({unstagedFilesCount})
          </span>
        </button>
      </div>

      {/* Right: Controls & Toggles */}
      <div className="diffs-toolbar-right">
        {/* Refresh git */}
        <button
          type="button"
          className="diffs-tool-btn"
          onClick={onRefresh}
          title="Refresh changes"
          aria-label="Refresh changes"
        >
          <RefreshIcon size={12} className={gitLoading ? 'icon-spin' : ''} />
        </button>

        {!isNarrow ? (
          <>
            {/* View Presentation Mode Toggle: Focused vs Stream */}
            <button
              type="button"
              className={`diffs-filter-pill ${viewMode === 'focused' ? 'active' : ''}`}
              onClick={() => setViewMode((m) => (m === 'focused' ? 'stream' : 'focused'))}
              title={viewMode === 'focused' ? 'Switch to All Files Stream' : 'Switch to Focused File View'}
              aria-label="Toggle view mode"
              style={{ height: '22px', fontSize: '10.5px' }}
            >
              {viewMode === 'focused' ? 'Focused' : 'Stream'}
            </button>

            {/* Expand / Collapse All (active in Stream mode) */}
            {viewMode === 'stream' && displayedFilesCount > 0 && (
              <button
                type="button"
                className="diffs-tool-btn"
                onClick={onToggleAllCollapse}
                title={allCollapsed ? 'Expand all files' : 'Collapse all files'}
                aria-label={allCollapsed ? 'Expand all files' : 'Collapse all files'}
              >
                {allCollapsed ? <ChevronsUpDownGlyph size={13} /> : <ChevronsDownUpGlyph size={13} />}
              </button>
            )}

            <div className="diffs-sep" />

            {/* View Mode Toggle: Unified vs Split */}
            <button
              type="button"
              className={`diffs-tool-btn ${layout === 'unified' ? 'active' : ''}`}
              onClick={() => setLayout('unified')}
              title="Unified diff view (stacked)"
              aria-label="Unified diff view"
            >
              <RowsGlyph size={13} />
            </button>
            <button
              type="button"
              className={`diffs-tool-btn ${layout === 'split' ? 'active' : ''}`}
              onClick={() => setLayout('split')}
              title="Split diff view (side-by-side)"
              aria-label="Split diff view"
            >
              <ColumnsGlyph size={13} />
            </button>

            <div className="diffs-sep" />

            {/* Word Wrap Toggle */}
            <button
              type="button"
              className={`diffs-tool-btn ${wordWrap ? 'active' : ''}`}
              onClick={() => setWordWrap((v) => !v)}
              title={wordWrap ? 'Disable line wrapping' : 'Enable line wrapping'}
              aria-label={wordWrap ? 'Disable line wrapping' : 'Enable line wrapping'}
            >
              <WrapTextGlyph size={13} />
            </button>
          </>
        ) : (
          /* Compact Overflow Menu (•••) for Narrow Dock Widths */
          <div className="diffs-more-menu-wrapper" ref={moreMenuRef}>
            <button
              type="button"
              className={`diffs-tool-btn ${moreMenuOpen ? 'active' : ''}`}
              onClick={() => setMoreMenuOpen((v) => !v)}
              title="Diff display options"
              aria-label="Diff display options"
              aria-expanded={moreMenuOpen}
              aria-haspopup="menu"
            >
              <MoreHorizontalIcon size={13} />
            </button>

            {moreMenuPresence.mounted && (
              <div
                role="menu"
                aria-label="Diff display options"
                className={`ui-menu diffs-overflow-menu scroll-quiet${
                  moreMenuPresence.motionClass ? ` ${moreMenuPresence.motionClass}` : ''
                }`}
              >
                <div className="ui-menu__header" role="presentation">
                  <span className="ui-menu__title">Diff options</span>
                </div>
                <div aria-hidden="true" className="ui-menu__rule" />

                <div className="ui-menu__heading" role="presentation">
                  View mode
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className={`ui-menu__row ${viewMode === 'focused' ? 'active' : ''}`}
                  onClick={() => {
                    setViewMode('focused');
                    setMoreMenuOpen(false);
                  }}
                >
                  <span aria-hidden="true" className="ui-menu__icon">
                    <FileTextIcon size={12} />
                  </span>
                  <span className="ui-menu__label">
                    <span className="ui-menu__row-title">Focused</span>
                  </span>
                  {viewMode === 'focused' && (
                    <span className="ui-menu__status">
                      <CheckGlyph size={11} />
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={`ui-menu__row ${viewMode === 'stream' ? 'active' : ''}`}
                  onClick={() => {
                    setViewMode('stream');
                    setMoreMenuOpen(false);
                  }}
                >
                  <span aria-hidden="true" className="ui-menu__icon">
                    <ListGlyph size={12} />
                  </span>
                  <span className="ui-menu__label">
                    <span className="ui-menu__row-title">Stream (All files)</span>
                  </span>
                  {viewMode === 'stream' && (
                    <span className="ui-menu__status">
                      <CheckGlyph size={11} />
                    </span>
                  )}
                </button>

                <div aria-hidden="true" className="ui-menu__rule" />
                <div className="ui-menu__heading" role="presentation">
                  Diff layout
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className={`ui-menu__row ${layout === 'unified' ? 'active' : ''}`}
                  onClick={() => {
                    setLayout('unified');
                    setMoreMenuOpen(false);
                  }}
                >
                  <span aria-hidden="true" className="ui-menu__icon">
                    <RowsGlyph size={12} />
                  </span>
                  <span className="ui-menu__label">
                    <span className="ui-menu__row-title">Unified (Stacked)</span>
                  </span>
                  {layout === 'unified' && (
                    <span className="ui-menu__status">
                      <CheckGlyph size={11} />
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={`ui-menu__row ${layout === 'split' ? 'active' : ''}`}
                  onClick={() => {
                    setLayout('split');
                    setMoreMenuOpen(false);
                  }}
                >
                  <span aria-hidden="true" className="ui-menu__icon">
                    <ColumnsGlyph size={12} />
                  </span>
                  <span className="ui-menu__label">
                    <span className="ui-menu__row-title">Split (Side by side)</span>
                  </span>
                  {layout === 'split' && (
                    <span className="ui-menu__status">
                      <CheckGlyph size={11} />
                    </span>
                  )}
                </button>

                <div aria-hidden="true" className="ui-menu__rule" />
                <div className="ui-menu__heading" role="presentation">
                  Formatting
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className={`ui-menu__row ${wordWrap ? 'active' : ''}`}
                  onClick={() => {
                    setWordWrap((w) => !w);
                  }}
                >
                  <span aria-hidden="true" className="ui-menu__icon">
                    <WrapTextGlyph size={12} />
                  </span>
                  <span className="ui-menu__label">
                    <span className="ui-menu__row-title">Wrap lines</span>
                  </span>
                  {wordWrap && (
                    <span className="ui-menu__status">
                      <CheckGlyph size={11} />
                    </span>
                  )}
                </button>

                {viewMode === 'stream' && displayedFilesCount > 0 && (
                  <>
                    <div aria-hidden="true" className="ui-menu__rule" />
                    <div className="ui-menu__heading" role="presentation">
                      Cards
                    </div>
                    <button
                      type="button"
                      role="menuitem"
                      className="ui-menu__row"
                      onClick={() => {
                        onToggleAllCollapse();
                        setMoreMenuOpen(false);
                      }}
                    >
                      <span aria-hidden="true" className="ui-menu__icon">
                        {allCollapsed ? (
                          <ChevronsUpDownGlyph size={12} />
                        ) : (
                          <ChevronsDownUpGlyph size={12} />
                        )}
                      </span>
                      <span className="ui-menu__label">
                        <span className="ui-menu__row-title">
                          {allCollapsed ? 'Expand all files' : 'Collapse all files'}
                        </span>
                      </span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* File Tree Drawer Toggle */}
        <button
          type="button"
          className={`diffs-tool-btn ${fileTreeOpen ? 'active' : ''}`}
          onClick={() => setFileTreeOpen((v) => !v)}
          title={fileTreeOpen ? 'Hide file tree' : 'Show file tree'}
          aria-label={fileTreeOpen ? 'Hide file tree' : 'Show file tree'}
        >
          <FolderTreeGlyph size={13} />
        </button>
      </div>
    </nav>
  );
};
