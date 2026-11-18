import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SpinnerIcon } from './ChatIcons';

describe('Chat SpinnerIcon', () => {
  it('renders an animated spinner class on the svg and preserves custom className', () => {
    const { container, rerender } = render(<SpinnerIcon size={24} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('class') ?? '').toContain('animate-spin');

    rerender(<SpinnerIcon size={16} className="custom-loader" />);
    const customSvg = container.querySelector('svg');
    expect(customSvg?.getAttribute('class') ?? '').toContain('animate-spin');
    expect(customSvg?.getAttribute('class') ?? '').toContain('custom-loader');
  });
});
