# Terminal Appearance & Rendering Settings — Specification

Status: implemented on `feat/ui-composer`.

## 1. Context & Problem Statement

During the terminal rendering investigation (`odd/tasks/terminal-session-artifact.md`), several low-level parameters in `src/components/views/TerminalView.tsx` were altered alongside the structural ConPTY and Unicode 11 fixes:

1. **Renderer Mode (`WebGL` vs. `DOM`)**:
   - Previously, Kite rendered terminals with xterm's **DOM renderer**, where Windows/WebView2 rasterizes glyphs directly using **DirectWrite + subpixel ClearType**.
   - Enabling `@xterm/addon-webgl` (`WebglAddon`) on visible panes switched rendering to a **GPU bitmap texture atlas** (grayscale alpha blending without ClearType subpixel antialiasing), changing perceived font weight, stroke crispness, and resolution.
2. **Line Height (`1.0` vs. `1.16`)**:
   - Previously, `lineHeight` was `1.16`, giving terminal rows comfortable vertical breathing room.
   - Setting `lineHeight: 1` compressed rows vertically by ~16% to force Unicode block elements (`▀`, `▄`, `█`) to touch. However, because `attachDomBlockFillCleanup` (`src/lib/terminalViewport.ts`) now replaces runs of Unicode block elements (`U+2580..U+2595`) with exact CSS `linear-gradient` backgrounds spanning 100% of the row height, **the DOM renderer no longer requires `lineHeight: 1` to avoid horizontal seams**.
3. **Contrast & Bold Brightening**:
   - `drawBoldTextInBrightColors: true` and `minimumContrastRatio: 4.5` shifted secondary ANSI colors compared to the classic palette.

### Product Goal
- **Restore the classic Kite terminal appearance as the default out-of-the-box configuration** (`renderer: 'dom'`, `lineHeight: 1.16`, `fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace'`, `fontSize: 13`, `cursorStyle: 'bar'`).
- **Expose a dedicated "Apariencia y Tipografía" section inside `Settings -> Terminal`** (`activeTab === 'terminal'` in `src/components/views/SettingsView.tsx`) so users can customize font family, font size, line height, cursor style, and renderer mode (`DOM` vs. `WebGL`) in real time without restarting their active terminal sessions.

---

## 2. Architecture & Data Contract

### 2.1 Preference Module (`src/lib/terminalAppearancePrefs.ts`)

Create `src/lib/terminalAppearancePrefs.ts` to own validation, persistence (`localStorage`), and live broadcast of terminal appearance settings:

```ts
export type TerminalRendererMode = 'dom' | 'webgl';

export type TerminalFontFamilyId =
  | 'cascadia'
  | 'jetbrains'
  | 'geist'
  | 'fira'
  | 'consolas';

export type TerminalCursorStyle = 'bar' | 'block' | 'underline';

export interface TerminalAppearancePrefs {
  renderer: TerminalRendererMode;
  fontFamilyId: TerminalFontFamilyId;
  fontSize: number;       // Clamped 10..22, default 13
  lineHeight: number;     // Allowed presets or clamped 1.0..1.4, default 1.16
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
}

export const TERMINAL_APPEARANCE_STORAGE_KEY = 'kite.terminalAppearancePrefs';
export const TERMINAL_APPEARANCE_CHANGED_EVENT = 'kite:terminal-appearance-changed';

export const DEFAULT_TERMINAL_APPEARANCE_PREFS: TerminalAppearancePrefs = {
  renderer: 'dom',
  fontFamilyId: 'cascadia',
  fontSize: 13,
  lineHeight: 1.16,
  cursorStyle: 'bar',
  cursorBlink: false,
};
```

#### Font Stack Mapping (`resolveTerminalFontFamily`)

| `fontFamilyId` | Label in Settings UI | CSS Font Stack |
| :--- | :--- | :--- |
| `'cascadia'` *(default)* | `Cascadia Mono (Clásico)` | `'"Cascadia Mono", "Cascadia Code", Consolas, monospace'` |
| `'jetbrains'` | `JetBrains Mono` | `'"JetBrains Mono", "Cascadia Mono", Consolas, monospace'` |
| `'geist'` | `Geist Mono` | `'"Geist Mono", "Cascadia Mono", Consolas, monospace'` |
| `'fira'` | `Fira Code` | `'"Fira Code", "Cascadia Mono", Consolas, monospace'` |
| `'consolas'` | `Consolas` | `'Consolas, "Cascadia Mono", monospace'` |

#### Line Height Presets

| Preset Label | Value | Description |
| :--- | :--- | :--- |
| `Clásico (1.16)` *(default)* | `1.16` | Espaciado original de Kite con lectura cómoda. |
| `Balanceado (1.08)` | `1.08` | Densidad intermedia para paneles divididos. |
| `Compacto (1.0)` | `1.0` | Máxima densidad vertical para TUIs de pantalla completa. |

---

## 3. Live Terminal Integration (`src/components/views/TerminalView.tsx`)

### 3.1 Initialization (`initTerminal`)
- Read `const appearance = getTerminalAppearancePrefs()` when constructing `new Terminal({ ... })`:
  - `fontFamily: resolveTerminalFontFamily(appearance.fontFamilyId)`
  - `fontSize: appearance.fontSize`
  - `lineHeight: appearance.lineHeight`
  - `cursorStyle: appearance.cursorStyle`
  - `cursorBlink: appearance.cursorBlink`
- Keep all structural stability hooks active in both `dom` and `webgl` modes:
  - `activateTerminalUnicodeProvider(term)` (`@xterm/addon-unicode11` + `11-zwj`)
  - `attachDomBlockFillCleanup(term)` (seamless CSS gradients for `U+2580..U+2595` in DOM mode)
  - `windowsPty: buildWindowsConptyOptions(DEFAULT_WINDOWS_CONPTY_BUILD_NUMBER)`

