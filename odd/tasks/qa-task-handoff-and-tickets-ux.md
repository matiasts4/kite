# Targeted QA Task Handoff, Traceability, MCP Wiring & Tasks UI Fixes

Objective: Establish a controlled manual-QA task workflow in **Kite Tasks** for key product areas (`Voice Mode`, `Zed / SETH Assistant`, `Agent / Orchestration`), add ODD and agent/thread traceability attributes (`oddPath`, `sourceAgent`, `sourceThreadId`) with interactive navigation in `TicketDetailView`, connect the `kite-tasks` MCP server across local coding agents, and modernize/fix broken selector popovers in `CreateTicketModal`, `TicketDetailView`, and `SelectMenu`.
Branch: `feat/response-thread`.
Test runner: `npx tsc --noEmit`, `npx vitest run src/components/ui/SelectMenu.test.tsx src/components/views/tickets`, `cargo test --manifest-path src-tauri/Cargo.toml --workspace`, `node .kite/sanitizer/audit-references.mjs --check`.
Does not change protected zones (`TitleBar.tsx` mode switcher).

---

## Specs

### S1 — Targeted QA Task Handoff Skill & Project Rules
- **Verbatim**:
  > "no es para todo. Esta estructuración que quiero aplicar. Sino que para ciertas. Partes clave, por ejemplo, para el voice mode, el asistente zed, la parte de agent"
  > "si se crea un, ODD bastante grande. Para una parte específica. No lo sé. Por ejemplo el asistente, o el voice mode. No quiero que se, hagan como veinte tareas. Sino que se haga una sola que me diga, testear el voice mode enfocado en, tal parte."
  > "debería poder también. Yo decidir cuándo se debe crear en Task esa parte, así que, sería más que nada agregar en alguna parte de instrucción o skill, eh, para cuando se tenga que crear en Task. esas... respectivas tareas. Para yo testear."
- **Behavior**:
  - Create `.agents/skills/qa-task-handoff/SKILL.md` following `.agents/skills/skill-creator/SKILL.md` conventions and register it in `AGENTS.md`.
  - Scope proactive proposals strictly to key areas (`Voice Mode`, `Zed / SETH Assistant`, `Agent / Orchestration`) or explicit user requests.
  - **One focused task per ODD / delivery**: consolidate verification into **1** actionable Kite Tasks card (never 20 micro-cards) with a concise internal checklist focused on the modified behavior.
  - **User decision gate**: if the user did not explicitly ask to create the task in their prompt, propose creating it at closeout and wait for confirmation before calling `create_task`.
  - Every created QA task starts in `Review` (or user-specified state), carries domain + `qa-manual` labels, links the ODD (`oddPath`), and records `sourceAgent` and `sourceThreadId` when available.
- **Checks**: Verify skill frontmatter, section order, token budget, `AGENTS.md` table registration, and `node .kite/sanitizer/audit-references.mjs --check`.

### S2 — ODD, Agent & Thread Traceability in Tasks (`TicketIssue`, MCP & `TicketDetailView`)
- **Verbatim**:
  > "También en esa tarea algún link. A el ODD."
  > "sería bastante bueno poder linkear. O tener cierta trazabilidad para saber. ¿Qué agente creó esa tarea o qué, en qué threads o chats? Básicamente para poder. Volver a esa conversación si es que llegó un problema, o algo así. Diría que eso puede ser uno de los atributos. Con los cuales se crea. La tarea como tal."
- **Behavior**:
  - Extend `TicketIssue` (Rust `src-tauri/src/tickets/document.rs` and TS `src/components/views/tickets/types.ts`) with optional backwards-compatible fields (`#[serde(default)]`): `oddPath`, `sourceAgent`, `sourceThreadId`.
  - Update `src-tauri/src/tickets/commands.rs` (`save_issue` create & update) and `src-tauri/src/tickets/mcp.rs` (`create_task`, `update_task`, `get_task`, `list_tasks`) to accept, persist, and expose `oddPath`, `sourceAgent`, `sourceThreadId`, `branch`, and `projectId`.
  - When `create_task` runs in MCP without explicit `sourceThreadId`, fall back to `KITE_ADDRESS` if set (`thread:<id>`), and use `sourceAgent` (when provided) for the created `TicketHistoryEvent.actor`.
  - Update `TicketDetailView.tsx`:
    - Render a clickable `oddPath` link (and auto-link `odd/tasks/*.md` / `.kite/tasks/*.md` references in the description) using `openFileInRightDock` so clicking opens the ODD document directly in RightDock Files.
    - Display `sourceAgent` and `sourceThreadId` in the task header/properties: when `sourceThreadId` represents a Kite thread (`thread:<id>` or thread ID), provide an **"Open thread"** button dispatching `kite:navigate-mode` (`'chat'`) + `kite:select-thread` (`{ threadId, mode: 'chat' }`); otherwise display the external session/conversation ID with copy support.
