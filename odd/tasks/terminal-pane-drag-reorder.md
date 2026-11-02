# Terminal Pane Drag-and-Drop & Reordering

Objective: Implement interactive drag-and-drop repositioning for terminal panes in Kite Code Workspace, enabling users to reorder terminals via edge-docking splits and in-place pane swapping while guaranteeing zero interruption to active terminal and agent PTY sessions.
Branch: `feat/terminal-drag-reorder` (or active working tree; uncommitted changes preserved).
Delivery strategy: `single-pr` (clean product specification and implementation).
Test runner: `npx vitest run`; typecheck: `npx tsc --noEmit`.

---

## 1. Context & Problem Statement

In Kite Code Workspace, users work with multi-pane layouts composed of interactive terminals, agent CLI processes, and thread views. While users can split panes and close them via menus and hotkeys, rearranging existing panes currently requires closing and re-opening sessions or relying on keyboard-driven adjacent swaps.

Users need a fluid, tactile desktop interaction:
1. Grabbing a terminal pane and dragging it to another location.
2. Docking it to an edge of another pane (left, right, top, bottom) to create a split dynamically.
3. Dropping it onto the center of another pane to swap their positions directly.
4. Keeping all underlying PTY sessions, VT buffer state, and running processes completely alive throughout the rearrangement with zero remounting or flicker.

---

## 2. Functional & Visual Specifications

### S1. Pane Drag Handle & Hover Grip
- **Grip Element**: Rendered within the pane header (`CodePaneHeader.tsx`) or as a floating centered grip handle at the top of the pane.
- **Visual Appearance**:
  - Centered horizontally along the pane's top header row.
  - Dimensions: 28px width × 18px height.
  - Corner radius: `var(--vl-radius-xs)` (4px micro radius).
  - Background: `var(--background)` with 85% opacity, border `1px solid var(--stroke-subtle)`.
  - Icon: 6-dot drag grid (2 columns × 3 dots or 2 rows × 3 dots, dot size 2px, dot color `var(--dim)` transitioning to `var(--foreground)` on hover).
  - Cursor: `cursor: grab` when idle; transitions to `cursor: grabbing` when active.
- **Visibility**:
  - Automatically revealed when the mouse hovers over the header area of a movable pane.
  - Visible only when the active tab contains two or more panes (`panes.length > 1`) and the tab is not in fullscreen mode.

### S2. Drag Deadband & Activation Threshold
- Pointer down on the grip records initial coordinates `(startX, startY)` without immediately triggering drag mode.
- Drag mode initiates only when pointer movement exceeds a deadband of **4px** (`max(|Δx|, |Δy|) >= 4px`).
- Simple clicks or micro-movements under 4px do not activate drag mode, preventing accidental layout shifts.

### S3. Global Drag Capture Overlay (`PaneDragOverlay`)
- While drag is active, a top-level overlay mounts over the workspace (`fixed inset-0 z-50`):
  - Captures all mouse and pointer events across the window.
  - Applies `cursor: grabbing` globally.
  - Occludes pointer events to underlying terminal canvases and webgl surfaces, completely preventing inadvertent text selection, scroll triggers, or terminal mouse-tracking interception during drag.

### S4. Drop Zone Geometry (Edge Splitting vs. Pane Swapping)
When the pointer hovers over any target pane $P_{\text{target}}$ (where $P_{\text{target}} \ne P_{\text{source}}$), the drop zone is determined by normalized bounding box coordinates:
$$x_{\text{rel}} = \frac{x_{\text{pointer}} - \text{origin.x}}{\text{width}}, \quad y_{\text{rel}} = \frac{y_{\text{pointer}} - \text{origin.y}}{\text{height}}$$
The minimum distance to any perimeter edge is calculated:
$$d_{\text{edge}} = \min(x_{\text{rel}}, 1 - x_{\text{rel}}, y_{\text{rel}}, 1 - y_{\text{rel}})$$

