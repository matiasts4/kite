import { useEffect, useRef, useState } from 'react';
import {
  AnimatePresence,
  motion,
  useMotionValueEvent,
  useScroll,
  useSpring,
} from 'motion/react';
import { isAtLiveEdge, prefersReducedMotion } from '../../../contract';
import { useLabMotion, useLabReduce } from '../../context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from '../../frame';
import { PlusIcon } from '../../ui';

/* -------------------------------------------------------------------------- */
/* 08.04 — Scroll: progress, reveal, edge fade, live edge                      */
/* -------------------------------------------------------------------------- */

interface ScrollLine {
  id: string;
  kind: 'user' | 'assistant' | 'tool';
  text: string;
}

const SCROLL_SEED: ScrollLine[] = [
  { id: 's1', kind: 'user', text: '¿Seguís el borde vivo cuando llega una línea?' },
  {
    id: 's2',
    kind: 'assistant',
    text: 'Solo si ya estabas abajo. Si estás leyendo arriba, te dejo quieto.',
  },
  { id: 's3', kind: 'tool', text: 'Leyó src/motion/contract.ts' },
  { id: 's4', kind: 'assistant', text: 'El umbral es 48 px y el alto nuevo se suma al scroll.' },
  { id: 's5', kind: 'user', text: 'Mostrame el progreso y el degradado del borde.' },
  { id: 's6', kind: 'assistant', text: 'Progreso en la barra, fades arriba y abajo, y las secciones entran al verlas.' },
];

const NEXT_LINES: { kind: ScrollLine['kind']; text: string }[] = [
  { kind: 'assistant', text: 'El borde vivo mide la distancia al final antes de sumar la fila.' },
  { kind: 'tool', text: 'Actualizó el ancla del transcript' },
  { kind: 'user', text: 'Si estoy arriba, avisame con una pastilla.' },
  { kind: 'assistant', text: 'La pastilla aparece solo cuando llegó algo nuevo.' },
];

