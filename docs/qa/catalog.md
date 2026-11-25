# Catálogo de pruebas de Kite

Fuente de verdad para ids, áreas, tipos y estado. Historial de ejecuciones de browser-lane append-only en [`catalog-runs.jsonl`](catalog-runs.jsonl).

## Carril Desktop E2E Real (`verify:desktop:e2e`)

**Carril principal:** `npm run verify:desktop:e2e` → Tauri + WebView2 real vía CDP (`scripts/e2e/run.mjs`) con sandbox aislado y shims CLI deterministas (`scripts/e2e/fake-driver/`). Sustituye al antiguo carril HTTP simulado para validar UI real, streaming IPC, subagentes/swarm y geometría sin saltarse hit-testing.

| id | spec | pasos / aserción | estado | última corrida | nota |
|----|------|------------------|--------|--------------|------|
| DESKTOP-SMOKE-01 | `desktop-smoke` | Shell Tauri real sin boot gate + toggle `Thread` hit-testable + composer listo | passed | 2026-11-15 verify:desktop:e2e | Sabotage `--sabotage=overlay` verifica rechazo de oclusión |
| THREAD-STREAM-01 | `thread-streaming` | Deltas mid-turn en vivo (`Interrupt`/estado activo) → cierre `idle` automático | passed | 2026-11-15 verify:desktop:e2e | Sabotage `--sabotage=ipc-drop` verifica fallo ante corte IPC |
| THREAD-SWITCH-01 | `thread-streaming` | Cambio entre Thread A en curso y Thread B sin perder estado ni mezclar streams | passed | 2026-11-15 verify:desktop:e2e | Cubierto dentro de `thread-streaming.e2e.mjs` |
| ORCH-SUB-01 | `orchestration` | Fan-out paralelo `Worker Alpha` / `Worker Beta` + inspección en RightDock `Subagents` | passed | 2026-11-15 verify:desktop:e2e | Verified live con `win-shim-v1.exe` |
| ORCH-SWARM-01 | `orchestration` | Swarm `E2E Release Swarm` (`@scout`, `@verifier`) en tablero RightDock `Subagents` | passed | 2026-11-15 verify:desktop:e2e | Corregido `name_taken` por placeholders `child_thread_id.is_none()` en `execute_swarm_add` |
| ORCH-FAIL-01 | `orchestration` | Propagación visible de subagente fallido (`Crasher Worker` -> `Failed` + `subagent_error`) sin quedar en spinner colgado | passed | 2026-11-15 verify:desktop:e2e | Cubierto en `orchestration.e2e.mjs` |
| UI-LAYOUT-01 | `ui-layout` | Cero overflow horizontal, cero overlap entre controles/filas en `1366x840` y `960x680` (RightDock cerrado/abierto) y cero clics forzados | passed | 2026-11-15 verify:desktop:e2e | Corregido shrink flex de wrappers en `.kite-composer-footer-left` (`composer.css`) |
| AGENTS-ROUTINES-01 | `agents-routines` | Modo Agent + Roster/AgentsView + navegación a Routines sin overflow/overlap ni errores de página en `1366x840` y `960x680` | passed | 2026-11-25 verify:desktop:e2e | Agregado en Fase 2 (`odd/tasks/engineering-quality-gate-and-delivery-loop.md`) |
| SETTINGS-TASKS-01 | `settings-tasks` | Modal Settings (General, Notifications, Audio/Argos, Subagents) + pestaña Tasks/Tickets en RightDock con IPC real y cero overlap | passed | 2026-11-25 verify:desktop:e2e | Agregado en Fase 2 (`odd/tasks/engineering-quality-gate-and-delivery-loop.md`) |
| CODE-DIFFS-01 | `code-diffs` | Modo Code + canvas de workspace + pestaña Diffs sin overflow/overlap ni errores en `1366x840` y `960x680` | passed | 2026-11-25 verify:desktop:e2e | Agregado en Fase 2 (`odd/tasks/engineering-quality-gate-and-delivery-loop.md`) |
| UI-KIT-01 | `ui-kit` | Ruta dev `?ui-kit=1` de primitivos core (`Button`, `Field`, `Card`, `Modal`, `Tabs`, `Badge`, `EmptyState`, `SelectMenu`) con interacción y capturas `1366x840`/`960x680` | passed | 2026-11-25 verify:desktop:e2e | Agregado en Fase 3 (`odd/tasks/engineering-quality-gate-and-delivery-loop.md`) |

---

## Carril Legacy Browser Mock (`dev:browser`)

**Carril legacy (solo HTTP simulado):** `npm run dev:browser` → `server/server.mjs` (mock Express + SSE) + Vite en `http://127.0.0.1:1430` · Playwright `npm run verify:browser:smoke` / `npm run verify:browser:qa` · No valida WebView2, IPC Rust ni procesos CLI reales.