- **Checks**: Rust unit tests covering serialization, backwards compatibility with legacy `tickets.json`, `create_task`/`get_task`/`update_task` traceability fields, and `KITE_ADDRESS` fallback; Vitest tests verifying clickable ODD links and thread navigation events in `TicketDetailView`.

### S3 — `kite-tasks` MCP Binary Resolution, OpenCode Discovery & Agent Wiring
- **Verbatim**:
  > "Claramente tenemos que. Conectar el MCP a los agentes. Antigravity, a OpenCode o algunos otros."
- **Behavior**:
  - Update `ticket_connect` / `ticket_configuration` in `src-tauri/src/tickets/commands.rs`, `src/lib/ipc/tickets.ts`, `src/components/views/TicketsView.tsx`, and `src/components/views/tickets/types.ts` to emit the actual `kite` executable command (instead of non-existent `kite-code`) with `["mcp", "tasks", ...]`.
  - Extend `src-tauri/src/acp/accounts.rs` and `src-tauri/src/chat/provider_env.rs` to include OpenCode's `~/.config/opencode/opencode.json` `mcp` server entries in provider MCP discovery.
  - Register `kite-tasks` (`kite mcp tasks`) cleanly in local agent configurations (Antigravity CLI `mcp_config.json`, OpenCode `opencode.json`, Codex `config.toml`, Gemini CLI `settings.json`, Claude `.claude.json` as applicable) without altering unrelated keys or secrets.
- **Checks**: Rust unit tests for `ticket_connect`, `ticket_configuration`, and OpenCode MCP discovery; TS tests for `formatMcpToml` / `ticketConnect`; live `kite.exe mcp tasks` JSON-RPC `initialize` + `tools/list` smoke check.

### S4 — Fix & Modernize "New Task" (`CreateTicketModal`) and Edit Selectors (`TicketDetailView` & `SelectMenu`)
- **Verbatim**:
  > "En la parte de New Desk, cuando se crea una tarea o también creo que cuando se edita. ¿Se tienen problemas? Quiero decir cada uno de los selectores, se nota que no está actualizado a nuestra nueva, nuestro nuevo diseño. También, cada uno de los selectores no se está viendo. Quiero decir, aprieto cada uno en los despliegos y no se ve, puede que no se esté superponiendo correctamente"
- **Behavior**:
  - Fix `SelectMenu.tsx`:
    - When rendered inside an open `<dialog>` (`element.closest('dialog[open]')`), use that `<dialog>` as `portalHost` so browser Top Layer `<Sheet>` dialogs never hide open dropdowns behind the modal.
    - Compute `position: fixed` anchor coordinates relative to the actual CSS fixed-position containing block (`transform`, `filter`, `backdrop-filter`, `perspective`, `contain`) and use a stacking z-index (`>= 10200` / `max + 20`) above dock and floating elements.
    - Allow narrow/compact triggers (such as `.ticket-properties` or chip triggers) to pass `minWidth` or keep menus constrained cleanly inside the viewport without clipping.
  - Modernize `CreateTicketModal.tsx`:
    - Migrate from legacy manual portal/inline styles to `<Sheet>` (`src/components/ui/Sheet.tsx`) and `<SelectMenu>` (`src/components/ui/SelectMenu.tsx`) for Status, Priority, Labels (multi-select toggle), and Project, plus optional ODD path input, adhering to `AGENTS.md` `--control-radius` (`8px`), `--dialog-radius` (`14px`), and `--vl-control-md` (`32px`) / `--vl-control-sm` (`28px`).
  - Fix `TicketDetailView.tsx` & task CSS (`src/visual-language.css` / `src/components/views/tickets/`):
    - Upgrade property selector triggers to `variant="field"` / semantic `8px` `--control-radius` and `28px` height (`--control-row`), keep Labels and Project selectable with sensible defaults when backend lists are empty, and ensure every selector opens visibly above `RightDock`.
- **Checks**: Vitest tests (`SelectMenu.test.tsx`, `CreateTicketModal.test.tsx`, `TicketDetailView` selector & traceability tests), `npx tsc --noEmit`, and visual/DOM verification.

---

## Tasks

