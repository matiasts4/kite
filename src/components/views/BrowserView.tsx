import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { BrowserSurfaceView } from '../../types';
import type { BrowserControlAction, DiscoveredBrowserServer } from '../../lib/ipc';
import {
  captureBrowserSurfaceScreenshot,
  closeBrowserSurface,
  discoverBrowserServers,
  isTauriEnvironment,
  listBrowserSurfaces,
  resumeBrowserSurface,
  takeoverBrowserSurface,
} from '../../lib/ipc';
import { openExternalLink } from '../../lib/terminalLinkNav';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  CameraIcon,
  EarthIcon,
  ExternalLinkIcon,
  HandIcon,
  LockKeyholeIcon,
  MonitorIcon,
  PlayIcon,
  RotateCcwIcon,
  RotateCwIcon,
  ServerIcon,
  ShieldAlertIcon,
  SmartphoneIcon,
  SquareMousePointerIcon,
  TabletIcon,
  TriangleAlertIcon,
  WifiOffIcon,
} from './browser/browserIcons';
import {
  BROWSER_ADDRESS_MAX_LENGTH,
  BROWSER_QUICK_DESTINATIONS,
  browserAddressLabel,
} from './browser/browserAddress';
import { fitDeviceBounds, getDeviceDimensions } from './browser/browserGeometry';
import { getBrowserSurfaceSession } from './browser/browserSurfaceRegistry';
import { BrowserTabBar } from './browser/BrowserTabBar';
import './browser.css';

export const ATTACH_BROWSER_SCREENSHOT_EVENT = 'kite:attach-browser-screenshot';

export interface BrowserScreenshotEventDetail {
  dataBase64: string;
  mimeType: string;
  fileName: string;
  url: string;
  sha256?: string;
}

export interface BrowserViewProps {
  workspaceId: string | null;
  isOccluded?: boolean;
}

function transportOf(displayUrl: string): 'secure' | 'local' | 'insecure' {
  try {
    const url = new URL(displayUrl);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (loopback) return 'local';
    return url.protocol === 'https:' ? 'secure' : 'insecure';
  } catch {
    return 'insecure';
  }
}

function upsertSurfaceList(
  prev: BrowserSurfaceView[],
  incoming: BrowserSurfaceView
): BrowserSurfaceView[] {
  const idx = prev.findIndex((item) => item.surfaceId === incoming.surfaceId);
  if (idx === -1) return [...prev, incoming];
  const next = prev.slice();
  next[idx] = incoming;
  return next;
}

