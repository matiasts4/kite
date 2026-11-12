import { Fragment, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from '../../frame';
import { ArrowRightIcon, CheckIcon, PlusIcon, SwapLabel } from '../../ui';

/* -------------------------------------------------------------------------- */
/* Model                                                                      */
/* -------------------------------------------------------------------------- */

type ChoiceId = 'new' | 'folder';
type IntroStatus = 'running' | 'done' | 'skipped';

const STEPS = [
  { kicker: 'Paso 1 · Bienvenida' },
  { kicker: 'Paso 2 · Arranque' },
  { kicker: 'Paso 3 · Listo' },
];

const BULLETS = [
  'El contexto del repo queda en el workspace, no en tu cabeza.',
  'Cada hilo guarda su borde vivo y retoma donde lo dejaste.',
  'Los permisos de escritura se piden una vez y quedan a la vista.',
];

const CHOICES: { id: ChoiceId; title: string; detail: string }[] = [
  { id: 'new', title: 'Proyecto nuevo', detail: 'Kite crea el workspace y el primer hilo.' },
  { id: 'folder', title: 'Abrir una carpeta', detail: 'Traé un repo existente y su historial.' },
];

function FolderIcon() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

function useIntroDemo() {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [choice, setChoice] = useState<ChoiceId>('new');
  const [status, setStatus] = useState<IntroStatus>('running');

  const next = () => {
    if (step < STEPS.length - 1) {
      setDirection(1);
      setStep(step + 1);
      return;
    }
    setStatus('done');
  };

  const back = () => {
    if (step === 0) return;
    setDirection(-1);
    setStep(step - 1);
  };

  const skip = () => setStatus('skipped');

  const restart = () => {
    setStatus('running');
    setStep(0);
    setDirection(1);
    setChoice('new');
  };

  return { step, direction, choice, setChoice, status, next, back, skip, restart };
}

type IntroDemo = ReturnType<typeof useIntroDemo>;

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

function IntroTitle({ mode, text }: { mode: CompareVariant; text: string }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  if (mode === 'kite') {
    return <h3 className="p7-intro__title">{text}</h3>;
  }

  const words = text.split(' ');
  return (
    <h3 className="p7-intro__title">
      {words.map((word, index) => (
        <Fragment key={`${word}-${index}`}>
          <motion.span
            className="p7-word"
            initial={{
              opacity: 0,
              y: reduce ? 0 : motionTokens.travel(6),
              filter: motionTokens.itemBlur,
            }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{
              ...motionTokens.itemSpring,
              delay: index * motionTokens.stagger,
            }}
          >
            {word}
          </motion.span>
          {index < words.length - 1 ? ' ' : null}
        </Fragment>
      ))}
    </h3>
  );
}

function SuccessMark({ mode }: { mode: CompareVariant }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  if (mode === 'kite') {
    return (
      <span className="p7-success">
        <svg
          className="p7-success__svg p7-success__svg--kite"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </span>
    );
  }

  return (
    <motion.span
      className="p7-success"
      initial={{
        opacity: 0,
        scale: reduce ? 1 : motionTokens.scale.popover,
        filter: motionTokens.surfaceBlur,
      }}
      animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
      transition={motionTokens.springs.pop}
    >
      <svg
        className="p7-success__svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <motion.polyline
          points="20 6 9 17 4 12"
          initial={{ pathLength: 0, opacity: 0 }}
          animate={{ pathLength: 1, opacity: 1 }}
          transition={reduce ? { duration: 0 } : motionTokens.tweens.reveal}
        />
      </svg>
    </motion.span>
  );
}

function ChoiceCard({
  mode,
  title,
  detail,
  icon,
  active,
  onSelect,
  buttonRef,
}: {
  mode: CompareVariant;
  title: string;
  detail: string;
  icon: ReactNode;
  active: boolean;
  onSelect: () => void;
  buttonRef: (element: HTMLButtonElement | null) => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  const content = (
    <>
      {mode === 'animate' && active ? (
        <motion.span
          layoutId="p7-intro-choice-ring"
          className="p7-choice__ring"
          initial={false}
          transition={motionTokens.springs.selection}
          aria-hidden="true"
        />
      ) : null}
      <span className="p7-choice__icon" aria-hidden="true">
        {icon}
      </span>
      <span className="p7-choice__copy">
        <strong>{title}</strong>
        <span>{detail}</span>
      </span>
    </>
  );

  if (mode === 'animate') {
    return (
      <motion.button
        ref={buttonRef}
        type="button"
        role="radio"
        aria-checked={active}
        className={`p7-choice p7-choice--${mode}${active ? ' is-active' : ''}`}
        onClick={onSelect}
        initial={{ transform: 'scale(1)' }}
        whileTap={{ transform: `scale(${reduce ? 1 : motionTokens.scale.choice})` }}
        transition={motionTokens.springs.press}
      >
        {content}
      </motion.button>
    );
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      role="radio"
      aria-checked={active}
      className={`p7-choice p7-choice--${mode}${active ? ' is-active' : ''}`}
      onClick={onSelect}
    >
      {content}
    </button>
  );
}

function StepContent({ mode, demo }: { mode: CompareVariant; demo: IntroDemo }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const choiceRefs = useRef<Record<ChoiceId, HTMLButtonElement | null>>({
    new: null,
    folder: null,
  });
  const selected = CHOICES.find((item) => item.id === demo.choice) ?? CHOICES[0];

  const onChoiceKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== 'ArrowRight' &&
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowLeft' &&
      event.key !== 'ArrowUp'
    ) {
      return;
    }
    event.preventDefault();
    const current = CHOICES.findIndex((item) => item.id === demo.choice);
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const next = CHOICES[(current + delta + CHOICES.length) % CHOICES.length];
    demo.setChoice(next.id);
    choiceRefs.current[next.id]?.focus();
  };

  if (demo.step === 0) {
    return (
      <div className="p7-intro__step">
        <span className="p7-intro__kicker">{STEPS[0].kicker}</span>
        <IntroTitle mode={mode} text="Tu workspace, con memoria" />
        <p className="p7-intro__lead">
          Kite reúne el repo, los hilos y las decisiones en un solo lugar. Esta intro tarda tres
          pasos.
        </p>
        <ul className="p7-intro__bullets">
          {BULLETS.map((item, index) =>
            mode === 'animate' ? (
              <motion.li
                key={item}
                initial={{
                  opacity: 0,
                  y: reduce ? 0 : motionTokens.travel(5),
                  filter: motionTokens.itemBlur,
                }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                transition={{
                  ...motionTokens.itemSpring,
                  delay: index * motionTokens.stagger,
                }}
              >
                <CheckIcon size={12} />
                <span>{item}</span>
              </motion.li>
            ) : (
              <li key={item}>
                <CheckIcon size={12} />
                <span>{item}</span>
              </li>
            )
          )}
        </ul>
      </div>
    );
  }

  if (demo.step === 1) {
    return (
      <div className="p7-intro__step">
        <span className="p7-intro__kicker">{STEPS[1].kicker}</span>
        <IntroTitle mode={mode} text="Elegí cómo empezar" />
        <p className="p7-intro__lead">
          Podés cambiarlo después. Lo elegido define qué abre Kite en la primera sesión.
        </p>
        <div
          className="p7-choices"
          role="radiogroup"
          aria-label="Modo de arranque"
          onKeyDown={onChoiceKeyDown}
        >
          {CHOICES.map((choice) => (
            <ChoiceCard
              key={choice.id}
              mode={mode}
              title={choice.title}
              detail={choice.detail}
              icon={choice.id === 'new' ? <PlusIcon size={14} /> : <FolderIcon />}
              active={demo.choice === choice.id}
              onSelect={() => demo.setChoice(choice.id)}
              buttonRef={(element) => {
                choiceRefs.current[choice.id] = element;
              }}
            />
          ))}
        </div>
        <p className="p7-intro__echo">
          Vas a empezar con{' '}
          {mode === 'animate' ? (
            <SwapLabel
              value={selected.title}
              labels={CHOICES.map((item) => item.title)}
              className="p7-intro__echo-value"
            />
          ) : (
            <strong>{selected.title}</strong>
          )}
          .
        </p>
      </div>
    );
  }

  return (
    <div className="p7-intro__step p7-intro__step--success">
      <span className="p7-intro__kicker">{STEPS[2].kicker}</span>
      <SuccessMark mode={mode} />
      <IntroTitle mode={mode} text="Todo listo para trabajar" />
      <p className="p7-intro__lead">
        Elegiste <strong>{selected.title}</strong>. Kite va a preparar el workspace, los permisos
        y el primer hilo.
      </p>
      <div className="p7-intro__summary">
        <span className="cmp-badge">workspace</span>
        <span className="cmp-badge">{selected.title}</span>
        <span className="cmp-badge">1 hilo</span>
      </div>
    </div>
  );
}

function Completion({ mode, demo }: { mode: CompareVariant; demo: IntroDemo }) {
  const done = demo.status === 'done';

  return (
    <div className="p7-intro__step p7-intro__step--done">
      {done ? (
        <SuccessMark mode={mode} />
      ) : (
        <span className="p7-intro__skip-mark" aria-hidden="true">
          <ArrowRightIcon size={18} />
        </span>
      )}
      <span className="p7-intro__kicker">{done ? 'Intro completada' : 'Intro omitida'}</span>
      <h3 className="p7-intro__title">
        {done ? 'Workspace listo' : 'La intro queda para después'}
      </h3>
      <p className="p7-intro__lead">
        {done
          ? 'El workspace ya tiene su primer hilo y los permisos base. Podés repetir la intro sin perder nada.'
          : 'Podés verla de nuevo desde los ajustes del workspace o reiniciarla acá mismo.'}
      </p>
      <SceneButton mode={mode} variant="primary" className="cmp-btn--sm" onClick={demo.restart}>
        Repetir intro
      </SceneButton>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pane                                                                       */
/* -------------------------------------------------------------------------- */

function OnboardingPane({ mode, demo }: { mode: CompareVariant; demo: IntroDemo }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const running = demo.status === 'running';
  const progress = running ? (demo.step + 1) / STEPS.length : 1;

  const variants = {
    enter: (dir: number) => ({
      opacity: 0,
      x: reduce ? 0 : dir * motionTokens.shift.step,
      filter: motionTokens.blur.panel,
    }),
    center: {
      opacity: 1,
      x: 0,
      filter: 'blur(0px)',
      transition: motionTokens.tweens.panelIn,
    },
    exit: (dir: number) => ({
      opacity: 0,
      x: reduce ? 0 : -dir * motionTokens.shift.step,
      filter: motionTokens.blur.panel,
      transition: motionTokens.tweens.panelOut,
    }),
  };

  return (
    <div className="p7-intro">
      <header className="cmp-card__head">
        <div>
          <strong>Intro del workspace</strong>
          <span>primera sesión · mismo paso en las dos columnas</span>
        </div>
        <span className="cmp-badge">{running ? 'intro' : 'listo'}</span>
      </header>

      <div className="p7-intro__progress">
        <div
          className="p7-progress"
          role="progressbar"
          aria-label="Progreso de la intro"
          aria-valuemin={1}
          aria-valuemax={STEPS.length}
          aria-valuenow={running ? demo.step + 1 : STEPS.length}
        >
          {mode === 'animate' && !reduce ? (
            <motion.span
              className="p7-progress__fill"
              initial={false}
              animate={{ scaleX: progress }}
              transition={motionTokens.springs.number}
              style={{ transformOrigin: 'left center' }}
            />
          ) : (
            <span className="p7-progress__fill" style={{ width: `${progress * 100}%` }} />
          )}
        </div>
        <span className="p7-intro__count" aria-live="polite">
          {running ? `Paso ${demo.step + 1} de ${STEPS.length}` : 'Completa'}
        </span>
      </div>

      <div className="p7-intro__stage">
        {mode === 'animate' ? (
          <AnimatePresence mode="wait" initial={false} custom={demo.direction}>
            {running ? (
              <motion.div
                key={`step-${demo.step}`}
                custom={demo.direction}
                variants={variants}
                initial="enter"
                animate="center"
                exit="exit"
                className="p7-intro__step-wrap"
              >
                <StepContent mode={mode} demo={demo} />
              </motion.div>
            ) : (
              <motion.div
                key="complete"
                initial={{ opacity: 0, filter: motionTokens.surfaceBlur }}
                animate={{
                  opacity: 1,
                  filter: 'blur(0px)',
                  transition: motionTokens.tweens.reveal,
                }}
                exit={{
                  opacity: 0,
                  filter: motionTokens.surfaceBlur,
                  transition: motionTokens.tweens.dismiss,
                }}
                className="p7-intro__step-wrap"
              >
                <Completion mode={mode} demo={demo} />
              </motion.div>
            )}
          </AnimatePresence>
        ) : (
          <div
            key={running ? `step-${demo.step}` : 'complete'}
            className="p7-intro__step-wrap motion-row-in"
          >
            {running ? <StepContent mode={mode} demo={demo} /> : <Completion mode={mode} demo={demo} />}
          </div>
        )}
      </div>

      <footer className="p7-intro__foot">
        {running ? (
          <>
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={demo.skip}
            >
              Saltar intro
            </SceneButton>
            <div className="p7-intro__actions">
              <SceneButton
                mode={mode}
                variant="ghost"
                className="cmp-btn--sm"
                onClick={demo.back}
                disabled={demo.step === 0}
              >
                Atrás
              </SceneButton>
              <SceneButton
                mode={mode}
                variant="primary"
                className="cmp-btn--sm"
                onClick={demo.next}
              >
                {demo.step === STEPS.length - 1 ? 'Empezar' : 'Siguiente'}
              </SceneButton>
            </div>
          </>
        ) : (
          <span className="p7-intro__foot-note">
            {demo.status === 'skipped' ? 'Omitiste la intro.' : 'Intro completada.'}
          </span>
        )}
      </footer>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Scene                                                                      */
/* -------------------------------------------------------------------------- */

export function OnboardingScene({ view }: { view: CompareView }) {
  const demo = useIntroDemo();

  return (
    <CompareScene
      index="06"
      title="Intro de onboarding"
      target="WorkspaceIntro · FormSteps"
      note="Los pasos comparten dirección y elección. Kite funde cada paso en 180 ms; Animate UI lo desliza desde el lado del avance, entra el título palabra por palabra y dibuja el check con blur."
      view={view}
    >
      {(mode) => <OnboardingPane mode={mode} demo={demo} />}
    </CompareScene>
  );
}
