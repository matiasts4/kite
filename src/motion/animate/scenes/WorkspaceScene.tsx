import { useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useLabMotion } from '../context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from '../frame';
import { MoreIcon } from '../ui';
import {
  ChevronRightIcon,
  SearchIcon,
  SidebarIcon,
  TerminalIcon,
} from './helpers';
import {
  PROJECTS,
  SEED_TERMINAL,
  THREADS,
  type TerminalLine,
  type ThreadNode,
} from './workspaceData';
import {
  DiffViewer,
  Dock,
  TerminalPane,
  ThreadMenu,
} from './workspacePanels';

function WorkspacePane({
  mode,
  threads,
  filter,
  onFilter,
  collapsed,
  onToggleRail,
  selectedThread,
  expanded,
  onToggleExpanded,
  onSelectThread,
  menuFor,
  onToggleMenu,
  submenuOpen,
  onSubmenu,
  project,
  onMoveTo,
  dockOpen,
  onToggleDock,
  onShowDiff,
  view,
  onView,
  terminalOpen,
  onToggleTerminal,
  terminalLines,
  command,
  onCommand,
  onSubmitCommand,
  onCloseTerminal,
}: {
  mode: CompareVariant;
  threads: ThreadNode[];
  filter: string;
  onFilter: (value: string) => void;
  collapsed: boolean;
  onToggleRail: () => void;
  selectedThread: string;
  expanded: string[];
  onToggleExpanded: (id: string) => void;
  onSelectThread: (id: string) => void;
  menuFor: string | null;
  onToggleMenu: (id: string) => void;
  submenuOpen: boolean;
  onSubmenu: (next: boolean) => void;
  project: string;
  onMoveTo: (next: string) => void;
  dockOpen: boolean;
  onToggleDock: () => void;
  onShowDiff: () => void;
  view: 'editor' | 'diff';
  onView: (next: 'editor' | 'diff') => void;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  terminalLines: TerminalLine[];
  command: string;
  onCommand: (value: string) => void;
  onSubmitCommand: () => void;
  onCloseTerminal: () => void;
}) {
  const motionTokens = useLabMotion();
  const railClass = `cmp-workspace__rail p6-ws__rail${
    mode === 'kite' ? ' p6-ws__rail--kite' : ''
  }${collapsed ? ' is-collapsed' : ''}`;
  const filtering = filter.trim().length > 0;

  const miniRail = (
    <div className="p6-ws__rail-mini">
      <SceneButton
        mode={mode}
        variant="icon"
        onClick={onToggleRail}
        aria-label="Expandir sidebar"
      >
        <SidebarIcon size={13} />
      </SceneButton>
      {THREADS.map((thread) => (
        <button
          key={thread.id}
          type="button"
          className={`p6-ws__mini${selectedThread === thread.id ? ' is-active' : ''}`}
          title={thread.title}
          aria-label={thread.title}
          onClick={() => onSelectThread(thread.id)}
        >
          <span className={`cmp-thread__dot cmp-thread__dot--${thread.state}`} aria-hidden="true" />
        </button>
      ))}
    </div>
  );

  const fullRail = (
    <>
      <div className="p6-ws__rail-head">
        <span>Hilos</span>
        <SceneButton
          mode={mode}
          variant="icon"
          onClick={onToggleRail}
          aria-label="Colapsar sidebar"
        >
          <SidebarIcon size={13} />
        </SceneButton>
      </div>

      <div className="p6-ws__search">
        <SearchIcon size={12} />
        <input
          className="p6-ws__search-input"
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
          placeholder="Filtrar hilos"
          aria-label="Filtrar hilos"
        />
      </div>

      <div className="p6-ws__project">Proyecto · {project}</div>

      <div className="p6-ws__tree">
        {threads.length === 0 && (
          <p className="p6-ws__empty">Sin hilos que coincidan.</p>
        )}
        {threads.map((thread) => {
          const hasChildren = Boolean(thread.children && thread.children.length > 0);
          const isOpen = expanded.includes(thread.id) || (filtering && hasChildren);
          return (
            <div key={thread.id} className="p6-ws__node">
              <div
                className={`cmp-thread p6-ws__thread${
                  selectedThread === thread.id ? ' is-active' : ''
                }`}
              >
                {hasChildren ? (
                  <button
                    type="button"
                    className="p6-ws__chev"
                    aria-label={isOpen ? `Contraer ${thread.title}` : `Expandir ${thread.title}`}
                    aria-expanded={isOpen}
                    onClick={() => onToggleExpanded(thread.id)}
                  >
                    {mode === 'animate' ? (
                      <motion.span
                        className="p6-ws__chevicon"
                        animate={{ rotate: isOpen ? 90 : 0 }}
                        transition={motionTokens.tweens.disclosure}
                      >
                        <ChevronRightIcon size={10} />
                      </motion.span>
                    ) : (
                      <ChevronRightIcon
                        size={10}
                        className={`p6-ws__chevicon${isOpen ? ' is-open' : ''}`}
                      />
                    )}
                  </button>
                ) : (
                  <span className="p6-ws__chev p6-ws__chev--empty" aria-hidden="true" />
                )}
                <span
                  className={`cmp-thread__dot cmp-thread__dot--${thread.state}`}
                  aria-hidden="true"
                />
                <button
                  type="button"
                  className="cmp-thread__text p6-ws__thread-button"
                  onClick={() => onSelectThread(thread.id)}
                >
                  <span>{thread.title}</span>
                  <small>{thread.detail}</small>
                </button>
                <SceneButton
                  mode={mode}
                  variant="icon"
                  className="cmp-thread__more"
                  aria-label={`Opciones de ${thread.title}`}
                  aria-haspopup="menu"
                  aria-expanded={menuFor === thread.id}
                  onClick={() => onToggleMenu(thread.id)}
                >
                  <MoreIcon size={12} />
                </SceneButton>
                <ThreadMenu
                  mode={mode}
                  open={menuFor === thread.id}
                  onClose={() => onToggleMenu(thread.id)}
                  submenuOpen={submenuOpen}
                  onSubmenu={onSubmenu}
                  onSelect={() => {
                    onSelectThread(thread.id);
                    onToggleMenu(thread.id);
                  }}
                  onMoveTo={onMoveTo}
                />
              </div>
              {hasChildren && isOpen && (
                <div className="p6-ws__children">
                  {thread.children?.map((child) => (
                    <button
                      key={child.id}
                      type="button"
                      className={`p6-ws__child${
                        selectedThread === child.id ? ' is-active' : ''
                      }`}
                      onClick={() => onSelectThread(child.id)}
                    >
                      <span
                        className={`cmp-thread__dot cmp-thread__dot--${child.state}`}
                        aria-hidden="true"
                      />
                      <span className="p6-ws__child-text">
                        <span>{child.title}</span>
                        <small>{child.detail}</small>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );

  return (
    <div className={`cmp-workspace p6-ws p6-mode p6-mode--${mode}`}>
      {mode === 'animate' ? (
        <motion.aside
          className={railClass}
          layout
          transition={motionTokens.springs.reflow}
          aria-label="Hilos del workspace"
        >
          {collapsed ? miniRail : fullRail}
        </motion.aside>
      ) : (
        <aside className={railClass} aria-label="Hilos del workspace">
          {collapsed ? miniRail : fullRail}
        </aside>
      )}

      <main className="cmp-editor p6-ws__editor">
        <header className="cmp-editor__head p6-ws__editor-head">
          <div className="cmp-tabs p6-ws__tabs" role="tablist" aria-label="Vista del editor">
            {(['editor', 'diff'] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={view === item}
                className={`cmp-tabs__tab${view === item ? ' is-active' : ''}`}
                onClick={() => onView(item)}
              >
                {mode === 'animate' && view === item && (
                  <motion.span
                    layoutId="cmp-workspace-tab"
                    className="cmp-tabs__indicator"
                    initial={false}
                    transition={motionTokens.springs.selection}
                  />
                )}
                <span className="cmp-tabs__label">{item === 'editor' ? 'Editor' : 'Diff'}</span>
              </button>
            ))}
          </div>
          <div className="p6-ws__editor-actions">
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={onToggleTerminal}
              aria-pressed={terminalOpen}
            >
              <TerminalIcon size={12} />
              Terminal
            </SceneButton>
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={onToggleDock}
            >
              {dockOpen ? 'Cerrar dock' : 'Abrir dock'}
            </SceneButton>
          </div>
        </header>

        <div className="p6-ws__body">
          {view === 'editor' ? (
            <pre className="cmp-editor__code">{`export const MOTION_ENTER_MS = 180;
export const MOTION_EXIT_MS = 140;

export function prefersReducedMotion() {
  return document.documentElement.dataset.motion === 'reduce';
}`}</pre>
          ) : (
            <DiffViewer mode={mode} />
          )}
        </div>

        <TerminalPane
          mode={mode}
          open={terminalOpen}
          lines={terminalLines}
          command={command}
          onCommand={onCommand}
          onSubmit={onSubmitCommand}
          onClose={onCloseTerminal}
        />

        <Dock mode={mode} open={dockOpen} onClose={onToggleDock} onShowDiff={onShowDiff} />
      </main>
    </div>
  );
}

export function WorkspaceScene({ view }: { view: CompareView }) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<string[]>(['t1']);
  const [filter, setFilter] = useState('');
  const [selectedThread, setSelectedThread] = useState('t1');
  const [project, setProject] = useState(PROJECTS[0]);
  const [editorView, setEditorView] = useState<'editor' | 'diff'>('editor');
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>(SEED_TERMINAL);
  const [command, setCommand] = useState('');
  const sequence = useRef(SEED_TERMINAL.length);

  const query = filter.trim().toLowerCase();
  const visibleThreads = THREADS.filter(
    (thread) =>
      !query ||
      thread.title.toLowerCase().includes(query) ||
      thread.children?.some((child) => child.title.toLowerCase().includes(query))
  );

  const runCommand = () => {
    const value = command.trim();
    if (!value) return;
    sequence.current += 2;
    const base = sequence.current;
    setTerminalLines((prev) => [
      ...prev,
      { id: `l${base - 1}`, tone: 'cmd', text: `$ ${value}` },
      { id: `l${base}`, tone: 'ok', text: `✓ ${value} · ok` },
    ]);
    setCommand('');
  };

  return (
    <CompareScene
      index="03"
      title="Workspace completo"
      target="Sidebar · SelectMenu · RightDock · Diff · Terminal"
      note="Rail colapsable con hilos anidados y filtro, menú con submenú, editor con diff, terminal y dock derecho. Abrí el menú de un hilo, colapsá el rail o cambiá a Diff: el estado es uno y las dos columnas lo comparten."
      view={view}
    >
      {(mode) => (
        <WorkspacePane
          mode={mode}
          threads={visibleThreads}
          filter={filter}
          onFilter={setFilter}
          collapsed={collapsed}
          onToggleRail={() => setCollapsed((value) => !value)}
          selectedThread={selectedThread}
          expanded={expanded}
          onToggleExpanded={(id) =>
            setExpanded((prev) =>
              prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
            )
          }
          onSelectThread={setSelectedThread}
          menuFor={menuFor}
          onToggleMenu={(id) => {
            setMenuFor((current) => (current === id ? null : id));
            setSubmenuOpen(false);
          }}
          submenuOpen={submenuOpen}
          onSubmenu={setSubmenuOpen}
          project={project}
          onMoveTo={(next) => {
            setProject(next);
            setMenuFor(null);
            setSubmenuOpen(false);
          }}
          dockOpen={dockOpen}
          onToggleDock={() => setDockOpen((value) => !value)}
          onShowDiff={() => {
            setEditorView('diff');
            setDockOpen(false);
          }}
          view={editorView}
          onView={setEditorView}
          terminalOpen={terminalOpen}
          onToggleTerminal={() => setTerminalOpen((value) => !value)}
          terminalLines={terminalLines}
          command={command}
          onCommand={setCommand}
          onSubmitCommand={runCommand}
          onCloseTerminal={() => setTerminalOpen(false)}
        />
      )}
    </CompareScene>
  );
}