- [x] **T1** (`S2`, `S3`, Risk: `item 3 (extends TicketIssue schema and kite-tasks MCP tool schemas while keeping legacy JSON backwards compatibility)`, route: `delegated` — disjoint Rust backend surface, commit `c0ff9a9`): Extend `TicketIssue`, `commands.rs`, `mcp.rs`, `bin/kite.rs`, `acp/accounts.rs`, `chat/provider_env.rs`, and `tickets/tests.rs` with `oddPath`/`sourceAgent`/`sourceThreadId`, native `kite mcp tasks` CLI support, `kite` binary command output, and OpenCode MCP discovery.
- [x] **T2** (`S4`, `S2`, Risk: `item 3 (updates shared SelectMenu.tsx portal/stacking behavior used across Settings, Chat, DispatchTaskModal, and Tickets)`, route: `delegated` — disjoint Frontend UI surface, commit `89df965`): Fix `SelectMenu.tsx` modal/top-layer portaling, containing-block bounds, and `zIndex >= 10200` stacking; migrate `CreateTicketModal.tsx` to `<Sheet>` + `<SelectMenu>`; modernize `TicketDetailView.tsx` selectors + ODD/thread traceability links; update `types.ts`/`tickets.ts`/`TicketsView.tsx` and Vitest coverage.
- [x] **T3** (`S1`, `S3`, Risk: `none`, route: `inline`, closed in docs commit): Create `.agents/skills/qa-task-handoff/SKILL.md`, register it in `AGENTS.md`, and configure `kite-tasks` MCP in local agent configs (Antigravity CLI/Desktop, OpenCode, Codex, Gemini CLI, Claude Code).
- [x] **T4** (`S1`, `S2`, `S3`, `S4`, Risk: `none`, route: `inline`, closed in docs commit): Ran integrated checks (`npx tsc --noEmit`, `npx vitest run src/components/ui/SelectMenu.test.tsx src/components/views/tickets src/components/RightDock.test.tsx` -> 5 files / 33 passed; `cargo test --bin kite-code` `tickets` 9/9, `accounts` 4/4, `provider_env` 8/8, `--bin kite` 17/17; `cargo build --release --bin kite` + isolated `kite.exe mcp tasks` JSON-RPC smoke test; `node .kite/sanitizer/audit-references.mjs --check` -> 112 files clean), completed independent Risk `item 3` review (**PASS** across `S1–S4`), and committed work units on `feat/response-thread`. Live WebView2 rendering (`npm run verify:desktop:e2e`) and replacing the in-use `%APPDATA%\Kite Code\bin\kite.exe` shim remain pending next Kite restart/desktop build.

---

## Log

- **L1 (2026-11-22)**:
  > "Me gustaría planear de cara al futuro, una forma para que yo pueda continuar desarrollando la aplicación. junto a los agentes, pero de una forma un poco más estructurada. ¿Y a qué me refiero con esto? Actualmente intento como ir avanzando a ciertos puntos que quiero mejorar, pero muchas veces quedo sin testear. Estos mismos. Es por esto que me gustaría como. Planear un poco. Cómo lo iremos haciendo. Para las funcionalidades. Y también me gustaría aclarar que no es para todo. Esta estructuración que quiero aplicar. Sino que para ciertas. Partes clave, por ejemplo, para el voice mode, el asistente zed, la parte de agent, Bueno, ¿a qué me refiero con esto? Cada vez que realicemos un ODD o bonificaciones o actualizaciones me gustaría plantear en tareas un tanto pequeñas. En la parte de task. Para que me queden pendientes y así yo pueda ver, si es que las probé o no. Por ejemplo. Si es que estuve desarrollando contigo no lo sé. Toda la parte o una gran parte de mejora para el voice mode, ¿Podrías ver que tengo pendiente lo que sería el testeo de esas modificaciones? También en esa tarea algún link. A el ODD. Y ese tipo de cosas, así puedo ir como viendo qué es lo que me falta. Eh, testear o demás, pero claro, debería poder también. Yo decidir cuándo se debe crear en Task esa parte, así que, sería más que nada agregar en alguna parte de instrucción o skill, eh, para cuando se tenga que crear en Task. esas... respectivas tareas. Para yo testear. Si es que quedó bien o no. habria ver como l ohacemos"
- **L2 (2026-11-22)**:
  > "Okey, aunque, ten en consideración cierta cosa. Por ejemplo, si se crea un, ODD bastante grande. Para una parte específica. No lo sé. Por ejemplo el asistente, o el voice mode. No quiero que se, hagan como veinte tareas. Sino que se haga una sola que me diga, testear el voice mode enfocado en, tal parte. Claramente tenemos que. Conectar el MCP a los agentes. Antigravity, a OpenCode o algunos otros. En también sería bastante bueno poder linkear. O tener cierta trazabilidad para saber. ¿Qué agente creó esa tarea o qué, en qué threads o chats? Básicamente para poder. Volver a esa conversación si es que llegó un problema, o algo así. Diría que eso puede ser uno de los atributos. Con los cuales se crea. La tarea como tal. No me parece algo malo. Claramente tiene que tener correcto lo del. Bueno, toda esa parte. Otra cosa a considerar. En la parte de New Desk, cuando se crea una tarea o también creo que cuando se edita. ¿Se tienen problemas? Quiero decir cada uno de los selectores, se nota que no está actualizado a nuestra nueva, nuestro nuevo diseño. También, cada uno de los selectores no se está viendo. Quiero decir, aprieto cada uno en los despliegos y no se ve, puede que no se esté superponiendo correctamente"
- **L3 (2026-11-22)**:
  > "si hazlo"
