# Startup splash cover

Objective: Keep the Kite logo covering the window from the first HTML paint until the intro dismisses, so the Code workspace never flashes underneath.
Branch: `feat/ui-composer` (shared dirty tree; do not stage unrelated terminal/settings files).
Delivery strategy: `single-pr` (uncommitted shared tree; user reviews diff).
Test runner: `npx vitest run`; typecheck: `npx tsc --noEmit`.

## Problem

The window shows the Code empty state (title bar, sidebar, agent launcher) for a few frames, then `AppIntro` covers it for about three seconds, then the app appears. The user wants the logo to cover that whole interval. No Code shell flash.

## Why

`AppIntro` is mounted in the same React commit as the shell, but `surfaceMotion('scrim')` starts at `opacity: 0` and fades in over 400 ms (`tweens.overlay`). The shell is visible through that fade. There is also no cover outside `#root` before React paints. `src/boot.css` exists, but `index.html` never mounts `.boot`, and the mark is `display: none` unless `html[data-launch="routine"]`.

## Scope

- Static opaque boot cover in `index.html`, sibling of `#root`, styled by a render-blocking `src/boot.css` link.
- Hide `#root` until the boot cover is released, so a late CSS apply cannot reveal the shell.
- `AppIntro` is opaque on the first frame in production. Exit fade may stay.
- Release the cover in `useLayoutEffect` only when the opaque intro is committed, or immediately when the intro is already dismissed (browser test lane).
- Motion Lab may still preview the entrance animation.

## Out of scope

- Do not change `APP_INTRO_MIN_MS`.
- Do not edit `src-tauri/**` or `tauri.conf.json` (already dirty with unrelated work).
- Do not restyle the Code empty state, title bar, or mode switcher.
- No inline `<style>` in `index.html` (CSP nonce breaks xterm).

## Tasks

- [x] T1. Cover startup from first HTML paint through the intro handoff.
- [x] T2. Verify typecheck and focused tests.

## Acceptance

- Before the bundle runs, the window shows an opaque cover with the Kite mark, not the Code workspace.
- The production intro does not fade in from transparent.
- The cover is removed only in the same commit as an opaque intro, or immediately when the intro starts dismissed.
- Browser test lane does not stay covered.
- Exit of the intro may still fade.

## Checks

- `npx tsc --noEmit`
- `npx vitest run src/motion/AppIntro.test.tsx` if that test exists; otherwise the closest intro test.

## Progress

- T1 done. Static `#boot` cover, `#root` hidden until release, production intro `initial={false}`, release in `useLayoutEffect`. Parent correction: stylesheet href is `./src/boot.css` so Vite emits it in the packaged build. Absolute `/src/boot.css` 404s after `vite build`.
- T2 done. `npx tsc --noEmit` passed. `npx vitest run src/motion/AppIntro.test.tsx` passed, 3 tests.
- Commit: `ccaac258db9e767c9ce06331160fc6dbc9a9a5d7` (`fix(splash): keep the logo covering the window until the intro is ready`).

## Next step

Relaunch the desktop app and confirm the Code workspace no longer flashes before the logo.
