import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarkdownPreviewPane } from './MarkdownPreviewPane';

describe('MarkdownPreviewPane', () => {
  it('renders headers, paragraphs, and lists correctly', () => {
    const md = `# Title Header
## Subtitle Header
This is a test paragraph with **bold** and \`inline code\`.

- First item
- Second item
`;
    render(<MarkdownPreviewPane text={md} relativePath="README.md" />);

    expect(screen.getByText('Title Header')).toBeInTheDocument();
    expect(screen.getByText('Subtitle Header')).toBeInTheDocument();
    expect(screen.getByText('First item')).toBeInTheDocument();
    expect(screen.getByText('Second item')).toBeInTheDocument();
    expect(screen.getByText('bold')).toBeInTheDocument();
    expect(screen.getByText('inline code')).toBeInTheDocument();
  });

  it('renders GitHub alerts properly', () => {
    const md = `> [!NOTE]
> This is a crucial note for users.
`;
    render(<MarkdownPreviewPane text={md} relativePath="README.md" />);

    expect(screen.getByText('NOTE')).toBeInTheDocument();
    expect(screen.getByText('This is a crucial note for users.')).toBeInTheDocument();
  });

  it('renders tables properly', () => {
    const md = `| Header 1 | Header 2 |
| --- | --- |
| Val 1 | Val 2 |
`;
    render(<MarkdownPreviewPane text={md} relativePath="README.md" />);

    expect(screen.getByText('Header 1')).toBeInTheDocument();
    expect(screen.getByText('Header 2')).toBeInTheDocument();
    expect(screen.getByText('Val 1')).toBeInTheDocument();
    expect(screen.getByText('Val 2')).toBeInTheDocument();
  });

  it('handles internal file navigation links', () => {
    const onNavigate = vi.fn();
    const md = `Check out [another doc](./docs/guide.md) for details.`;
    render(
      <MarkdownPreviewPane
        text={md}
        relativePath="README.md"
        onNavigateInternalFile={onNavigate}
      />
    );

    const link = screen.getByText('another doc');
    expect(link).toBeInTheDocument();
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith('./docs/guide.md');
  });

  it('renders document outline sidebar and navigates to headings', () => {
    // Mock scrollIntoView
    const scrollIntoViewMock = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoViewMock;

    const onToggleOutline = vi.fn();
    const md = `# Section One
Paragraph one.
## Subsection Alpha
Paragraph two.
### Sub-subsection
Paragraph three.`;

    render(
      <MarkdownPreviewPane
        text={md}
        relativePath="README.md"
        showOutline={true}
        onToggleOutline={onToggleOutline}
      />
    );

    // Outline header badge and title
    expect(screen.getByRole('complementary', { name: /table of contents/i })).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument(); // 3 headings

    // Buttons in outline
    const outlineButtons = screen.getAllByRole('button', { name: /Section One/i });
    expect(outlineButtons.length).toBeGreaterThanOrEqual(1);

    // Click heading in outline
    fireEvent.click(outlineButtons[0]);
    expect(scrollIntoViewMock).toHaveBeenCalled();

    // Close button
    const closeBtn = screen.getByRole('button', { name: /close outline/i });
    fireEvent.click(closeBtn);
    expect(onToggleOutline).toHaveBeenCalledTimes(1);
  });

  it('displays empty state in outline when document has no headings', () => {
    const md = `Just a plain paragraph without any markdown headings.`;
    render(
      <MarkdownPreviewPane
        text={md}
        relativePath="README.md"
        showOutline={true}
      />
    );

    expect(screen.getByText(/no headings in this document/i)).toBeInTheDocument();
  });
});

