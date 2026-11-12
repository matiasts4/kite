import { useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { LabMotionContext, useLabMotion, useLabReduce } from '../../context';
import { createLabTokens, type LabLevel } from '../../tokens';
import { formatSpring } from './shared';

const LEVELS: LabLevel[] = ['subtle', 'more', 'expressive'];

const LEVEL_META: Record<LabLevel, { label: string; hint: string }> = {
  subtle: { label: 'Subtle', hint: 'el token tal cual' },
  more: { label: 'More', hint: '×1.5 y blur.surface' },
  expressive: { label: 'Expressive', hint: '×2.4, bounce y stagger' },
};

const ACTIVITY_LABELS = [
  'Cuota actualizada',
  'Hilo archivado',
  'Modelo cambiado',
  'Sync completado',
  'Token rotado',
  'Agente conectado',
];

interface ActivityItem {
  id: number;
  order: number;
  label: string;
}

interface LevelCardProps {
  level: LabLevel;
  tempo: number;
  items: ActivityItem[];
  onAdd: (count: number) => void;
  onClear: () => void;
}

function LevelCard({ level, tempo, items, onAdd, onClear }: LevelCardProps) {
  const tokens = useMemo(() => createLabTokens(level, tempo), [level, tempo]);

  return (
    <LabMotionContext.Provider value={tokens}>
      <LevelDemo items={items} onAdd={onAdd} onClear={onClear} />
    </LabMotionContext.Provider>
  );
}

function LevelDemo({
  items,
  onAdd,
  onClear,
}: {
  items: ActivityItem[];
  onAdd: (count: number) => void;
  onClear: () => void;
}) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const meta = LEVEL_META[tokens.level];

  return (
    <article className={`p9-level p9-level--${tokens.level}`}>
      <header className="p9-level__head">
        <span className={`p9-level__dot p9-level__dot--${tokens.level}`} aria-hidden="true" />
        <div>
          <strong>{meta.label}</strong>
          <span>{meta.hint}</span>
        </div>
        <span className="cmp-badge">{items.length}</span>
      </header>

      <div className="p9-level__stage">
        {items.length === 0 ? (
          <p className="p9-level__empty">Sin actividad. Agrega uno o tres eventos.</p>
        ) : (
          <div className="p9-activity-list">
            <AnimatePresence initial={false}>
              {items.map((item) => (
                <motion.div
                  key={item.id}
                  layout="position"
                  className="p9-activity"
                  transition={tokens.itemSpring}
                  initial={{
                    opacity: 0,
                    transform: reduce ? 'none' : `translateY(${tokens.travel(8)}px)`,
                    filter: tokens.itemBlur,
                  }}
                  animate={{
                    opacity: 1,
                    transform: 'none',
                    filter: 'blur(0px)',
                    transition: {
                      ...tokens.itemSpring,
                      delay: reduce ? 0 : item.order * tokens.stagger,
                    },
                  }}
                  exit={{
                    opacity: 0,
                    transform: reduce ? 'none' : `translateY(${-tokens.travel(4)}px)`,
                    filter: tokens.itemBlur,
                    transition: tokens.tweens.fade,
                  }}
                >
                  <span className="p9-activity__dot" aria-hidden="true" />
                  <span className="p9-activity__text">{item.label}</span>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>

      <div className="p9-level__actions">
        <motion.button
          type="button"
          className="cmp-btn cmp-btn--primary cmp-btn--sm"
          whileTap={reduce ? undefined : { transform: `scale(${tokens.scale.press})` }}
          transition={tokens.springs.press}
          onClick={() => onAdd(1)}
        >
          Agregar
        </motion.button>
        <button
          type="button"
          className="cmp-btn cmp-btn--sm"
          onClick={() => onAdd(3)}
        >
          Agregar 3
        </button>
        <button type="button" className="cmp-btn cmp-btn--ghost cmp-btn--sm" onClick={onClear}>
          Limpiar
        </button>
      </div>

      <footer className="p9-level__values">
        <span>press spring.press</span>
        <span>travel ×{tokens.travel(1)}</span>
        <span>item blur {tokens.itemBlur}</span>
        <span>stagger {Math.round(tokens.stagger * 1000)} ms</span>
        <span>reflow {formatSpring(tokens.itemSpring)}</span>
        <span>disclosure {Math.round(tokens.tweens.disclosure.duration * 1000)} ms</span>
      </footer>
    </article>
  );
}

export function LevelMatrix() {
  const global = useLabMotion();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const idRef = useRef(1);

  const add = (count: number) => {
    const additions: ActivityItem[] = Array.from({ length: count }, (_, order) => {
      const id = idRef.current;
      idRef.current += 1;
      return {
        id,
        order,
        label: ACTIVITY_LABELS[id % ACTIVITY_LABELS.length],
      };
    });
    setItems((previous) => [...previous, ...additions].slice(-6));
  };

  const clear = () => setItems([]);

  const values = useMemo(
    () =>
      LEVELS.map((level) => {
        const tokens = createLabTokens(level, global.tempo);
        return {
          level,
          travel: tokens.travel(8).toFixed(1),
          blur: tokens.itemBlur,
          stagger: Math.round(tokens.stagger * 1000),
        };
      }),
    [global.tempo]
  );

  const press = global.springs.press;

  return (
    <section className="cmp-scene" data-page="09">
      <header className="cmp-scene__head">
        <span className="cmp-scene__index">09.2</span>
        <div className="cmp-scene__copy">
          <h2>Niveles y tempo</h2>
          <p>
            El mismo componente, con el mismo estado, en los tres niveles a la vez. El nivel no
            se aplica a un demo suelto: cambia lo que recorre y cómo se asienta lo que entra.
          </p>
        </div>
        <span className="cmp-scene__target">subtle · more · expressive</span>
      </header>

      <p className="p9-lede">
        Los tres se calculan con <code>createLabTokens(level, tempo)</code> y el tempo actual{' '}
        <strong>×{global.tempo.toFixed(2)}</strong>. Tu nivel global es{' '}
        <strong>{global.level}</strong>; esta matriz lo ignora a propósito para mostrar los tres
        juntos. <code>spring.press</code> ahora es <strong>{formatSpring(press)}</strong>: el tempo
        cambia la rigidez y amortiguación, no la escala.
      </p>

      <div className="p9-matrix">
        {LEVELS.map((level) => (
          <LevelCard
            key={level}
            level={level}
            tempo={global.tempo}
            items={items}
            onAdd={add}
            onClear={clear}
          />
        ))}
      </div>

      <div className="p9-levels-notes">
        <div className="p9-note">
          <h3>Cambia con el nivel</h3>
          <ul>
            <li>
              <strong>Recorrido.</strong> Cada 8 px de base se convierten en{' '}
              {values.map((item) => item.travel).join(' / ')} px.
            </li>
            <li>
              <strong>Blur de entrada.</strong> {values.map((item) => item.blur).join(' / ')}.
            </li>
            <li>
              <strong>Stagger.</strong> {values.map((item) => `${item.stagger} ms`).join(' / ')}.
            </li>
            <li>
              <strong>Spring de reflow.</strong> Reflow en subtle y more; en expressive pasa a
              bounce.
            </li>
          </ul>
        </div>
        <div className="p9-note p9-note--same">
          <h3>No cambia</h3>
          <ul>
            <li>
              <strong>Press.</strong> <code>scale.press</code> 0.97 y <code>spring.press</code> en
              los tres; el nivel no lo toca.
            </li>
            <li>
              <strong>Tweens y curvas.</strong> Mismos tokens y mismas curvas; el tempo multiplica
              su duración.
            </li>
            <li>
              <strong>Escalas, blur y shifts.</strong> Son constantes: el nivel solo deriva{' '}
              <code>travel</code> y elige el spring de reflow.
            </li>
            <li>
              <strong>Reduced motion.</strong> Es ortogonal: apaga los transforms en los tres
              niveles, no solo en expressive.
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
