import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { motionSurfaceClass } from '../../../surface';
import { usePresence } from '../../../usePresence';
import { useLabMotion, useLabReduce } from '../../context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from '../../frame';
import { CloseIcon } from '../../ui';

/* -------------------------------------------------------------------------- */
/* 08.01 — Shared element: card → detail                                       */
/* -------------------------------------------------------------------------- */

type ProjectTone = 'blue' | 'green' | 'amber';

interface Project {
  id: string;
  title: string;
  meta: string;
  body: string;
  tone: ProjectTone;
  files: string[];
}

const PROJECTS: Project[] = [
  {
    id: 'transcript',
    title: 'Transcript vivo',
    meta: '3 archivos',
    body: 'El borde vivo decide si el transcript acompaña o espera a que vuelvas.',
    tone: 'blue',
    files: ['chat/transcript.tsx', 'motion/contract.ts', 'usePresence.ts'],
  },
  {
    id: 'kanban',
    title: 'Tablero',
    meta: '12 tareas',
    body: 'Las tarjetas cambian de columna sin perder su identidad ni su lugar.',
    tone: 'green',
    files: ['tasks/board.tsx', 'tasks/card.tsx', 'useDropTarget.ts'],
  },
  {
    id: 'preview',
    title: 'Preview',
    meta: '9 páginas',
    body: 'Cada página compara el mismo estado con dos motores y un solo control.',
    tone: 'amber',
    files: ['animate/frame.tsx', 'animate/tokens.ts', 'pages/registry.ts'],
  },
];

