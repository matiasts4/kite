import { describe, it, expect, vi } from 'vitest';
import {
  openDiffsInRightDock,
  consumePendingDiffPreview,
  peekPendingDiffPreview,
  stripWorkspacePathPrefix,
  resolveRepoDiffPaths,
  OPEN_RIGHT_DOCK_DIFFS_EVENT,
  OPEN_DIFFS_EVENT,
  type DiffPreviewRequest,
} from './diffPreviewNav';

describe('diffPreviewNav', () => {
  it('dispatches dock diff events and manages pending request queue', () => {
    const dockListener = vi.fn();
    const diffsListener = vi.fn();
    window.addEventListener(OPEN_RIGHT_DOCK_DIFFS_EVENT, (e) => {
      dockListener((e as CustomEvent<DiffPreviewRequest>).detail);
    });
    window.addEventListener(OPEN_DIFFS_EVENT, (e) => {
      diffsListener((e as CustomEvent<DiffPreviewRequest>).detail);
    });

    openDiffsInRightDock({
      workspaceId: 'ws-1',
      workspaceName: 'kite',
      focusPaths: ['C:\\Users\\PC\\Desktop\\Proyectos\\kite\\README.md'],
      selectedPath: 'C:\\Users\\PC\\Desktop\\Proyectos\\kite\\README.md',
    });

    const expected = {
      workspaceId: 'ws-1',
      workspaceName: 'kite',
      focusPaths: ['C:\\Users\\PC\\Desktop\\Proyectos\\kite\\README.md'],
      selectedPath: 'C:\\Users\\PC\\Desktop\\Proyectos\\kite\\README.md',
    };

    expect(dockListener).toHaveBeenCalledWith(expected);
    expect(diffsListener).toHaveBeenCalledWith(expected);
    expect(peekPendingDiffPreview()).toEqual(expected);
    expect(consumePendingDiffPreview()).toEqual(expected);
    expect(consumePendingDiffPreview()).toBeNull();
  });

  it('strips workspace root paths and maps candidates onto repo-relative git paths', () => {
    expect(stripWorkspacePathPrefix('C:\\Users\\PC\\Desktop\\Proyectos\\kite\\README.md', 'kite')).toBe(
      'README.md'
    );
    expect(stripWorkspacePathPrefix('C:/work/kite/src/components/App.tsx', 'kite')).toBe(
      'src/components/App.tsx'
    );
    expect(
      resolveRepoDiffPaths(
        [
          'C:\\Users\\PC\\Desktop\\Proyectos\\kite\\README.md',
          'C:/Users/PC/Desktop/Proyectos/kite/src/main.ts',
        ],
        ['README.md', 'docs/README.md', 'src/main.ts', 'index.html'],
        'kite'
      )
    ).toEqual(['README.md', 'src/main.ts']);
  });
});
