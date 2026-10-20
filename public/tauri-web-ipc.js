// Kite Code — Tauri 2.0 web IPC compatibility shim
// Injected in browser dev mode so the desktop React app can call invoke() over HTTP.

(function () {
  // If native Tauri IPC already exists (inside desktop app), install resilience wrapper
  if (
    window.__TAURI_INTERNALS__ &&
    typeof window.__TAURI_INTERNALS__.invoke === "function" &&
    !window.__TAURI_INTERNALS__.__is_web_ipc_shim__
  ) {
    console.log("%c[Kite Code] Native Tauri IPC detected, installing resilience wrapper.", "color: #4ade80; font-weight: bold; font-size: 14px;");
    const nativeInvoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
    window.__TAURI_INTERNALS__.invoke = async function (cmd, args = {}, ...rest) {
      if (cmd && cmd.startsWith("plugin:window|")) {
        try {
          switch (cmd) {
            case "plugin:window|minimize":
              return await nativeInvoke("app_window_minimize");
            case "plugin:window|toggle_maximize":
            case "plugin:window|maximize":
            case "plugin:window|unmaximize":
              return await nativeInvoke("app_window_toggle_maximize");
            case "plugin:window|close":
              return await nativeInvoke("app_window_close");
            case "plugin:window|start_dragging":
              return await nativeInvoke("app_window_start_dragging");
            case "plugin:window|is_maximized":
              return await nativeInvoke("app_window_is_maximized");
            case "plugin:window|is_minimized": return false;
            case "plugin:window|is_fullscreen": return false;
            case "plugin:window|is_focused": return true;
            case "plugin:window|scale_factor": return window.devicePixelRatio || 1;
            case "plugin:window|inner_size":
            case "plugin:window|outer_size":
              return { width: window.innerWidth, height: window.innerHeight };
            case "plugin:window|inner_position":
            case "plugin:window|outer_position":
              return { x: window.screenX || 0, y: window.screenY || 0 };
            default:
              return null;
          }
        } catch (e) {
          console.warn("[Kite Code] Window operation fallback:", cmd, e);
          return null;
        }
      }

      try {
        const res = await nativeInvoke(cmd, args, ...rest);
        if (cmd === "save_shell_state" || cmd === "save_workspace_layout" || cmd === "save_thread_grid" || cmd === "set_app_menu_state") {
          return null;
        }
        return res;
      } catch (err) {
        if (err && String(err).toLowerCase().includes("not found")) {
          console.warn(`[Kite Code] Graceful fallback for unhandled command ${cmd}:`, err);
          if (cmd.startsWith("list_")) return [];
          if (cmd.startsWith("save_") || cmd.startsWith("set_") || cmd.startsWith("cancel_") || cmd.startsWith("delete_") || cmd.startsWith("update_") || cmd.startsWith("remove_")) return null;
          return null;
        }
        console.error(`[Kite Code] Command failed for ${cmd}:`, err);
        throw err;
      }
    };
    return;
  }

  console.log("%c[Kite Code] Initializing Tauri 2.0 web IPC shim...", "color: #38bdf8; font-weight: bold; font-size: 14px;");

  const callbacks = new Map();
  let callbackSeq = 1;
  const eventListeners = new Map();

  function transformCallback(fn, once = false) {
    const id = callbackSeq++;
    callbacks.set(id, (data) => {
      if (once) callbacks.delete(id);
      if (typeof fn === "function") fn(data);
    });
    return id;
  }

  function unregisterCallback(id) {
    callbacks.delete(id);
  }

  async function invoke(cmd, args = {}) {
    if (cmd && cmd.startsWith("plugin:window|")) {
      switch (cmd) {
        case "plugin:window|is_maximized":
          return false;
        case "plugin:window|is_minimized":
          return false;
        case "plugin:window|is_fullscreen":
          return false;
        case "plugin:window|is_focused":
          return true;
        case "plugin:window|scale_factor":
          return window.devicePixelRatio || 1;
        case "plugin:window|inner_size":
        case "plugin:window|outer_size":
          return { width: window.innerWidth, height: window.innerHeight };
        case "plugin:window|inner_position":
        case "plugin:window|outer_position":
          return { x: window.screenX || 0, y: window.screenY || 0 };
        case "plugin:window|toggle_maximize":
        case "plugin:window|maximize":
        case "plugin:window|unmaximize":
        case "plugin:window|minimize":
        case "plugin:window|close":
        case "plugin:window|start_dragging":
          return null;
        default:
          return null;
      }
    }

    if (cmd === "plugin:event|listen") {
      const eventName = args.event;
      const handlerId = args.handler;
      if (!eventListeners.has(eventName)) {
        eventListeners.set(eventName, new Set());
      }
      eventListeners.get(eventName).add(handlerId);
      return handlerId;
    }

    if (cmd === "plugin:event|unlisten") {
      const eventName = args.event;
      const eventId = args.eventId;
      if (eventListeners.has(eventName)) {
        eventListeners.get(eventName).delete(eventId);
      }
      return true;
    }

    if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") {
      return null;
    }

    try {
      const response = await fetch("/api/tauri/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cmd, args })
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `Command failed: ${cmd}`);
      }
      return await response.json();
    } catch (err) {
      console.error(`[Tauri IPC Error] ${cmd}:`, err);
      throw err;
    }
  }

  window.__TAURI_INTERNALS__ = {
    __is_web_ipc_shim__: true,
    invoke,
    transformCallback,
    unregisterCallback,
    convertFileSrc: (src) => src,
    ipc: (message) => {
      console.log("[Tauri legacy ipc]", message);
    },
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" }
    }
  };

  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event, id) => {
      if (eventListeners.has(event)) {
        eventListeners.get(event).delete(id);
      }
    }
  };

  window.addEventListener("resize", () => {
    const handlers = eventListeners.get("tauri://resize");
    if (handlers) {
      for (const id of handlers) {
        const cb = callbacks.get(id);
        if (cb) cb({ event: "tauri://resize", id, payload: { width: window.innerWidth, height: window.innerHeight } });
      }
    }
  });

  setInterval(async () => {
    try {
      const res = await fetch("/api/tauri/events");
      if (res.ok) {
        const events = await res.json();
        for (const ev of events) {
          if (eventListeners.has(ev.event)) {
            for (const handlerId of eventListeners.get(ev.event)) {
              const cb = callbacks.get(handlerId);
              if (cb) cb({ event: ev.event, id: handlerId, payload: ev.payload });
            }
          }
        }
      }
    } catch (_) {}
  }, 1000);

  console.log("%c[Kite Code] Tauri web IPC shim ready.", "color: #4ade80; font-weight: bold;");
})();
