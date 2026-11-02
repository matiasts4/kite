import type { CompareView } from '../../frame';
import { ButtonsMetalSection } from './ButtonsMetalSection';
import { ThinkingOrbsSection } from './ThinkingOrbsSection';
import { BotAvatarsSection } from './BotAvatarsSection';
import { ComposerBeamSection } from './ComposerBeamSection';
import { LiquidGooeySection } from './LiquidGooeySection';
import './librariesDev.css';

export function LibrariesDevPage({ view }: { view: CompareView }) {
  return (
    <div className="p11-page">
      {/* Hero introductorio */}
      <section className="p11-intro-hero">
        <span className="alab-eyebrow">11 · Libraries.dev Suite Showcase</span>
        <h2>Efectos y Componentes Diseñados para la Era de Agentes IA</h2>
        <p>
          Integración completa de la suite de Jakub Antalik (<code>Libraries.dev</code>).
          Cada efecto está diseñado como una capa que envuelve componentes React existentes,
          preservando la accesibilidad y semántica HTML mientras aporta materiales WebGL2,
          física líquida, avatares 3D procedurales y haces de luz reactivos.
        </p>
        <ul className="p11-badges-list">
          <li className="p11-badge-pill">border-beam</li>
          <li className="p11-badge-pill">thinking-orbs</li>
          <li className="p11-badge-pill">metal-fx</li>
          <li className="p11-badge-pill">bot-avatars</li>
          <li className="p11-badge-pill">voice-glow</li>
          <li className="p11-badge-pill">liquid-gooey</li>
        </ul>
      </section>

      {/* 11.1 Botones Metálicos & Border Beam */}
      <ButtonsMetalSection view={view} />

      {/* 11.2 Orbes Cognitivos del Agente */}
      <ThinkingOrbsSection view={view} />

      {/* 11.3 Avatares Vivos de Agentes */}
      <BotAvatarsSection view={view} />

      {/* 11.4 Composer Inteligente con BorderBeam & VoiceGlow */}
      <ComposerBeamSection view={view} />

      {/* 11.5 Fusión Líquida Gooey */}
      <LiquidGooeySection view={view} />
    </div>
  );
}
