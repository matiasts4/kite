import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { UnifiedDiffView, parseDiffString } from './UnifiedDiffView';

const SAMPLE_PATCH = [
  'diff --git a/src/example.ts b/src/example.ts',
  'index 1111111..2222222 100644',
  '--- a/src/example.ts',
  '+++ b/src/example.ts',
  '@@ -1,3 +1,3 @@',
  ' export function greet(name: string) {',
  '-  return "hello " + name;',
  '+  return `hello ${name}`;',
  ' }',
].join('\n');

describe('UnifiedDiffView', () => {
  it('renders unified patches with a single line-number gutter via @pierre/diffs', async () => {
    const { container } = render(<UnifiedDiffView diff={SAMPLE_PATCH} />);

    const figure = screen.getByRole('figure', { name: /Diff, 1 additions, 1 deletions/i });
    expect(figure).toBeInTheDocument();

    await waitFor(() => {
      const shadowRoot = container.querySelector('diffs-container')?.shadowRoot;
      expect(shadowRoot).toBeTruthy();
      expect(shadowRoot?.querySelector('[data-diff-type="single"]')).toBeTruthy();
      expect(shadowRoot?.querySelectorAll('[data-gutter]').length).toBe(1);
      const code = shadowRoot?.querySelector('[data-code]');
      expect(code?.textContent).toContain('return `hello ${name}`;');
      expect(code?.textContent).not.toContain('diff --git');
    });
  });

  it('supports pre-parsed DiffData objects with explicit filePath syntax highlighting', async () => {
    const parsed = parseDiffString(SAMPLE_PATCH);
    const { container } = render(
      <UnifiedDiffView diff={parsed} filePath="src/example.ts" status="modified" />
    );

    await waitFor(() => {
      const shadowRoot = container.querySelector('diffs-container')?.shadowRoot;
      const code = shadowRoot?.querySelector('[data-code]');
      expect(code?.textContent).toContain('export function greet');
    });
  });
});
