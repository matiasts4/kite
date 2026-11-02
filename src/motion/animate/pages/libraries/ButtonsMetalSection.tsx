import { useState } from 'react';
import { MetalFx, MetalBadge, MetalText, type MetalFxPreset } from 'metal-fx';
import { BorderBeam } from 'border-beam';
import { CompareScene, type CompareVariant, type CompareView } from '../../frame';

export function ButtonsMetalSection({ view }: { view: CompareView }) {
  const [preset, setPreset] = useState<MetalFxPreset>('chromatic');
  const [isPulseActive, setIsPulseActive] = useState(true);
  const [count, setCount] = useState(0);
  const [activePill, setActivePill] = useState<'agent' | 'auto'>('auto');
  const [radiusMode, setRadiusMode] = useState<'squircle' | 'pill' | 'technical'>('squircle');

  const radiusVars = {
    '--ld-pill-radius': radiusMode === 'pill' ? '9999px' : radiusMode === 'squircle' ? '10px' : '6px',
    '--ld-icon-btn-radius': radiusMode === 'pill' ? '50%' : radiusMode === 'squircle' ? '10px' : '6px',
    '--ld-chip-radius': radiusMode === 'pill' ? '50%' : radiusMode === 'squircle' ? '8px' : '4px',
  } as React.CSSProperties;

  return (
    <CompareScene
      index="11.1"
      title="Botones, Píldoras Glass y Anillos Prismáticos (Libraries.dev)"
      target="metal-fx · Glass Stadium · Chromatic Prism Ring"
      note="Bordes especulares con relieve sub-píxel, píldoras stadium con chips anidados y anillos con aberración cromática iridiscente."
      view={view}
      labels={{ kite: 'Kite Estándar', animate: 'Libraries.dev FX' }}
      meta={{ kite: 'Borde plano 1px · Near-black', animate: 'Bisel especular · Relieve glass · Prisma 360°' }}
    >
      {(mode: CompareVariant) => {
        if (mode === 'kite') {
          return (
            <div className="p11-showcase-box">
              <div className="p11-button-row">
                <button
                  type="button"
                  className="primary-button p11-demo-btn"
                  onClick={() => setCount((c) => c + 1)}
                >
                  Ejecutar Agente ({count})
                </button>
                <button type="button" className="secondary-button p11-demo-btn">
                  Acción Secundaria
                </button>
                <span className="p11-kite-badge">Pro</span>
              </div>
              <div className="p11-title-sample">
                <span className="p11-sample-headline">Autonomous Agent Engine</span>
                <p className="p11-subtext">Estilo visual estándar de Kite con gradiente near-black y foco azul.</p>
              </div>
            </div>
          );
        }

        return (
          <div className="p11-showcase-box">
            {/* Controles interactivos */}
            <div className="p11-controls-bar">
              <span className="p11-label">Preset Metal:</span>
              <div className="p11-segmented">
                {(['chromatic', 'silver', 'gold'] as MetalFxPreset[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`p11-seg-btn ${preset === p ? 'p11-seg-btn--active' : ''}`}
                    onClick={() => setPreset(p)}
                  >
                    {p}
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
                  ] as ['squircle' | 'pill' | 'technical', string][]
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

              <label className="p11-checkbox-label">
                <input
                  type="checkbox"
                  checked={isPulseActive}
                  onChange={(e) => setIsPulseActive(e.target.checked)}
                />
                Pulse Glow Activo
              </label>
            </div>

            {/* Fila 1: Píldoras Glass & Anillo Prismático (Imágenes 1 y 2) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, ...radiusVars }}>
              <div className="p11-label" style={{ color: '#38bdf8' }}>
                ✦ Píldoras Stadium Glass & Botón de Envío Cromático (Libraries.dev):
              </div>

              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                {/* Botón circular Plus (Imagen 1) */}
                <button
                  type="button"
                  className="ld-circle-btn"
                  title="Adjuntar o acción rápida (+)"
                  onClick={() => setCount((c) => c + 1)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>

                {/* Píldora Stadium Glass: Agent v (Imagen 1) */}
                <button
                  type="button"
                  className={`ld-glass-pill ${activePill === 'agent' ? 'ld-glass-pill--active' : ''}`}
                  onClick={() => setActivePill('agent')}
                  title="Selector de modo"
                >
                  <span>Agent</span>
                  <svg className="ld-glass-pill__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>

                {/* Píldora Stadium Glass: Auto v (Imagen 1) */}
                <button
                  type="button"
                  className={`ld-glass-pill ${activePill === 'auto' ? 'ld-glass-pill--active' : ''}`}
                  onClick={() => setActivePill('auto')}
                  title="Selector de modelo"
                >
                  <span>Auto</span>
                  <svg className="ld-glass-pill__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>

                {/* Botón Circular Cromático Prismático Send (Imagen 1) */}
                <button
                  type="button"
                  className="ld-chromatic-btn"
                  title="Enviar prompt (Anillo cromático iridiscente)"
                  onClick={() => setCount((c) => c + 1)}
                >
                  <span className="ld-chromatic-btn__ring" />
                  <span className="ld-chromatic-btn__glow" />
                  <span className="ld-chromatic-btn__core">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="19" x2="12" y2="5" />
                      <polyline points="5 12 12 5 19 12" />
                    </svg>
                  </span>
                </button>

                {/* Píldora Anidada con Chip de Icono (Imagen 2: Gooey Project 45 files) */}
                <div className="ld-nested-pill" title="Píldora anidada de proyecto">
                  <div className="ld-nested-pill__chip">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                  </div>
                  <span className="ld-nested-pill__title">Gooey Project</span>
                  <span className="ld-nested-pill__meta">45 files</span>
                </div>
              </div>
            </div>

            {/* Fila 2: Botones MetalFx & BorderBeam */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 6 }}>
              <div className="p11-label" style={{ color: '#94a3b8' }}>
                Acciones Metal WebGL2 & Badge:
              </div>
              <div className="p11-button-row">
                <MetalFx variant="button" preset={preset} strength={1}>
                  <button
                    type="button"
                    className="primary-button p11-demo-btn p11-metal-btn"
                    onClick={() => setCount((c) => c + 1)}
                  >
                    ✨ Ejecutar Agente ({count})
                  </button>
                </MetalFx>

                <BorderBeam
                  size="pulse-inner"
                  colorVariant={preset === 'gold' ? 'gold' : 'colorful'}
                  active={isPulseActive}
                  borderRadius={8}
                >
                  <button type="button" className="secondary-button p11-demo-btn p11-beam-btn">
                    ⚡ Acción Destacada
                  </button>
                </BorderBeam>

                <MetalBadge scale={1.15}>Pro</MetalBadge>
              </div>
            </div>

            {/* Texto Líquido Metal */}
            <div className="p11-title-sample">
              <MetalText
                font="600 21px/1.2 system-ui, -apple-system, sans-serif"
                color="#f0f3f8"
              >
                Autonomous Agent Engine
              </MetalText>
              <p className="p11-subtext">
                Bordes biselados con reflejo de luz ambiental, relieve interior y aberración cromática inspirados en Libraries.dev.
              </p>
            </div>
          </div>
        );
      }}
    </CompareScene>
  );
}
