/** True when the Tauri web IPC shim is active (browser test lane, not native WebView). */
export function isWebIpcShim(): boolean {
  if (typeof window === 'undefined') return false;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { __is_web_ipc_shim__?: boolean } })
    .__TAURI_INTERNALS__;
  return Boolean(internals?.__is_web_ipc_shim__);
}

/** Dev browser lane: shim IPC + optional Vite mode or query flag. */
export function isBrowserTestLane(): boolean {
  if (typeof window === 'undefined') return false;
  if (isWebIpcShim()) return true;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('kiteBrowserTest') === '1') return true;
  } catch {
    // ignore
  }
  return import.meta.env.VITE_KITE_BROWSER_TEST === '1';
}