## Reglas

- Cada **id** es estable; no se reutiliza ni renombra.
- Antes de diseñar un caso nuevo, buscar el id. Si está `passed`, solo regresión.
- Si la función cambia, id nuevo; el viejo pasa a `deferred` con motivo en **nota**.
- **última corrida:** fecha ISO + comando (`verify:browser:smoke`, `verify:browser:qa`, navegador integrado, `vitest`).

## Tipos

| Tipo | Uso |
|------|-----|
| boot | Superficie abre; gate de navegador no tapa |
| utterance | Frase Zed → acción (corpus `utterances.es.json`) |
| flow | Varios pasos; fallo corta el guion |
| target | Acción en agente/terminal nombrado |
| negative | Orden ambigua no dispara acción peligrosa |
| empty | Sin sesión; mensaje claro, no “Working” eterno |
| persist | Segundo turno conserva el primero |
| stop | Cortar turno/voz sin trabar |
| error-surface | IPC/cuota no tapan el chat |
| nav | Pestaña/ajuste abre |
| a11y-hook | testid/aria-label del runner |
| desktop-only | `deferred` hasta `npm run tauri dev` |

---

## Lane

| id | tipo | pasos / aserción | estado | última corrida | nota |
|----|------|------------------|--------|--------------|------|
| LANE-BOOT-01 | boot | Abre carril: sin tarjeta Tauri, `zed-input`, modo Agent, roster solo Antigravity | passed | 2026-10-20 verify:browser:qa | |

---

## Zed — Ola 1

| id | tipo | pasos / aserción | estado | última corrida | nota |
|----|------|------------------|--------|--------------|------|
| ZED-SPAWN-01 | utterance | «abre 2 terminales con antigravity» → status OK, ≥2 `terminal-pane` | passed | 2026-10-20 verify:browser:smoke | |
| ZED-SUM-01 | target | «qué está haciendo Orion» → cita buffer; reserva: a veces mezclaba terminales | passed | 2026-10-20 verify:browser:smoke | Superseded por ZED-SUM-02 para resumen limpio |
| ZED-SUM-02 | target | «resume qué dijo Nova» → status nombra Nova/`[Nova]`, sin Orion | passed | 2026-10-21 verify:browser:qa (zed1) | Heurístico + resumen local |
| ZED-INJ-01 | target | «en la terminal de Orion escribe: lista…» → inyectado en Orion | passed | 2026-10-21 verify:browser:qa (zed1) | |
| ZED-CLOSE-01 | target | «cierra la terminal Nova» → 1 pane restante | passed | 2026-10-21 verify:browser:qa (zed1) | |
| ZED-CLOSE-02 | empty | «cierra las terminales» + «resume Orion» → sin panes, mensaje vacío | passed | 2026-10-21 verify:browser:qa (zed1) | |

## Zed — Ola 2

| id | tipo | pasos / aserción | estado | última corrida | nota |
|----|------|------------------|--------|--------------|------|
| ZED-SPAWN-02 | utterance | Una terminal antigravity + tarea ipc | passed | 2026-10-21 verify:browser:qa (zed2) | |
| ZED-SPAWN-03 | utterance | «abre dos terminales…» → exactamente 2 panes | passed | 2026-10-21 verify:browser:qa (zed2) | |
| ZED-SUM-03 | target | «cómo va Orion» + «estado de la terminal 1» | passed | 2026-10-21 verify:browser:qa (zed2) | |
| ZED-SUM-04 | negative | Sin terminales, «resume la tarea» → no abre | passed | 2026-10-21 verify:browser:qa (zed2) | |
| ZED-INJ-02 | negative | «en la terminal abierta qué hay» → narrate, no inject | passed | 2026-10-21 verify:browser:qa (zed2) | |
| ZED-SUB-01 | utterance | Delegar subagente antigravity | passed | 2026-10-21 verify:browser:qa (zed2) | |
| ZED-WEB-01 | utterance | «abre https://example.com» | passed | 2026-10-21 verify:browser:qa (zed2) | |
| ZED-STOP-01 | stop | «callate» / silenciar altavoz | passed | 2026-10-21 verify:browser:qa (zed2) | |
| ZED-MOVE-01 | nav | Arrastrar píldora, recargar, input usable | passed | 2026-10-21 verify:browser:qa (zed2) | |
| ZED-SET-01 | nav | Ajustes → pestaña Asistente Zed | passed | 2026-10-21 verify:browser:qa (zed2) | Sidebar Settings |

## Zed — Aplazado

