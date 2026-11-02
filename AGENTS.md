# Kite Code — Agent Guidelines

Kite Code is a focused desktop client for autonomous coding agents.

This document serves as the single source of truth for AI agents contributing code to this repository. Its rules prevent design drift, architectural fragmentation, and guesswork.

---

## 1. Visual Language & Corner Radius System

To maintain tight aesthetic cohesion across all desktop surfaces, Kite enforces a **4-tier semantic radius system** anchored in CSS variables and mapped directly in `tailwind.config.js`.

### The Radius Contract

| Semantic Tier | Token | Value | Tailwind Utilities | Primary Use Cases |
| :--- | :--- | :--- | :--- | :--- |
| **Micro** | `--vl-radius-xs` / `--vl-radius-sm` | **4px / 6px** | `rounded-xs`, `rounded-sm` | Checkboxes, keycap badges, micro-tags, chips, small pill labels. |
| **Control (Universal)** | `--control-radius` (`--vl-radius-md`) | **8px** | `rounded-control`, `rounded-md` | **All interactive elements**: Buttons (`.primary-button`, `.chrome-button`), inputs (`.ui-field`), select triggers, sidebar items, dropdown rows, segmented items. |
| **Container / Card** | `--card-radius` (`--vl-radius-lg`) | **12px** | `rounded-card`, `rounded-lg` | Surface cards (`.ui-card`), agent tiles, code preview blocks, panels, chat containers. |
| **Dialog / Overlay** | `--dialog-radius` (`--vl-radius-xl`) | **14px** | `rounded-dialog`, `rounded-xl` | Floating modals, dialog backdrops, overlay sheets, major drawers. |
| **Pill / Circle** | `--pill-radius` | **9999px / 50%** | `rounded-full`, `rounded-pill` | Avatars, status dots, toggle switches, stadium buttons. |

### Strict Rules for Agents

1. **NO Arbitrary Pixel Radii**:
   - ❌ Never write arbitrary ad-hoc values like `border-radius: 2px`, `3px`, `5px`, `7px`, `9px`, `10px` in CSS.
   - ❌ Never use inline arbitrary Tailwind classes like `rounded-[7px]` or `rounded-[10px]`.
   - ✅ Always use the semantic tokens (`var(--control-radius)`, `var(--card-radius)`, `var(--dialog-radius)`) or standard utilities (`rounded-control`, `rounded-card`, `rounded-dialog`, `rounded-md`, `rounded-lg`, `rounded-sm`, `rounded-full`).

2. **Optical Nesting (Concentric Borders)**:
   - When rendering simulated borders or inset rings using pseudo-elements (`before:` or `after:`), subtract `1px` so the inner line remains concentric and free of corner artifacts:
     ```css
     border-radius: var(--control-radius); /* 8px */
     /* Pseudo inner border */
     &::before {
       border-radius: calc(var(--control-radius) - 1px); /* 7px */
     }
     ```

---

## 2. Control Sizing & Height Standards

To prevent jarring height jumps when users navigate across lateral tabs and panels, interactive elements must adhere to the 3-tier control height standard:

| Control Tier | Token | Value | Applied To |
| :--- | :--- | :--- | :--- |
| **Standard (Default)** | `--vl-control-md` | **32px** | View header action buttons (`.primary-button`, `.tickets-new`), search fields (`.ui-field`, `.tickets-search`), select dropdown triggers. |
| **Compact (Dense)** | `--control-row` / `--vl-control-sm` | **28px / 26px** | Toolbar navigation buttons, address bar inputs, secondary action buttons, sidebar rows, filter chips. |
| **Hero / Large** | `--vl-control-lg` | **38px** | Prominent hero inputs, splash actions. |

### Strict Rules for Agents
- ❌ Never declare arbitrary ad-hoc inline heights like `height: 20px`, `22px`, `24px`, `30px`, `34px` for buttons or inputs.
- ✅ Always use standard 32px height for view header search inputs and primary action buttons.
- ✅ Always use 26px or 28px for compact toolbar icon buttons.

---

## 3. Protected Zones (Do Not Alter)

- **TitleBar Mode Switcher**:
  The stadium pill toggle in `src/components/TitleBar.tsx` (`mode-toggle--stadium` for `Agent | Code | Thread`) and its sliding motion indicator (`layoutId="titlebar-mode-toggle-indicator"`) is a signature brand element. **Do not modify its geometry, padding, or motion behavior.**

---

## 4. Architecture & Task Discipline

1. **Dual-Tier ODDs**:
   - Public task specifications live under `odd/tasks/<slug>.md`. They must be 100% product-focused and clean of external donor or cloning references.
   - Internal investigation tasks live under `.kite/tasks/<slug>.md` (gitignored).
2. **Quality Verification**:
   - Always verify changes with `npx tsc --noEmit` and `npx vitest run`.
   - Before any commit or push, run `node .kite/sanitizer/audit-references.mjs --check`.
