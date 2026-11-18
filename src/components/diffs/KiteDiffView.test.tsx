import { describe, expect, it, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { KiteDiffView } from './KiteDiffView';
import {
  DEFAULT_THEME_CUSTOMIZATIONS,
  applyThemeCustomizationsToDocument,
  sanitizeThemeCustomizations,
  writeThemeCustomizations,
} from '../../lib/themeCustomizations';

const samplePatch = [
  'diff --git a/src/example.ts b/src/example.ts',
  '--- a/src/example.ts',
  '+++ b/src/example.ts',
  '@@ -1,3 +1,3 @@',
  ' export function greet() {',
  '-  return "old value";',
  '+  return "new value";',
  ' }',
].join('\n');

function extractShadowCodeText(container: HTMLElement): string {
  const host = container.querySelector('diffs-container');
  const codeNodes = host?.shadowRoot?.querySelectorAll('[data-code]');
  if (!codeNodes || codeNodes.length === 0) return '';
  return Array.from(codeNodes)
    .map((node) => node.textContent ?? '')
    .join('\n');
}

describe('KiteDiffView', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-palette');
    document.documentElement.removeAttribute('data-daltonized-diffs');
    document.documentElement.removeAttribute('style');
  });

  it('renders single-column unified diff without raw diff --git meta headers', async () => {
    const { container } = render(
      <KiteDiffView diff={samplePatch} filePath="src/example.ts" layout="unified" wordWrap={true} />
    );

    const wrapper = container.querySelector('.kite-diff-surface');
    expect(wrapper).toHaveAttribute('data-diff-layout', 'unified');

    await waitFor(() => {
      const text = extractShadowCodeText(container);
      expect(text).not.toContain('diff --git');
      expect(text).toContain('old value');
      expect(text).toContain('new value');
    });

    const diffHost = container.querySelector('diffs-container');
    expect(diffHost).toBeInTheDocument();
    expect(diffHost?.shadowRoot?.querySelector('[data-diff-type="single"]')).toBeInTheDocument();
    expect(diffHost?.shadowRoot?.querySelector('[data-code]')).toBeInTheDocument();
    // Single gutter + code columns in unified mode (no separate old/new/marker table columns)
    expect(diffHost?.shadowRoot?.querySelectorAll('[data-gutter]')).toHaveLength(1);
  });

  it('renders split layout attribute cleanly', async () => {
    const { container } = render(
      <KiteDiffView diff={samplePatch} filePath="src/example.ts" layout="split" wordWrap={false} />
    );

    const wrapper = container.querySelector('.kite-diff-surface');
    expect(wrapper).toHaveAttribute('data-diff-layout', 'split');
    expect(wrapper).toHaveAttribute('data-word-wrap', 'false');
    await waitFor(() => {
      const diffHost = container.querySelector('diffs-container');
      expect(diffHost?.shadowRoot?.querySelector('[data-diff-type="split"]')).toBeInTheDocument();
    });
  });

  it('renders whitespace-only message when ignoreWhitespace collapses every edit', () => {
    const wsOnly = [
      'diff --git a/ws.ts b/ws.ts',
      '--- a/ws.ts',
      '+++ b/ws.ts',
      '@@ -1,1 +1,1 @@',
      '-const x =   1;',
      '+const x = 1;',
    ].join('\n');

    const { getByText } = render(
      <KiteDiffView diff={wsOnly} filePath="ws.ts" ignoreWhitespace={true} />
    );
    expect(getByText(/Only whitespace or indentation changes/i)).toBeInTheDocument();
  });

  it('syncs active palette and daltonized diff tokens live on kite:theme-changed', async () => {
    const { container } = render(
      <KiteDiffView diff={samplePatch} filePath="src/example.ts" layout="unified" />
    );
    const wrapper = container.querySelector('.kite-diff-surface') as HTMLElement;
    expect(wrapper).toHaveAttribute('data-daltonized-diffs', 'false');

    const daltonizedTokyo = sanitizeThemeCustomizations({
      ...DEFAULT_THEME_CUSTOMIZATIONS,
      appearanceMode: 'dark',
      darkThemeId: 'tokyo-night',
      overrides: {
        ...DEFAULT_THEME_CUSTOMIZATIONS.overrides,
        daltonizedDiffs: true,
      },
    });
    writeThemeCustomizations(daltonizedTokyo);
    applyThemeCustomizationsToDocument(daltonizedTokyo);

    act(() => {
      window.dispatchEvent(
        new CustomEvent('kite:theme-changed', {
          detail: {
            theme: 'dark',
            palette: 'tokyo-night',
            customizations: daltonizedTokyo,
          },
        })
      );
    });

    await waitFor(() => {
      expect(wrapper).toHaveAttribute('data-palette', 'tokyo-night');
      expect(wrapper).toHaveAttribute('data-daltonized-diffs', 'true');
      expect(wrapper.style.getPropertyValue('--diff-addition')).toBe('#38bdf8');
      expect(wrapper.style.getPropertyValue('--diff-deletion')).toBe('#f59e0b');
    });
  });
});
