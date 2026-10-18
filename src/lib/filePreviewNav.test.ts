import { describe, it, expect, vi } from 'vitest';
import {
  openFileInRightDock,
  consumePendingFilePreview,
  OPEN_RIGHT_DOCK_FILE_EVENT,
  FilePreviewRequest,
} from './filePreviewNav';

describe('filePreviewNav', () => {
  it('dispatches OPEN_RIGHT_DOCK_FILE_EVENT and queues pending preview', () => {
    const listener = vi.fn();
    window.addEventListener(OPEN_RIGHT_DOCK_FILE_EVENT, (e) => {
      listener((e as CustomEvent<FilePreviewRequest>).detail);
    });

    openFileInRightDock({
      candidate: 'src/main.rs:42:10',
      workspaceId: 'ws-123',
      collapseTree: true,
    });

    expect(listener).toHaveBeenCalledWith({
      candidate: 'src/main.rs:42:10',
      workspaceId: 'ws-123',
      collapseTree: true,
      preferRendered: true,
    });

    const pending = consumePendingFilePreview();
    expect(pending).toEqual({
      candidate: 'src/main.rs:42:10',
      workspaceId: 'ws-123',
      collapseTree: true,
      preferRendered: true,
    });

    // Second consume returns null (queue cleared)
    expect(consumePendingFilePreview()).toBeNull();
  });
});