1. **Outer 25% Perimeter Margin ($d_{\text{edge}} < 0.25$)**:
   - Targets the closest edge: `left`, `right`, `top`, or `bottom`.
   - Signals an **Edge Split** (the source pane will be docked adjacent to the target pane).
2. **Inner 50% Core Area ($d_{\text{edge}} \ge 0.25$)**:
   - Returns no edge (`null`).
   - Signals a **Full Pane Swap** (the source pane and target pane will exchange places).

### S5. Visual Drop Preview Indicator
During active dragging over a valid target pane, the overlay renders an animated drop target preview box:
- **Edge Split Preview**:
  - `left`: Occupies the left 50% of the target pane (`width / 2`).
  - `right`: Occupies the right 50% of the target pane (`origin.x + width / 2`, `width / 2`).
  - `top`: Occupies the top 50% of the target pane (`height / 2`).
  - `bottom`: Occupies the bottom 50% of the target pane (`origin.y + height / 2`, `height / 2`).
- **Pane Swap Preview**:
  - Occupies 100% of the target pane bounding box.
- **Styling**:
  - Background: `rgba(var(--accent-rgb), 0.16)`.
  - Border: `2px solid var(--accent)`.
  - Corner radius: `var(--card-radius)` (12px), matching `.code-pane-panel`.
  - Transitions: Fast opacity and geometry transitions (`transition: all 120ms ease-out`).

### S6. Cancellation & Safety
- Pressing `Escape` at any point during drag cancels the operation immediately.
- Releasing the pointer outside the window bounds or outside any valid target pane cleanly aborts the drag with zero layout mutation.
- When drag ends or cancels, focus is restored to the source terminal pane.

### S7. Zero Terminal Lifecycle Interruption (Non-Destructive Reordering)
- Kite uses persistent terminal slot hosts (`terminalSlotsRef` in `CodeWorkspace.tsx`) where each terminal DOM element is portaled into a stable detached container.
- Moving or swapping leaf nodes updates the layout tree structure (`WorkspaceTab.root`) while preserving leaf IDs and occupant session IDs (`sessionId`).
- Terminal DOM nodes are reparented into the newly positioned pane slot (`.code-pane-body`) without unmounting `<TerminalView>`, restarting PTY processes, or dropping WebSocket / IPC connections.
- Long-running agent tasks (compilations, dev servers, agent loops) continue running without pause.

---

## 3. Behavioral Contracts (WHEN ... THEN ...)

- **WHEN** a user hovers over the header of a terminal pane in a multi-pane tab, **THEN** Kite MUST display the 6-dot drag grip with `cursor: grab`.
- **WHEN** a tab contains only 1 pane or is in fullscreen mode, **THEN** Kite MUST NOT display the drag grip or allow pane dragging.
- **WHEN** the user presses down on the grip and moves the pointer fewer than 4px, **THEN** Kite MUST NOT initiate drag mode or alter layout.
- **WHEN** the user moves the pointer 4px or more, **THEN** Kite MUST mount the global drag overlay, set `cursor: grabbing`, and occlude underlying terminal events.
- **WHEN** the user drags over the outer 25% boundary of another pane, **THEN** Kite MUST highlight the corresponding half of the target pane indicating an edge split (`left`, `right`, `top`, or `bottom`).
- **WHEN** the user drags over the inner 50% center of another pane, **THEN** Kite MUST highlight the entire target pane indicating a pane swap.
- **WHEN** the user releases the pointer over an edge zone, **THEN** Kite MUST remove the source leaf from its current position, split the target container along the required axis, place the source leaf beside the target, and focus the source terminal.
- **WHEN** the user releases the pointer over the center zone, **THEN** Kite MUST swap the layout positions of the source and target leaves and retain focus on the source terminal.
- **WHEN** the user presses the `Escape` key while dragging, **THEN** Kite MUST dismiss the overlay and cancel the operation without modifying layout state.
- **WHEN** any drag reordering completes, **THEN** all running terminal processes in both panes MUST retain their live PTY connections and scrollback history without restarting.

