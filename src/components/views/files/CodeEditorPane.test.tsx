import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CodeEditorPane, OpenFileTab } from './CodeEditorPane';

describe('CodeEditorPane', () => {
  const dummyFile: OpenFileTab = {
    entryId: 'test.md',
    name: '03_ARQUITECTURA_AGENTES_Y_PATRONES.md',
    relativePath: 'documentacion_oficial/03_ARQUITECTURA_AGENTES_Y_PATRONES.md',
    revision: 'abc1234',
    draftText: '# Arquitectura de Agentes\n\nEste es un documento de prueba.\n\n## 1. El Mandato Fundamental\nContenido de la seccion.',
    initialText: '# Arquitectura de Agentes\n\nEste es un documento de prueba.\n\n## 1. El Mandato Fundamental\nContenido de la seccion.',
  };

  it('renders markdown file with Rendered/Source and Outline toolbar controls', () => {
    const onCloseTab = vi.fn();
    render(
      <CodeEditorPane
        openFiles={[dummyFile]}
        activeFileId="test.md"
        activeTab={dummyFile}
        isModified={false}
        isSaving={false}
        autoSave={false}
        isEditMode={false}
        fileError={null}
        loadingContent={false}
        onSelectTab={vi.fn()}
        onCloseTab={onCloseTab}
        onSave={vi.fn()}
        onToggleAutoSave={vi.fn()}
        onToggleEditMode={vi.fn()}
        onDiscardAndReload={vi.fn()}
        onReloadFromDisk={vi.fn()}
        onDraftChange={vi.fn()}
      />
    );

    // Toolbar controls
    expect(screen.getByText('03_ARQUITECTURA_AGENTES_Y_PATRONES.md')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rendered/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /source/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /outline/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();

    // Outline is not visible initially
    expect(screen.queryByRole('complementary', { name: /table of contents/i })).not.toBeInTheDocument();

    // Click Outline button to open it
    const outlineBtn = screen.getByRole('button', { name: /outline/i });
    fireEvent.click(outlineBtn);

    // Now Outline panel is rendered with the headings from markdown
    expect(screen.getByRole('complementary', { name: /table of contents/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Arquitectura de Agentes/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('button', { name: /1\. El Mandato Fundamental/i }).length).toBeGreaterThanOrEqual(1);

    // Clicking Outline button again toggles it off
    fireEvent.click(outlineBtn);
    expect(screen.queryByRole('complementary', { name: /table of contents/i })).not.toBeInTheDocument();
  });

  it('switches between Rendered preview and Source code view', () => {
    render(
      <CodeEditorPane
        openFiles={[dummyFile]}
        activeFileId="test.md"
        activeTab={dummyFile}
        isModified={false}
        isSaving={false}
        autoSave={false}
        isEditMode={false}
        fileError={null}
        loadingContent={false}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onSave={vi.fn()}
        onToggleAutoSave={vi.fn()}
        onToggleEditMode={vi.fn()}
        onDiscardAndReload={vi.fn()}
        onReloadFromDisk={vi.fn()}
        onDraftChange={vi.fn()}
      />
    );

    // In preview mode initially
    expect(screen.getByText('Arquitectura de Agentes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /outline/i })).toBeInTheDocument();

    // Switch to Source mode
    const sourceBtn = screen.getByRole('button', { name: /source/i });
    fireEvent.click(sourceBtn);

    // In Source mode, raw tokens / lines are displayed and Outline button is hidden
    expect(screen.queryByRole('button', { name: /outline/i })).not.toBeInTheDocument();
    expect(screen.getByText('Markdown Source')).toBeInTheDocument();

    // Switch back to Rendered mode
    const renderedBtn = screen.getByRole('button', { name: /rendered/i });
    fireEvent.click(renderedBtn);
    expect(screen.getByRole('button', { name: /outline/i })).toBeInTheDocument();
  });

  it('automatically opens in Source mode if targetLine > 0 is provided, and in Preview mode if targetLine is null', () => {
    // 1. With targetLine = 2 (e.g. from chat link with line number)
    const { rerender } = render(
      <CodeEditorPane
        openFiles={[dummyFile]}
        activeFileId="test.md"
        activeTab={dummyFile}
        targetLine={2}
        isModified={false}
        isSaving={false}
        autoSave={false}
        isEditMode={false}
        fileError={null}
        loadingContent={false}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onSave={vi.fn()}
        onToggleAutoSave={vi.fn()}
        onToggleEditMode={vi.fn()}
        onDiscardAndReload={vi.fn()}
        onReloadFromDisk={vi.fn()}
        onDraftChange={vi.fn()}
      />
    );

    // In source mode, Outline button is hidden and Markdown Source indicator is shown
    expect(screen.queryByRole('button', { name: /outline/i })).not.toBeInTheDocument();
    expect(screen.getByText('Markdown Source')).toBeInTheDocument();

    // 2. User clicks on a whole document link (targetLine becomes null)
    rerender(
      <CodeEditorPane
        openFiles={[dummyFile]}
        activeFileId="test.md"
        activeTab={dummyFile}
        targetLine={null}
        isModified={false}
        isSaving={false}
        autoSave={false}
        isEditMode={false}
        fileError={null}
        loadingContent={false}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onSave={vi.fn()}
        onToggleAutoSave={vi.fn()}
        onToggleEditMode={vi.fn()}
        onDiscardAndReload={vi.fn()}
        onReloadFromDisk={vi.fn()}
        onDraftChange={vi.fn()}
      />
    );

    // Now it automatically reverts to Preview mode!
    expect(screen.getByRole('button', { name: /outline/i })).toBeInTheDocument();
    expect(screen.getByText('Preview')).toBeInTheDocument();
  });

  it('renders unsupported card for binary/media files with Reveal and Open Default App actions', () => {
    const mediaFile: OpenFileTab = {
      entryId: 'video.mp4',
      name: 'demo-walkthrough.mp4',
      relativePath: 'media/demo-walkthrough.mp4',
      revision: '',
      draftText: '',
      initialText: '',
      isUnsupportedBinary: true,
    };

    const onRevealInExplorer = vi.fn();
    const onOpenInDefaultApp = vi.fn();

    render(
      <CodeEditorPane
        openFiles={[mediaFile]}
        activeFileId="video.mp4"
        activeTab={mediaFile}
        isModified={false}
        isSaving={false}
        autoSave={false}
        isEditMode={false}
        fileError={null}
        loadingContent={false}
        onSelectTab={vi.fn()}
        onCloseTab={vi.fn()}
        onSave={vi.fn()}
        onToggleAutoSave={vi.fn()}
        onToggleEditMode={vi.fn()}
        onDiscardAndReload={vi.fn()}
        onReloadFromDisk={vi.fn()}
        onDraftChange={vi.fn()}
        onRevealInExplorer={onRevealInExplorer}
        onOpenInDefaultApp={onOpenInDefaultApp}
      />
    );

    expect(screen.getAllByText('demo-walkthrough.mp4').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('media/demo-walkthrough.mp4').length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByText(/This binary or media file cannot be previewed directly in Kite/i)
    ).toBeInTheDocument();

    // Action buttons in unsupported card
    const revealBtns = screen.getAllByRole('button', { name: /reveal/i });
    expect(revealBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(revealBtns[revealBtns.length - 1]);
    expect(onRevealInExplorer).toHaveBeenCalledWith('media/demo-walkthrough.mp4');

    const openBtns = screen.getAllByRole('button', { name: /open/i });
    expect(openBtns.length).toBeGreaterThanOrEqual(1);
    // Find the one that specifically opens default app
    const openDefaultAppBtn = screen.getByRole('button', { name: /open in default app/i });
    fireEvent.click(openDefaultAppBtn);
    expect(onOpenInDefaultApp).toHaveBeenCalledWith('media/demo-walkthrough.mp4');
  });
});
