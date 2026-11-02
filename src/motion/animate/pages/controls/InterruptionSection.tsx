import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import { usePresence } from '../../../usePresence';
import { motionSurfaceClass } from '../../../surface';
import { CompareScene, SceneButton, type CompareVariant, type CompareView } from '../../frame';
import { P1Block, P1Pane, Segmented } from './primitives';

const PARITY = [
  { id: 'start', label: 'Inicio' },
  { id: 'middle', label: 'Centro' },
  { id: 'end', label: 'Final' },
];

const MATRIX = [
  {
    surface: 'Pulsación',
    kite: 'translateY(1px) · 150 ms',
    animate: 'scale .97 · spring.press',
  },
  {
    surface: 'Selección',
    kite: 'fondo CSS · 150 ms',
    animate: 'layoutId · spring.selection',
  },
  {
    surface: 'Iconos',
    kite: 'cross-fade · 150 ms',
    animate: 'scale .5 + blur 2px · swap',
  },
  {
    surface: 'Campo / capa',
    kite: 'borde · popover 180/140 ms',
    animate: 'scale.menu · menu tween',
  },
  {
    surface: 'Interrupción',
    kite: 'el keyframe reinicia',
    animate: 'el spring retargetea',
  },
  {
    surface: 'Reduced motion',
    kite: 'sin animación',
    animate: 'fade y blur, sin desplazamiento',
  },
];

