import { useState } from 'react';
import { motion } from 'motion/react';
import { BorderBeam } from 'border-beam';
import { ThinkingOrb } from 'thinking-orbs';
import { springs, scale } from '../../../standard/tokens';
import { CompareScene, type CompareVariant, type CompareView } from '../../frame';
import './stadiumDesign.css';

/* -------------------------------------------------------------------------- */
/* Icons                                                                      */
/* -------------------------------------------------------------------------- */

function CopyIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function ArrowUpIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

function ArrowLeftIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  );
}

function ArrowRightIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  );
}

function SparklesIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </svg>
  );
}

function CheckIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export function StadiumButtonsSection({ view }: { view: CompareView }) {
  const [radiusMode, setRadiusMode] = useState<'stadium' | 'squircle' | 'technical'>('stadium');
  const [activeMode, setActiveMode] = useState<'agent' | 'code' | 'chat'>('agent');
  const [controlTab, setControlTab] = useState<'manual' | 'agent'>('manual');
  const [family, setFamily] = useState<'rotate' | 'pulse'>('rotate');
  const [beamType, setBeamType] = useState<'large' | 'small' | 'line'>('line');
  const [colorTheme, setColorTheme] = useState<
    'colorful' | 'mono' | 'ocean' | 'sunset' | 'forest' | 'candy' | 'ice' | 'gold'
  >('colorful');
  const [isPaused, setIsPaused] = useState(false);
  const [copied, setCopied] = useState(false);

  const [beamColorMode, setBeamColorMode] = useState<
    'dynamic' | 'colorful' | 'ocean' | 'sunset' | 'ice'
  >('dynamic');

  const MODE_META = {
    agent: {
      label: 'Agent',
      tag: 'Autonomía & Memoria',
      desc: 'Delega tareas complejas a agentes con herramientas de terminal, MCP y memoria persistente.',
    },
    code: {
      label: 'Code',
      tag: 'Workspace & Paneles',
      desc: 'Entorno de trabajo en carpetas, edición con terminales paralelos y diffs en vivo.',
    },
    chat: {
      label: 'Thread',
      tag: 'Conversación Rápida',
      desc: 'Hilos ágiles de preguntas y respuestas con streaming palabra por palabra.',
    },
  };

  const MODE_THEMES = {
    agent: {
      beam: 'ocean' as const,
      name: 'Ocean (Cian & Violeta Eléctrico)',
      badgeBg: 'rgba(56, 189, 248, 0.12)',
      badgeColor: '#38bdf8',
      badgeBorder: 'rgba(56, 189, 248, 0.28)',
    },
    code: {
      beam: 'ice' as const,
      name: 'Ice Mint (Menta & Esmeralda)',
      badgeBg: 'rgba(45, 212, 191, 0.12)',
      badgeColor: '#2dd4bf',
      badgeBorder: 'rgba(45, 212, 191, 0.28)',
    },
    chat: {
      beam: 'sunset' as const,
      name: 'Sunset (Coral & Ámbar Cálido)',
      badgeBg: 'rgba(244, 63, 94, 0.12)',
      badgeColor: '#fb7185',
      badgeBorder: 'rgba(244, 63, 94, 0.28)',
    },
  };

  const getEffectiveBeamColor = (mode: 'agent' | 'code' | 'chat') => {
    if (beamColorMode === 'dynamic') {
      return MODE_THEMES[mode].beam;
    }
    return beamColorMode;
  };

  const handleCopy = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="stadium-showcase stadium-root" data-radius={radiusMode}>
      <CompareScene
        index="1.0"
        title="Rediseño Stadium Pill & Obsidian Glass (Inspirado en Libraries.dev)"
        target="Stadium Pill (9999px) · Squircle (12px) · Obsidian Glass · Bisel Especular"
        note="El salto estético hacia el diseño de libraries.dev: botones en forma de cápsula continua, superficies de obsidiana con bisel sub-píxel superior, chips de selección y paneles de control redondeados."
        view={view}
        labels={{ kite: 'Kite Previo (8px Rectangular)', animate: 'Rediseño Stadium & Glass' }}
        meta={{
          kite: 'Radio 8px · Estilo técnico plano',
          animate: 'Píldoras 9999px · Bisel 1px · Obsidian Satin',
        }}
      >
        {(mode: CompareVariant) => {
          if (mode === 'kite') {
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {/* Visual anterior de Kite */}
                <div
                  style={{
                    padding: 20,
                    borderRadius: 8,
                    background: '#161b22',
                    border: '1px solid #30363d',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 16,
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#f0f6fc' }}>
                    Estructura previa de Kite (Esquinas técnicas de 8px)
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <button type="button" className="primary-button" style={{ height: 32 }}>
                      <CopyIcon /> Copiar prompt
                    </button>
                    <button type="button" className="secondary-button" style={{ height: 32 }}>
                      Ajustes del agente
                    </button>
                    <button type="button" className="ghost-button" style={{ height: 32 }}>
                      Cancelar
                    </button>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <span style={{ fontSize: 12, color: '#8b949e' }}>Filtro:</span>
                    <span
                      style={{
                        padding: '4px 10px',
                        borderRadius: 6,
                        background: '#21262d',
                        border: '1px solid #30363d',
                        fontSize: 11,
                        color: '#c9d1d9',
                      }}
                    >
                      Rotate
                    </span>
                    <span
                      style={{
                        padding: '4px 10px',
                        borderRadius: 6,
                        background: 'transparent',
                        border: '1px solid #30363d',
                        fontSize: 11,
                        color: '#8b949e',
                      }}
                    >
                      Pulse
                    </span>
                  </div>
                </div>

                {/* Tarjeta de estado previa */}
                <div
                  style={{
                    padding: 16,
                    borderRadius: 8,
                    background: '#11151c',
                    border: '1px solid #28303d',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <div
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: '50%',
                      border: '2px solid #58a6ff',
                      borderTopColor: 'transparent',
                    }}
                  />
                  <span style={{ fontSize: 12, color: '#8b949e' }}>Pensando respuesta...</span>
                </div>
              </div>
            );
          }

          // Rediseño Stadium & Obsidian Glass
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {/* Barra de control de curvatura interactiva */}
              <div className="stadium-header-bar">
                <div className="stadium-header-title">
                  <span>Modo de Geometría:</span>
                  <span className="badge">
                    {radiusMode === 'stadium'
                      ? 'Píldora Stadium (9999px)'
                      : radiusMode === 'squircle'
                        ? 'Squircle Suave (12px)'
                        : 'Técnico (8px)'}
                  </span>
                </div>

                <div className="stadium-curvature-group">
                  {(['stadium', 'squircle', 'technical'] as const).map((r) => {
                    const isSelected = radiusMode === r;
                    const label =
                      r === 'stadium'
                        ? 'Píldora (9999px) ⭐'
                        : r === 'squircle'
                          ? 'Squircle (12px)'
                          : 'Técnico (8px)';
                    return (
                      <motion.button
                        key={r}
                        type="button"
                        whileTap={{ scale: scale.choice }}
                        className={`stadium-curvature-btn ${isSelected ? 'active' : ''}`}
                        onClick={() => setRadiusMode(r)}
                      >
                        {isSelected && (
                          <motion.span
                            layoutId="stadium-curvature-indicator"
                            className="stadium-sliding-thumb"
                            transition={springs.selection}
                            initial={false}
                            aria-hidden="true"
                          />
                        )}
                        <span className="stadium-label-z">{label}</span>
                      </motion.button>
                    );
                  })}
                </div>
              </div>

              {/* Conmutador Superior Stadium Pill: Agent · Code · Thread (TitleBar Redesign con Animated UI) */}
              <div className="stadium-mode-card">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#f8fafc' }}>
                      Conmutador Superior Stadium Pill (TitleBar: Agent · Code · Thread)
                    </div>
                    <div style={{ fontSize: 12, color: '#8b949e', marginTop: 2 }}>
                      Estándar Animated UI: deslizamiento continuo con springs.selection ({springs.selection.stiffness}/{springs.selection.damping}), whileTap={scale.press} y haz luminoso perimetral.
                    </div>
                  </div>

                  {/* Track de Modos con Animación Animated UI + Borde Beam */}
                  <div className="stadium-mode-track" role="tablist" aria-label="Selector de modo">
                    {(['agent', 'code', 'chat'] as const).map((m) => {
                      const meta = MODE_META[m];
                      const isActive = activeMode === m;
                      const beamColor = getEffectiveBeamColor(m);

                      return (
                        <motion.button
                          key={m}
                          type="button"
                          role="tab"
                          aria-selected={isActive}
                          whileTap={{ scale: scale.press }}
                          className={`stadium-mode-btn ${isActive ? 'active' : ''}`}
                          onClick={() => setActiveMode(m)}
                        >
                          {isActive && (
                            <motion.div
                              layoutId="stadium-mode-indicator-layer"
                              className="stadium-mode-indicator-layer"
                              transition={springs.selection}
                              initial={false}
                              aria-hidden="true"
                              data-mode={m}
                              data-color={beamColor}
                            >
                              <BorderBeam
                                size="sm"
                                colorVariant={beamColor}
                                borderRadius={9999}
                                active
                              >
                                <div className="stadium-mode-pill-backdrop" />
                              </BorderBeam>
                            </motion.div>
                          )}
                          <span className="stadium-mode-btn-text">{meta.label}</span>
                        </motion.button>
                      );
                    })}
                  </div>
                </div>

                {/* Selector de Paleta de Animación de Colores */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingTop: 4 }}>
                  <span style={{ fontSize: 11.5, color: '#8b949e', fontWeight: 500 }}>
                    Paleta del Haz (libraries.dev):
                  </span>
                  <div style={{ display: 'inline-flex', gap: 4, padding: 2, background: 'rgba(0,0,0,0.4)', borderRadius: 9999, border: '1px solid rgba(255,255,255,0.06)' }}>
                    {[
                      { id: 'dynamic', label: '✨ Dinámico por Modo' },
                      { id: 'colorful', label: '🌈 Colorful Spectrum' },
                      { id: 'ocean', label: '🌊 Ocean' },
                      { id: 'ice', label: '❄️ Ice Mint' },
                      { id: 'sunset', label: '🌅 Sunset' },
                    ].map((opt) => (
                      <motion.button
                        key={opt.id}
                        type="button"
                        whileTap={{ scale: scale.choice }}
                        className={`stadium-curvature-btn ${beamColorMode === opt.id ? 'active' : ''}`}
                        style={{ fontSize: 11, padding: '3px 10px' }}
                        onClick={() => setBeamColorMode(opt.id as any)}
                      >
                        {beamColorMode === opt.id && (
                          <motion.span
                            layoutId="stadium-beam-palette-indicator"
                            className="stadium-sliding-thumb"
                            transition={springs.selection}
                            initial={false}
                            aria-hidden="true"
                          />
                        )}
                        <span className="stadium-label-z">{opt.label}</span>
                      </motion.button>
                    ))}
                  </div>
                </div>

                {/* Caja de descripción del modo activo */}
                <div className="stadium-mode-desc-box">
                  <div className="stadium-mode-desc-text">
                    <strong style={{ color: '#f1f5f9' }}>{MODE_META[activeMode].label}:</strong>{' '}
                    {MODE_META[activeMode].desc}
                    <span style={{ marginLeft: 8, fontSize: 11, color: '#64748b' }}>
                      • Haz activo:{' '}
                      <strong style={{ color: MODE_THEMES[activeMode].badgeColor }}>
                        {beamColorMode === 'dynamic' ? MODE_THEMES[activeMode].name : beamColorMode.toUpperCase()}
                      </strong>
                    </span>
                  </div>
                  <span
                    className="stadium-mode-desc-tag"
                    style={{
                      background: MODE_THEMES[activeMode].badgeBg,
                      color: MODE_THEMES[activeMode].badgeColor,
                      borderColor: MODE_THEMES[activeMode].badgeBorder,
                    }}
                  >
                    {MODE_META[activeMode].tag}
                  </span>
                </div>

                {/* Mockup de Integración Completa en Barra Superior */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Vista en Contexto de la Barra de Título (TitleBar)
                  </div>
                  <div className="stadium-header-mockup">
                    {/* Lado Izquierdo */}
                    <div className="stadium-mockup-left">
                      <div className="stadium-mockup-brand">
                        <div
                          style={{
                            width: 20,
                            height: 20,
                            borderRadius: 6,
                            background: 'linear-gradient(135deg, #0ea5e9, #6366f1)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: '#fff',
                            fontSize: 10,
                            fontWeight: 800,
                          }}
                        >
                          K
                        </div>
                        <span>Kite</span>
                      </div>
                      <motion.button
                        type="button"
                        whileTap={{ scale: scale.press }}
                        className="stadium-btn stadium-btn--secondary"
                        style={{ padding: '4px 10px', fontSize: 11, height: 26 }}
                      >
                        Sidebar
                      </motion.button>
                    </div>

                    {/* Centro: El Conmutador Stadium con Borde Animado y Animated UI */}
                    <div className="stadium-mode-track">
                      {(['agent', 'code', 'chat'] as const).map((m) => {
                        const meta = MODE_META[m];
                        const isActive = activeMode === m;
                        const beamColor = getEffectiveBeamColor(m);

                        return (
                          <motion.button
                            key={m}
                            type="button"
                            whileTap={{ scale: scale.press }}
                            className={`stadium-mode-btn ${isActive ? 'active' : ''}`}
                            style={{ padding: '4px 16px', fontSize: 12, minWidth: 70 }}
                            onClick={() => setActiveMode(m)}
                          >
                            {isActive && (
                              <motion.div
                                layoutId="stadium-titlebar-mock-indicator"
                                className="stadium-mode-indicator-layer"
                                transition={springs.selection}
                                initial={false}
                                aria-hidden="true"
                                data-mode={m}
                                data-color={beamColor}
                              >
                                <BorderBeam
                                  size="sm"
                                  colorVariant={beamColor}
                                  borderRadius={9999}
                                  active
                                >
                                  <div className="stadium-mode-pill-backdrop" />
                                </BorderBeam>
                              </motion.div>
                            )}
                            <span className="stadium-mode-btn-text">{meta.label}</span>
                          </motion.button>
                        );
                      })}
                    </div>

                    {/* Lado Derecho: Badges en Píldora */}
                    <div className="stadium-mockup-right">
                      <span className="stadium-pill-badge">
                        <span className="dot" />
                        CPU 12% · 4.2GB
                      </span>
                      <span className="stadium-pill-badge quota">
                        <span className="dot" />
                        Ultra · 82%
                      </span>
                      <motion.button
                        type="button"
                        whileTap={{ scale: scale.press }}
                        className="stadium-btn stadium-btn--stone"
                        style={{ padding: '4px 12px', fontSize: 11, height: 26, gap: 5 }}
                      >
                        <SparklesIcon size={12} /> Zed
                      </motion.button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Panel de Control Interactivo (Réplica del modal de Libraries.dev) */}
              <div className="stadium-modal-card">
                {/* Cabecera del modal */}
                <div className="stadium-modal-topbar">
                  <div className="stadium-segmented-capsule">
                    {(['manual', 'agent'] as const).map((t) => {
                      const isSelected = controlTab === t;
                      const label = t === 'manual' ? 'Manual controls' : 'Agent';
                      return (
                        <motion.button
                          key={t}
                          type="button"
                          whileTap={{ scale: scale.choice }}
                          className={`stadium-segmented-item ${isSelected ? 'active' : ''}`}
                          onClick={() => setControlTab(t)}
                        >
                          {isSelected && (
                            <motion.span
                              layoutId="stadium-modal-tab-indicator"
                              className="stadium-sliding-thumb"
                              transition={springs.selection}
                              initial={false}
                              aria-hidden="true"
                            />
                          )}
                          <span className="stadium-label-z">{label}</span>
                        </motion.button>
                      );
                    })}
                  </div>

                  <div className="stadium-actions-row">
                    <motion.button
                      type="button"
                      whileTap={{ scale: scale.press }}
                      className="stadium-btn stadium-btn--primary"
                      onClick={handleCopy}
                    >
                      {copied ? <CheckIcon /> : <CopyIcon />}
                      {copied ? 'Copiado!' : 'Copy prompt'}
                    </motion.button>

                    <motion.button
                      type="button"
                      whileTap={{ scale: scale.press }}
                      className="stadium-circle-btn"
                      title="Presets"
                      aria-label="Presets"
                    >
                      <SparklesIcon />
                    </motion.button>
                  </div>
                </div>

                {/* Cuerpo del modal (Canvas + Panel de Opciones) */}
                <div className="stadium-modal-body">
                  {/* Canvas de Preview en vivo con BorderBeam */}
                  <div className="stadium-canvas">
                    <BorderBeam
                      size={beamType === 'line' ? 'line' : beamType === 'small' ? 'sm' : 'md'}
                      colorVariant={colorTheme}
                      borderRadius={16}
                      active={!isPaused}
                    >
                      <div className="stadium-canvas-card">
                        <div className="stadium-skeleton-line short" />
                        <div className="stadium-skeleton-line mid" />
                        <div className="stadium-skeleton-line" />
                      </div>
                    </BorderBeam>

                    <div className="stadium-canvas-footer">
                      <button
                        type="button"
                        className="stadium-btn stadium-btn--secondary"
                        onClick={() => setIsPaused((p) => !p)}
                      >
                        {isPaused ? 'Resume' : 'Pause'}
                      </button>
                    </div>
                  </div>

                  {/* Panel de Controles lateral */}
                  <div className="stadium-controls-panel">
                    {/* Family */}
                    <div className="stadium-control-group">
                      <span className="stadium-group-label">Family</span>
                      <div className="stadium-chips-grid">
                        {(['rotate', 'pulse'] as const).map((f) => (
                          <button
                            key={f}
                            type="button"
                            className={`stadium-chip ${family === f ? 'active' : 'inactive'}`}
                            onClick={() => setFamily(f)}
                          >
                            {f.charAt(0).toUpperCase() + f.slice(1)}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Type */}
                    <div className="stadium-control-group">
                      <span className="stadium-group-label">Type</span>
                      <div className="stadium-chips-grid">
                        {(['large', 'small', 'line'] as const).map((t) => (
                          <button
                            key={t}
                            type="button"
                            className={`stadium-chip ${beamType === t ? 'active' : 'inactive'}`}
                            onClick={() => setBeamType(t)}
                          >
                            {t.charAt(0).toUpperCase() + t.slice(1)}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Color Theme */}
                    <div className="stadium-control-group">
                      <span className="stadium-group-label">Color theme</span>
                      <div className="stadium-chips-grid">
                        {(
                          ['colorful', 'mono', 'ocean', 'sunset', 'forest', 'candy', 'ice', 'gold'] as const
                        ).map((c) => (
                          <button
                            key={c}
                            type="button"
                            className={`stadium-chip ${colorTheme === c ? 'active' : 'inactive'}`}
                            onClick={() => setColorTheme(c)}
                          >
                            {c.charAt(0).toUpperCase() + c.slice(1)}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Catálogo de Botones y Formas Stadium */}
              <div
                style={{
                  padding: 22,
                  borderRadius: 'var(--stadium-card-radius)',
                  background: '#13161e',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 16,
                }}
              >
                <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f8fafc' }}>
                  Familia de Botones Stadium & Acciones (Acabado Satin Matte)
                </div>

                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                  <motion.button
                    type="button"
                    whileTap={{ scale: scale.press }}
                    className="stadium-btn stadium-btn--primary"
                    title="Píldora Primaria sin halos ni brillos en los bordes"
                  >
                    <SparklesIcon /> Acción Principal
                  </motion.button>

                  <motion.button
                    type="button"
                    whileTap={{ scale: scale.press }}
                    className="stadium-btn stadium-btn--stone"
                    title="Estilo piedra flotante suave"
                  >
                    <CopyIcon /> Píldora Pebble Stone
                  </motion.button>

                  <div className="stadium-btn--beam-wrap">
                    <BorderBeam size="line" colorVariant="ocean" borderRadius={9999} active>
                      <motion.button
                        type="button"
                        whileTap={{ scale: scale.press }}
                        className="stadium-btn stadium-btn--primary"
                      >
                        Con Borde Beam
                      </motion.button>
                    </BorderBeam>
                  </div>

                  <motion.button
                    type="button"
                    whileTap={{ scale: scale.press }}
                    className="stadium-btn stadium-btn--secondary"
                  >
                    Secundario Satin
                  </motion.button>

                  <motion.button
                    type="button"
                    whileTap={{ scale: scale.press }}
                    className="stadium-btn stadium-btn--ghost"
                  >
                    Ghost Link
                  </motion.button>

                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginLeft: 'auto' }}>
                    <motion.button
                      type="button"
                      whileTap={{ scale: scale.icon }}
                      className="stadium-circle-btn"
                      aria-label="Atrás"
                    >
                      <ArrowLeftIcon />
                    </motion.button>
                    <motion.button
                      type="button"
                      whileTap={{ scale: scale.icon }}
                      className="stadium-circle-btn"
                      aria-label="Adelante"
                    >
                      <ArrowRightIcon />
                    </motion.button>
                    <motion.button
                      type="button"
                      whileTap={{ scale: scale.icon }}
                      className="stadium-circle-btn"
                      aria-label="Enviar"
                      style={{ background: 'linear-gradient(180deg, #242a38, #131720)' }}
                    >
                      <ArrowUpIcon />
                    </motion.button>
                  </div>
                </div>
              </div>

              {/* Píldoras Flotantes de Estado AI (de la Imagen 4 de Thinking Orbs) */}
              <div
                style={{
                  padding: 22,
                  borderRadius: 'var(--stadium-card-radius)',
                  background: '#11141b',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 16,
                }}
              >
                <div style={{ fontSize: 13.5, fontWeight: 600, color: '#f8fafc' }}>
                  Píldoras Flotantes de Estado de Agente (Thinking Orbs)
                </div>

                <div className="stadium-ai-pills-row">
                  <div className="stadium-floating-pill">
                    <ThinkingOrb state="solving" size={20} />
                    <span>Solving....</span>
                  </div>

                  <div className="stadium-floating-pill">
                    <ThinkingOrb state="weaving" size={20} />
                    <span>Thinking....</span>
                  </div>

                  <div className="stadium-floating-pill">
                    <ThinkingOrb state="listening" size={20} />
                    <span>Agent listening...</span>
                  </div>

                  <div className="stadium-floating-pill">
                    <ThinkingOrb state="working" size={20} />
                    <span>Working....</span>
                  </div>
                </div>
              </div>

              {/* Tarjetas de Onboarding / Features (de la Imagen 2) */}
              <div className="stadium-feature-grid">
                <div className="stadium-feature-card">
                  <span className="stadium-badge-num">1</span>
                  <h3 className="stadium-feature-title">Copy the prompt</h3>
                  <p className="stadium-feature-desc">
                    Every library page has a Copy prompt button. One paste gives your agent the whole
                    library.
                  </p>
                  <div className="stadium-feature-snippet">
                    <button type="button" className="stadium-btn stadium-btn--primary">
                      <CopyIcon /> Copy prompt
                    </button>
                  </div>
                </div>

                <div className="stadium-feature-card">
                  <span className="stadium-badge-num">2</span>
                  <h3 className="stadium-feature-title">Make it yours</h3>
                  <p className="stadium-feature-desc">
                    Open the Studio for every knob, tune it live and copy the result as props.
                  </p>
                  <div className="stadium-feature-snippet">
                    <button type="button" className="stadium-btn stadium-btn--secondary">
                      Make it more subtle
                    </button>
                  </div>
                </div>
              </div>
            </div>
          );
        }}
      </CompareScene>
    </div>
  );
}
