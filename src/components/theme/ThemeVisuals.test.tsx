import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DIFF_SURFACE_THEME_UNSAFE_CSS } from '../../lib/diffs/diffRendering';
import { render, screen } from '@testing-library/react';
import { StageBackdrop } from './StageBackdrop';
import { ThemeHeroFigure } from './ThemeHeroFigure';
import { ChatHome } from '../views/chat/ChatHome';
import { ChatView } from '../views/ChatView';
import { CodeHome } from '../code/CodeHome';
import { WorkspaceEmptyLauncher } from '../code/WorkspaceEmptyLauncher';
import {
  DEFAULT_THEME_CUSTOMIZATIONS,
  applyThemeCustomizationsToDocument,
  sanitizeThemeCustomizations,
  writeThemeCustomizations,
  type ConcreteBackdropPresetId,
} from '../../lib/themeCustomizations';

vi.mock('../views/chat/useChatSession', () => ({
  useChatSession: () => ({
    isLoadingInitial: false,
    gridThreadIds: [],
    handleCreateNewThread: vi.fn(),
  }),
}));

describe('StageBackdrop & ThemeHeroFigure visual components', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-motion');
  });

  it('renders StageBackdrop preset scenes, custom image, dimming, blur, and film grain', () => {
    const auroraState = sanitizeThemeCustomizations({
      ...DEFAULT_THEME_CUSTOMIZATIONS,
      darkThemeId: 'aurora-studio',
      backdrop: {
        preset: 'theme-default',
        customImageUrl: '',
        dimming: 35,
        blur: 8,
        grain: true,
      },
    });

    const { rerender } = render(<StageBackdrop customizations={auroraState} />);
    const backdrop = screen.getByTestId('stage-backdrop');
    expect(backdrop.getAttribute('data-backdrop-preset')).toBe('aurora-mesh');
    expect(backdrop.getAttribute('data-grain')).toBe('true');
    expect(screen.getByTestId('stage-backdrop-scene-aurora-mesh')).toBeTruthy();

    const customImageState = sanitizeThemeCustomizations({
      ...DEFAULT_THEME_CUSTOMIZATIONS,
      backdrop: {
        preset: 'custom-image',
        customImageUrl: 'https://example.com/wallpaper.png',
        dimming: 50,
        blur: 14,
        grain: false,
      },
    });

    rerender(<StageBackdrop customizations={customImageState} />);
    expect(backdrop.getAttribute('data-backdrop-preset')).toBe('custom-image');
    const customImg = screen.getByTestId('stage-backdrop-custom-image');
    expect(customImg.getAttribute('style')).toContain('https://example.com/wallpaper.png');
  });

  it('renders watermark figure on StageBackdrop when showWatermark is enabled', () => {
    const watermarkState = sanitizeThemeCustomizations({
      ...DEFAULT_THEME_CUSTOMIZATIONS,
      backdrop: {
        ...DEFAULT_THEME_CUSTOMIZATIONS.backdrop,
        preset: 'alpine-dusk',
      },
      figure: {
        style: 'pixel-companion',
        showWatermark: true,
      },
    });

    render(<StageBackdrop customizations={watermarkState} />);
    expect(screen.getByTestId('stage-backdrop-watermark')).toBeTruthy();
  });

  it('renders all ThemeHeroFigure styles, supports fallbackFigure and voiceState, and returns null when figure style resolves to none', () => {
    const styles = [
      'pixel-companion',
      'isometric-construct',
      'editorial-botanical',
      'orbital-constellation',
      'kite-crest',
      'kinetic-ring',
    ] as const;

    const { rerender, container } = render(
      <ThemeHeroFigure figure="pixel-companion" variant="hero" />
    );

    for (const style of styles) {
      rerender(<ThemeHeroFigure figure={style} variant="hero" voiceState="listening" voiceLevel={0.4} />);
      const fig = screen.getByTestId(`theme-hero-figure-${style}`);
      expect(fig).toBeTruthy();
      expect(fig).toHaveAttribute('data-voice-state', 'listening');
    }

    rerender(<ThemeHeroFigure figure="none" fallbackFigure="kinetic-ring" variant="hero" />);
    expect(screen.getByTestId('theme-hero-figure-kinetic-ring')).toBeTruthy();

    rerender(<ThemeHeroFigure figure="none" variant="hero" />);
    expect(container.querySelector('[data-testid^="theme-hero-figure-"]')).toBeNull();
  });

  it('plays mount greeting choreography, reacts to click/poke, and tracks composer curious mood across hero figures', async () => {
    const { fireEvent } = await import('@testing-library/react');
    const { rerender } = render(
      <ThemeHeroFigure figure="pixel-companion" variant="hero" triggerKey="chat-1" />
    );

    const fig = screen.getByTestId('theme-hero-figure-pixel-companion');
    expect(fig).toHaveAttribute('data-reaction', 'greeting');
    expect(fig).toHaveAttribute('data-interactive', 'true');
    expect(fig.querySelector('.kite-px__arm-right')).not.toBeNull();
    expect(fig.querySelector('.kite-px__eyes')).not.toBeNull();

    // Clicking the mascot triggers an excited burst reaction
    fireEvent.click(fig);
    expect(fig).toHaveAttribute('data-reaction', 'excited');

    // Passing curious mood (e.g. composer typing) reflects live state
    rerender(
      <ThemeHeroFigure
        figure="pixel-companion"
        variant="hero"
        triggerKey="chat-1"
        mood="curious"
      />
    );
    expect(fig).toHaveAttribute('data-mood', 'curious');

    // Changing triggerKey (opening a new chat) replays greeting entrance
    rerender(
      <ThemeHeroFigure
        figure="pixel-companion"
        variant="hero"
        triggerKey="chat-2"
        mood="idle"
      />
    );
    expect(fig).toHaveAttribute('data-reaction', 'greeting');

    // Watermark remains non-interactive
    rerender(<ThemeHeroFigure figure="pixel-companion" variant="watermark" />);
    expect(screen.getByTestId('theme-hero-figure-pixel-companion')).toHaveAttribute(
      'data-interactive',
      'false'
    );
  });

  it('renders ThemeHeroFigure inside ChatHome and CodeHome empty states and respects style="none"', () => {
    writeThemeCustomizations({
      ...DEFAULT_THEME_CUSTOMIZATIONS,
      figure: { style: 'pixel-companion', showWatermark: false },
    });

    const { unmount } = render(<ChatHome onStartThread={() => {}} />);
    expect(screen.getByTestId('theme-hero-figure-pixel-companion')).toBeTruthy();
    unmount();

    writeThemeCustomizations({
      ...DEFAULT_THEME_CUSTOMIZATIONS,
      figure: { style: 'none', showWatermark: false },
    });

    const { container } = render(<CodeHome onAddWorkspace={() => {}} />);
    expect(container.querySelector('[data-testid^="theme-hero-figure-"]')).toBeNull();
  });

  it('renders every backdrop preset, scrim dimming/blur, reduced-motion state, ChatView empty state, and WorkspaceEmptyLauncher', () => {
    const presets: ConcreteBackdropPresetId[] = [
      'none',
      'aurora-mesh',
      'alpine-dusk',
      'solar-horizon',
      'event-horizon',
      'lunar-eclipse',
      'astral-nebula',
      'tokyo-rain',
      'misty-forest',
      'cloud-sea',
      'custom-image',
    ];

    for (const preset of presets) {
      const state = sanitizeThemeCustomizations({
        ...DEFAULT_THEME_CUSTOMIZATIONS,
        backdrop: {
          preset,
          customImageUrl: preset === 'custom-image' ? 'https://example.com/bg.jpg' : '',
          dimming: 45,
          blur: 10,
          grain: preset === 'solar-horizon',
        },
      });
      const { unmount, container } = render(<StageBackdrop customizations={state} />);
      if (preset === 'none') {
        expect(container.firstChild).toBeNull();
        expect(screen.queryByTestId('stage-backdrop')).toBeNull();
        expect(container.querySelector('.stage-backdrop__scrim')).toBeNull();
      } else {
        const backdrop = screen.getByTestId('stage-backdrop');
        expect(backdrop.getAttribute('data-backdrop-preset')).toBe(preset);
        expect(screen.getByTestId(`stage-backdrop-scene-${preset}`)).toBeTruthy();
        if (preset !== 'custom-image') {
          const wall = screen.getByTestId(`stage-backdrop-wallpaper-${preset}`);
          expect(wall.getAttribute('style')).toContain(`/wallpapers/${preset}.jpg`);
          expect(container.querySelector('.stage-backdrop__svg')).toBeNull();
        }
        const scrim = container.querySelector('.stage-backdrop__scrim') as HTMLElement | null;
        expect(scrim).toBeTruthy();
        expect(scrim?.style.opacity).toBe('0.45');
        expect(scrim?.style.backdropFilter).toBe('');
      }
      unmount();
    }

    document.documentElement.setAttribute('data-motion', 'reduce');
    writeThemeCustomizations({
      ...DEFAULT_THEME_CUSTOMIZATIONS,
      figure: { style: 'orbital-constellation', showWatermark: false },
    });

    const { unmount: unmountChat } = render(<ChatView workspaceId={null} />);
    expect(screen.getByTestId('theme-hero-figure-orbital-constellation')).toBeTruthy();
    expect(document.documentElement.getAttribute('data-motion')).toBe('reduce');
    unmountChat();

    render(
      <WorkspaceEmptyLauncher
        workspace={{
          id: 'ws-1',
          displayName: 'Kite Repo',
          createdAtUnixMs: 0,
          lastOpenedAtUnixMs: 0,
          pinned: false,
          available: true,
        }}
        availableEngines={[]}
        onLaunchAgent={vi.fn()}
        onLaunchTerminal={vi.fn()}
        onLaunchMore={vi.fn()}
      />
    );
    expect(screen.getByTestId('theme-hero-figure-orbital-constellation')).toBeTruthy();
  });

  it('wires 4-tier semantic glass tokens across Diffs Shadow DOM and document theme targets', () => {
    const appFrame = document.createElement('div');
    appFrame.className = 'app-frame';
    const zoomViewport = document.createElement('div');
    zoomViewport.className = 'zoom-viewport';
    appFrame.appendChild(zoomViewport);
    document.body.appendChild(appFrame);

    try {
      const glassState = sanitizeThemeCustomizations({
        ...DEFAULT_THEME_CUSTOMIZATIONS,
        darkThemeId: 'aurora-studio',
        surface: {
          translucent: true,
          opacity: 62,
          blur: 22,
          contrast: 55,
        },
      });
      applyThemeCustomizationsToDocument(glassState);

      for (const el of [document.documentElement, appFrame, zoomViewport]) {
        expect(el.getAttribute('data-surface-glass')).toBe('true');
        expect(el.style.getPropertyValue('--theme-surface-opacity')).toBe('62%');
        expect(el.style.getPropertyValue('--theme-surface-blur')).toBe('22px');
        expect(el.style.getPropertyValue('--pane')).toBe('#0d1424');
      }

      const solidState = sanitizeThemeCustomizations({
        ...DEFAULT_THEME_CUSTOMIZATIONS,
        darkThemeId: 'kite-dark',
        backdrop: {
          ...DEFAULT_THEME_CUSTOMIZATIONS.backdrop,
          preset: 'none',
        },
        surface: {
          ...DEFAULT_THEME_CUSTOMIZATIONS.surface,
          translucent: false,
        },
      });
      applyThemeCustomizationsToDocument(solidState);
      expect(document.documentElement.getAttribute('data-surface-glass')).toBe('false');
    } finally {
      appFrame.remove();
    }

    expect(DIFF_SURFACE_THEME_UNSAFE_CSS).toContain('--diffs-bg: var(--glass-nested-bg');
    expect(DIFF_SURFACE_THEME_UNSAFE_CSS).toContain('[data-diffs-header][data-sticky]');
    expect(DIFF_SURFACE_THEME_UNSAFE_CSS).toContain('--diffs-bg-addition-override: color-mix');
  });

  it('aligns Toaster, MermaidDiagram, PluginsView, and secondary modals with active theme & glass tokens', async () => {
    const fsSpecifier = ['node', 'fs'].join(':');
    const fs = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (filePath: string, encoding: 'utf8') => string;
    };

    const appTsx = fs.readFileSync('src/App.tsx', 'utf8');
    const toastCss = fs.readFileSync('src/lib/toast.css', 'utf8');
    const mermaidTsx = fs.readFileSync('src/components/ui/MermaidDiagram.tsx', 'utf8');
    const pluginsTsx = fs.readFileSync('src/components/views/PluginsView.tsx', 'utf8');
    const agentResumeTsx = fs.readFileSync('src/components/modals/AgentPaneResumeModal.tsx', 'utf8');
    const resumeHostTsx = fs.readFileSync('src/components/modals/ResumeHost.tsx', 'utf8');
    const routinesTsx = fs.readFileSync('src/components/views/RoutinesView.tsx', 'utf8');

    expect(appTsx).toContain('<Toaster position="bottom-right" theme={appearance}');
    expect(toastCss).toContain("html[data-surface-glass='true']");
    expect(mermaidTsx).toContain('kite:theme-changed');
    expect(mermaidTsx).not.toContain("background: '#16181d'");
    expect(pluginsTsx).not.toContain("rgba(255, 255, 255, 0.03)");
    expect(pluginsTsx).not.toContain("rgba(255, 255, 255, 0.05)");
    expect(agentResumeTsx).toContain('--glass-modal-bg');
    expect(resumeHostTsx).toContain('--glass-modal-bg');
    expect(routinesTsx).toContain('--glass-modal-bg');
  });

  it('avoids GPU layer explosion in theme-visuals.css, visual-language.css, and index.css', async () => {
    const fsSpecifier = ['node', 'fs'].join(':');
    const fs = (await import(/* @vite-ignore */ fsSpecifier)) as {
      readFileSync: (filePath: string, encoding: 'utf8') => string;
    };

    const themeVisualsCss = fs.readFileSync('src/components/theme/theme-visuals.css', 'utf8');
    const visualLanguageCss = fs.readFileSync('src/visual-language.css', 'utf8');
    const indexCss = fs.readFileSync('src/index.css', 'utf8');

    expect(themeVisualsCss).not.toContain('feTurbulence');
    expect(themeVisualsCss).not.toContain('transform: translateZ(0)');

    expect(visualLanguageCss).not.toContain('backdrop-filter: var(--glass-blur)');
    expect(visualLanguageCss).toContain('backdrop-filter: var(--glass-overlay-blur)');
    expect(visualLanguageCss).toMatch(/\.chat-transcript\s*\{\s*contain:\s*layout style;\s*\}/);

    expect(indexCss).toMatch(/\.mode-layer\s*\{[^}]*display:\s*none;/);
    expect(indexCss).toMatch(/\.mode-layer--visible\s*\{[^}]*display:\s*flex;/);
  });
});
