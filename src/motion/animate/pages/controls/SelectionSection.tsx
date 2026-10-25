import { useState } from 'react';
import { motion } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import { CompareScene, type CompareView } from '../../frame';
import { MultiGroup, P1Block, P1Pane, Segmented } from './primitives';

interface NotifyState {
  mail: boolean;
  push: boolean;
  digest: boolean;
}

const FREQUENCIES = [
  { id: 'live', label: 'Tiempo real' },
  { id: 'hour', label: 'Cada hora' },
  { id: 'day', label: 'Resumen diario' },
];

const DENSITY = [
  { id: 'comfy', label: 'Cómoda' },
  { id: 'compact', label: 'Compacta' },
  { id: 'focus', label: 'Enfoque' },
];

const CHANNELS = [
  { id: 'mail', label: 'Correo' },
  { id: 'push', label: 'Push' },
  { id: 'slack', label: 'Slack' },
];

export function SelectionSection({ view }: { view: CompareView }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const [notify, setNotify] = useState<NotifyState>({ mail: true, push: true, digest: false });
  const [newsletter, setNewsletter] = useState(true);
  const [terms, setTerms] = useState(true);
  const [frequency, setFrequency] = useState('hour');
  const [live, setLive] = useState(true);
  const [density, setDensity] = useState('comfy');
  const [channels, setChannels] = useState<string[]>(['mail']);

  const allNotify = Object.values(notify).every(Boolean);
  const someNotify = Object.values(notify).some(Boolean) && !allNotify;

  const setChannel = (key: keyof NotifyState, next: boolean) => {
    setNotify((current) => ({ ...current, [key]: next }));
  };

  const toggleChannel = (id: string) => {
    setChannels((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    );
  };

  return (
    <CompareScene
      index="03"
      title="Selección"
      target="Checkbox · RadioGroup · Switch · Segmented"
      note="Qué mirar: controles 100% nativos de Kite. El checkbox real (16×16 con trazo SVG drawn), el radio real con dot circular, el interruptor .ui-switch de 40×22 con perilla .ui-switch__knob y el grupo segmentado .ui-segmented con indicador deslizante."
      view={view}
    >
      {(mode) => (
        <P1Pane mode={mode}>
          <div className="p1-grid">
            {/* 1. Checkbox */}
            <P1Block
              title="Checkbox"
              hint="nativo 16×16 · trazo drawn · estado mixto · error"
              className="p1-span-2"
            >
              <div className="ui-check-layout">
                {/* Grupo anidado con padre indeterminado */}
                <div className="ui-check-group" role="group" aria-label="Notificaciones">
                  <label className="ui-check-label">
                    <input
                      type="checkbox"
                      checked={allNotify}
                      ref={(el) => {
                        if (el) el.indeterminate = someNotify;
                      }}
                      onChange={(event) => {
                        const next = event.target.checked;
                        setNotify({ mail: next, push: next, digest: next });
                      }}
                    />
                    <span className="ui-check-label__text">Notificaciones generales</span>
                  </label>

                  <div className="ui-check-group__children">
                    <label className="ui-check-label">
                      <input
                        type="checkbox"
                        checked={notify.mail}
                        onChange={(event) => setChannel('mail', event.target.checked)}
                      />
                      <span className="ui-check-label__text">Correo</span>
                    </label>
                    <label className="ui-check-label">
                      <input
                        type="checkbox"
                        checked={notify.push}
                        onChange={(event) => setChannel('push', event.target.checked)}
                      />
                      <span className="ui-check-label__text">Push</span>
                    </label>
                    <label className="ui-check-label">
                      <input
                        type="checkbox"
                        checked={notify.digest}
                        onChange={(event) => setChannel('digest', event.target.checked)}
                      />
                      <span className="ui-check-label__text">Resumen semanal</span>
                    </label>
                  </div>
                  <p className="p1-mini-note">
                    El padre muestra el estado mixto mediante <code>:indeterminate</code> nativo; al hacer clic selecciona o deselecciona el grupo completo.
                  </p>
                </div>

                {/* Estados individuales: normal, error, deshabilitado */}
                <div className="ui-check-stack">
                  <label className="ui-check-label">
                    <input
                      type="checkbox"
                      checked={newsletter}
                      onChange={(event) => setNewsletter(event.target.checked)}
                    />
                    <span className="ui-check-label__text">Recibir boletín de novedades</span>
                  </label>

                  <div className={`ui-check-wrap${!terms ? ' is-error' : ''}`}>
                    <label className="ui-check-label">
                      <input
                        type="checkbox"
                        checked={terms}
                        aria-invalid={!terms || undefined}
                        aria-describedby={!terms ? `p1-terms-error-${mode}` : undefined}
                        onChange={(event) => setTerms(event.target.checked)}
                      />
                      <span className="ui-check-label__text">Acepto los términos del servicio</span>
                    </label>
                    {!terms && (
                      <span id={`p1-terms-error-${mode}`} className="p1-error" role="alert">
                        Necesitás aceptarlo para continuar.
                      </span>
                    )}
                  </div>

                  <label className="ui-check-label is-disabled">
                    <input type="checkbox" checked disabled readOnly />
                    <span className="ui-check-label__text">Recordar en este equipo (bloqueado)</span>
                  </label>

                  <p className="p1-mini-note">
                    Checkbox 16 × 16 con radio 4 estilizado por <code>visual-language.css</code>; el trazo SVG drawn se activa en <code>:checked</code>.
                  </p>
                </div>
              </div>
            </P1Block>

            {/* 2. Radio */}
            <P1Block title="Radio" hint="nativo 16×16 · dot radial · navegación por teclado">
              <div
                className="ui-radio-group"
                role="radiogroup"
                aria-label="Frecuencia de avisos"
              >
                {FREQUENCIES.map((item) => (
                  <label key={item.id} className="ui-radio-label">
                    <input
                      type="radio"
                      name={`p1-frequency-${mode}`}
                      value={item.id}
                      checked={frequency === item.id}
                      onChange={() => setFrequency(item.id)}
                    />
                    <span className="ui-radio-label__text">{item.label}</span>
                  </label>
                ))}
                <label className="ui-radio-label is-disabled">
                  <input
                    type="radio"
                    name={`p1-frequency-${mode}`}
                    value="disabled"
                    disabled
                  />
                  <span className="ui-radio-label__text">Sin notificaciones (deshabilitado)</span>
                </label>
              </div>
              <p className="p1-mini-note">
                Radio nativo circular (16 × 16) con gradiente radial y anillo de foco uniforme.
              </p>
            </P1Block>

            {/* 3. Interruptor */}
            <P1Block title="Interruptor" hint=".ui-switch · 40×22 · knob 18px">
              <div className="ui-switch-row">
                <div className="ui-switch-row__copy">
                  <span className="ui-switch-row__title">Modo en vivo</span>
                  <small className="ui-switch-row__hint">Seguir el borde vivo del transcript</small>
                </div>
                {mode === 'animate' ? (
                  <motion.button
                    type="button"
                    role="switch"
                    aria-checked={live}
                    className="ui-switch"
                    onClick={() => setLive((value) => !value)}
                    whileTap={{ scale: reduce ? 1 : motionTokens.scale.press }}
                    transition={motionTokens.springs.press}
                  >
                    <motion.span
                      className="ui-switch__knob"
                      animate={{ x: live ? 18 : 0 }}
                      transition={motionTokens.springs.thumb}
                    />
                  </motion.button>
                ) : (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={live}
                    className="ui-switch"
                    onClick={() => setLive((value) => !value)}
                  >
                    <span className="ui-switch__knob" />
                  </button>
                )}
              </div>

              <div className="ui-switch-row is-disabled">
                <div className="ui-switch-row__copy">
                  <span className="ui-switch-row__title">Avisos de escritorio</span>
                  <small className="ui-switch-row__hint">Bloqueado por la organización</small>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={true}
                  disabled
                  className="ui-switch"
                >
                  <span className="ui-switch__knob" />
                </button>
              </div>

              <p className="p1-mini-note">
                Componente real <code>.ui-switch</code> de Kite. En Animate UI la perilla se anima con <code>spring.thumb</code>.
              </p>
            </P1Block>

            {/* 4. Grupo segmentado */}
            <P1Block
              title="Grupo segmentado"
              hint=".ui-segmented · SegmentedIndicator"
              className="p1-span-2"
            >
              <div className="ui-segmented-rows">
                <div className="ui-segmented-row">
                  <span className="p1-label">Densidad</span>
                  <Segmented
                    mode={mode}
                    label="Densidad de la lista"
                    items={DENSITY}
                    value={density}
                    onChange={setDensity}
                    layoutId={`p1-density-${mode}`}
                  />
                </div>
                <div className="ui-segmented-row">
                  <span className="p1-label">Canales</span>
                  <MultiGroup
                    mode={mode}
                    label="Canales de notificación"
                    items={CHANNELS}
                    selected={channels}
                    onToggle={toggleChannel}
                  />
                </div>
              </div>
              <p className="p1-mini-note">
                Implementación oficial de <code>.ui-segmented</code> con <code>SegmentedIndicator</code>: selección simple deslizante y selección múltiple con superficies independientes.
              </p>
            </P1Block>
          </div>
        </P1Pane>
      )}
    </CompareScene>
  );
}
