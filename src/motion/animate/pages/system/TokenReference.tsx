import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import type { Bezier, LabTokens } from '../../tokens';
import { SceneButton } from '../../frame';
import { ChevronDownIcon, SwapLabel } from '../../ui';
import { curvePath, formatSpring, formatTween, maxBlurPx } from './shared';

const SPRINGS: Array<[keyof LabTokens['springs'], string, string]> = [
  ['press', 'spring.press', 'Press de cualquier control; también el switch.'],
  ['pop', 'spring.pop', 'Tooltips, popovers y toasts anclados.'],
  ['dialog', 'spring.dialog', 'Diálogos y alertas.'],
  ['toast', 'spring.toast', 'Toasts que entran desde un borde.'],
  ['selection', 'spring.selection', 'Indicador que se mueve entre pestañas.'],
  ['highlight', 'spring.highlight', 'Superficie que sigue al puntero.'],
  ['reflow', 'spring.reflow', 'Ítems que abren lugar; en expressive usa bounce.'],
  ['thumb', 'spring.thumb', 'Pulgar y estiramiento del switch.'],
  ['number', 'spring.number', 'Números y barras que ruedan a su valor.'],
  ['bounce', 'spring.bounce', 'Marcas que popean: radios, checks y llegadas agrupadas.'],
];

const USED_SPRINGS = new Set<keyof LabTokens['springs']>([
  'press',
  'pop',
  'selection',
  'thumb',
  'number',
  'reflow',
]);

const TWEENS: Array<[keyof LabTokens['tweens'], string, string]> = [
  ['menu', 'transition.menu', 'Menús, selects y comboboxes.'],
  ['overlay', 'transition.overlay', 'Scrim y fondo de un overlay.'],
  ['dialogFade', 'transition.dialogFade', 'Contenido del diálogo antes del tilt.'],
  ['fade', 'transition.fade', 'Contenido que aparece en su lugar.'],
  ['color', 'transition.color', 'Highlight y cambios de color.'],
  ['reveal', 'transition.reveal', 'Etiqueta que aparece tras el movimiento.'],
  ['disclosure', 'transition.disclosure', 'Acordeones y paneles que se despliegan.'],
  ['panelOut', 'transition.panelOut', 'Panel de pestaña saliendo.'],
  ['panelIn', 'transition.panelIn', 'Panel de pestaña entrando.'],
  ['swap', 'transition.swap', 'Dos iconos o etiquetas que se cambian.'],
  ['spin', 'transition.spin', 'Dos iconos que se cambian girando.'],
  ['dismiss', 'transition.dismiss', 'Superficie descartada: más rápida al salir.'],
  ['sheet', 'transition.sheet', 'Sheet que entra desde su borde.'],
  ['shake', 'transition.shake', 'Marca que sacude un error.'],
  ['instant', 'transition.instant', 'Sin animación deliberada (reduced).'],
];

const USED_TWEENS = new Set<keyof LabTokens['tweens']>([
  'menu',
  'fade',
  'disclosure',
  'panelIn',
  'panelOut',
  'swap',
  'dismiss',
]);

const CURVES: Array<{ name: string; value: Bezier; use: string }> = [
  { name: 'ease.out', value: [0.23, 1, 0.32, 1], use: 'Entra o sale.' },
  { name: 'ease.soft', value: [0.215, 0.61, 0.355, 1], use: 'Se despliega o atenúa.' },
  { name: 'ease.leave', value: [0, 0, 0.58, 1], use: 'Sale para dejar lugar.' },
  { name: 'ease.enter', value: [0.25, 0.1, 0.35, 1], use: 'Entra donde otro salió.' },
  { name: 'ease.away', value: [0.33, 0.17, 0.67, 0.5], use: 'Se descarta, acelera.' },
  { name: 'ease.color', value: [0.25, 0.1, 0.25, 1], use: 'Color y highlight.' },
  { name: 'ease.inOut', value: [0.77, 0, 0.175, 1], use: 'Se mueve en pantalla o sacude.' },
];

function TokenChip({ name, value, used = false }: { name: string; value: string; used?: boolean }) {
  return (
    <span className={`p9-token-chip${used ? ' is-used' : ''}`}>
      <code>{name}</code>
      <span>{value}</span>
    </span>
  );
}

function DemoCard({
  title,
  tokens,
  children,
}: {
  title: string;
  tokens: string;
  children: ReactNode;
}) {
  return (
    <article className="p9-demo">
      <header className="p9-demo__head">
        <strong>{title}</strong>
        <span className="p9-demo__tokens">{tokens}</span>
      </header>
      {children}
    </article>
  );
}

function PressDemo() {
  const tokens = useLabMotion();
  const reduce = useLabReduce();

  return (
    <div className="p9-demo__stage p9-demo__stage--center">
      <motion.button
        type="button"
        className="cmp-btn cmp-btn--primary"
        whileTap={reduce ? undefined : { transform: `scale(${tokens.scale.press})` }}
        transition={tokens.springs.press}
      >
        Mantén presionado
      </motion.button>
      <span className="p9-demo__hint">El color no se anima; la escala sí.</span>
    </div>
  );
}