---

## 4. Architecture & Tree Utilities

### 4.1 Tree Utilities (`src/components/code/treeUtils.ts`)
Two pure functions are added to manipulate the pane hierarchy:

```ts
/** Swaps the positions or occupants of two leaves in the layout tree. */
export function swapLeaves(
  root: PaneNode,
  sourceLeafId: string,
  targetLeafId: string
): PaneNode;

/** Moves a source leaf to an edge of a target leaf, splitting the container. */
export function moveLeafToEdge(
  root: PaneNode,
  sourceLeafId: string,
  targetLeafId: string,
  edge: 'left' | 'right' | 'top' | 'bottom'
): PaneNode;
```

### 4.2 State Management (`useWorkspaceLayoutState.ts`)
Add layout action handlers:
- `handleMoveLeaf(sourceLeafId: string, targetLeafId: string, edge: 'left' | 'right' | 'top' | 'bottom')`:
  Invokes `moveLeafToEdge` on active tab root, updates active root, and persists layout.
- `handleSwapLeaves(sourceLeafId: string, targetLeafId: string)`:
  Invokes `swapLeaves` on active tab root, updates active root, and persists layout.

### 4.3 UI Components
- `PaneDragOverlay.tsx`: Global overlay component rendering the drop preview indicator and managing pointer listeners during drag.
- `CodePaneHeader.tsx`: Houses the drag handle grip button with hover reveal and pointer down dispatch.

---

## 5. Task Breakdown

- **T1 — Pure Tree Operations (`src/components/code/treeUtils.ts` & tests)** — Status: completed — Implemented `swapLeaves`, `insertLeafAdjacent`, and `moveLeafToEdge`. 19 unit tests passing in `src/components/code/treeUtils.test.ts`.
- **T2 — Layout State Actions (`src/components/code/useWorkspaceLayoutState.ts`)** — Status: completed — Added `handleSwapLeaves` and `handleMoveLeaf` with active root updates, layout persistence, and focus preservation.
- **T3 — Drag Handle Grip (`src/components/code/CodePaneHeader.tsx`)** — Status: completed — Added 6-dot grip handle (`GripDotsIcon`), 4px micro radius token, hover reveal, grab cursor, and pointer down listener.
- **T4 — Global Drag Overlay & Drop Zones (`src/components/code/PaneDragOverlay.tsx`)** — Status: completed — Implemented full-window capture overlay with 4px activation deadband, 25% edge margin calculation, 50% center swap, Escape key cancellation, and accent drop indicator preview. Tested in `PaneDragOverlay.test.tsx` and `paneDragUtils.test.ts`.
- **T5 — Non-Destructive Reparenting Integration (`src/components/code/CodeWorkspace.tsx`)** — Status: completed — Integrated `PaneDragOverlay` with terminal slot host reparenting, ensuring terminals never unmount or restart PTYs during rearrangement.
- **T6 — Test Coverage & Verification** — Status: completed — 41/41 vitest unit tests passing, `npx tsc --noEmit` exit 0, sanitizer audit clean.

---

## 6. Verification Criteria

1. **Unit Tests**:
   - `treeUtils.test.ts` passes with 100% coverage on `swapLeaves` and `moveLeafToEdge`.
   - Drop zone calculation tests verify 25% edge margin thresholds and center swap behavior across various pane dimensions.
2. **Type Safety**:
   - `npx tsc --noEmit` exits with code 0.
3. **Session Stability**:
   - Moving a terminal running an active command (e.g. `ping` or `top`) maintains continuous execution without clearing or reconnecting.
4. **Sanitization Compliance**:
   - `node .kite/sanitizer/audit-references.mjs --check` passes cleanly with zero violations.