### 3.2 Renderer Switching (`syncVisibleBitmapRenderers`)
- Update `syncVisibleBitmapRenderers()` in `src/components/views/TerminalView.tsx`:
  - Read `const { renderer } = getTerminalAppearancePrefs()`.
  - If `renderer === 'dom'`, call `releaseBitmapRenderer(live)` on all entries in `liveTerms` and refresh visible terminals (`live.term.refresh(0, live.term.rows - 1)`), allowing the native DOM renderer + `attachDomBlockFillCleanup` to paint with ClearType.
  - If `renderer === 'webgl'`, attach `WebglAddon` to visible terminals and release it on parked terminals.

### 3.3 Real-Time Updates Without Session Restart
- Subscribe to `TERMINAL_APPEARANCE_CHANGED_EVENT` inside `TerminalView.tsx` (and iterate over `liveTerms`):
  1. Apply `term.options.fontFamily`, `term.options.fontSize`, `term.options.lineHeight`, `term.options.cursorStyle`, and `term.options.cursorBlink`.
  2. Call `syncVisibleBitmapRenderers()`.
  3. Call `fitTerminal()` so `FitAddon` re-measures cell metrics and sends a single `resize_terminal` IPC command if `cols` or `rows` changed.
- Also update the existing `font-larger` / `font-smaller` handler in `TerminalView.tsx` to persist the updated `fontSize` via `setTerminalAppearancePrefs({ fontSize: next })` so keyboard/menu zoom stays in sync with Settings.

---

## 4. Settings UI Specification (`src/components/views/SettingsView.tsx`)

In `src/components/views/SettingsView.tsx`, update the ` SETTINGS_TABS` blurb for `'terminal'` and add a new `<section className="settings-group">` inside `{activeTab === 'terminal' && (...)}`:

### 4.1 Section Layout (`Apariencia y Tipografía`)

Place **Apariencia y Tipografía** as the first section in `activeTab === 'terminal'`, followed by **Shell**, **Enlaces y Navegación Web**, and **Sessions**:

1. **Modo de renderizado (`renderer`)**:
   - **Title**: `Motor de renderizado`
   - **Description**: `DOM usa el suavizado nativo ClearType del sistema (aspecto clásico). WebGL acelera el dibujado en GPU.`
   - **Control**: `<fieldset className="ui-segmented">` with `SegmentedIndicator` (`group="settings-terminal-renderer"`):
     - `DOM · Clásico` (`renderer === 'dom'`)
     - `WebGL · GPU` (`renderer === 'webgl'`)
2. **Fuente (`fontFamilyId`)**:
   - **Title**: `Familia tipográfica`
   - **Description**: `Fuente monoespaciada utilizada en todas las terminales integradas.`
   - **Control**: `<SelectMenu variant="field" className="settings-select" ... />` with `FONT_FAMILY_ROWS`.
3. **Tamaño de letra (`fontSize`)**:
   - **Title**: `Tamaño de fuente`
   - **Description**: `Tamaño base del texto en píxeles (10 px – 22 px).`
   - **Control**: Stepper/segmented control (`-`, valor actual p. ej. `13 px`, `+`) + botón `Restablecer` si difiere de `DEFAULT_TERMINAL_APPEARANCE_PREFS`.
4. **Altura de línea (`lineHeight`)**:
   - **Title**: `Altura de línea`
   - **Description**: `Espaciado vertical entre filas. El modo Clásico (1.16) mantiene la proporción original.`
   - **Control**: `<fieldset className="ui-segmented">` with `SegmentedIndicator` (`group="settings-terminal-line-height"`):
     - `Clásico (1.16)`
     - `Balanceado (1.08)`
     - `Compacto (1.0)`
5. **Estilo de cursor (`cursorStyle`)**:
   - **Title**: `Estilo del cursor`
   - **Description**: `Forma visual del cursor activo en la terminal.`
   - **Control**: `<fieldset className="ui-segmented">` with `SegmentedIndicator` (`group="settings-terminal-cursor-style"`):
     - `Barra` (`'bar'`)
     - `Bloque` (`'block'`)
     - `Subrayado` (`'underline'`)

### 4.2 Design System Compliance (`AGENTS.md`)
- Use only semantic radius tokens (`var(--control-radius)` / `rounded-control` for buttons/selects/segmented controls, `var(--card-radius)` / `.ui-card` for cards).
- Adhere to the 3-tier control height contract (`32px` for `.settings-select` field triggers, `28px` for compact `.ui-button` / `.ui-segmented` controls).
- Zero external icon libraries; use inline SVG icons from `src/components/views/settings/icons.tsx`.

---

## 5. Verification Checklist

1. **Unit Tests (`src/lib/terminalAppearancePrefs.test.ts`)**:
   - Verify default fallback (`renderer: 'dom'`, `fontFamilyId: 'cascadia'`, `fontSize: 13`, `lineHeight: 1.16`, `cursorStyle: 'bar'`).
   - Verify clamping of out-of-range `fontSize` / `lineHeight` and event dispatch on update.
2. **Visual & Functional Checks**:
   - Launching Kite with no saved preference renders terminals with the **classic DOM ClearType font rendering and `1.16` line height**.
   - Changing font family, font size, line height, or renderer in `Settings -> Terminal` immediately updates open terminals (including split panes) and recalculates PTY dimensions without killing the running process.
3. **Quality Gate**:
   - `npx tsc --noEmit`
   - `npx vitest run`
   - `node .kite/sanitizer/audit-references.mjs --check`