function ProjectDetail({
  mode,
  project,
  onClose,
}: {
  mode: CompareVariant;
  project: Project;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const isAnimate = mode === 'animate';

  return (
    <>
      {isAnimate ? (
        <motion.span
          layoutId={`p8-project-cover-${project.id}`}
          className={`p8-detail__cover p8-card__art--${project.tone}`}
          aria-hidden="true"
          transition={motionTokens.springs.dialog}
        />
      ) : (
        <span
          className={`p8-detail__cover p8-card__art--${project.tone}`}
          aria-hidden="true"
        />
      )}

      <div className="p8-detail__body">
        <div className="p8-detail__head">
          {isAnimate ? (
            <motion.strong
              layoutId={`p8-project-title-${project.id}`}
              className="p8-detail__title"
              transition={motionTokens.springs.dialog}
            >
              {project.title}
            </motion.strong>
          ) : (
            <strong className="p8-detail__title">{project.title}</strong>
          )}
          <span className="cmp-badge">{project.meta}</span>
          <SceneButton
            mode={mode}
            variant="icon"
            className="p8-detail__close"
            onClick={onClose}
            aria-label="Cerrar detalle"
          >
            <CloseIcon size={12} />
          </SceneButton>
        </div>

        {isAnimate ? (
          <motion.div
            className="p8-detail__content"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0, transition: motionTokens.tweens.reveal }}
          >
            <p>{project.body}</p>
            <ul>
              {project.files.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          </motion.div>
        ) : (
          <div className="p8-detail__content">
            <p>{project.body}</p>
            <ul>
              {project.files.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="p8-detail__foot">
          <SceneButton mode={mode} variant="ghost" onClick={onClose}>
            Volver
          </SceneButton>
        </div>
      </div>
    </>
  );
}

function SharedElementPane({
  mode,
  open,
  owner,
  shown,
  onOpen,
  onClose,
}: {
  mode: CompareVariant;
  open: string | null;
  owner: CompareVariant | null;
  shown: Project | null;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open !== null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const lastOpenId = useRef<string | null>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    const becameOpen = open !== null && !wasOpen.current;
    const becameClosed = open === null && wasOpen.current;
    wasOpen.current = open !== null;
    if (owner !== mode) return;
    if (becameOpen) {
      lastOpenId.current = open;
      panelRef.current?.focus();
      return;
    }
    if (becameClosed && lastOpenId.current) {
      const id = lastOpenId.current;
      lastOpenId.current = null;
      triggers.current.get(id)?.focus();
    }
  }, [open, owner, mode]);

  useEffect(() => {
    if (open === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const baseContent = (
    <>
      <span className="p8-kicker">Proyectos</span>
      <div className="p8-cards">
        {PROJECTS.map((project) =>
          mode === 'animate' ? (
            <motion.button
              key={project.id}
              type="button"
              layoutId={`p8-project-${project.id}`}
              className="p8-card"
              ref={(element) => {
                if (element) triggers.current.set(project.id, element);
              }}
              onClick={() => onOpen(project.id)}
              whileTap={
                reduce
                  ? undefined
                  : {
                      scale: motionTokens.scale.choice,
                      transition: motionTokens.springs.press,
                    }
              }
              transition={motionTokens.springs.dialog}
            >
              <motion.span
                layoutId={`p8-project-cover-${project.id}`}
                className={`p8-card__art p8-card__art--${project.tone}`}
                aria-hidden="true"
                transition={motionTokens.springs.dialog}
              />
              <motion.span
                layoutId={`p8-project-title-${project.id}`}
                className="p8-card__title"
                transition={motionTokens.springs.dialog}
              >
                {project.title}
              </motion.span>
              <span className="p8-card__meta">{project.meta}</span>
            </motion.button>
          ) : (
            <button
              key={project.id}
              type="button"
              className="p8-card"
              ref={(element) => {
                if (element) triggers.current.set(project.id, element);
              }}
              onClick={() => onOpen(project.id)}
            >
              <span
                className={`p8-card__art p8-card__art--${project.tone}`}
                aria-hidden="true"
              />
              <span className="p8-card__title">{project.title}</span>
              <span className="p8-card__meta">{project.meta}</span>
            </button>
          )
        )}
      </div>
      <p className="p8-shared__hint">
        {mode === 'animate'
          ? 'Abrí una tarjeta: la superficie viaja y la capa nueva queda arriba.'
          : 'Abrí una tarjeta: un modal fundido, sin elemento compartido.'}
      </p>
    </>
  );

  return (
    <div className="p8-shared">
      {mode === 'animate' ? (
        <motion.div
          className="p8-shared__base"
          animate={{ opacity: open !== null ? 0.3 : 1 }}
          transition={motionTokens.tweens.fade}
          aria-hidden={open !== null ? true : undefined}
        >
          {baseContent}
        </motion.div>
      ) : (
        <div
          className={`p8-shared__base${open !== null ? ' is-veiled' : ''}`}
          aria-hidden={open !== null ? true : undefined}
        >
          {baseContent}
        </div>
      )}

      <div className="p8-shared__layer">
        {mode === 'kite' ? (
          presence.mounted && shown ? (
            <>
              <div
                className={`p8-shared__scrim ${motionSurfaceClass(presence.phase, 'scrim')}`}
                onClick={onClose}
                aria-hidden="true"
              />
              <div
                ref={panelRef}
                tabIndex={-1}
                className={`p8-detail ${motionSurfaceClass(presence.phase, 'modal')}`}
                role="dialog"
                aria-modal="true"
                aria-label={shown.title}
              >
                <ProjectDetail mode={mode} project={shown} onClose={onClose} />
              </div>
            </>
          ) : null
        ) : (
          <AnimatePresence>
            {open !== null && shown && (
              <motion.div
                key="scrim"
                className="p8-shared__scrim"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: motionTokens.tweens.overlay }}
                exit={{ opacity: 0, transition: motionTokens.tweens.overlay }}
                onClick={onClose}
                aria-hidden="true"
              />
            )}
            {open !== null && shown && (
              <motion.div
                key={`panel-${shown.id}`}
                ref={panelRef}
                tabIndex={-1}
                layoutId={`p8-project-${shown.id}`}
                className="p8-detail"
                role="dialog"
                aria-modal="true"
                aria-label={shown.title}
                transition={motionTokens.springs.dialog}
              >
                <ProjectDetail mode={mode} project={shown} onClose={onClose} />
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </div>
    </div>
  );
}

export function SharedElementScene({ view }: { view: CompareView }) {
  const [open, setOpen] = useState<string | null>(null);
  const [lastOpen, setLastOpen] = useState<string | null>(null);
  const [owner, setOwner] = useState<CompareVariant | null>(null);

  useEffect(() => {
    if (open !== null) setLastOpen(open);
  }, [open]);

  const shownId = open ?? lastOpen;
  const shown = PROJECTS.find((project) => project.id === shownId) ?? null;

  return (
    <CompareScene
      index="01"
      title="Elemento compartido"
      target="TaskCard → TaskDetail"
      note="La misma tarjeta se abre en detalle: Animate UI comparte la superficie, la portada y el título con layoutId, y la capa nueva se dibuja por encima de la grilla que se apaga. Kite funde un modal y no comparte nada. Escape o Volver cierran."
      view={view}
    >
      {(mode) => (
        <SharedElementPane
          mode={mode}
          open={open}
          owner={owner}
          shown={shown}
          onOpen={(id) => {
            setOwner(mode);
            setOpen(id);
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </CompareScene>
  );
}