export const BrowserView: React.FC<BrowserViewProps> = ({ workspaceId, isOccluded = false }) => {
  const session = useMemo(() => getBrowserSurfaceSession(workspaceId), [workspaceId]);
  const { viewport, phase, view, busy, error } = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot
  );
  const [addressInput, setAddressInput] = useState<string>('');
  const [startInput, setStartInput] = useState<string>('');
  const [isEditingAddress, setIsEditingAddress] = useState<boolean>(false);
  const [surfaces, setSurfaces] = useState<BrowserSurfaceView[]>([]);
  const [discoveredServers, setDiscoveredServers] = useState<DiscoveredBrowserServer[]>([]);
  const [serversOpen, setServersOpen] = useState<boolean>(false);
  const [discoveringServers, setDiscoveringServers] = useState<boolean>(false);
  const [capturingScreenshot, setCapturingScreenshot] = useState<boolean>(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<boolean>(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const designMode = view?.designMode ?? false;

  const flashNotice = useCallback((message: string) => {
    setActionNotice(message);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => {
      setActionNotice(null);
    }, 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    };
  }, []);

  // Keep active view synced into our multi-tab list without stealing focus from user tabs.
  useEffect(() => {
    if (!view) return;
    setSurfaces((prev) => upsertSurfaceList(prev, view));
  }, [view]);

  // Hydrate open user + parallel agent surfaces and listen for native live status updates.
  useEffect(() => {
    let active = true;
    const loadSurfaces = async () => {
      try {
        const res = await listBrowserSurfaces(workspaceId);
        if (!active) return;
        const incoming = Array.isArray(res?.surfaces) ? res.surfaces : [];
        setSurfaces(incoming);
        const currentView = session.getSnapshot().view;
        if (currentView) {
          const match = incoming.find((s) => s.surfaceId === currentView.surfaceId);
          if (match) session.syncView(match);
        }
      } catch (err) {
        console.warn('[BrowserView] Failed to list browser surfaces:', err);
      }
    };

    void loadSurfaces();

    let unlistenUpdated: (() => void) | null = null;
    let unlistenClosed: (() => void) | null = null;
    if (isTauriEnvironment()) {
      void listen<BrowserSurfaceView>('browser:surface-updated', (event) => {
        if (!active || !event.payload?.surfaceId) return;
        const updated = event.payload;
        if (workspaceId && updated.workspaceId && updated.workspaceId !== workspaceId) {
          return;
        }
        setSurfaces((prev) => upsertSurfaceList(prev, updated));
        session.syncView(updated);
      })
        .then((fn) => {
          if (active) unlistenUpdated = fn;
          else fn();
        })
        .catch((err) => {
          console.warn('[BrowserView] Failed to subscribe to browser:surface-updated:', err);
        });

      void listen<{ surfaceId?: string }>('browser:surface-closed', (event) => {
        if (!active || !event.payload?.surfaceId) return;
        const closedId = event.payload.surfaceId;
        session.handleExternalClose(closedId);
        setSurfaces((prev) => prev.filter((item) => item.surfaceId !== closedId));
      })
        .then((fn) => {
          if (active) unlistenClosed = fn;
          else fn();
        })
        .catch((err) => {
          console.warn('[BrowserView] Failed to subscribe to browser:surface-closed:', err);
        });
    }

    return () => {
      active = false;
      unlistenUpdated?.();
      unlistenClosed?.();
    };
  }, [workspaceId, session]);

  const refreshLocalServers = useCallback(async () => {
    setDiscoveringServers(true);
    try {
      const res = await discoverBrowserServers();
      setDiscoveredServers(Array.isArray(res?.servers) ? res.servers : []);
    } catch (err) {
      console.warn('[BrowserView] Failed to discover local dev servers:', err);
      flashNotice('Could not scan local dev servers.');
    } finally {
      setDiscoveringServers(false);
    }
  }, [flashNotice]);

  // Auto-discover local dev servers when viewing the start screen.
  useEffect(() => {
    if (phase === 'blank') {
      void refreshLocalServers();
    }
  }, [phase, refreshLocalServers]);

  // The surface lives outside the DOM: anchor it to the pane and keep occlusion in sync.
  useEffect(() => {
    const element = anchorRef.current;
    session.setAnchor(element, !isOccluded && !serversOpen);
    return () => session.setAnchor(null, false);
  }, [session, isOccluded, serversOpen]);

  useEffect(() => {
    void session.setOccluded(isOccluded || serversOpen);
  }, [session, isOccluded, serversOpen]);

  // Keep native WebView2 presentation strictly synchronized whenever the anchor element or window resizes.
  useEffect(() => {
    const element = anchorRef.current;
    if (!element) return;

    let rafId: number | null = null;
    const update = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        session.refreshPresentation();
      });
    };

    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener('resize', update);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [session]);

  // Mirror the live surface address into the bar, unless the user is editing it.
  useEffect(() => {
    if (!isEditingAddress) setAddressInput(view?.displayUrl ?? '');
  }, [view?.displayUrl, isEditingAddress]);

  // Autofocus the address input when entering edit mode.
  useEffect(() => {
    if (isEditingAddress) {
      const input = document.querySelector<HTMLInputElement>('#browser-toolbar-address-app-browser');
      input?.focus();
      input?.select();
    }
  }, [isEditingAddress]);

  const anchorRect = anchorRef.current ? anchorRef.current.getBoundingClientRect() : null;
  const deviceDim = getDeviceDimensions(viewport);
  const localFittedBounds =
    anchorRect && deviceDim
      ? fitDeviceBounds({ x: 0, y: 0, width: anchorRect.width, height: anchorRect.height }, viewport)
      : null;
  const showDevicePreview = deviceDim !== null && view !== null && phase === 'ready';

  const currentSecurity = view?.transportSecurity ?? (addressInput ? transportOf(addressInput) : null);
  const showAgentBanner = Boolean(
    view && (view.ownerKind === 'agent' || view.agentActive || view.pausedForAuth || view.takeoverRequested)
  );

  const openAddress = (raw: string): void => {
    setServersOpen(false);
    void session.openAddress(raw);
  };

  const control = (action: BrowserControlAction): void => {
    void session.control(action);
  };

  const handleSelectTab = (surface: BrowserSurfaceView): void => {
    setServersOpen(false);
    void session.attachSurface(surface);
  };

  const handleCloseTab = async (surface: BrowserSurfaceView): Promise<void> => {
    const remaining = surfaces.filter((item) => item.surfaceId !== surface.surfaceId);
    setSurfaces(remaining);
    if (view?.surfaceId === surface.surfaceId) {
      if (remaining.length > 0) {
        await session.attachSurface(remaining[0]);
      } else {
        await session.detachToBlank();
      }
    }
    try {
      await closeBrowserSurface(surface.surfaceId, surface.descriptorId);
    } catch (err) {
      console.warn('[BrowserView] Failed to close browser surface:', surface.surfaceId, err);
    }
  };

  const handleNewTab = (): void => {
    setServersOpen(false);
    void session.detachToBlank();
  };

  const handleTakeover = async (): Promise<void> => {
    if (!view || actionBusy) return;
    setActionBusy(true);
    try {
      const updated = await takeoverBrowserSurface(view.surfaceId);
      setSurfaces((prev) => upsertSurfaceList(prev, updated));
      session.syncView(updated);
      flashNotice('Agent paused — you have manual control.');
    } catch (err) {
      console.warn('[BrowserView] Failed to take over browser tab:', err);
      flashNotice('Could not take over browser tab.');
    } finally {
      setActionBusy(false);
    }
  };

  const handleResumeAgent = async (): Promise<void> => {
    if (!view || actionBusy) return;
    setActionBusy(true);
    try {
      const updated = await resumeBrowserSurface(view.surfaceId, view.ownerThreadId ?? null);
      setSurfaces((prev) => upsertSurfaceList(prev, updated));
      session.syncView(updated);
      flashNotice('Agent control resumed.');
    } catch (err) {
      console.warn('[BrowserView] Failed to resume agent control:', err);
      flashNotice('Could not resume agent control.');
    } finally {
      setActionBusy(false);
    }
  };

  const handleCaptureScreenshot = async (): Promise<void> => {
    if (!view || capturingScreenshot) return;
    setCapturingScreenshot(true);
    try {
      const result = await captureBrowserSurfaceScreenshot(view.surfaceId, 'png', 90);
      if (!result.ok || !result.dataBase64) {
        flashNotice(result.error || 'Screenshot capture returned no image.');
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const detail: BrowserScreenshotEventDetail = {
        dataBase64: result.dataBase64,
        mimeType: result.mimeType || 'image/png',
        fileName: `browser-capture-${stamp}.png`,
        url: view.displayUrl,
        sha256: result.sha256,
      };
      window.dispatchEvent(new CustomEvent<BrowserScreenshotEventDetail>(ATTACH_BROWSER_SCREENSHOT_EVENT, { detail }));
      flashNotice('Screenshot attached to active thread.');
    } catch (err) {
      console.warn('[BrowserView] Failed to capture browser screenshot:', err);
      flashNotice('Failed to capture browser screenshot.');
    } finally {
      setCapturingScreenshot(false);
    }
  };

  return (
    <div className="browser-pane-host" data-testid="app-browser-pane">
      {/* Multi-tab strip showing user tabs and parallel agent tabs */}
      <BrowserTabBar
        surfaces={surfaces}
        activeSurfaceId={view?.surfaceId ?? null}
        onSelectTab={handleSelectTab}
        onCloseTab={(surface) => void handleCloseTab(surface)}
        onNewTab={handleNewTab}
      />

      {/* Browser Controls Toolbar */}
      <div
        aria-label="Browser controls"
        className="app-browser-toolbar"
        data-tooltip-placement="above"
        role="toolbar"
      >
        {/* Navigation buttons: Back & Forward */}
        <span className="browser-pane-nav">
          <button
            aria-label="Back"
            disabled={!view?.canGoBack || busy}
            onClick={() => control('back')}
            title="Back"
            type="button"
          >
            <ArrowLeftIcon size={12} />
          </button>
          <button
            aria-label="Forward"
            disabled={!view?.canGoForward || busy}
            onClick={() => control('forward')}
            title="Forward"
            type="button"
          >
            <ArrowRightIcon size={12} />
          </button>
        </span>

        {/* URL Address Bar with SSL Lock badge and Reload button */}
        <div className={`browser-pane-address${isEditingAddress ? ' browser-pane-address--editing' : ''}`}>
          {currentSecurity === 'secure' ? (
            <span
              aria-label="Secure connection"
              className="browser-pane-security browser-pane-security--secure"
              role="img"
              title="Secure connection"
            >
              <LockKeyholeIcon size={11} />
            </span>
          ) : currentSecurity === 'local' ? (
            <span
              aria-label="Local connection"
              className="browser-pane-security browser-pane-security--local"
              role="img"
              title="Local connection"
            >
              <EarthIcon size={11} />
            </span>
          ) : currentSecurity === 'insecure' ? (
            <span
              aria-label="Not secure"
              className="browser-pane-security browser-pane-security--insecure"
              role="img"
              title="Not secure — HTTP outside loopback"
            >
              <TriangleAlertIcon size={11} />
              <span aria-hidden="true">Not secure</span>
            </span>
          ) : (
            <span className="browser-pane-security">
              <EarthIcon size={11} />
            </span>
          )}

          {isEditingAddress ? (
            <input
              aria-label="Address"
              id="browser-toolbar-address-app-browser"
              maxLength={BROWSER_ADDRESS_MAX_LENGTH}
              onChange={(e) => setAddressInput(e.target.value)}
              onBlur={() => {
                setIsEditingAddress(false);
                setAddressInput(view?.displayUrl || '');
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  openAddress(addressInput);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setIsEditingAddress(false);
                  setAddressInput(view?.displayUrl || '');
                }
              }}
              placeholder="Address or search"
              spellCheck={false}
              value={addressInput}
            />
          ) : (
            <button
              aria-label="Address"
              className="browser-pane-address__label"
              onClick={() => {
                setIsEditingAddress(true);
                setAddressInput(view?.displayUrl || '');
              }}
              title={view?.displayUrl || 'Click to enter an address'}
              type="button"
            >
              {view ? browserAddressLabel(view.displayUrl) : 'Address or search'}
            </button>
          )}

          <button
            aria-label={view?.loading ? 'Page is loading' : 'Reload page'}
            disabled={!view || busy || view.loading}
            onClick={() => control('reload')}
            title={view?.loading ? 'Page is loading' : 'Reload'}
            type="button"
          >
            <RotateCcwIcon size={12} className={view?.loading ? 'browser-pane-address__loading' : ''} />
          </button>
          <span aria-live="polite" className="sr-only">
            {error ?? (view?.loading ? 'Page loading' : '')}
          </span>
        </div>

        {/* Local Dev Servers quick-picker */}
        <button
          aria-label="Local dev servers"
          aria-expanded={serversOpen}
          className="browser-toolbar-action"
          data-testid="browser-local-servers-btn"
          onClick={() => {
            const next = !serversOpen;
            setServersOpen(next);
            if (next) void refreshLocalServers();
          }}
          title="Local dev servers"
          type="button"
        >
          <ServerIcon size={12} />
        </button>

        {/* Capture Screenshot to Active Thread */}
        <button
          aria-label="Capture screenshot to thread"
          className="browser-toolbar-action"
          data-testid="browser-capture-screenshot-btn"
          disabled={!view || busy || capturingScreenshot}
          onClick={() => void handleCaptureScreenshot()}
          title="Capture screenshot to active thread"
          type="button"
        >
          <CameraIcon size={12} />
        </button>

        {/* Toggle Design Mode (Element Picker) */}
        <button
          aria-label="Select element"
          aria-pressed={designMode}
          className="browser-design-mode"
          data-variant="toolbar"
          disabled={!view || busy}
          onClick={() => void session.setDesignMode(!designMode)}
          title={designMode ? 'Stop selecting elements' : 'Select element — copy it for your agent'}
          type="button"
        >
          <SquareMousePointerIcon size={12} />
        </button>

        {/* Open in external browser */}
        <button
          aria-label="Open in external browser"
          className="browser-external-open"
          data-variant="toolbar"
          disabled={!view?.displayUrl && !addressInput}
          onClick={() => {
            const currentUrl = view?.displayUrl || addressInput;
            if (currentUrl) {
              openExternalLink(currentUrl);
            }
          }}
          title="Open in external browser"
          type="button"
        >
          <ExternalLinkIcon size={12} />
        </button>

        {/* Device Viewport Toolbar (Responsive preview: Desktop, Phone, Tablet, Rotate) */}
        <fieldset className="browser-device-toolbar" aria-label="Responsive preview">
          <button
            aria-label="Desktop preview"
            aria-pressed={viewport.mode === 'desktop'}
            onClick={() => session.setViewport({ mode: 'desktop', landscape: false })}
            title="Desktop viewport"
            type="button"
          >
            <MonitorIcon size={12} />
            <span>Desktop</span>
          </button>
          <button
            aria-label="Phone preview"
            aria-pressed={viewport.mode === 'phone'}
            onClick={() => session.setViewport({ mode: 'phone', landscape: viewport.landscape })}
            title="Phone viewport"
            type="button"
          >
            <SmartphoneIcon size={12} />
            <span>Phone</span>
          </button>
          <button
            aria-label="Tablet preview"
            aria-pressed={viewport.mode === 'tablet'}
            onClick={() => session.setViewport({ mode: 'tablet', landscape: viewport.landscape })}
            title="Tablet viewport"
            type="button"
          >
            <TabletIcon size={12} />
            <span>Tablet</span>
          </button>
          <button
            aria-label="Rotate preview"
            disabled={viewport.mode === 'desktop'}
            onClick={() => session.setViewport({ mode: viewport.mode, landscape: !viewport.landscape })}
            title={viewport.landscape ? 'Rotate to portrait' : 'Rotate to landscape'}
            type="button"
          >
            <RotateCwIcon size={12} />
          </button>
        </fieldset>
      </div>

      {/* Live Agent Control & Auth Handoff Banner */}
      {showAgentBanner && view && (
        <div
          className={`browser-agent-banner${view.pausedForAuth ? ' browser-agent-banner--paused' : ''}${view.takeoverRequested ? ' browser-agent-banner--manual' : ''}`}
          data-testid="browser-agent-banner"
          role="status"
        >
          <div className="browser-agent-banner__info">
            {view.pausedForAuth ? <ShieldAlertIcon size={13} /> : <BotIcon size={13} />}
            <span className="browser-agent-banner__pill">
              {view.statusPill ||
                (view.pausedForAuth
                  ? 'Paused for sign-in'
                  : view.takeoverRequested
                    ? 'Manual control'
                    : 'Agent active')}
            </span>
            {view.pauseReason && (
              <span className="browser-agent-banner__reason">{view.pauseReason}</span>
            )}
          </div>
          <div className="browser-agent-banner__actions">
            {view.agentActive && !view.pausedForAuth && (
              <button
                type="button"
                className="browser-agent-banner__btn browser-agent-banner__btn--stop"
                data-testid="browser-takeover-btn"
                disabled={actionBusy}
                onClick={() => void handleTakeover()}
              >
                <HandIcon size={12} />
                <span>Stop / Take Over</span>
              </button>
            )}
            {(view.pausedForAuth || view.takeoverRequested || !view.agentActive) && (
              <button
                type="button"
                className="browser-agent-banner__btn browser-agent-banner__btn--resume"
                data-testid="browser-resume-btn"
                disabled={actionBusy}
                onClick={() => void handleResumeAgent()}
              >
                <PlayIcon size={12} />
                <span>Resume Agent</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Transient status feedback banner */}
      {actionNotice && (
        <div className="browser-capture-feedback" role="status" data-testid="browser-action-notice">
          {actionNotice}
        </div>
      )}

      {/* Local Servers Quick-Picker Popover */}
      {serversOpen && (
        <div
          className="browser-servers-popover"
          role="dialog"
          aria-label="Local dev servers"
          data-testid="browser-servers-popover"
        >
          <div className="browser-servers-popover__header">
            <span>Local Dev Servers</span>
            <button
              type="button"
              className="browser-servers-popover__refresh"
              disabled={discoveringServers}
              onClick={() => void refreshLocalServers()}
            >
              {discoveringServers ? 'Scanning…' : 'Rescan'}
            </button>
          </div>
          {discoveredServers.length === 0 ? (
            <p className="browser-servers-popover__empty">
              {discoveringServers
                ? 'Probing local loopback dev ports…'
                : 'No local dev servers detected on common ports.'}
            </p>
          ) : (
            <ul className="browser-servers-popover__list">
              {discoveredServers.map((srv) => (
                <li key={srv.url}>
                  <button
                    type="button"
                    className="browser-servers-popover__item"
                    onClick={() => openAddress(srv.url)}
                  >
                    <span className="browser-servers-popover__url">{srv.url}</span>
                    <span className="browser-servers-popover__meta">
                      {srv.titleHint || srv.frameworkHint || 'Local server'} · :{srv.port}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Main Page Area */}
      <div className="browser-pane-content">
        <div className="browser-runtime">
          {/* Native WebView2 Mounting Anchor (Bounds Reference & Device Frame Overlay) */}
          <div className="browser-runtime__anchor" ref={anchorRef}>
            {showDevicePreview && localFittedBounds !== null && (
              <>
                <div
                  className="browser-device-frame"
                  style={{
                    left: localFittedBounds.x,
                    top: localFittedBounds.y,
                    width: localFittedBounds.width,
                    height: localFittedBounds.height,
                  }}
                />
                <p
                  className="browser-device-caption"
                  style={{
                    top: localFittedBounds.y + localFittedBounds.height,
                  }}
                >
                  {deviceDim.width} × {deviceDim.height} · {Math.round((localFittedBounds.zoom ?? 1) * 100)}%
                  <span className="sr-only">
                    {' '}— CSS viewport preview. Touch and device hardware are unchanged.
                  </span>
                </p>
              </>
            )}
            {showDevicePreview && localFittedBounds === null && (
              <p className="browser-device-space" role="status">
                Enlarge this pane to fit the preview.
              </p>
            )}
          </div>

          {/* Initial Blank Start Screen */}
          {phase === 'blank' && (
            <div className="browser-start">
              <EarthIcon size={32} className="browser-start__icon" />
              <div>
                <h2>Browser</h2>
                <p>One browser for every mode. It keeps its page when you switch between Agent, Code and Thread.</p>
              </div>
              <form
                className="browser-start__form"
                onSubmit={(e) => {
                  e.preventDefault();
                  openAddress(startInput);
                }}
              >
                <label className="sr-only" htmlFor="browser-address-app-browser">
                  Address or search
                </label>
                <input
                  id="browser-address-app-browser"
                  maxLength={BROWSER_ADDRESS_MAX_LENGTH}
                  onChange={(e) => setStartInput(e.target.value)}
                  placeholder="Address or search"
                  spellCheck={false}
                  value={startInput}
                />
                <button aria-label="Open address" disabled={busy} type="submit">
                  <ArrowRightIcon size={14} />
                </button>
              </form>
              {discoveredServers.length > 0 && (
                <fieldset className="browser-start__servers" data-testid="browser-start-servers">
                  <legend className="browser-start__servers-label">Detected local servers</legend>
                  <div className="browser-start__quick">
                    {discoveredServers.map((srv) => (
                      <button
                        key={srv.url}
                        type="button"
                        disabled={busy}
                        onClick={() => openAddress(srv.url)}
                      >
                        {srv.frameworkHint || 'Local'} :{srv.port}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}
              <fieldset className="browser-start__quick">
                <legend className="sr-only">Quick destinations</legend>
                {BROWSER_QUICK_DESTINATIONS.map((destination) => (
                  <button
                    key={destination.target}
                    type="button"
                    disabled={busy}
                    onClick={() => openAddress(destination.target)}
                  >
                    {destination.label}
                  </button>
                ))}
              </fieldset>
              {error && (
                <p className="browser-start__error" role="alert">
                  {error}
                </p>
              )}
            </div>
          )}

          {/* Preparing / Creating Loading Screen */}
          {phase === 'creating' && (
            <div className="browser-preview-state" role="status">
              <span className="loading-spinner" />
              <strong>Preparing the browser…</strong>
              <p>The page is opening in an isolated browser surface.</p>
            </div>
          )}

          {/* Error Loading Screen */}
          {phase === 'error' && (
            <div className="browser-preview-state browser-preview-state--error" role="alert">
              <WifiOffIcon size={30} />
              <strong>
                {isTauriEnvironment() ? "Couldn't load this page" : 'Desktop Browser Surface'}
              </strong>
              <p>
                {error ||
                  (isTauriEnvironment()
                    ? 'The isolated browser surface is unavailable.'
                    : 'Native WebView2 child surfaces require running in the desktop Tauri window (npm run tauri dev).')}
              </p>
              <button
                type="button"
                className="secondary-button browser-preview-state__action"
                onClick={() => session.reset()}
              >
                Back to start
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
