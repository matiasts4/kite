import { useState } from 'react';
import { Liquid } from 'liquid-gooey';
import { CompareScene, type CompareVariant, type CompareView } from '../../frame';

export function LiquidGooeySection({ view }: { view: CompareView }) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedTool, setSelectedTool] = useState('Terminal');

  return (
    <CompareScene
      index="11.5"
      title="Superficies Líquidas y Menú Flotante (liquid-gooey)"
      target="liquid-gooey · Liquid & Liquid.Item"
      note="Componentes en contacto que se fusionan como metal líquido o mercurio, estirándose orgánicamente sin perder nitidez de texto."
      view={view}
      labels={{ kite: 'Kite Estándar', animate: 'Libraries.dev FX' }}
      meta={{ kite: 'Menú popover rígido', animate: 'Filtros SVG dinámicos · Fusión líquida' }}
    >
      {(mode: CompareVariant) => {
        if (mode === 'kite') {
          return (
            <div className="p11-showcase-box">
              <div className="p11-static-menu-wrapper">
                <button
                  type="button"
                  className="primary-button p11-fab-btn"
                  onClick={() => setIsOpen(!isOpen)}
                >
                  {isOpen ? '✕' : '＋'} Herramientas
                </button>
                {isOpen && (
                  <div className="p11-static-popup">
                    <button type="button" className="p11-popup-item">📟 Terminal</button>
                    <button type="button" className="p11-popup-item">🔍 Búsqueda</button>
                    <button type="button" className="p11-popup-item">🌿 Git Worktree</button>
                  </div>
                )}
              </div>
              <p className="p11-subtext">Menú desplegable tradicional con geometría rígida.</p>
            </div>
          );
        }

        return (
          <div className="p11-showcase-box">
            <div className="p11-controls-bar">
              <button
                type="button"
                className="p11-mini-btn p11-mini-btn--active"
                onClick={() => setIsOpen(!isOpen)}
              >
                {isOpen ? 'Colapsar Satélites' : 'Desplegar Satélites Líquidos'}
              </button>
              <span className="p11-subtext">
                Herramienta seleccionada: <strong>{selectedTool}</strong>
              </span>
            </div>

            {/* Grupo Líquido con Liquid y Liquid.Item */}
            <div className="p11-liquid-stage">
              <Liquid
                blur={7}
                contrast={18}
                fill="var(--vl-surface-raised, #18202c)"
                shadow="0 6px 20px rgba(0,0,0,0.35)"
              >
                {/* Botón Principal (Centro) */}
                <Liquid.Item
                  x={0}
                  y={0}
                  radius={24}
                  transition="bouncy"
                >
                  <button
                    type="button"
                    className="p11-liquid-main-btn"
                    onClick={() => setIsOpen(!isOpen)}
                  >
                    {isOpen ? '✕' : '＋'}
                  </button>
                </Liquid.Item>

                {/* Satélite 1: Terminal */}
                <Liquid.Item
                  x={isOpen ? -95 : 0}
                  y={isOpen ? -55 : 0}
                  radius={18}
                  transition="bouncy"
                >
                  <button
                    type="button"
                    className="p11-liquid-sat-btn"
                    onClick={() => {
                      setSelectedTool('Terminal');
                      setIsOpen(false);
                    }}
                    title="Terminal"
                  >
                    📟
                  </button>
                </Liquid.Item>

                {/* Satélite 2: Búsqueda */}
                <Liquid.Item
                  x={isOpen ? 0 : 0}
                  y={isOpen ? -85 : 0}
                  radius={18}
                  transition="bouncy"
                >
                  <button
                    type="button"
                    className="p11-liquid-sat-btn"
                    onClick={() => {
                      setSelectedTool('Búsqueda');
                      setIsOpen(false);
                    }}
                    title="Búsqueda"
                  >
                    🔍
                  </button>
                </Liquid.Item>

                {/* Satélite 3: Git */}
                <Liquid.Item
                  x={isOpen ? 95 : 0}
                  y={isOpen ? -55 : 0}
                  radius={18}
                  transition="bouncy"
                >
                  <button
                    type="button"
                    className="p11-liquid-sat-btn"
                    onClick={() => {
                      setSelectedTool('Git Worktree');
                      setIsOpen(false);
                    }}
                    title="Git Worktree"
                  >
                    🌿
                  </button>
                </Liquid.Item>
              </Liquid>
            </div>

            <p className="p11-subtext" style={{ textAlign: 'center', marginTop: 16 }}>
              Observa cómo los botones satélite se desprenden y vuelven a fusionarse fluidamente como gotas de mercurio al abrir o cerrar.
            </p>
          </div>
        );
      }}
    </CompareScene>
  );
}
