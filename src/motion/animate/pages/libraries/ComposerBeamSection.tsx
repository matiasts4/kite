import { useState, useEffect } from 'react';
import { BorderBeam, type BorderBeamSize, type BorderBeamColorVariant } from 'border-beam';
import { VoiceBeam } from 'voice-glow';
import { ThinkingOrb, type OrbState } from 'thinking-orbs';
import { CompareScene, type CompareVariant, type CompareView } from '../../frame';

type SimulationState = 'idle' | 'solving' | 'searching' | 'weaving' | 'streaming' | 'voice';
type RadiusMode = 'squircle' | 'pill' | 'technical';

export function ComposerBeamSection({ view }: { view: CompareView }) {
  const [simState, setSimState] = useState<SimulationState>('solving');
  const [radiusMode, setRadiusMode] = useState<RadiusMode>('squircle');
  const colorVariant: BorderBeamColorVariant = 'ocean';
  const [selectedModel, setSelectedModel] = useState('Auto');
  const [selectedMode, setSelectedMode] = useState('Agent');
  const [voiceLevel, setVoiceLevel] = useState(0.4);
  const [elapsedSec, setElapsedSec] = useState(2.3);

  const beamMode: BorderBeamSize = simState === 'streaming' ? 'line' : 'md';

  const radiusVars = {
    '--ld-pill-radius': radiusMode === 'pill' ? '9999px' : radiusMode === 'squircle' ? '10px' : '6px',
    '--ld-composer-radius': radiusMode === 'pill' ? '20px' : radiusMode === 'squircle' ? '14px' : '10px',
    '--ld-icon-btn-radius': radiusMode === 'pill' ? '50%' : radiusMode === 'squircle' ? '10px' : '6px',
    '--ld-chip-radius': radiusMode === 'pill' ? '50%' : radiusMode === 'squircle' ? '8px' : '4px',
  } as React.CSSProperties;

  // Simulación de oscilación de audio y tiempo
  useEffect(() => {
    if (simState === 'voice') {
      const interval = setInterval(() => {
        setVoiceLevel(0.2 + Math.random() * 0.7);
      }, 120);
      return () => clearInterval(interval);
    }
    if (simState !== 'idle') {
      const timer = setInterval(() => {
        setElapsedSec((s) => Number((s + 0.1).toFixed(1)));
      }, 100);
      return () => clearInterval(timer);
    }
  }, [simState]);

  const isRunning = simState !== 'idle';
  const orbState: OrbState =
    simState === 'solving'
      ? 'solving'
      : simState === 'searching'
      ? 'searching'
      : simState === 'weaving'
      ? 'weaving'
      : simState === 'streaming'
      ? 'composing'
      : 'listening';

  const cognitivePhrase =
    simState === 'solving'
      ? 'Razonando plan de implementación y arquitectura...'
      : simState === 'searching'
      ? 'Explorando codebase, referencias y definiciones...'
      : simState === 'weaving'
      ? 'Componiendo cambios y validando contratos...'
      : simState === 'streaming'
      ? 'Sintetizando tokens finales en streaming...'
      : 'Escuchando audio con detección de silencios...';

  return (
    <CompareScene
      index="11.4"
      title="Thread Composer & Barra Cognitiva Persistente (Libraries.dev)"
      target="border-beam · thinking-orbs · glass stadium pills · chromatic send"
      note="Cajita de chat con bordes glass especulares, botón Send con anillo cromático iridiscente y barra cognitiva anclada que nunca se pierde al hacer scroll."
      view={view}
      labels={{ kite: 'Kite Estándar', animate: 'Libraries.dev FX' }}
      meta={{ kite: 'Dropdowns planos 1px · Scroll disperso', animate: 'Píldoras glass · Anillo cromático 360° · ThinkingOrb anclado' }}
    >
      {(mode: CompareVariant) => {
        if (mode === 'kite') {
          return (
            <div className="p11-showcase-box">
              {/* Composer tradicional de Kite */}
              <div className="p11-composer-box">
                <textarea
                  className="p11-textarea"
                  placeholder="Build anything..."
                  defaultValue="Analiza los endpoints del servidor y refactoriza la capa de red con la nueva arquitectura."
                  rows={2}
                />
                <div className="p11-composer-actions">
                  <div className="p11-tools-left">
                    <button type="button" className="p11-icon-btn" title="Adjuntar">
                      📎 Attach
                    </button>
                    <span className="p11-model-chip">Agent</span>
                    <span className="p11-model-chip">Auto</span>
                  </div>
                  <button type="button" className="primary-button p11-send-btn">
                    Enviar
                  </button>
                </div>
              </div>
              <p className="p11-subtext">
                Enfoque tradicional: botones rectangulares planos con borde simple de 1px. Cuando el agente piensa en el transcript, el orbe puede remontar y desaparecer con el scroll de mensajes largos.
              </p>
            </div>
          );
        }

        return (
          <div className="p11-showcase-box">
            {/* Barra de simulación interactiva */}
            <div className="p11-controls-bar">
              <span className="p11-label">Estado de Agente:</span>
              <div className="p11-segmented">
                {(
                  [
                    ['idle', 'Reposo'],
                    ['solving', 'Pensando'],
                    ['searching', 'Buscando'],
                    ['weaving', 'Componiendo'],
                    ['streaming', 'Tokens'],
                    ['voice', 'Voz'],
                  ] as [SimulationState, string][]
                ).map(([st, label]) => (
                  <button
                    key={st}
                    type="button"
                    className={`p11-seg-btn ${simState === st ? 'p11-seg-btn--active' : ''}`}
                    onClick={() => {
                      setSimState(st);
                      setElapsedSec(0.8);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <span className="p11-label">Modelo:</span>
              <div className="p11-segmented">
                {['Auto', 'Claude 3.7', 'Gemini 2.5', 'DeepSeek'].map((m) => (
                  <button
                    key={m}
                    type="button"
                    className={`p11-seg-btn ${selectedModel === m ? 'p11-seg-btn--active' : ''}`}
                    onClick={() => setSelectedModel(m)}
                  >
                    {m}
                  </button>
                ))}
              </div>

              <span className="p11-label" style={{ color: '#38bdf8' }}>Curvatura:</span>
              <div className="p11-segmented">
                {(
                  [
                    ['squircle', 'Squircle (10px) ⭐'],
                    ['pill', 'Píldora (9999px)'],
                    ['technical', 'Técnico (6px)'],
                  ] as [RadiusMode, string][]
                ).map(([r, label]) => (
                  <button
                    key={r}
                    type="button"
                    className={`p11-seg-btn ${radiusMode === r ? 'p11-seg-btn--active' : ''}`}
                    onClick={() => setRadiusMode(r)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Reconstrucción de la cajita de Thread con Libraries.dev FX */}
            <div style={{ position: 'relative', width: '100%', maxWidth: '640px', ...radiusVars }}>
              {/* Barra Cognitiva Persistente (Evita que el Thinking Orb remonte o se pierda) */}
              {isRunning && simState !== 'voice' && (
                <div className="ld-cognitive-bar">
                  <div className="ld-cognitive-bar__left">
                    <div className="ld-cognitive-bar__orb">
                      <ThinkingOrb state={orbState} size={20} color="#38bdf8" />
                    </div>
                    <div className="ld-cognitive-bar__status">
                      <span className="ld-cognitive-bar__phase">
                        {simState === 'solving' && 'Razonando solución'}
                        {simState === 'searching' && 'Buscando contexto'}
                        {simState === 'weaving' && 'Componiendo código'}
                        {simState === 'streaming' && 'Generando respuesta'}
                      </span>
                      <span className="ld-cognitive-bar__detail">{cognitivePhrase}</span>
                    </div>
                  </div>

                  <div className="ld-cognitive-bar__right">
                    <span className="ld-cognitive-bar__badge">{elapsedSec}s</span>
                    <button
                      type="button"
                      className="ld-cognitive-bar__stop-btn"
                      onClick={() => setSimState('idle')}
                      title="Detener ejecución"
                    >
                      Detener
                    </button>
                  </div>
                </div>
              )}

              {/* Contenedor del Composer envuelto en BorderBeam o VoiceBeam */}
              {simState === 'voice' ? (
                <VoiceBeam level={voiceLevel} colorVariant={colorVariant} borderRadius={16}>
                  <div className="ld-thread-composer" style={{ background: '#121214' }}>
                    <textarea
                      className="ld-thread-composer__input"
                      placeholder="Escuchando tu voz..."
                      value="Habla con libertad... El haz inferior reacciona a la intensidad de tu voz en tiempo real."
                      rows={2}
                      readOnly
                    />
                    <div className="ld-thread-composer__footer">
                      <div className="ld-thread-composer__group">
                        <span className="p11-pulse-indicator" />
                        <span className="p11-voice-status">Micrófono activo (xAI Grok STT)</span>
                      </div>
                      <button
                        type="button"
                        className="ld-glass-pill ld-glass-pill--active"
                        onClick={() => setSimState('idle')}
                      >
                        Finalizar dictado
                      </button>
                    </div>
                  </div>
                </VoiceBeam>
              ) : (
                <BorderBeam
                  size={beamMode}
                  colorVariant={colorVariant}
                  active={isRunning}
                  borderRadius={radiusMode === 'pill' ? (isRunning ? 16 : 20) : radiusMode === 'squircle' ? (isRunning ? 12 : 14) : 8}
                >
                  <div
                    className={`ld-thread-composer ${
                      isRunning ? 'ld-thread-composer--with-bar' : ''
                    }`}
                  >
                    <textarea
                      className="ld-thread-composer__input"
                      placeholder="Build anything..."
                      defaultValue="Analiza los endpoints del servidor y refactoriza la capa de red con la nueva arquitectura."
                      rows={2}
                    />

                    {/* Footer con los nuevos botones estilo Libraries.dev */}
                    <div className="ld-thread-composer__footer">
                      {/* Grupo izquierdo: Botón circular + y modo de trabajo */}
                      <div className="ld-thread-composer__group">
                        {/* Botón Circular + (Imagen 1) */}
                        <button
                          type="button"
                          className="ld-circle-btn"
                          title="Adjuntar archivos o carpetas (+)"
                          onClick={() => {}}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                          >
                            <line x1="12" y1="5" x2="12" y2="19" />
                            <line x1="5" y1="12" x2="19" y2="12" />
                          </svg>
                        </button>

                        {/* Píldora Stadium Glass: Agent v (Imagen 1) */}
                        <button
                          type="button"
                          className="ld-glass-pill"
                          onClick={() =>
                            setSelectedMode((m) =>
                              m === 'Agent' ? 'Plan' : m === 'Plan' ? 'Ask' : 'Agent'
                            )
                          }
                          title="Selector de modo de trabajo"
                        >
                          <span>{selectedMode}</span>
                          <svg
                            className="ld-glass-pill__chevron"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>
                      </div>

                      {/* Grupo derecho: Selector de modelo con píldora glass y botón de envío cromático */}
                      <div className="ld-thread-composer__group">
                        {/* Píldora Stadium Glass: Auto v (Imagen 1) */}
                        <button
                          type="button"
                          className="ld-glass-pill"
                          onClick={() =>
                            setSelectedModel((m) =>
                              m === 'Auto'
                                ? 'Claude 3.7'
                                : m === 'Claude 3.7'
                                ? 'Gemini 2.5'
                                : 'Auto'
                            )
                          }
                          title="Selector de modelo IA"
                        >
                          <span>{selectedModel}</span>
                          <svg
                            className="ld-glass-pill__chevron"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="6 9 12 15 18 9" />
                          </svg>
                        </button>

                        {/* Botón Circular Send con Anillo Cromático Prismático (Imagen 1) */}
                        <button
                          type="button"
                          className="ld-chromatic-btn"
                          title={isRunning ? 'Detener ejecución' : 'Enviar prompt (Enter)'}
                          onClick={() => setSimState(isRunning ? 'idle' : 'solving')}
                        >
                          <span className="ld-chromatic-btn__ring" />
                          <span className="ld-chromatic-btn__glow" />
                          <span className="ld-chromatic-btn__core">
                            {isRunning ? (
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="currentColor"
                              >
                                <rect x="5" y="5" width="14" height="14" rx="2" />
                              </svg>
                            ) : (
                              <svg
                                width="15"
                                height="15"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <line x1="12" y1="19" x2="12" y2="5" />
                                <polyline points="5 12 12 5 19 12" />
                              </svg>
                            )}
                          </span>
                        </button>
                      </div>
                    </div>
                  </div>
                </BorderBeam>
              )}
            </div>

            <p className="p11-subtext">
              ✦ <strong>Novedad de diseño:</strong> Los bordes biselados de las píldoras (
              <code>Agent</code>, <code>Auto</code>) aportan un relieve táctil sutil, mientras que el
              botón de envío luce una corona cromática 360° con aberración prismática y reflejo de luz
              ambiental. La <strong>barra cognitiva anclada</strong> mantiene el estado del Thinking
              Orb siempre a la vista sin desplazarse con el scroll.
            </p>
          </div>
        );
      }}
    </CompareScene>
  );
}
