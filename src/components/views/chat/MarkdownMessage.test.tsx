import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarkdownMessage, isFileHref } from './MarkdownMessage';
import * as filePreviewNav from '../../../lib/filePreviewNav';
import * as sidecarNav from '../../../lib/sidecarNav';

describe('MarkdownMessage sidecar:// URI handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sidecarNav.clearKnownSidecars();
    sidecarNav.consumePendingSidecarRequest();
  });

  it('excludes sidecar:// URIs from isFileHref while keeping real file links', () => {
    expect(isFileHref('sidecar://android-cli-plugin/device-hub')).toBe(false);
    expect(isFileHref('sidecar://device-hub/index.html?view=auxpane')).toBe(false);
    expect(isFileHref('SIDECAR://my-plugin.v1/panel')).toBe(false);
    expect(isFileHref('https://example.com/docs.html')).toBe(false);

    expect(isFileHref('file:///C:/repo/src/App.tsx')).toBe(true);
    expect(isFileHref('./src/App.tsx')).toBe(true);
    expect(isFileHref('/Users/dev/notes.md')).toBe(true);
    expect(isFileHref('src/App.tsx')).toBe(true);
  });

  it('renders sidecar:// links as md-sidecar-pill buttons and opens RightDock without launching a browser', () => {
    const openSidecarSpy = vi.spyOn(sidecarNav, 'openSidecarInRightDock');
    const openFileSpy = vi.spyOn(filePreviewNav, 'openFileInRightDock').mockImplementation(() => {});

    render(
      <MarkdownMessage
        workspaceId="ws-42"
        text="Inspect your device in [Open Device Hub](sidecar://android-cli-plugin/device-hub/?view=auxpane)."
      />,
    );

    const pillBtn = screen.getByRole('button', { name: 'Open Device Hub' });
    expect(pillBtn).toBeInTheDocument();
    expect(pillBtn).toHaveClass('md-sidecar-pill');
    expect(pillBtn).toHaveAttribute(
      'data-sidecar-uri',
      'sidecar://android-cli-plugin/device-hub/?view=auxpane',
    );
    expect(screen.queryByRole('link', { name: 'Open Device Hub' })).toBeNull();

    fireEvent.click(pillBtn);

    expect(openFileSpy).not.toHaveBeenCalled();
    expect(openSidecarSpy).toHaveBeenCalledTimes(1);
    expect(openSidecarSpy).toHaveBeenCalledWith({
      sidecarId: 'android-cli-plugin/device-hub',
      viewPath: '/?view=auxpane',
      title: 'Open Device Hub',
      workspaceId: 'ws-42',
    });
  });

  it('keeps standard anchors for HTTP links and file links', () => {
    const openFileSpy = vi.spyOn(filePreviewNav, 'openFileInRightDock').mockImplementation(() => {});
    const openSidecarSpy = vi.spyOn(sidecarNav, 'openSidecarInRightDock');

    render(
      <MarkdownMessage
        workspaceId="ws-7"
        text="See [Docs](https://kite.dev/docs) or [Source](src/App.tsx)."
      />,
    );

    const httpLink = screen.getByRole('link', { name: 'Docs' });
    expect(httpLink).toHaveAttribute('href', 'https://kite.dev/docs');
    expect(httpLink).toHaveAttribute('target', '_blank');

    const fileLink = screen.getByRole('link', { name: 'Source' });
    expect(fileLink).toHaveAttribute('href', 'src/App.tsx');
    fireEvent.click(fileLink);

    expect(openFileSpy).toHaveBeenCalledWith({
      candidate: 'src/App.tsx',
      workspaceId: 'ws-7',
      collapseTree: true,
    });
    expect(openSidecarSpy).not.toHaveBeenCalled();
  });
});
