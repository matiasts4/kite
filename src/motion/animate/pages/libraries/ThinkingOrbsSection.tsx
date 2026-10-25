import { useState } from 'react';
import { ThinkingOrb, type OrbState, type OrbSize } from 'thinking-orbs';
import { CompareScene, type CompareVariant, type CompareView } from '../../frame';

const ORB_STATES: { id: OrbState; label: string; desc: string }[] = [
  { id: 'searching', label: 'searching', desc: 'Meridiano que barre la esfera (búsqueda en código o web)' },
  { id: 'solving', label: 'solving', desc: 'Bandas que giran en cuartos y encajan (cálculo o plan)' },
  { id: 'working', label: 'working', desc: 'Partículas en órbitas inclinadas (ejecución de herramientas)' },
  { id: 'connecting', label: 'connecting', desc: 'Constelación cableándose y paquetes fluyendo (conexión MCP)' },
  { id: 'weaving', label: 'weaving', desc: 'Tres hebras trenzándose (análisis sintáctico o síntesis)' },
  { id: 'composing', label: 'composing', desc: 'Cinta ondulante multi-banda (generación de texto)' },
  { id: 'breathing', label: 'breathing', desc: 'Anillo frontal en metamorfosis lenta (espera atenta)' },
  { id: 'listening', label: 'listening', desc: 'Ondas atravesando anillos de latitud (dictado o audio)' },
  { id: 'shaping', label: 'shaping', desc: 'Contorno punteado mutando círculo → triángulo → cuadrado' },
];

export function ThinkingOrbsSection({ view }: { view: CompareView }) {
  const [selectedState, setSelectedState] = useState<OrbState>('searching');
  const [orbSize, setOrbSize] = useState<OrbSize>(64);
  const [colorTint, setColorTint] = useState<string>('');

  const currentMeta = ORB_STATES.find((s) => s.id === selectedState) ?? ORB_STATES[0];

  return (
    <CompareScene
      index="11.2"
      title="Orbes de Pensamiento del Agente (thinking-orbs)"
      target="thinking-orbs · ThinkingOrb"
      note="Indicadores procedurales 3D sobre canvas 2D para sustituir spinners genéricos con estados cognitivos exactos."
      view={view}
      labels={{ kite: 'Kite Estándar', animate: 'Libraries.dev FX' }}
      meta={{ kite: 'Spinner CSS / Dots', animate: 'Canvas 2D · 9 estados matemáticos' }}
    >
      {(mode: CompareVariant) => {
        if (mode === 'kite') {
          return (
            <div className="p11-showcase-box">
              <div className="p11-kite-thinking">
                <div className="p11-kite-spinner" />
                <span className="p11-thinking-text">Pensando respuesta y buscando archivos...</span>
              </div>
              <div className="p11-steps-stack">
                <div className="p11-step-row">
                  <span className="p11-step-dot" />
                  <span>Buscando referencias en el repo...</span>
                </div>
                <div className="p11-step-row">
                  <span className="p11-step-dot" />
                  <span>Analizando árbol de llamadas...</span>
                </div>
                <div className="p11-step-row">
                  <span className="p11-step-dot" />
                  <span>Conectando con servidor de herramientas...</span>
                </div>
              </div>
            </div>
          );
        }

        return (
          <div className="p11-showcase-box">
            {/* Selector de estados */}
            <div className="p11-states-grid">
              {ORB_STATES.map((st) => (
                <button
                  key={st.id}
                  type="button"
                  className={`p11-state-chip ${selectedState === st.id ? 'p11-state-chip--active' : ''}`}
                  onClick={() => setSelectedState(st.id)}
                >
                  <ThinkingOrb state={st.id} size={20} color={colorTint || undefined} />
                  <span>{st.label}</span>
                </button>
              ))}
            </div>

            {/* Escaparate principal */}
            <div className="p11-orb-stage">
              <div className="p11-orb-display">
                <ThinkingOrb
                  state={selectedState}
                  size={orbSize}
                  color={colorTint || undefined}
                />
              </div>
              <div className="p11-orb-details">
                <div className="p11-orb-title">
                  <strong>Estado: {selectedState}</strong>
                  <span className="p11-size-badge">{orbSize}px</span>
                </div>
                <p className="p11-orb-desc">{currentMeta.desc}</p>
                <div className="p11-orb-controls">
                  <span className="p11-label">Tamaño:</span>
                  {([64, 32, 20] as OrbSize[]).map((sz) => (
                    <button
                      key={sz}
                      type="button"
                      className={`p11-mini-btn ${orbSize === sz ? 'p11-mini-btn--active' : ''}`}
                      onClick={() => setOrbSize(sz)}
                    >
                      {sz}px
                    </button>
                  ))}
                  <span className="p11-label" style={{ marginLeft: 12 }}>Tinte:</span>
                  <button
                    type="button"
                    className={`p11-mini-btn ${!colorTint ? 'p11-mini-btn--active' : ''}`}
                    onClick={() => setColorTint('')}
                  >
                    Mono
                  </button>
                  <button
                    type="button"
                    className={`p11-mini-btn ${colorTint === '#00d084' ? 'p11-mini-btn--active' : ''}`}
                    onClick={() => setColorTint('#00d084')}
                  >
                    Verde
                  </button>
                  <button
                    type="button"
                    className={`p11-mini-btn ${colorTint === '#38bdf8' ? 'p11-mini-btn--active' : ''}`}
                    onClick={() => setColorTint('#38bdf8')}
                  >
                    Cyan
                  </button>
                  <button
                    type="button"
                    className={`p11-mini-btn ${colorTint === '#f59e0b' ? 'p11-mini-btn--active' : ''}`}
                    onClick={() => setColorTint('#f59e0b')}
                  >
                    Ámbar
                  </button>
                </div>
              </div>
            </div>

            {/* Integración inline en pasos del agente */}
            <div className="p11-agent-steps">
              <div className="p11-agent-step-item">
                <ThinkingOrb state="searching" size={20} color="#38bdf8" />
                <span>Buscando referencias de símbolos en el workspace...</span>
              </div>
              <div className="p11-agent-step-item">
                <ThinkingOrb state="solving" size={20} color="#f59e0b" />
                <span>Sintetizando plan de ejecución en subagentes...</span>
              </div>
              <div className="p11-agent-step-item">
                <ThinkingOrb state="connecting" size={20} color="#a78bfa" />
                <span>Conectando con socket MCP y herramientas...</span>
              </div>
            </div>
          </div>
        );
      }}
    </CompareScene>
  );
}