| id | tipo | estado | nota |
|----|------|--------|------|
| ZED-VOICE-01 | desktop-only | deferred | Mic headless inestable |
| ZED-TTS-01 | desktop-only | deferred | TTS altavoz |
| ZED-CLOUD-01 | deferred | deferred | Planner cloud fuera del carril |
| ZED-PTY-01 | desktop-only | deferred | Antigravity CLI real |

---

## Agent — Ola 1

| id | tipo | pasos / aserción | estado | última corrida | nota |
|----|------|------------------|--------|--------------|------|
| AGENT-BOOT-01 | boot | Modo Agent, Antigravity en roster (1 fila) | passed | 2026-10-21 verify:browser:qa (agent1) | |
| AGENT-CHAT-01 | flow | Mensaje composer → `[Antigravity]` | passed | 2026-10-20 navegador integrado | |
| AGENT-CHAT-02 | persist | Segundo turno; primer mensaje visible en hilo | passed | 2026-10-21 verify:browser:qa (agent1) | Mock guarda user+assistant |
| AGENT-CHAT-03 | empty | Send disabled; Enter no turno vacío | passed | 2026-10-21 verify:browser:qa (agent1) | |
| AGENT-CHAT-04 | stop | Stop devuelve composer a idle | passed | 2026-10-21 verify:browser:qa (agent1) | |

## Agent — Ola 2

| id | tipo | pasos / aserción | estado | última corrida | nota |
|----|------|------------------|--------|--------------|------|
| AGENT-TERM-01 | nav | Pestaña Terminal abre sin ENOENT powershell | passed | 2026-10-21 verify:browser:qa (agent2) | |
| AGENT-SET-01 | nav | Panel settings abre | passed | 2026-10-21 verify:browser:qa (agent2) | |
| AGENT-MEM-01 | nav | Memory room abre | passed | 2026-10-21 verify:browser:qa (agent2) | |
| AGENT-SKILL-01 | nav | Skills abre | passed | 2026-10-21 verify:browser:qa (agent2) | |
| AGENT-FILE-01 | negative | Adjuntar no congela composer | passed | 2026-10-21 verify:browser:qa (agent2) | |
| AGENT-ERR-01 | error-surface | Sin `Cannot find module` en banner | passed | 2026-10-21 verify:browser:qa (agent2) | |
| AGENT-NEW-01 | persist | New chat → hilo vacío | passed | 2026-10-21 verify:browser:qa (agent2) | |
| AGENT-ARCH-01 | nav | Archivar saca de lista activa | passed | 2026-10-21 verify:browser:qa (agent2) | |

## Agent — Aplazado

| id | tipo | estado | nota |
|----|------|--------|------|
| AGENT-LIVE-01 | desktop-only | deferred | Turno real CLI |
| AGENT-CREATE-01 | deferred | deferred | Asistente alta agente |
| AGENT-AUTO-01 | deferred | deferred | Autopilot |

---

## Otras áreas (reservado)

| id | área | estado | nota |
|----|------|--------|------|
| CODE-PANE-01 | code | planned | Abrir pane |
| CODE-SPLIT-01 | code | planned | Split |
| CODE-CLOSE-01 | code | planned | Cerrar sin perder workspace |
| THREAD-HOME-01 | thread | planned | Home acepta prompt |
| THREAD-SEND-01 | thread | planned | Turno simulado |
| THREAD-HAND-01 | thread | deferred | Handoff multi-cuenta |
| SET-GEN-01 | settings | planned | General |
| SET-VOICE-01 | settings | planned | Voice |
| SET-QUOTA-01 | settings | planned | Cuotas sin error módulo |
| SET-KEYS-01 | settings | planned | Atajos listados |
| ROUT-LIST-01 | routines | planned | Lista rutinas |
| ROUT-RUN-01 | routines | planned | Run simulado fixture |
| DESK-BOOT-01 | desktop | deferred | `tauri dev` sin gate |
| DESK-PTY-01 | desktop | deferred | PTY real |

---

## Comandos

```powershell
# Carril Desktop E2E Real (recomendado — Tauri + WebView2 CDP aislado)
npm run verify:desktop:e2e
npm run verify:desktop:e2e -- --spec desktop-smoke
npm run verify:desktop:e2e -- --sabotage=overlay --spec desktop-smoke
npm run verify:desktop:e2e -- --sabotage=ipc-drop --spec thread-streaming

# Carril Legacy HTTP Mock (solo UI aislada sin IPC Rust)
npm run dev:browser
npm run verify:browser:smoke
npm run verify:browser:qa
$env:QA_WAVE='zed1'; npm run verify:browser:qa
```

Tras una corrida verde de QA, actualizar **estado** y **última corrida** de los ids cubiertos en esta tabla.