function PopDemo() {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const [open, setOpen] = useState(false);

  return (
    <div className="p9-demo__stage p9-demo__stage--pop">
      <div className="cmp-anchor p9-pop-anchor">
        <SceneButton
          mode="animate"
          variant="ghost"
          className="cmp-chip"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          Cuota
          <ChevronDownIcon size={11} />
        </SceneButton>
        <AnimatePresence>
          {open && (
            <motion.div
              className="cmp-popover p9-pop"
              initial={{
                opacity: 0,
                scale: reduce ? 1 : tokens.scale.popover,
                y: reduce ? 0 : -tokens.travel(4),
                filter: tokens.surfaceBlur,
              }}
              animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
              exit={{
                opacity: 0,
                scale: reduce ? 1 : tokens.scale.popover,
                y: reduce ? 0 : -tokens.travel(4),
                filter: tokens.surfaceBlur,
                transition: tokens.tweens.dismiss,
              }}
              transition={tokens.springs.pop}
              style={{ transformOrigin: 'top right' }}
            >
              <strong className="p9-pop__title">72% restante</strong>
              <p>La superficie crece desde el trigger.</p>
              <div className="cmp-meter cmp-meter--sm">
                <div className="cmp-meter__fill" style={{ width: '72%' }} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function DisclosureDemo() {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const [open, setOpen] = useState(true);

  return (
    <div className="p9-demo__stage">
      <div className="p9-disclosure">
        <button
          type="button"
          className="p9-disclosure__trigger"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span>Detalle del token</span>
          <ChevronDownIcon
            size={12}
            className={`cmp-accordion__chevron${open ? ' is-open' : ''}`}
          />
        </button>
        <motion.div
          className="p9-disclosure__body"
          initial={false}
          animate={{
            height: open ? 'auto' : 0,
            opacity: open ? 1 : 0,
            filter: open ? 'blur(0px)' : tokens.blur.disclosure,
          }}
          transition={
            reduce
              ? {
                  height: { duration: 0 },
                  opacity: tokens.tweens.fade,
                  filter: tokens.tweens.fade,
                }
              : {
                  height: tokens.tweens.disclosure,
                  opacity: tokens.tweens.disclosure,
                  filter: tokens.tweens.disclosure,
                }
          }
          style={{ overflow: 'hidden' }}
        >
          <p>
            Solo <code>height</code> cambia porque el contenido empuja lo que sigue. El resto
            de la página no anima layout.
          </p>
        </motion.div>
      </div>
      <span className="p9-demo__hint">Altura: la excepción permitida.</span>
    </div>
  );
}

function SwapDemo() {
  const [copied, setCopied] = useState(false);

  return (
    <div className="p9-demo__stage p9-demo__stage--center">
      <button
        type="button"
        className="cmp-btn"
        aria-label={copied ? 'Copiado' : 'Copiar'}
        onClick={() => setCopied((value) => !value)}
      >
        <SwapLabel value={copied ? 'Copiado' : 'Copiar'} labels={['Copiar', 'Copiado']} />
      </button>
      <span className="p9-demo__hint">El foco se queda en el botón.</span>
    </div>
  );
}

function StaggerDemo() {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const [round, setRound] = useState(0);

  return (
    <div className="p9-demo__stage">
      <div className="p9-stagger" key={round}>
        {[0, 1, 2].map((index) => (
          <motion.span
            key={index}
            className="p9-stagger__chip"
            initial={{
              opacity: 0,
              transform: reduce ? 'none' : `translateY(${tokens.travel(6)}px)`,
            }}
            animate={{ opacity: 1, transform: 'none' }}
            transition={{ ...tokens.itemSpring, delay: reduce ? 0 : index * tokens.stagger }}
          >
            {index + 1}
          </motion.span>
        ))}
      </div>
      <button type="button" className="cmp-btn cmp-btn--sm" onClick={() => setRound((value) => value + 1)}>
        Repetir
      </button>
    </div>
  );
}

export function TokenReference() {
  const tokens = useLabMotion();
  const travelUnit = tokens.travel(1);
  const maxBlur = maxBlurPx(tokens.blur);

  return (
    <section className="cmp-scene" data-page="09">
      <header className="cmp-scene__head">
        <span className="cmp-scene__index">09.1</span>
        <div className="cmp-scene__copy">
          <h2>Tokens en vivo</h2>
          <p>
            Todo lo que se mueve sale de aquí. Mueve Nivel o Tempo en la barra superior: los
            springs, tweens y el stagger cambian; curvas, escalas, blur y shifts son fijos.
          </p>
        </div>
        <span className="cmp-scene__target">useLabMotion()</span>
      </header>

      <div className="p9-live">
        <span className="p9-live__item">
          <small>Nivel</small>
          <strong>{tokens.level}</strong>
        </span>
        <span className="p9-live__item">
          <small>Tempo</small>
          <strong>×{tokens.tempo.toFixed(2)}</strong>
        </span>
        <span className="p9-live__item">
          <small>travel(1)</small>
          <strong>×{travelUnit}</strong>
        </span>
        <span className="p9-live__item">
          <small>Stagger</small>
          <strong>{Math.round(tokens.stagger * 1000)} ms</strong>
        </span>
        <span className="p9-live__item">
          <small>Blur máximo</small>
          <strong>{maxBlur} px</strong>
        </span>
        <code>useLabMotion()</code>
      </div>

      <div className="p9-token-grid">
        <div className="p9-token-card">
          <header className="p9-token-card__head">
            <h3>Springs</h3>
            <span>stiffness / damping · con tempo aplicado</span>
          </header>
          <table className="p9-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Valor actual</th>
                <th>Uso</th>
              </tr>
            </thead>
            <tbody>
              {SPRINGS.map(([key, name, use]) => (
                <tr key={name} className={USED_SPRINGS.has(key) ? 'is-used' : undefined}>
                  <td>
                    <code>{name}</code>
                  </td>
                  <td className="p9-table__value">{formatSpring(tokens.springs[key])}</td>
                  <td>{use}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="p9-token-card">
          <header className="p9-token-card__head">
            <h3>Tweens</h3>
            <span>duración × tempo · curvas fijas</span>
          </header>
          <table className="p9-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Valor actual</th>
                <th>Uso</th>
              </tr>
            </thead>
            <tbody>
              {TWEENS.map(([key, name, use]) => (
                <tr key={name} className={USED_TWEENS.has(key) ? 'is-used' : undefined}>
                  <td>
                    <code>{name}</code>
                  </td>
                  <td className="p9-table__value">{formatTween(tokens.tweens[key])}</td>
                  <td>{use}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="p9-token-card">
          <header className="p9-token-card__head">
            <h3>Curvas</h3>
            <span>fijas · el tempo no las toca</span>
          </header>
          <div className="p9-curves">
            {CURVES.map((curve) => (
              <div className="p9-curve-card" key={curve.name}>
                <svg className="p9-curve" viewBox="0 0 100 100" aria-hidden="true">
                  <path d={curvePath(curve.value)} fill="none" stroke="currentColor" strokeWidth="3" />
                  <line x1="0" y1="100" x2="100" y2="100" stroke="currentColor" strokeOpacity="0.18" />
                </svg>
                <code>{curve.name}</code>
                <span>{curve.value.join(', ')}</span>
                <small>{curve.use}</small>
              </div>
            ))}
          </div>
        </div>

        <div className="p9-token-card">
          <header className="p9-token-card__head">
            <h3>Escalas, blur, shifts y stagger</h3>
            <span>valores vivos · shift efectivo según nivel</span>
          </header>

          <h4>scale</h4>
          <div className="p9-token-chips">
            {Object.entries(tokens.scale).map(([name, value]) => (
              <TokenChip
                key={name}
                name={`scale.${name}`}
                value={String(value)}
                used={name === 'press' || name === 'popover' || name === 'icon' || name === 'toast'}
              />
            ))}
          </div>

          <h4>blur</h4>
          <div className="p9-token-chips">
            {Object.entries(tokens.blur).map(([name, value]) => (
              <TokenChip key={name} name={`blur.${name}`} value={value} used={name === 'surface'} />
            ))}
            <TokenChip name="surfaceBlur" value={tokens.surfaceBlur} used />
            <TokenChip name="swapBlur" value={tokens.swapBlur} used />
            <TokenChip name="itemBlur" value={tokens.itemBlur} used />
          </div>

          <h4>shift</h4>
          <div className="p9-token-chips">
            {Object.entries(tokens.shift).map(([name, value]) => (
              <TokenChip
                key={name}
                name={`shift.${name}`}
                value={`${value}px → ${tokens.travel(value).toFixed(1)}px`}
                used={name === 'tabs'}
              />
            ))}
          </div>

          <h4>stagger</h4>
          <div className="p9-token-chips">
            <TokenChip name="stagger" value={`${Math.round(tokens.stagger * 1000)} ms`} used />
          </div>
        </div>
      </div>

      <p className="p9-legend">
        <span className="p9-legend__dot" aria-hidden="true" />
        Token usado en un demo de esta página. Los demos de abajo nombran los suyos.
      </p>

      <div className="p9-demos">
        <DemoCard title="Press" tokens="spring.press · scale.press">
          <PressDemo />
        </DemoCard>
        <DemoCard title="Popover" tokens="spring.pop · scale.popover · blur.surface">
          <PopDemo />
        </DemoCard>
        <DemoCard title="Disclosure" tokens="transition.disclosure · blur.disclosure">
          <DisclosureDemo />
        </DemoCard>
        <DemoCard title="Swap" tokens="transition.swap · blur.icon">
          <SwapDemo />
        </DemoCard>
        <DemoCard
          title="Stagger"
          tokens={`stagger ${Math.round(tokens.stagger * 1000)} ms · spring.reflow`}
        >
          <StaggerDemo />
        </DemoCard>
      </div>
    </section>
  );
}
