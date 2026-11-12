import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { usePresence } from '../../usePresence';
import { motionSurfaceClass } from '../../surface';
import { useLabMotion, useLabReduce } from '../context';
import { SceneButton, type CompareVariant } from '../frame';
import { CloseIcon } from '../ui';
import { ChevronRightIcon } from './helpers';
import {
  DIFF_ROWS,
  PROJECTS,
  type TerminalLine,
} from './workspaceData';

export function ProjectSubmenu({
  mode,
  open,
  onMoveTo,
}: {
  mode: CompareVariant;
  open: boolean;
  onMoveTo: (project: string) => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);

  const rows = (
    <>
      {PROJECTS.map((project) => (
        <button
          key={project}
          type="button"
          role="menuitem"
          className="cmp-menu__item"
          onClick={() => onMoveTo(project)}
        >
          <span className="cmp-menu__label">Proyecto · {project}</span>
        </button>
      ))}
    </>
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div
        className={`cmp-menu p6-ws__submenu ${motionSurfaceClass(presence.phase, 'panel-left')}`}
        role="menu"
        aria-label="Mover a proyecto"
      >
        {rows}
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="cmp-menu p6-ws__submenu"
          role="menu"
          aria-label="Mover a proyecto"
          initial={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.menu,
            x: reduce ? 0 : -motionTokens.travel(4),
          }}
          animate={{
            opacity: 1,
            scale: 1,
            x: 0,
            transition: reduce ? motionTokens.tweens.fade : motionTokens.tweens.menu,
          }}
          exit={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.menu,
            x: reduce ? 0 : -motionTokens.travel(4),
            transition: motionTokens.tweens.dismiss,
          }}
          style={{ transformOrigin: 'left top' }}
        >
          {rows}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function ThreadMenu({
  mode,
  open,
  onClose,
  submenuOpen,
  onSubmenu,
  onSelect,
  onMoveTo,
}: {
  mode: CompareVariant;
  open: boolean;
  onClose: () => void;
  submenuOpen: boolean;
  onSubmenu: (next: boolean) => void;
  onSelect: () => void;
  onMoveTo: (project: string) => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);
  const [hovered, setHovered] = useState<string | null>(null);

  const highlight = (id: string) =>
    mode === 'animate' && hovered === id ? (
      <motion.span
        layoutId="cmp-thread-highlight"
        className="cmp-menu__highlight"
        initial={false}
        transition={motionTokens.springs.highlight}
      />
    ) : null;

  const leave = () => {
    setHovered(null);
    onSubmenu(false);
  };

  const rows = (
    <>
      <button
        type="button"
        role="menuitem"
        className="cmp-menu__item"
        onPointerEnter={() => setHovered('open')}
        onFocus={() => setHovered('open')}
        onBlur={() => setHovered(null)}
        onClick={onSelect}
      >
        {highlight('open')}
        <span className="cmp-menu__label">Abrir hilo</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className={`cmp-menu__item p6-ws__menu-row${submenuOpen ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={submenuOpen}
        onPointerEnter={() => {
          setHovered('move');
          onSubmenu(true);
        }}
        onFocus={() => {
          setHovered('move');
          onSubmenu(true);
        }}
        onBlur={() => setHovered(null)}
        onClick={() => onSubmenu(true)}
      >
        {highlight('move')}
        <span className="cmp-menu__label">
          Mover a
          <ChevronRightIcon size={10} />
        </span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="cmp-menu__item"
        onPointerEnter={() => setHovered('rename')}
        onFocus={() => setHovered('rename')}
        onBlur={() => setHovered(null)}
        onClick={onClose}
      >
        {highlight('rename')}
        <span className="cmp-menu__label">Renombrar</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="cmp-menu__item cmp-menu__item--danger"
        onPointerEnter={() => setHovered('archive')}
        onFocus={() => setHovered('archive')}
        onBlur={() => setHovered(null)}
        onClick={onClose}
      >
        {highlight('archive')}
        <span className="cmp-menu__label">Archivar</span>
      </button>
      <ProjectSubmenu mode={mode} open={submenuOpen} onMoveTo={onMoveTo} />
    </>
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div
        className={`cmp-menu ${motionSurfaceClass(presence.phase, 'popover')}`}
        role="menu"
        aria-label="Opciones del hilo"
        onPointerLeave={leave}
      >
        {rows}
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="cmp-menu"
          role="menu"
          aria-label="Opciones del hilo"
          initial={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.menu,
            y: reduce ? 0 : -motionTokens.travel(4),
          }}
          animate={{
            opacity: 1,
            scale: 1,
            y: 0,
            transition: reduce ? motionTokens.tweens.fade : motionTokens.tweens.menu,
          }}
          exit={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.menu,
            y: reduce ? 0 : -motionTokens.travel(4),
            transition: motionTokens.tweens.dismiss,
          }}
          style={{ transformOrigin: 'top right' }}
          onPointerLeave={leave}
        >
          {rows}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Dock({
  mode,
  open,
  onClose,
  onShowDiff,
}: {
  mode: CompareVariant;
  open: boolean;
  onClose: () => void;
  onShowDiff: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);

  const content = (
    <>
      <div className="cmp-dock__head">
        <strong>Cambios</strong>
        <SceneButton mode={mode} variant="icon" onClick={onClose} aria-label="Cerrar dock">
          <CloseIcon size={12} />
        </SceneButton>
      </div>
      <div className="cmp-dock__files">
        <div>
          <span>src/motion/contract.ts</span>
          <em>+14</em>
        </div>
        <div>
          <span>src/App.tsx</span>
          <em>+3 −1</em>
        </div>
        <div>
          <span>src/App.css</span>
          <em>−2</em>
        </div>
      </div>
      <p className="cmp-muted">El dock se desplaza con transform; el ancho no se anima.</p>
      <div className="p6-dock__actions">
        <SceneButton mode={mode} className="cmp-btn--sm" onClick={onShowDiff}>
          Ver diff
        </SceneButton>
      </div>
    </>
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <>
        <div
          className={`cmp-scrim ${motionSurfaceClass(presence.phase, 'scrim')}`}
          onClick={onClose}
          aria-hidden="true"
        />
        <aside className={`cmp-dock ${motionSurfaceClass(presence.phase, 'panel')}`}>{content}</aside>
      </>
    );
  }

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            className="cmp-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: motionTokens.tweens.overlay }}
            exit={{ opacity: 0, transition: motionTokens.tweens.overlay }}
            onClick={onClose}
            aria-hidden="true"
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {open && (
          <motion.aside
            className="cmp-dock"
            initial={{ x: reduce ? 0 : '100%', opacity: 0 }}
            animate={{
              x: 0,
              opacity: 1,
              transition: reduce ? motionTokens.tweens.fade : motionTokens.tweens.sheet,
            }}
            exit={{
              x: reduce ? 0 : '100%',
              opacity: 0,
              transition: motionTokens.tweens.dismiss,
            }}
          >
            {content}
          </motion.aside>
        )}
      </AnimatePresence>
    </>
  );
}

export function DiffViewer({ mode }: { mode: CompareVariant }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  return (
    <div className="p6-diff">
      <div className="p6-diff__head">
        <span>src/motion/contract.ts</span>
        <span className="p6-diff__stats">
          <em>+4</em>
          <strong>−2</strong>
        </span>
      </div>
      <div className="p6-diff__rows" key={mode}>
        {DIFF_ROWS.map((row, index) =>
          mode === 'animate' ? (
            <motion.div
              key={`${row.no}-${row.type}-${index}`}
              className={`p6-diff__row p6-diff__row--${row.type}`}
              initial={{
                opacity: 0,
                x: reduce ? 0 : -motionTokens.travel(4),
                filter: motionTokens.itemBlur,
              }}
              animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
              transition={{
                ...motionTokens.itemSpring,
                delay: reduce ? 0 : index * motionTokens.stagger,
              }}
            >
              <span className="p6-diff__no">{row.no}</span>
              <span className="p6-diff__sign">
                {row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''}
              </span>
              <span className="p6-diff__code">{row.text || ' '}</span>
            </motion.div>
          ) : (
            <div
              key={`${row.no}-${row.type}-${index}`}
              className={`p6-diff__row p6-diff__row--${row.type} motion-row-in`}
              style={{ animationDelay: `${index * 18}ms` }}
            >
              <span className="p6-diff__no">{row.no}</span>
              <span className="p6-diff__sign">
                {row.type === 'add' ? '+' : row.type === 'del' ? '−' : ''}
              </span>
              <span className="p6-diff__code">{row.text || ' '}</span>
            </div>
          )
        )}
      </div>
    </div>
  );
}

export function TerminalPane({
  mode,
  open,
  lines,
  command,
  onCommand,
  onSubmit,
  onClose,
}: {
  mode: CompareVariant;
  open: boolean;
  lines: TerminalLine[];
  command: string;
  onCommand: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);

  const content = (
    <div className="p6-terminal__inner">
      <div className="p6-terminal__head">
        <span>terminal · zsh</span>
        <SceneButton mode={mode} variant="icon" onClick={onClose} aria-label="Cerrar terminal">
          <CloseIcon size={11} />
        </SceneButton>
      </div>
      <div className="p6-terminal__lines">
        {lines.map((line) => (
          <div key={line.id} className={`p6-terminal__line p6-terminal__line--${line.tone}`}>
            {line.text}
          </div>
        ))}
      </div>
      <form
        className="p6-terminal__form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <span className="p6-terminal__prompt" aria-hidden="true">
          $
        </span>
        <input
          className="p6-terminal__input"
          value={command}
          onChange={(event) => onCommand(event.target.value)}
          placeholder="npm run test"
          aria-label="Comando de terminal"
        />
      </form>
    </div>
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div className={`p6-terminal ${motionSurfaceClass(presence.phase, 'terminal')}`}>
        {content}
      </div>
    );
  }

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          className="p6-terminal"
          initial={{ height: 0, opacity: 0 }}
          animate={{
            height: 'auto',
            opacity: 1,
            transition: reduce ? motionTokens.tweens.fade : motionTokens.tweens.disclosure,
          }}
          exit={{
            height: 0,
            opacity: 0,
            transition: motionTokens.tweens.panelOut,
          }}
          style={{ overflow: 'hidden' }}
        >
          {content}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
