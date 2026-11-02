import { useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { CompareScene, type CompareVariant, type CompareView } from '../../frame';
import { useLabMotion, useLabReduce } from '../../context';
import './visual.css';

/* -------------------------------------------------------------------------- */
/* Icons                                                                      */
/* -------------------------------------------------------------------------- */

function SearchIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m16.5 16.5 4 4" />
    </svg>
  );
}

function ChevronIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ArrowIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

function SparkIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* 10.1 — Shape and surface tokens                                            */
/* -------------------------------------------------------------------------- */

function TokenRow({ label, value, children }: { label: string; value: string; children?: React.ReactNode }) {
  return (
    <div className="p10-token-row">
      <span className="p10-token-row__label">{label}</span>
      <span className="p10-token-row__value">{value}</span>
      {children}
    </div>
  );
}

function TokenScene({ view }: { view: CompareView }) {
  return (
    <CompareScene
      index="10.1"
      title="Forma y superficie"
      target="Radius · stroke · surface"
      note="La propuesta no cambia el color de marca: ordena la forma. Una escala de radios, tres superficies, dos pesos de borde y un solo anillo de foco. La columna Actual muestra los valores que Kite mezcla hoy."
      view={view}
      labels={{ kite: 'Actual', animate: 'Propuesto' }}
      meta={{ kite: 'valores actuales', animate: 'escala nueva' }}
    >
      {(mode) =>
        mode === 'kite' ? (
          <div className="p10-tokens">
            <TokenRow label="Radios" value="6 · 7 · 10 · 14" />
            <TokenRow label="Controles" value="28 · 32 · 38" />
            <TokenRow label="Switch" value="44 × 20 · knob 26 × 16" />
            <TokenRow label="Borde" value="1 px · rgba(255,255,255,.10)" />
            <TokenRow label="Superficie" value="plana · un solo nivel" />
            <TokenRow label="Foco" value="2 px · sin offset fijo" />
            <div className="p10-token-preview">
              <span className="p10-actual-radius">6</span>
              <span className="p10-actual-radius p10-actual-radius--7">7</span>
              <span className="p10-actual-radius p10-actual-radius--10">10</span>
              <span className="p10-actual-radius p10-actual-radius--14">14</span>
            </div>
          </div>
        ) : (
          <div className="p10-proposed">
            <div className="p10-radius-scale" aria-label="Escala de radios propuesta">
              {[4, 6, 8, 12, 14].map((radius) => (
                <span key={radius} className="p10-radius-chip" style={{ borderRadius: radius }}>
                  <b>{radius}</b>
                  <small>{radius === 4 ? 'check' : radius === 6 ? 'chip' : radius === 8 ? 'control' : radius === 12 ? 'card' : 'panel'}</small>
                </span>
              ))}
            </div>
            <div className="p10-surface-stack">
              <span className="p10-surface p10-surface--canvas"><b>canvas</b><small>fondo</small></span>
              <span className="p10-surface p10-surface--raised"><b>raised</b><small>tarjeta · fila</small></span>
              <span className="p10-surface p10-surface--overlay"><b>overlay</b><small>menú · diálogo</small></span>
            </div>
            <div className="p10-token-list">
              <TokenRow label="Controles" value="26 · 32 · 38" />
              <TokenRow label="Switch" value="40 × 22 · knob 18" />
              <TokenRow label="Borde" value="1 px · 12% / 22%" />
              <TokenRow label="Foco" value="2 px · offset 2" />
            </div>
          </div>
        )
      }
    </CompareScene>
  );
}

/* -------------------------------------------------------------------------- */
/* 10.2 — Selection controls                                                   */
/* -------------------------------------------------------------------------- */

function ProposedCheckbox({
  checked,
  indeterminate,
  disabled,
  invalid,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  onChange: () => void;
  label: string;
  hint?: string;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const on = checked || indeterminate;
  const state: boolean | 'mixed' = indeterminate ? 'mixed' : checked;

  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state}
      disabled={disabled}
      className={`p10-check${on ? ' is-on' : ''}${invalid ? ' is-invalid' : ''}`}
      onClick={onChange}
    >
      <span className="p10-check__box" aria-hidden="true">
        <svg viewBox="0 0 12 12" className="p10-check__mark">
          {indeterminate ? (
            <motion.path
              d="M2.4 6h7.2"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              initial={false}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={motionTokens.tweens.fade}
            />
          ) : (
            <motion.path
              d="M2.2 6.2 4.8 8.7 9.8 3.4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={false}
              animate={{ pathLength: checked ? 1 : 0, opacity: checked ? 1 : 0 }}
              transition={reduce ? motionTokens.tweens.instant : checked ? motionTokens.tweens.reveal : motionTokens.tweens.swap}
            />
          )}
        </svg>
      </span>
      <span className="p10-check__copy">
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </span>
    </button>
  );
}

