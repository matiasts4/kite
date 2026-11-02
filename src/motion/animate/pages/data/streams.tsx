import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import { CompareScene, SceneButton, type CompareVariant, type CompareView } from '../../frame';
import { ChevronDownIcon } from '../../ui';

/* -------------------------------------------------------------------------- */
/* Scene 6 — Diff, terminal and transcript                                    */
/* -------------------------------------------------------------------------- */

type DiffKind = 'add' | 'remove' | 'context';

interface DiffLine {
  kind: DiffKind;
  text: string;
}

interface DiffFile {
  id: string;
  name: string;
  short: string;
  adds: number;
  removes: number;
  lines: DiffLine[];
}

const DIFF_FILES: DiffFile[] = [
  {
    id: 'contract',
    name: 'src/motion/contract.ts',
    short: 'contract.ts',
    adds: 2,
    removes: 1,
    lines: [
      { kind: 'context', text: 'export const MOTION_ENTER_MS = 180;' },
      { kind: 'remove', text: 'export const MOTION_EXIT_MS = 140;' },
      { kind: 'add', text: 'export const MOTION_EXIT_MS = 160;' },
      { kind: 'add', text: 'export const MOTION_EASE = cubicBezier(0.16, 1, 0.3, 1);' },
      { kind: 'context', text: 'export const LIVE_EDGE_THRESHOLD_PX = 48;' },
    ],
  },
  {
    id: 'surface',
    name: 'src/motion/surface.ts',
    short: 'surface.ts',
    adds: 2,
    removes: 1,
    lines: [
      { kind: 'context', text: 'export function motionSurfaceClass(phase, kind) {' },
      { kind: 'context', text: "  if (kind === 'scrim') return `motion-scrim-${phase}`;" },
      { kind: 'remove', text: '  return `motion-${kind}-${phase}`;' },
      { kind: 'add', text: "  const suffix = phase === 'out' ? 'out' : 'in';" },
      { kind: 'add', text: '  return `motion-${kind}-${suffix}`;' },
      { kind: 'context', text: '}' },
    ],
  },
  {
    id: 'presence',
    name: 'src/motion/usePresence.ts',
    short: 'usePresence.ts',
    adds: 2,
    removes: 1,
    lines: [
      { kind: 'context', text: 'export function usePresence(open: boolean): Presence {' },
      { kind: 'remove', text: '  const mounted = useRef(open);' },
      { kind: 'add', text: '  const [mounted, setMounted] = useState(open);' },
      { kind: 'add', text: '  const mountedRef = useRef(open);' },
      { kind: 'context', text: '  useEffect(() => {' },
      { kind: 'context', text: '    if (!open) setPhase(out);' },
    ],
  },
];

interface TermLine {
  id: number;
  text: string;
  tone: 'cmd' | 'out' | 'ok' | 'err';
}

const SEED_TERM: TermLine[] = [
  { id: 1, text: '$ kite doctor', tone: 'cmd' },
  { id: 2, text: 'ok · 3 workspaces · 0 conflictos', tone: 'ok' },
];

type ToolStatus = 'done' | 'pending' | 'error' | 'running';

interface ToolRow {
  id: string;
  tool: string;
  detail: string;
  status: ToolStatus;
}

const SEED_TOOLS: ToolRow[] = [
  { id: 'a', tool: 'read_file', detail: 'src/motion/surface.ts', status: 'done' },
  { id: 'b', tool: 'write_file', detail: 'pages/data/data.css', status: 'pending' },
  { id: 'c', tool: 'run_terminal', detail: 'npx tsc --noEmit', status: 'error' },
];

const TOOL_STATUS: Record<ToolStatus, string> = {
  done: 'listo',
  pending: 'aprobación',
  error: 'error',
  running: 'corriendo',
};

function formatLine(line: DiffLine): string {
  if (line.kind === 'add') return `+${line.text}`;
  if (line.kind === 'remove') return `-${line.text}`;
  return ` ${line.text}`;
}