function InterruptionPane({
  mode,
  stop,
  presses,
  onStop,
  parity,
  onParity,
  lastInput,
  onInputKind,
  noticeOpen,
  onToggleNotice,
}: {
  mode: CompareVariant;
  stop: number;
  presses: number;
  onStop: (index: number) => void;
  parity: string;
  onParity: (value: string) => void;
  lastInput: 'pointer' | 'keyboard' | null;
  onInputKind: (kind: 'pointer' | 'keyboard') => void;
  noticeOpen: boolean;
  onToggleNotice: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(noticeOpen);

  const noticeContent = (
    <>
      <strong>Ajustes guardados.</strong> El aviso entra sin mover el contenido que lo rodea.
    </>
  );

  return (
    <P1Pane mode={mode}>
      <div className="p1-grid">
        <P1Block title="Retarget vs reinicio" hint="pulsá rápido 1 → 5 → 2">
          <div className="p1-rail">
            <span className="p1-rail__track" aria-hidden="true" />
            {mode === 'kite' ? (
              <span
                key={`rail-${presses}`}
                className="p1-rail__marker p1-rail__marker--kite"
                style={{ left: `${stop * 20}%` }}
                aria-hidden="true"
              />
            ) : (
              <motion.span
                className="p1-rail__marker p1-rail__marker--animate"
                style={{ left: 0, width: '20%' }}
                animate={{ x: `${stop * 100}%` }}
                transition={reduce ? motionTokens.tweens.instant : motionTokens.springs.selection}
                aria-hidden="true"
              />
            )}
          </div>
          <div className="p1-stops" role="group" aria-label="Destino del marcador">
            {[0, 1, 2, 3, 4].map((index) => (
              <SceneButton
                key={index}
                mode={mode}
                variant="ghost"
                className="p1-stop"
                aria-pressed={stop === index}
                aria-label={`Ir a la parada ${index + 1}`}
                onClick={() => onStop(index)}
              >
                {index + 1}
              </SceneButton>
            ))}
          </div>
          <p className="p1-caption">
            {mode === 'kite'
              ? 'Cada clic remonta el marcador y su keyframe arranca de cero.'
              : 'El spring conserva la velocidad y cambia de destino a mitad de camino.'}
          </p>
          <p className="p1-caption">
            Pulsos: <strong className="p1-counter">{presses}</strong>
          </p>
        </P1Block>

        <P1Block title="Paridad de entrada" hint="clic · flechas">
          <Segmented
            mode={mode}
            label="Alineación de la barra"
            items={PARITY}
            value={parity}
            onChange={onParity}
            layoutId="p1-parity"
            onInputKind={onInputKind}
          />
          <p className={`p1-parity p1-parity--${lastInput ?? 'idle'}`} role="status">
            {lastInput === null
              ? 'Probá con un clic o con ← →.'
              : `Última entrada: ${lastInput === 'keyboard' ? 'teclado' : 'puntero'}.`}
          </p>
          <p className="p1-mini-note">
            La misma superficie se desliza con cualquiera de las dos entradas; no hay un camino
            «sin animación».
          </p>
        </P1Block>

        <P1Block title="Reduced motion" hint="afecta a las dos columnas" className="p1-span-2">
          <div className="p1-wrap p1-wrap--between">
            <span className={`p1-badge${reduce ? ' is-on' : ''}`}>
              reduced motion: {reduce ? 'activo' : 'inactivo'}
            </span>
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              aria-expanded={noticeOpen}
              onClick={onToggleNotice}
            >
              {noticeOpen ? 'Ocultar aviso' : 'Mostrar aviso'}
            </SceneButton>
          </div>
          {mode === 'kite' ? (
            presence.mounted && (
              <div
                className={`p1-notice ${motionSurfaceClass(presence.phase, 'row')}`}
                role="status"
              >
                {noticeContent}
              </div>
            )
          ) : (
            <AnimatePresence>
              {noticeOpen && (
                <motion.div
                  key="notice"
                  className="p1-notice"
                  role="status"
                  initial={{
                    opacity: 0,
                    y: reduce ? 0 : motionTokens.travel(4),
                    filter: motionTokens.surfaceBlur,
                  }}
                  animate={{
                    opacity: 1,
                    y: 0,
                    filter: 'blur(0px)',
                    transition: motionTokens.tweens.reveal,
                  }}
                  exit={{
                    opacity: 0,
                    y: reduce ? 0 : motionTokens.travel(-4),
                    filter: motionTokens.surfaceBlur,
                    transition: motionTokens.tweens.dismiss,
                  }}
                >
                  {noticeContent}
                </motion.div>
              )}
            </AnimatePresence>
          )}
          <p className="p1-mini-note">
            Con reduced motion, Kite apaga la animación y Animate UI conserva solo opacidad y blur.
            El spring del riel también salta.
          </p>
        </P1Block>
      </div>
    </P1Pane>
  );
}

export function InterruptionSection({ view }: { view: CompareView }) {
  const [stop, setStop] = useState(0);
  const [presses, setPresses] = useState(0);
  const [parity, setParity] = useState('middle');
  const [lastInput, setLastInput] = useState<'pointer' | 'keyboard' | null>(null);
  const [noticeOpen, setNoticeOpen] = useState(false);

  const chooseStop = (index: number) => {
    setStop(index);
    setPresses((value) => value + 1);
  };

  return (
    <div className="p1-section">
      <CompareScene
        index="05"
        title="Teclado e interrupción"
        target="Keyboard parity · interruption · reduced motion"
        note="Qué mirar: pulsá las paradas en ráfaga. Kite remonta el marcador y reinicia su keyframe; Animate UI retargetea el spring desde donde está. Después movete con ← → y mirá que la selección se desliza igual."
        view={view}
      >
        {(mode) => (
          <InterruptionPane
            mode={mode}
            stop={stop}
            presses={presses}
            onStop={chooseStop}
            parity={parity}
            onParity={setParity}
            lastInput={lastInput}
            onInputKind={setLastInput}
            noticeOpen={noticeOpen}
            onToggleNotice={() => setNoticeOpen((value) => !value)}
          />
        )}
      </CompareScene>

      <section className="p1-matrix" aria-label="Matriz de comparación">
        <div className="p1-matrix__head">
          <span className="p1-block__title">Matriz rápida</span>
          <span className="p1-mini-note">La misma superficie, dos motores.</span>
        </div>
        <div className="p1-matrix__scroll">
          <table className="p1-matrix__table">
            <thead>
              <tr>
                <th scope="col">Superficie</th>
                <th scope="col">Kite hoy</th>
                <th scope="col">Animate UI</th>
              </tr>
            </thead>
            <tbody>
              {MATRIX.map((row) => (
                <tr key={row.surface}>
                  <th scope="row">{row.surface}</th>
                  <td>{row.kite}</td>
                  <td>{row.animate}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
