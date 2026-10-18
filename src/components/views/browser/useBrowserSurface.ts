import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { getBrowserSurfaceSession } from './browserSurfaceRegistry';

function subscribeToVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

function readDocumentVisible(): boolean {
  return document.visibilityState === 'visible';
}

function serverDocumentVisible(): boolean {
  return true;
}

/**
 * Binds the browser surface session for a workspace to a React anchor element.
 * `occluded` hides the native surface while a modal is open.
 */
export function useBrowserSurface(workspaceId: string | null, occluded: boolean) {
  const session = useMemo(() => getBrowserSurfaceSession(workspaceId), [workspaceId]);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const documentVisible = useSyncExternalStore(
    subscribeToVisibility,
    readDocumentVisible,
    serverDocumentVisible
  );
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const anchorRef = useCallback((node: HTMLElement | null) => setAnchor(node), []);
  const attached = documentVisible && anchor !== null;

  useEffect(() => {
    session.setAnchor(anchor, attached);
  }, [session, anchor, attached]);

  // Leaving the view (or switching session) hides the surface without closing it.
  useEffect(() => () => session.setAnchor(null, false), [session]);

  useEffect(() => {
    session.setOccluded(occluded).catch(() => undefined);
  }, [session, occluded]);

  // Layout changes that do not resize the anchor still move the native bounds.
  useEffect(() => {
    if (anchor === null) return undefined;
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        session.refreshPresentation();
      });
    };
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    resizeObserver?.observe(anchor);
    const appFrame = anchor.closest<HTMLElement>('.app-frame');
    const mutationObserver =
      appFrame !== null && typeof MutationObserver !== 'undefined' ? new MutationObserver(schedule) : null;
    if (appFrame !== null) {
      mutationObserver?.observe(appFrame, { attributes: true, attributeFilter: ['class', 'style'] });
    }
    const onFrameTransitionEnd = (event: Event) => {
      if (event.target === appFrame) schedule();
    };
    appFrame?.addEventListener('transitionend', onFrameTransitionEnd);
    window.addEventListener('resize', schedule);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      appFrame?.removeEventListener('transitionend', onFrameTransitionEnd);
      window.removeEventListener('resize', schedule);
    };
  }, [anchor, session]);

  return useMemo(
    () => ({
      ...state,
      anchorRef,
      attached,
      openAddress: session.openAddress,
      control: session.control,
      setDesignMode: session.setDesignMode,
      retry: session.retry,
      reset: session.reset,
      setViewport: session.setViewport,
    }),
    [state, anchorRef, attached, session]
  );
}

export type BrowserSurfaceController = ReturnType<typeof useBrowserSurface>;
