import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { BrowserControlAction } from '../../lib/ipc';
import { isTauriEnvironment } from '../../lib/ipc';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  RotateCwIcon,
  RotateCcwIcon,
  EarthIcon,
  LockKeyholeIcon,
  TriangleAlertIcon,
  SquareMousePointerIcon,
  MonitorIcon,
  SmartphoneIcon,
  TabletIcon,
  WifiOffIcon,
} from './browser/browserIcons';
import {
  BROWSER_ADDRESS_MAX_LENGTH,
  BROWSER_QUICK_DESTINATIONS,
  browserAddressLabel,
} from './browser/browserAddress';
import { fitDeviceBounds, getDeviceDimensions } from './browser/browserGeometry';
import { getBrowserSurfaceSession } from './browser/browserSurfaceRegistry';
import './browser.css';

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

export const BrowserView: React.FC<BrowserViewProps> = ({ workspaceId, isOccluded = false }) => {
  const session = useMemo(() => getBrowserSurfaceSession(workspaceId), [workspaceId]);
  const { viewport, phase, view, busy, error } = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot
  );
  const [addressInput, setAddressInput] = useState<string>('');
  const [startInput, setStartInput] = useState<string>('');
  const [isEditingAddress, setIsEditingAddress] = useState<boolean>(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  const designMode = view?.designMode ?? false;

  // The surface lives outside the DOM: anchor it to the pane and keep occlusion in sync.
  useEffect(() => {
    const element = anchorRef.current;
    session.setAnchor(element, !isOccluded);
    return () => session.setAnchor(null, false);
  }, [session, isOccluded]);

  useEffect(() => {
    void session.setOccluded(isOccluded);
  }, [session, isOccluded]);

  // Keep native WebView2 presentation strictly synchronized whenever the anchor element or window resizes
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

  // Autofocus the address input when entering edit mode
  useEffect(() => {
    if (isEditingAddress) {
      const input = document.querySelector<HTMLInputElement>('#browser-toolbar-address-app-browser');
      input?.focus();
      input?.select();
    }
  }, [isEditingAddress]);

  // Device preview overlay geometry (presentation only; the session owns native bounds)
  const anchorRect = anchorRef.current ? anchorRef.current.getBoundingClientRect() : null;
  const deviceDim = getDeviceDimensions(viewport);
  const localFittedBounds =
    anchorRect && deviceDim
      ? fitDeviceBounds({ x: 0, y: 0, width: anchorRect.width, height: anchorRect.height }, viewport)
      : null;
  const showDevicePreview = deviceDim !== null && view !== null && phase === 'ready';

  const currentSecurity = view?.transportSecurity ?? (addressInput ? transportOf(addressInput) : null);

  const openAddress = (raw: string): void => {
    void session.openAddress(raw);
  };

  const control = (action: BrowserControlAction): void => {
    void session.control(action);
  };

  return (
    <div className="browser-pane-host" data-testid="app-browser-pane">
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
                className="secondary-button"
                onClick={() => session.reset()}
                style={{ marginTop: '12px' }}
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
