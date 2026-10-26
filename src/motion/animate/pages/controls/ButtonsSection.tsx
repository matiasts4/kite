import { useEffect, useRef, useState } from 'react';
import { CompareScene, type CompareView } from '../../frame';
import { BookmarkIcon, CloudIcon, SearchIcon } from './icons';
import { PlusIcon, SwapLabel } from '../../ui';
import {
  P1Block,
  P1Button,
  P1MagneticButton,
  P1Pane,
  P1PulseRing,
  P1SaveGlyph,
  P1Spinner,
  Segmented,
  ToggleIcon,
} from './primitives';

function ArrowUpIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const SAVE_LABELS: Record<SaveState, string> = {
  idle: 'Guardar borrador',
  saving: 'Guardando…',
  saved: 'Guardado',
  error: 'Reintentar',
};

const SAVE_LABEL_LIST = Object.values(SAVE_LABELS);

const SAVE_STATUS: Record<SaveState, string> = {
  idle: 'Sin cambios',
  saving: 'Guardando…',
  saved: 'Guardado',
  error: 'Error al guardar',
};

const ALIGNMENT = [
  { id: 'left', label: 'Izq.' },
  { id: 'center', label: 'Centro' },
  { id: 'right', label: 'Der.' },
];

function KiteLabel({ value, labels }: { value: string; labels: string[] }) {
  return (
    <span className="p1-kite-label">
      {labels.map((label) => (
        <span key={label} className="p1-kite-label__ghost" aria-hidden="true">
          {label}
        </span>
      ))}
      <span className="p1-kite-label__live">
        <span key={value} className="p1-swap-text">
          {value}
        </span>
      </span>
    </span>
  );
}