function ProposedRadio({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  hint?: string;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={`p10-radio${checked ? ' is-on' : ''}`}
      onClick={onChange}
    >
      <span className="p10-radio__box" aria-hidden="true">
        <motion.span
          className="p10-radio__dot"
          initial={false}
          animate={{ scale: checked ? 1 : 0, opacity: checked ? 1 : 0 }}
          transition={reduce ? motionTokens.tweens.instant : motionTokens.springs.pop}
        />
      </span>
      <span className="p10-check__copy">
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </span>
    </button>
  );
}

function ProposedSwitch({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  return (
    <div className={`p10-switch-row${disabled ? ' is-disabled' : ''}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={`p10-switch ui-switch${checked ? ' is-on' : ''}`}
        onClick={onChange}
      >
        <motion.span
          className="p10-switch__thumb ui-switch__knob"
          initial={false}
          animate={{ x: checked ? 18 : 0 }}
          transition={reduce ? motionTokens.tweens.instant : motionTokens.springs.thumb}
        />
      </button>
      <span className="p10-switch__copy">
        <strong>{label}</strong>
        {hint ? <small>{hint}</small> : null}
      </span>
    </div>
  );
}

function SelectionScene({ view }: { view: CompareView }) {
  const [notify, setNotify] = useState(true);
  const [telemetry, setTelemetry] = useState(false);
  const [beta, setBeta] = useState(false);
  const [plan, setPlan] = useState('balanced');
  const [sync, setSync] = useState(true);

  const render = (mode: CompareVariant) => {
    if (mode === 'kite') {
      return (
        <div className="p10-controls">
          <label className="p10-native">
            <input type="checkbox" checked={notify} onChange={() => setNotify((v) => !v)} />
            <span><strong>Notificaciones</strong><small>Avisos de trabajo terminado.</small></span>
          </label>
          <label className="p10-native">
            <input type="checkbox" checked={telemetry} onChange={() => setTelemetry((v) => !v)} />
            <span><strong>Telemetría</strong><small>Ayuda a mejorar Kite.</small></span>
          </label>
          <div className="p10-native-group" role="radiogroup" aria-label="Plan">
            {[
              { id: 'fast', label: 'Rápido', hint: 'Menos contexto' },
              { id: 'balanced', label: 'Equilibrado', hint: 'Uso diario' },
              { id: 'deep', label: 'Profundo', hint: 'Más razonamiento' },
            ].map((item) => (
              <label key={item.id} className="p10-native">
                <input
                  type="radio"
                  name="p10-actual-plan"
                  checked={plan === item.id}
                  onChange={() => setPlan(item.id)}
                />
                <span><strong>{item.label}</strong><small>{item.hint}</small></span>
              </label>
            ))}
          </div>
          <div className="p10-switch-row">
            <button
              type="button"
              role="switch"
              aria-checked={sync}
              aria-label="Sincronizar"
              className="p10-switch p10-switch--actual"
              onClick={() => setSync((v) => !v)}
            >
              <span className="p10-switch__thumb" />
            </button>
            <span className="p10-switch__copy">
              <strong>Sincronizar</strong>
              <small>44 × 20 · knob 26 × 16</small>
            </span>
          </div>
        </div>
      );
    }

    return (
      <div className="p10-proposed p10-controls">
        <ProposedCheckbox
          checked={notify}
          onChange={() => setNotify((v) => !v)}
          label="Notificaciones"
          hint="Avisos de trabajo terminado."
        />
        <ProposedCheckbox
          checked={false}
          indeterminate
          onChange={() => {}}
          label="Selección parcial"
          hint="Estado mixto del grupo."
        />
        <ProposedCheckbox
          checked={telemetry}
          onChange={() => setTelemetry((v) => !v)}
          label="Telemetría"
          hint="Ayuda a mejorar Kite."
        />
        <ProposedCheckbox
          checked
          invalid
          onChange={() => {}}
          label="Campo con error"
          hint="Necesita una acción."
        />
        <ProposedCheckbox
          checked={beta}
          disabled
          onChange={() => setBeta((v) => !v)}
          label="Canal beta"
          hint="No disponible en esta cuenta."
        />
        <div className="p10-proposed-group" role="radiogroup" aria-label="Plan propuesto">
          {[
            { id: 'fast', label: 'Rápido', hint: 'Menos contexto' },
            { id: 'balanced', label: 'Equilibrado', hint: 'Uso diario' },
            { id: 'deep', label: 'Profundo', hint: 'Más razonamiento' },
          ].map((item) => (
            <ProposedRadio
              key={item.id}
              checked={plan === item.id}
              onChange={() => setPlan(item.id)}
              label={item.label}
              hint={item.hint}
            />
          ))}
        </div>
        <ProposedSwitch
          checked={sync}
          onChange={() => setSync((v) => !v)}
          label="Sincronizar"
          hint="40 × 22 · knob 18"
        />
      </div>
    );
  };

  return (
    <CompareScene
      index="10.2"
      title="Selección"
      target="Checkbox · Radio · Switch"
      note="El checkbox propuesto tiene 16 px, radio 4 y check dibujado; el radio usa un punto que aparece con spring.pop; el switch baja a 40 × 22 con knob de 18 y un inset real. El estado es compartido entre las dos columnas."
      view={view}
      labels={{ kite: 'Actual', animate: 'Propuesto' }}
      meta={{ kite: 'nativo + 44 × 20', animate: '16 px + 40 × 22' }}
    >
      {render}
    </CompareScene>
  );
}

/* -------------------------------------------------------------------------- */
/* 10.3 — Fields                                                              */
/* -------------------------------------------------------------------------- */

function FieldScene({ view }: { view: CompareView }) {
  const [name, setName] = useState('Kite');
  const [query, setQuery] = useState('');
  const [model, setModel] = useState('auto');

  const render = (mode: CompareVariant) => {
    if (mode === 'kite') {
      return (
        <div className="p10-fields p10-fields--actual">
          <label className="p10-field-actual">
            <span>Nombre del workspace</span>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="p10-field-actual">
            <span>Buscar</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Archivo o hilo…" />
          </label>
          <label className="p10-field-actual">
            <span>Modelo</span>
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              <option value="auto">Automático</option>
              <option value="fast">Rápido</option>
              <option value="deep">Profundo</option>
            </select>
          </label>
          <label className="p10-field-actual is-invalid">
            <span>Rama</span>
            <input value="" placeholder="feature/" readOnly />
            <small>El nombre no puede estar vacío.</small>
          </label>
        </div>
      );
    }

    return (
      <div className="p10-proposed p10-fields">
        <label className="p10-field">
          <span className="p10-field__label">Nombre del workspace</span>
          <span className="p10-field__control ui-field">
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </span>
          <span className="p10-field__hint">Visible para todo el equipo.</span>
        </label>
        <label className="p10-field">
          <span className="p10-field__label">Buscar</span>
          <span className="p10-field__control p10-field__control--search ui-field">
            <SearchIcon />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Archivo o hilo…" />
            <kbd>⌘K</kbd>
          </span>
        </label>
        <label className="p10-field">
          <span className="p10-field__label">Modelo</span>
          <span className="p10-field__control p10-field__control--select ui-field">
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              <option value="auto">Automático</option>
              <option value="fast">Rápido</option>
              <option value="deep">Profundo</option>
            </select>
            <ChevronIcon />
          </span>
        </label>
        <label className="p10-field is-invalid">
          <span className="p10-field__label">Rama</span>
          <span className="p10-field__control ui-field">
            <input value="" placeholder="feature/" readOnly />
          </span>
          <span className="p10-field__hint">El nombre no puede estar vacío.</span>
        </label>
      </div>
    );
  };

  return (
    <CompareScene
      index="10.3"
      title="Campos"
      target="Input · Search · Select"
      note="La propuesta unifica altura (32 px), radio (8), borde y foco. El campo tiene un inset de superficie, el foco suma un anillo de 2 px con offset, y el error usa el mismo borde de peligro que el resto del sistema. Los valores se comparten."
      view={view}
      labels={{ kite: 'Actual', animate: 'Propuesto' }}
      meta={{ kite: '36 px · flat', animate: '32 px · inset' }}
    >
      {render}
    </CompareScene>
  );
}

/* -------------------------------------------------------------------------- */
/* 10.4 — Buttons                                                             */
/* -------------------------------------------------------------------------- */

function ProposedButton({
  variant = 'secondary',
  size = 'md',
  children,
  onClick,
}: {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
  onClick?: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const prodClass =
    variant === 'primary'
      ? 'primary-button'
      : variant === 'secondary'
      ? 'secondary-button'
      : variant === 'ghost'
      ? 'ghost-button'
      : 'danger-button';

  return (
    <motion.button
      type="button"
      className={`p10-btn p10-btn--${variant} p10-btn--${size} ${prodClass}`}
      whileHover={reduce ? undefined : { y: -1, transition: motionTokens.springs.highlight }}
      whileTap={{ scale: reduce ? 1 : motionTokens.scale.press }}
      transition={motionTokens.springs.press}
      onClick={onClick}
    >
      {children}
    </motion.button>
  );
}

function ButtonScene({ view }: { view: CompareView }) {
  const [saved, setSaved] = useState(false);

  const render = (mode: CompareVariant) => {
    if (mode === 'kite') {
      return (
        <div className="p10-buttons p10-buttons--actual">
          <div className="p10-button-row">
            <button type="button" className="p10-btn p10-btn--actual p10-btn--primary p10-btn--sm">Publicar</button>
            <button type="button" className="p10-btn p10-btn--actual p10-btn--sm">Secundario</button>
            <button type="button" className="p10-btn p10-btn--actual p10-btn--ghost p10-btn--sm">Fantasma</button>
            <button type="button" className="p10-btn p10-btn--actual p10-btn--danger p10-btn--sm">Eliminar</button>
          </div>
          <div className="p10-button-row">
            <button type="button" className="p10-btn p10-btn--actual p10-btn--primary">Publicar</button>
            <button type="button" className="p10-btn p10-btn--actual">Secundario</button>
            <button type="button" className="p10-btn p10-btn--actual p10-btn--ghost">Fantasma</button>
          </div>
          <div className="p10-button-row">
            <button type="button" className="p10-btn p10-btn--actual p10-btn--primary p10-btn--lg">Publicar</button>
            <button type="button" className="p10-btn p10-btn--actual p10-btn--danger">Eliminar</button>
            <button type="button" className="p10-btn p10-btn--actual p10-btn--icon" aria-label="Abrir">↗</button>
          </div>
        </div>
      );
    }

    return (
      <div className="p10-proposed p10-buttons">
        <div className="p10-button-row">
          <ProposedButton variant="primary" size="sm">Publicar</ProposedButton>
          <ProposedButton size="sm">Secundario</ProposedButton>
          <ProposedButton variant="ghost" size="sm">Fantasma</ProposedButton>
          <ProposedButton variant="danger" size="sm">Eliminar</ProposedButton>
          <ProposedButton variant="ghost" size="sm" onClick={() => setSaved((v) => !v)}>
            <SparkIcon /> {saved ? 'Listo' : 'Probar'}
          </ProposedButton>
        </div>
        <div className="p10-button-row">
          <ProposedButton variant="primary">Publicar</ProposedButton>
          <ProposedButton>Secundario</ProposedButton>
          <ProposedButton variant="ghost">Fantasma</ProposedButton>
          <ProposedButton variant="primary">
            Publicar <ArrowIcon />
          </ProposedButton>
        </div>
        <div className="p10-button-row">
          <ProposedButton variant="primary" size="lg">Publicar</ProposedButton>
          <ProposedButton variant="danger" size="lg">Eliminar</ProposedButton>
          <ProposedButton variant="ghost" size="lg"><SparkIcon /> Generar</ProposedButton>
        </div>
        <p className="p10-hint">26 · 32 · 38 px · radio 8 · inset highlight · un solo foco.</p>
      </div>
    );
  };

  return (
    <CompareScene
      index="10.4"
      title="Botones"
      target="Variant · Size · State"
      note="La propuesta ordena tres alturas y cuatro variantes. El primario es negro con borde claro, highlight interno y una sombra corta; el acento queda para el foco, no para el relleno. El secundario vive en la superficie raised; el peligro es un outline teñido, no un bloque rojo. El hover levanta 1 px y el press baja a 0.97."
      view={view}
      labels={{ kite: 'Actual', animate: 'Propuesto' }}
      meta={{ kite: 'plano', animate: 'negro + inset' }}
    >
      {render}
    </CompareScene>
  );
}

/* -------------------------------------------------------------------------- */
/* 10.5 — Surfaces                                                            */
/* -------------------------------------------------------------------------- */

function SurfacesScene({ view }: { view: CompareView }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const [selected, setSelected] = useState('motion');

  const render = (mode: CompareVariant) => {
    if (mode === 'kite') {
      return (
        <div className="p10-surfaces p10-surfaces--actual">
          <button
            type="button"
            className={`p10-card p10-card--actual${selected === 'motion' ? ' is-selected' : ''}`}
            onClick={() => setSelected('motion')}
          >
            <span className="p10-card__tag">motion</span>
            <strong>Contrato de motion</strong>
            <p>Entrada 180 ms, salida 140 ms. Transform y opacity.</p>
            <span className="p10-card__meta">src/motion/contract.ts</span>
          </button>
          <button
            type="button"
            className={`p10-card p10-card--actual${selected === 'presence' ? ' is-selected' : ''}`}
            onClick={() => setSelected('presence')}
          >
            <span className="p10-card__tag">presence</span>
            <strong>Presencia de overlays</strong>
            <p>El overlay vive hasta que su salida termina.</p>
            <span className="p10-card__meta">src/motion/usePresence.ts</span>
          </button>
          <div className="p10-panel p10-panel--actual">
            <strong>Superficie actual</strong>
            <p>Un solo fondo, un borde de 1 px, sin highlight interno.</p>
          </div>
        </div>
      );
    }

    return (
      <div className="p10-proposed p10-surfaces">
        <div className="p10-card-grid">
          {[
            { id: 'motion', tag: 'motion', title: 'Contrato de motion', body: 'Entrada 180 ms, salida 140 ms. Transform y opacity.', meta: 'src/motion/contract.ts' },
            { id: 'presence', tag: 'presence', title: 'Presencia de overlays', body: 'El overlay vive hasta que su salida termina.', meta: 'src/motion/usePresence.ts' },
          ].map((card) => (
            <motion.button
              key={card.id}
              type="button"
              className={`p10-card p10-card--proposed ui-card${selected === card.id ? ' is-selected' : ''}`}
              whileHover={reduce ? undefined : { y: -3 }}
              whileTap={{ scale: reduce ? 1 : 0.985 }}
              transition={motionTokens.springs.highlight}
              onClick={() => setSelected(card.id)}
            >
              <span className={`p10-card__cover p10-card__cover--${card.id}`} aria-hidden="true" />
              <span className="p10-card__body">
                <span className="p10-card__tag">{card.tag}</span>
                <strong>{card.title}</strong>
                <p>{card.body}</p>
                <span className="p10-card__meta">{card.meta}<ArrowIcon /></span>
              </span>
            </motion.button>
          ))}
        </div>
        <div className="p10-agent">
          <span className="p10-agent__avatar">MC</span>
          <span className="p10-agent__copy">
            <strong>Mira Chen</strong>
            <small>Diseño de producto</small>
          </span>
          <span className="p10-agent__status"><i /> En línea</span>
        </div>
        <div className="p10-panel p10-panel--proposed">
          <span className="p10-panel__head"><strong>Superficie propuesta</strong><span className="p10-panel__badge">overlay</span></span>
          <p>Radio 14, borde 1 px, inset highlight y sombra en dos capas. El contenido respira 14 px.</p>
          <span className="p10-panel__row"><span>Fondo</span><b>raised</b></span>
          <span className="p10-panel__row"><span>Borde</span><b>22%</b></span>
        </div>
      </div>
    );
  };

  return (
    <CompareScene
      index="10.5"
      title="Tarjetas y superficies"
      target="Card · Agent · Overlay"
      note="La tarjeta propuesta suma radio 12, cover con gradiente, highlight interno y una sombra que aparece con el hover. La ficha de agente usa el mismo lenguaje en miniatura; el panel de overlay sube a radio 14 y dos capas de sombra."
      view={view}
      labels={{ kite: 'Actual', animate: 'Propuesto' }}
      meta={{ kite: 'plano', animate: 'cover + capas' }}
    >
      {render}
    </CompareScene>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export function VisualPage({ view }: { view: CompareView }) {
  return (
    <div className="p10-page" data-page="10" data-view={view}>
      <section className="p10-intro">
        <div>
          <span className="alab-eyebrow">10 · Lenguaje visual</span>
          <h2>La forma también comunica</h2>
          <p>
            Las animaciones ya están. Esta página separa la otra mitad del sistema: radios,
            bordes, superficies, alturas y estados. La columna Actual muestra lo que Kite mezcla
            hoy; la propuesta ordena esos valores sin cambiar la identidad de color.
          </p>
        </div>
        <ul className="p10-rules">
          <li>4 px de grid</li>
          <li>3 superficies</li>
          <li>2 pesos de borde</li>
          <li>1 anillo de foco</li>
          <li>3 alturas de control</li>
        </ul>
      </section>

      <TokenScene view={view} />
      <SelectionScene view={view} />
      <FieldScene view={view} />
      <ButtonScene view={view} />
      <SurfacesScene view={view} />
    </div>
  );
}
