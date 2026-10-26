import { useState } from 'react';
import { BotAvatar, type BotAvatarType, type BotAvatarState, type BotAvatarShading } from 'bot-avatars';
import { CompareScene, type CompareVariant, type CompareView } from '../../frame';

export function BotAvatarsSection({ view }: { view: CompareView }) {
  const [activeType, setActiveType] = useState<BotAvatarType>('droid');
  const [activeState, setActiveState] = useState<BotAvatarState>('working');
  const [shading, setShading] = useState<BotAvatarShading>('fabric');
  const [hasHeadphones, setHasHeadphones] = useState(false);
  const [hasGlasses, setHasGlasses] = useState(false);

  return (
    <CompareScene
      index="11.3"
      title="Avatares Vivos de Agentes (bot-avatars)"
      target="bot-avatars · BotAvatar"
      note="Personajes 3D vivos renderizados sobre Canvas 2D (sin WebGL ni dependencias pesadas), con miradas, parpadeos y saltos al interactuar."
      view={view}
      labels={{ kite: 'Kite Estándar', animate: 'Libraries.dev FX' }}
      meta={{ kite: 'Iconos SVG estáticos', animate: 'Canvas 2D procedimental · 3D rig' }}
    >
      {(mode: CompareVariant) => {
        if (mode === 'kite') {
          return (
            <div className="p11-showcase-box">
              <div className="p11-roster-stack">
                <div className="p11-static-agent-card">
                  <div className="p11-static-avatar">🤖</div>
                  <div>
                    <strong>Architect Agent</strong>
                    <div className="p11-subtext">Estado: Ejecutando tarea (icono estático)</div>
                  </div>
                </div>
                <div className="p11-static-agent-card">
                  <div className="p11-static-avatar">🔍</div>
                  <div>
                    <strong>Researcher Agent</strong>
                    <div className="p11-subtext">Estado: Esperando consulta</div>
                  </div>
                </div>
                <div className="p11-static-agent-card">
                  <div className="p11-static-avatar">🛡️</div>
                  <div>
                    <strong>Reviewer Agent</strong>
                    <div className="p11-subtext">Estado: Inactivo</div>
                  </div>
                </div>
              </div>
            </div>
          );
        }

        return (
          <div className="p11-showcase-box">
            {/* Controles del avatar */}
            <div className="p11-controls-bar">
              <span className="p11-label">Tipo:</span>
              <div className="p11-segmented">
                {(['droid', 'clover', 'ghost', 'cat', 'star'] as BotAvatarType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={`p11-seg-btn ${activeType === t ? 'p11-seg-btn--active' : ''}`}
                    onClick={() => setActiveType(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>

              <span className="p11-label">Estado:</span>
              <div className="p11-segmented">
                {(['default', 'working', 'sleeping'] as BotAvatarState[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`p11-seg-btn ${activeState === s ? 'p11-seg-btn--active' : ''}`}
                    onClick={() => setActiveState(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>

              <span className="p11-label">Acabado:</span>
              <div className="p11-segmented">
                {(['fabric', 'plastic', 'crisp'] as BotAvatarShading[]).map((sh) => (
                  <button
                    key={sh}
                    type="button"
                    className={`p11-seg-btn ${shading === sh ? 'p11-seg-btn--active' : ''}`}
                    onClick={() => setShading(sh)}
                  >
                    {sh}
                  </button>
                ))}
              </div>
            </div>

            {/* Stage del Avatar interactivo */}
            <div className="p11-avatar-stage">
              <div className="p11-avatar-hero">
                <BotAvatar
                  type={activeType}
                  state={activeState}
                  shading={shading}
                  size={100}
                  headphones={hasHeadphones}
                  glasses={hasGlasses ? 'round' : 'none'}
                  interactive={true}
                />
                <span className="p11-click-hint">¡Haz clic sobre él para hacerlo saltar! 🐾</span>
              </div>
              <div className="p11-avatar-options">
                <label className="p11-checkbox-label">
                  <input
                    type="checkbox"
                    checked={hasHeadphones}
                    onChange={(e) => setHasHeadphones(e.target.checked)}
                  />
                  Auriculares
                </label>
                <label className="p11-checkbox-label">
                  <input
                    type="checkbox"
                    checked={hasGlasses}
                    onChange={(e) => setHasGlasses(e.target.checked)}
                  />
                  Gafas redondas
                </label>
              </div>
            </div>

            {/* Roster de agentes con avatares reales */}
            <div className="p11-roster-stack">
              <div className="p11-live-agent-card">
                <BotAvatar type="droid" state="working" size={48} shading="plastic" />
                <div className="p11-agent-info">
                  <div className="p11-agent-name-row">
                    <strong>Architect Agent</strong>
                    <span className="p11-badge-status p11-badge-status--busy">Trabajando</span>
                  </div>
                  <span className="p11-subtext">Generando estructura de subagentes en segundo plano...</span>
                </div>
              </div>

              <div className="p11-live-agent-card">
                <BotAvatar type="clover" state="default" glasses="round" size={48} shading="fabric" />
                <div className="p11-agent-info">
                  <div className="p11-agent-name-row">
                    <strong>Researcher Agent</strong>
                    <span className="p11-badge-status p11-badge-status--ready">Atento</span>
                  </div>
                  <span className="p11-subtext">Listo para indexar repositorios y documentación.</span>
                </div>
              </div>

              <div className="p11-live-agent-card">
                <BotAvatar type="ghost" state="sleeping" headphones size={48} shading="fabric" />
                <div className="p11-agent-info">
                  <div className="p11-agent-name-row">
                    <strong>Reviewer Agent</strong>
                    <span className="p11-badge-status p11-badge-status--sleep">En reposo</span>
                  </div>
                  <span className="p11-subtext">Se activará automáticamente al terminar la fase de código.</span>
                </div>
              </div>
            </div>
          </div>
        );
      }}
    </CompareScene>
  );
}