export function ButtonsSection({ view }: { view: CompareView }) {
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [forceError, setForceError] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [alignment, setAlignment] = useState('left');
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach((id) => window.clearTimeout(id));
    },
    []
  );

  const later = (callback: () => void, delay: number) => {
    timers.current.push(window.setTimeout(callback, delay));
  };

  const save = () => {
    if (saveState === 'saving') return;
    setSaveState('saving');
    later(() => {
      setSaveState(forceError ? 'error' : 'saved');
      if (!forceError) {
        later(() => setSaveState((current) => (current === 'saved' ? 'idle' : current)), 1600);
      }
    }, 950);
  };

  const sync = () => {
    if (syncing) return;
    setSyncing(true);
    later(() => setSyncing(false), 1400);
  };

  const saveLabel = SAVE_LABELS[saveState];

  return (
    <CompareScene
      index="01"
      title="Botones y estados"
      target="Button · AsyncAction · ToggleGroup"
      note="Qué mirar: la jerarquía real con .primary-button, .secondary-button, .ghost-button y .danger-button. Kite hoy responde con transiciones CSS estándar y compresión a 0.97; Animate UI eleva en hover, amortigua la compresión mediante resortes, e integra morph asíncrono y seguimiento magnético."
      view={view}
    >
      {(mode) => (
        <P1Pane mode={mode}>
          <div className="p1-grid">
            {/* 1. Jerarquía de producción */}
            <P1Block title="Jerarquía" hint="primary · secondary · ghost · danger">
              <div className="p1-wrap">
                <P1Button mode={mode} variant="primary">
                  Publicar
                </P1Button>
                <P1Button mode={mode} variant="secondary">
                  Secundario
                </P1Button>
                <P1Button mode={mode} variant="ghost">
                  Fantasma
                </P1Button>
                <P1Button mode={mode} variant="danger" shakeOnClick>
                  Eliminar
                </P1Button>
                <P1Button mode={mode} variant="icon" aria-label="Buscar en el proyecto">
                  <SearchIcon size={14} />
                </P1Button>
              </div>
              <p className="p1-mini-note">
                Variantes de producción Kite con <code>.primary-button</code>, <code>.secondary-button</code>, <code>.ghost-button</code> y <code>.danger-button</code>.
              </p>
            </P1Block>

            {/* 2. Escala de tamaños y botones de acción */}
            <P1Block title="Tamaños y acción" hint="26px · 32px · 38px · circular 32px">
              <div className="p1-wrap">
                <P1Button mode={mode} variant="secondary" size="sm">
                  Compact (26px)
                </P1Button>
                <P1Button mode={mode} variant="secondary" size="md">
                  Default (32px)
                </P1Button>
                <P1Button mode={mode} variant="secondary" size="lg">
                  Large (38px)
                </P1Button>
                <P1Button
                  mode={mode}
                  variant="secondary"
                  circle
                  aria-label="Agregar elemento (+)"
                >
                  <PlusIcon size={14} />
                </P1Button>
                <P1Button
                  mode={mode}
                  variant="primary"
                  circle
                  aria-label="Enviar prompt (↑)"
                >
                  <ArrowUpIcon size={14} />
                </P1Button>
              </div>
              <p className="p1-mini-note">
                Alturas: Compact (<code>--vl-control-sm</code>, 26px / <code>.ui-control--sm</code>), Default (32px), Large (38px / <code>.ui-control--lg</code>) y botones de acción circulares de 32px (+ y ↑).
              </p>
            </P1Block>

            {/* 3. Estados de interacción */}
            <P1Block title="Estados de interacción" hint="normal · hover · active · disabled · busy">
              <div className="p1-wrap">
                <P1Button mode={mode} variant="secondary">
                  Normal
                </P1Button>
                <P1Button mode={mode} variant="secondary" disabled>
                  Deshabilitado
                </P1Button>
                <P1Button
                  mode={mode}
                  variant="primary"
                  aria-busy={syncing}
                  onClick={sync}
                >
                  {syncing ? (
                    <>
                      <P1Spinner mode={mode} size={13} />
                      <span>Sincronizando…</span>
                    </>
                  ) : (
                    <>
                      <CloudIcon size={13} />
                      <span>Sincronizar (busy)</span>
                    </>
                  )}
                </P1Button>
              </div>
              <p className="p1-mini-note">
                Hover con elevación sutil; pulsación activa con compresión a 0.97. El estado busy (<code>[aria-busy='true']</code>) conserva foco e interactividad con spinner.
              </p>
            </P1Block>

            {/* 4. Guardado asíncrono */}
            <P1Block title="Guardado asíncrono" hint="idle → saving → saved / error">
              <div className="p1-wrap p1-wrap--between">
                <P1Button
                  mode={mode}
                  variant={saveState === 'error' ? 'danger' : 'primary'}
                  className={saveState === 'saving' ? 'is-busy' : ''}
                  aria-disabled={saveState === 'saving'}
                  aria-busy={saveState === 'saving'}
                  onClick={save}
                >
                  {mode === 'animate' ? (
                    <>
                      <P1SaveGlyph state={saveState} />
                      <SwapLabel value={saveLabel} labels={SAVE_LABEL_LIST} />
                    </>
                  ) : (
                    <KiteLabel value={saveLabel} labels={SAVE_LABEL_LIST} />
                  )}
                </P1Button>
                <span className={`p1-status p1-status--${saveState}`} role="status">
                  <i aria-hidden="true" />
                  {SAVE_STATUS[saveState]}
                </span>
              </div>
              <label className="ui-check-label p1-inline-check">
                <input
                  type="checkbox"
                  checked={forceError}
                  onChange={(event) => setForceError(event.target.checked)}
                />
                <span className="ui-check-label__text">Forzar error al guardar</span>
              </label>
            </P1Block>

            {/* 5. Alternancia y grupo */}
            <P1Block title="Alternancia y grupo" hint="aria-pressed · .ui-segmented">
              <div className="p1-wrap">
                <P1Button
                  mode={mode}
                  variant="ghost"
                  className={`p1-toggle${pinned ? ' is-on' : ''}`}
                  aria-pressed={pinned}
                  onClick={() => setPinned((value) => !value)}
                >
                  <span className="p1-pin">
                    {mode === 'animate' ? (
                      <ToggleIcon mode="animate" active={pinned}>
                        <BookmarkIcon size={13} filled={pinned} />
                      </ToggleIcon>
                    ) : (
                      <BookmarkIcon size={13} filled={pinned} />
                    )}
                    {mode === 'animate' && (
                      <P1PulseRing active={pinned} className="p1-pin__ring" />
                    )}
                  </span>
                  <span>{pinned ? 'Fijado' : 'Fijar hilo'}</span>
                </P1Button>

                <Segmented
                  mode={mode}
                  label="Alineación del texto"
                  items={ALIGNMENT}
                  value={alignment}
                  onChange={setAlignment}
                  layoutId={`p1-align-${mode}`}
                />
              </div>
              <p className="p1-mini-note">
                Alternancia individual con <code>aria-pressed</code> y grupo segmentado oficial de Kite con <code>SegmentedIndicator</code>.
              </p>
            </P1Block>

            {/* 6. Magnético */}
            <P1Block title="Magnético" hint="pointer-follow · spring" className="p1-span-2">
              <div className="p1-magnet-demo">
                <P1MagneticButton mode={mode}>
                  Botón magnético
                </P1MagneticButton>
                <p className="p1-mini-note p1-magnet-demo__note">
                  En Animate UI la superficie sigue el puntero con <code>spring.highlight</code> y vuelve al reposo al salir; con reduced motion se queda quieto. Kite hoy conserva su hover estándar en CSS.
                </p>
              </div>
            </P1Block>
          </div>
        </P1Pane>
      )}
    </CompareScene>
  );
}