function ScrollPane({
  mode,
  lines,
  onAdd,
}: {
  mode: CompareVariant;
  lines: ScrollLine[];
  onAdd: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const viewportRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const percentRef = useRef<HTMLSpanElement>(null);
  const atEdgeRef = useRef(true);
  const previousCount = useRef(lines.length);
  const [atEdge, setAtEdge] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});

  const { scrollYProgress } = useScroll({ container: viewportRef });
  const numberSpring = motionTokens.springs.number;
  const progress = useSpring(
    scrollYProgress,
    'stiffness' in numberSpring
      ? { stiffness: numberSpring.stiffness, damping: numberSpring.damping }
      : undefined
  );

  useMotionValueEvent(progress, 'change', (value) => {
    if (mode !== 'animate' || !percentRef.current) return;
    percentRef.current.textContent = `${Math.round(value * 100)}%`;
  });

  const handleScroll = () => {
    const element = viewportRef.current;
    if (!element) return;
    const max = element.scrollHeight - element.clientHeight;
    const value = max > 0 ? element.scrollTop / max : 0;
    if (mode === 'kite' && barRef.current) {
      barRef.current.style.transform = `scaleX(${value})`;
    }
    if (mode === 'kite' && percentRef.current) {
      percentRef.current.textContent = `${Math.round(value * 100)}%`;
    }
    const edge = isAtLiveEdge(element.scrollHeight, element.scrollTop, element.clientHeight);
    atEdgeRef.current = edge;
    setAtEdge((current) => (current === edge ? current : edge));
    if (edge) setUnseen(0);
  };

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const edge = isAtLiveEdge(element.scrollHeight, element.scrollTop, element.clientHeight);
    atEdgeRef.current = edge;
    setAtEdge(edge);
  }, []);

  useEffect(() => {
    const element = viewportRef.current;
    const grew = lines.length > previousCount.current;
    previousCount.current = lines.length;
    if (!element || !grew) return;
    if (atEdgeRef.current) {
      element.scrollTo({
        top: element.scrollHeight,
        behavior: reduce ? 'auto' : 'smooth',
      });
      setUnseen(0);
      return;
    }
    setUnseen((count) => count + 1);
  }, [lines.length, reduce]);

  useEffect(() => {
    if (mode !== 'kite') return;
    const root = viewportRef.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]'));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const key = entry.target.getAttribute('data-reveal');
          if (key) {
            setRevealed((current) =>
              current[key] ? current : { ...current, [key]: true }
            );
          }
          observer.unobserve(entry.target);
        }
      },
      { root, threshold: 0.55 }
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [mode]);

  const jumpToEdge = () => {
    const element = viewportRef.current;
    if (!element) return;
    element.scrollTo({
      top: element.scrollHeight,
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
    setUnseen(0);
  };

  const revealBlock = (key: string, title: string, detail: string) => {
    if (mode === 'animate') {
      return (
        <motion.div
          key={key}
          className="p8-reveal"
          initial={{ opacity: 0, y: reduce ? 0 : 8 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ root: viewportRef, amount: 0.55, once: true }}
          transition={motionTokens.tweens.reveal}
        >
          <strong>{title}</strong>
          <span>{detail}</span>
        </motion.div>
      );
    }
    return (
      <div
        key={key}
        className={`p8-reveal${revealed[key] ? ' is-in' : ''}`}
        data-reveal={key}
      >
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
    );
  };

  return (
    <div className="p8-scroll-scene">
      <div className="p8-scroll__head">
        <span className="p8-kicker">Transcript</span>
        <div className="p8-scroll__track" aria-hidden="true">
          {mode === 'animate' ? (
            <motion.div
              className="p8-scroll__bar"
              style={{ scaleX: reduce ? scrollYProgress : progress }}
            />
          ) : (
            <div ref={barRef} className="p8-scroll__bar p8-scroll__bar--kite" />
          )}
        </div>
        <span ref={percentRef} className="p8-scroll__pct">
          0%
        </span>
      </div>

      <div className="p8-scroll__wrap">
        <div className="p8-scroll__frame">
          <motion.div
            ref={viewportRef}
            className="p8-scroll__viewport"
            layoutScroll={mode === 'animate'}
            onScroll={handleScroll}
            tabIndex={0}
            aria-label="Transcript con borde vivo"
          >
            <div className="p8-scroll__inner">
              {revealBlock('first', 'Primer hito', 'El transcript abre en la última sesión.')}
              {revealBlock('second', 'Segundo hito', 'Los bloques entran cuando asoman al viewport.')}

              <div className="p8-transcript">
                <AnimatePresence initial={false}>
                  {lines.map((line, index) =>
                    mode === 'animate' ? (
                      <motion.div
                        key={line.id}
                        layout="position"
                        className={`p8-line p8-line--${line.kind}`}
                        initial={{ opacity: 0, y: 6, filter: reduce ? 'blur(0px)' : motionTokens.itemBlur }}
                        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                        transition={motionTokens.springs.pop}
                      >
                        {line.text}
                      </motion.div>
                    ) : (
                      <div
                        key={line.id}
                        className={`p8-line p8-line--${line.kind}${
                          index === lines.length - 1 ? ' motion-row-in' : ''
                        }`}
                      >
                        {line.text}
                      </div>
                    )
                  )}
                </AnimatePresence>
                <div className="p8-live" aria-hidden="true">
                  <span className="p8-live__dot" />
                  borde vivo
                </div>
              </div>
            </div>
          </motion.div>
        </div>

        {unseen > 0 && (
          <SceneButton
            mode={mode}
            variant="ghost"
            className="p8-jump"
            onClick={jumpToEdge}
            aria-label={`Ir al borde vivo, ${unseen} líneas nuevas`}
          >
            ↓ {unseen} nueva{unseen === 1 ? '' : 's'}
          </SceneButton>
        )}
      </div>

      <div className="p8-scroll__foot">
        <SceneButton mode={mode} variant="ghost" className="cmp-btn--sm" onClick={onAdd}>
          <PlusIcon size={11} />
          Agregar línea
        </SceneButton>
        <span className={`p8-scroll__state${atEdge ? ' is-live' : ''}`}>
          {atEdge ? 'En el borde' : 'Lectura pausada'}
        </span>
        <SceneButton
          mode={mode}
          variant="ghost"
          className="cmp-btn--sm"
          onClick={jumpToEdge}
          disabled={atEdge}
        >
          Ir al borde
        </SceneButton>
        <span className="p8-chip-static" aria-live="polite">
          {reduce ? 'reduced · salto' : 'motion · smooth'}
        </span>
      </div>
    </div>
  );
}

export function ScrollScene({ view }: { view: CompareView }) {
  const [lines, setLines] = useState<ScrollLine[]>(SCROLL_SEED);
  const sequence = useRef(0);

  const addLine = () => {
    sequence.current += 1;
    const template = NEXT_LINES[(sequence.current - 1) % NEXT_LINES.length];
    setLines((current) => [
      ...current,
      { id: `n${sequence.current}`, kind: template.kind, text: template.text },
    ]);
  };

  return (
    <CompareScene
      index="04"
      title="Scroll"
      target="Transcript · live edge"
      note="Progreso, revelado por intersección, degradado de borde y un transcript que sigue el borde vivo solo si ya estabas abajo. Agregá una línea desde arriba: aparece la pastilla en vez del salto. Con reduced motion el scroll salta y el movimiento se apaga: Animate UI conserva los fades y Kite aparece sin animación."
      view={view}
    >
      {(mode) => (
        <ScrollPane mode={mode} lines={lines} onAdd={addLine} />
      )}
    </CompareScene>
  );
}
