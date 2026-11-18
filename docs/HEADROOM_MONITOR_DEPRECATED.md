# Headroom Monitor — Deprecated & Detached

Status: **Deprecated (detached from runtime loading, preserved as reference)**

## Summary

The Headroom proxy monitor tab and its Tauri loopback fetcher are no longer loaded or rendered in Kite Code.

### Why It Was Detached

1. **No longer used in active workflows**: Headroom MCP/proxy integration is not part of the active agent runtime.
2. **Incompatible with OAuth/CCPA provider traffic**: Native Antigravity CLI/IDE sessions route directly over CCPA (`daily-cloudcode-pa.googleapis.com`) rather than `GOOGLE_GEMINI_BASE_URL`, so local proxy metrics (`http://127.0.0.1:8787/stats`) never reflected those models or turns.
3. **Avoid dead runtime surface**: Removing the tab from the resource monitor popover and unregistering the Tauri command keeps the active UI and binary clean without losing the implementation blueprint.

## Preserved Reference Files

These files remain in the repository so a future token/context-savings monitor can reuse the card layout, formatting helpers, and loopback polling pattern:

- `src/components/telemetry/tabs/HeadroomTab.tsx` — UI panel (`HeadroomPanel`, lifetime + session metrics, per-model/per-agent breakdowns, sparkline).
- `src/lib/headroomMonitor.ts` — Payload parser (`parseHeadroomEnvelope`) and number/USD/duration formatters.
- `src-tauri/src/headroom_monitor.rs` — Loopback-only HTTP fetcher (`fetch_headroom_monitor`, `is_loopback_http`).
- `src/components/telemetry/tabs/HeadroomTab.test.tsx` & `src/lib/headroomMonitor.test.ts` — Unit tests covering the UI and parser contracts.

## Detached Entry Points

- `src/components/telemetry/SystemResourcePopover.tsx`: Removed the `headroom` tab entry, `ResourceTab` union variant, and `<HeadroomTab />` import/render so Vite excludes the module from the production bundle.
- `src-tauri/src/main.rs`: Gated `pub mod headroom_monitor;` under `#[cfg(test)]` and removed `fetch_headroom_monitor` from `tauri::generate_handler!`.

## Guidance for a Future Replacement

When implementing a similar token/context-savings view in the future:

1. Source metrics from Kite's own provider/runtime usage ledger or native CLI session telemetry rather than assuming an external HTTP proxy sees every provider's traffic.
2. Reintroduce a tab in `SystemResourcePopover.tsx` (or dedicated telemetry panel) reusing the visual layout in `HeadroomTab.tsx` and the formatting helpers in `headroomMonitor.ts`.