function DiffBlock({
  mode,
  fileId,
  collapsed,
  onFile,
  onToggleCollapsed,
}: {
  mode: CompareVariant;
  fileId: string;
  collapsed: boolean;
  onFile: (id: string) => void;
  onToggleCollapsed: () => void;
}) {
  const motionTokens = useLabMotion();
  const uid = useId();
  const tablistRef = useRef<HTMLDivElement>(null);
  const file = DIFF_FILES.find((item) => item.id === fileId) ?? DIFF_FILES[0];
  const panelId = `${uid}-diff`;

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = (index + step + DIFF_FILES.length) % DIFF_FILES.length;
    onFile(DIFF_FILES[next].id);
    requestAnimationFrame(() => {
      tablistRef.current
        ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
        [next]?.focus();
    });
  };

  return (
    <div className="p4-diff">
      <div className="p4-diff__head">
        <div ref={tablistRef} className="p4-diff__tabs" role="tablist" aria-label="Archivos del diff">
          {DIFF_FILES.map((item, index) => {
            const active = item.id === file.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={panelId}
                tabIndex={active ? 0 : -1}
                className="p4-filetab"
                onClick={() => onFile(item.id)}
                onKeyDown={(event) => onTabKey(event, index)}
              >
                {item.short}
              </button>
            );
          })}
        </div>
        <div className="p4-diff__meta">
          <span className="p4-diff__adds">+{file.adds}</span>
          <span className="p4-diff__removes">−{file.removes}</span>
          <SceneButton
            mode={mode}
            variant="ghost"
            className="cmp-btn--sm"
            aria-expanded={!collapsed}
            aria-controls={panelId}
            onClick={onToggleCollapsed}
          >
            {collapsed ? 'Mostrar' : 'Ocultar'}
            {mode === 'animate' ? (
              <motion.span
                className="p4-diff__chevron"
                animate={{ rotate: collapsed ? 0 : 180 }}
                transition={motionTokens.springs.press}
              >
                <ChevronDownIcon size={9} />
              </motion.span>
            ) : (
              <ChevronDownIcon
                size={9}
                className={`p4-diff__chevron${collapsed ? '' : ' is-open'}`}
              />
            )}
          </SceneButton>
        </div>
      </div>

      {mode === 'animate' ? (
        <AnimatePresence initial={false}>
          {!collapsed && (
            <motion.div
              key="diff-body"
              id={panelId}
              role="tabpanel"
              aria-label={file.name}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={motionTokens.tweens.disclosure}
              style={{ overflow: 'hidden' }}
            >
              <motion.div
                key={file.id}
                className="p4-diff__body"
                initial={{ opacity: 0, y: motionTokens.travel(4) }}
                animate={{ opacity: 1, y: 0 }}
                transition={motionTokens.tweens.panelIn}
              >
                {file.lines.map((line, index) => (
                  <motion.div
                    key={`${file.id}-${index}`}
                    className={`p4-linecode p4-linecode--${line.kind}`}
                    initial={{
                      opacity: 0,
                      y: motionTokens.travel(3),
                      filter: motionTokens.itemBlur,
                    }}
                    animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                    transition={{
                      ...motionTokens.tweens.reveal,
                      delay: index * motionTokens.stagger,
                    }}
                  >
                    {formatLine(line)}
                  </motion.div>
                ))}
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      ) : (
        <div
          id={panelId}
          role="tabpanel"
          aria-label={file.name}
          aria-hidden={collapsed || undefined}
          className="p4-collapse"
          data-open={!collapsed}
        >
          <div className="p4-collapse__inner">
            <div className="p4-diff__body">
              {file.lines.map((line, index) => (
                <div
                  key={`${file.id}-${index}`}
                  className={`p4-linecode p4-linecode--${line.kind} motion-row-in`}
                >
                  {formatLine(line)}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Cursor({ mode }: { mode: CompareVariant }) {
  const reduce = useLabReduce();

  if (mode === 'kite') {
    return <span className="p4-term__cursor p4-term__cursor--css" aria-hidden="true" />;
  }

  return (
    <motion.span
      className="p4-term__cursor"
      aria-hidden="true"
      animate={reduce ? { opacity: 1 } : { opacity: [1, 1, 0, 0] }}
      transition={
        reduce ? { duration: 0 } : { duration: 1, repeat: Infinity, times: [0, 0.5, 0.5, 1] }
      }
    />
  );
}

function TerminalBlock({
  mode,
  lines,
  command,
  streaming,
  onCommand,
  onRun,
  onClear,
}: {
  mode: CompareVariant;
  lines: TermLine[];
  command: string;
  streaming: boolean;
  onCommand: (value: string) => void;
  onRun: () => void;
  onClear: () => void;
}) {
  const motionTokens = useLabMotion();
  const outRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = outRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines.length]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onRun();
  };

  return (
    <div className="p4-term">
      <div className="p4-term__head">
        <span>terminal · zsh</span>
        <SceneButton mode={mode} variant="ghost" className="cmp-btn--sm" onClick={onClear}>
          Limpiar
        </SceneButton>
      </div>
      <div ref={outRef} className="p4-term__out" aria-live="polite">
        {mode === 'animate' ? (
          <AnimatePresence initial={false}>
            {lines.map((line) => (
              <motion.div
                key={line.id}
                layout="position"
                className={`p4-term__line p4-term__line--${line.tone}`}
                initial={{ opacity: 0, y: motionTokens.travel(4), filter: motionTokens.itemBlur }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                transition={motionTokens.itemSpring}
              >
                {line.text}
              </motion.div>
            ))}
          </AnimatePresence>
        ) : (
          lines.map((line) => (
            <div key={line.id} className={`p4-term__line p4-term__line--${line.tone} motion-row-in`}>
              {line.text}
            </div>
          ))
        )}
        <div className="p4-term__prompt">
          <span className="p4-term__ps1" aria-hidden="true">
            ›
          </span>
          <Cursor mode={mode} />
        </div>
      </div>
      <form className="p4-term__form" onSubmit={submit}>
        <input
          className="p4-term__input"
          value={command}
          onChange={(event) => onCommand(event.target.value)}
          placeholder="npx tsc --noEmit"
          aria-label="Comando para la terminal"
          spellCheck={false}
        />
        <SceneButton
          mode={mode}
          variant="primary"
          type="submit"
          className="cmp-btn--sm"
          disabled={streaming}
        >
          {streaming ? 'Corriendo…' : 'Ejecutar'}
        </SceneButton>
      </form>
    </div>
  );
}

function TranscriptBlock({
  mode,
  rows,
  onApprove,
  onRetry,
}: {
  mode: CompareVariant;
  rows: ToolRow[];
  onApprove: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const rowRefs = useRef(new Map<string, HTMLDivElement | null>());

  const act = (id: string, action: (target: string) => void) => {
    action(id);
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  };

  return (
    <div className="p4-trans">
      <div className="p4-trans__head">
        <span>herramientas · {rows.length}</span>
        <span className="p4-hint">aprobá o reintentá</span>
      </div>
      <div className="p4-trans__list">
        {rows.map((row) => {
          const side =
            row.status === 'pending' ? (
              <SceneButton
                mode={mode}
                variant="primary"
                className="cmp-btn--sm"
                onClick={() => act(row.id, onApprove)}
              >
                Aprobar
              </SceneButton>
            ) : row.status === 'error' ? (
              <SceneButton
                mode={mode}
                variant="ghost"
                className="cmp-btn--sm"
                onClick={() => act(row.id, onRetry)}
              >
                Reintentar
              </SceneButton>
            ) : mode === 'animate' ? (
              <motion.span
                key={row.status}
                className="p4-trans__status"
                initial={reduce ? false : { opacity: 0, filter: motionTokens.swapBlur }}
                animate={{ opacity: 1, filter: 'blur(0px)' }}
                transition={motionTokens.tweens.swap}
              >
                {TOOL_STATUS[row.status]}
              </motion.span>
            ) : (
              <span className="p4-trans__status">{TOOL_STATUS[row.status]}</span>
            );

          const body = (
            <>
              <span className={`p4-trans__dot p4-trans__dot--${row.status}`} aria-hidden="true" />
              <div className="p4-trans__text">
                <strong>{row.tool}</strong>
                <span>{row.detail}</span>
              </div>
              <div className="p4-trans__side">{side}</div>
            </>
          );

          return mode === 'animate' ? (
            <motion.div
              key={row.id}
              ref={(node) => {
                rowRefs.current.set(row.id, node);
              }}
              tabIndex={-1}
              layout="position"
              className={`p4-trans__row is-${row.status}`}
              transition={motionTokens.itemSpring}
            >
              {body}
            </motion.div>
          ) : (
            <div
              key={row.id}
              ref={(node) => {
                rowRefs.current.set(row.id, node);
              }}
              tabIndex={-1}
              className={`p4-trans__row is-${row.status}`}
            >
              {body}
            </div>
          );
        })}
      </div>
      <div className="p4-trans__foot">
        <span className="p4-hint">
          {rows.filter((row) => row.status === 'pending').length} pendientes ·{' '}
          {rows.filter((row) => row.status === 'error').length} con error
        </span>
      </div>
    </div>
  );
}

export function StreamsScene({ view }: { view: CompareView }) {
  const [fileId, setFileId] = useState(DIFF_FILES[0].id);
  const [collapsed, setCollapsed] = useState(false);
  const [termLines, setTermLines] = useState<TermLine[]>(SEED_TERM);
  const [command, setCommand] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [tools, setTools] = useState<ToolRow[]>(SEED_TOOLS);
  const [said, setSaid] = useState('');
  const nextLine = useRef(SEED_TERM.length + 1);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach((id) => window.clearTimeout(id));
    },
    []
  );

  const pushLine = (line: Omit<TermLine, 'id'>) => {
    nextLine.current += 1;
    const id = nextLine.current;
    setTermLines((prev) => [...prev, { ...line, id }].slice(-7));
  };

  const runCommand = () => {
    if (streaming) return;
    const trimmed = command.trim();
    const text = trimmed || 'npx tsc --noEmit';
    pushLine({ text: `$ ${text}`, tone: 'cmd' });
    setStreaming(true);
    const script: { text: string; tone: TermLine['tone'] }[] = [
      { text: 'analizando src/motion/animate/pages/data/', tone: 'out' },
      { text: '0 errores · 14 archivos', tone: 'out' },
      { text: 'proceso terminado en 2,1 s', tone: 'ok' },
    ];
    script.forEach((line, index) => {
      timers.current.push(
        window.setTimeout(() => {
          pushLine(line);
          if (index === script.length - 1) setStreaming(false);
        }, 280 * (index + 1))
      );
    });
  };

  const approve = (id: string) => {
    setTools((prev) =>
      prev.map((row) => (row.id === id ? { ...row, status: 'done' as const } : row))
    );
    setSaid('Escritura aprobada');
  };

  const retry = (id: string) => {
    setTools((prev) =>
      prev.map((row) => (row.id === id ? { ...row, status: 'running' as const } : row))
    );
    setSaid('Reintentando run_terminal');
    timers.current.push(
      window.setTimeout(() => {
        setTools((prev) =>
          prev.map((row) => (row.id === id ? { ...row, status: 'done' as const } : row))
        );
      }, 950)
    );
  };

  return (
    <>
      <CompareScene
        index="06"
        title="Diff, terminal y transcript"
        target="DiffView · TerminalPane · ToolCallList"
        note="Cambiá de archivo y colapsá el diff; ejecutá un comando y aprobá o reintentá una herramienta. Kite usa el keyframe de fila y el panel CSS; Animate UI escalona las líneas, deja entrar cada salida de terminal con blur y cambia el estado de la herramienta con un swap."
        view={view}
      >
        {(mode) => (
          <div className="p4-streams" data-engine={mode}>
            <DiffBlock
              mode={mode}
              fileId={fileId}
              collapsed={collapsed}
              onFile={setFileId}
              onToggleCollapsed={() => setCollapsed((current) => !current)}
            />
            <div className="p4-streams__split">
              <TerminalBlock
                mode={mode}
                lines={termLines}
                command={command}
                streaming={streaming}
                onCommand={setCommand}
                onRun={runCommand}
                onClear={() => setTermLines([])}
              />
              <TranscriptBlock
                mode={mode}
                rows={tools}
                onApprove={approve}
                onRetry={retry}
              />
            </div>
          </div>
        )}
      </CompareScene>
      <p className="p4-sr" aria-live="polite">
        {said}
      </p>
    </>
  );
}
