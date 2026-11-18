# Startup performance, Thread loading smoothness, and work-mode persistence

Objective: Restore and surpass pre-modularization app launch speed, fix the static loading icon and slow initial load in Thread (`workMode = 'chat'`), reopen Kite in whichever mode (`Agent | Code | Thread`) was last open before exit, and document all root causes, traceability, and prevention guards.
Branch: `feat/response-thread`
Delivery strategy: `ask-on-risk`
Test runner: `npx tsc --noEmit`; `npx vitest run`; `cargo test --manifest-path src-tauri/Cargo.toml`; `node .kite/sanitizer/audit-references.mjs --check`

## Specs

S1. App startup speed & comparison baseline:
- "actualmetne noto ciertos problemas de rendimiento para abrir la aplicacion, basicamente se demora demasiado a comparacion de antes, con antes me refiero a aprox 5 dias A ver, mira, realmente no sé la fecha exacta, pero fue antes de hacer ese cambio masivo que hicimos de modularizacion bastante grande"
- "Creo que podemos hacer ciertas verificaciones. Para entender qué fue lo que pasó, por qué se obtiene un rendimiento tan distinto. ¿Cómo podemos corregir y cómo podemos mejorar esta versión? Al igual que optimizar de cara al futuro para que sea más rápido, la apertura."
- "Puedes tener un Word Tree con la versión de esa fecha? Para comparar el rendimiento. Y hacer una trazabilidad de cosas que pudimos haber cambiado."
- Eliminate startup blocking on both Rust `.setup()` / pre-window init and React root / Vite module graph (lazy-load non-active views/overlays and heavy diff worker pool, break duplicate `loadBootstrap` / `Sidebar` probe loops, avoid full-binary shim reads, move daemon/dispatch setup off `.setup()`, keep `APP_INTRO_MIN_MS` responsive instead of artificially blocking 3s after boot is ready, and split heavy vendor chunks). Keep pre-modularization comparison worktree (`ec710bc`) available for baseline comparison.

S2. Thread (`chat`) static logo & fast loading:
- "En la parte de thread, apenas se coloca, la parte de thread, aparece como, una loguito cargando, pero el logo es fijo y, no sé por qué aparece de hecho. Quiero decir. La carga de la parte de thread debería ser más rápida."
- Fix the loading spinner (`SpinnerIcon` and missing `.animate-spin` CSS animation) so any visible spinner actually animates smoothly (respecting `prefers-reduced-motion`).
- Make switching to Thread load cleanly and fast: remove unconditional `persist()` SQLite rewrites inside read-only `load_thread`, move blocking chat thread/summary/model/agent Tauri commands off the IPC thread onto `async` + `spawn_blocking`, hydrate cached summaries/grid/threads from `localStorage` immediately in `useChatSession` (stale-while-revalidate), and defer non-active provider model/agent prefetches.

S3. Reopen last active view mode (`Agent | Code | Thread`):
- "Ya no quiero que code sea por defecto lo que yo vea al abrir la aplicación, sino que, ojalá pueda ser lo último que deje abierto. Quiero decir, si yo dejé la parte de code por último abierto antes de cerrar la aplicación, ok. Que se abra con code. Pero si yo dejé la parte de thread o la parte de agent. Como último al cerrar la aplicación, que se abra desde eso."
- Restore `'agent' | 'code' | 'chat'` from `localStorage` (`kite.workMode`) on startup (defaulting to `'code'` only when absent/invalid, keeping browser test lane `'agent'` override), ensure backend preferences respect saved mode on bootstrap, and initialize `hasOpenedChat` when starting in `'chat'`.

S4. Root-cause & fix documentation:
- "También quiero que dejes documentado todo lo que serían las correcciones y las causas como tal. Por si es que en algún momento tenemos este error nuevamente."
- Publish clear technical documentation with timeline/git traceability, measured evidence, root causes, fixes, and ongoing startup/Thread performance invariants.

S5. Smooth Thread-to-Thread switching:
- "okey la verdad quedo muy rapido, es perfecto, una cosa que no me gusto mucho es el paso de un thread a otro, como que se hace raro el cambio, es brusco no muy fluido pero si es rapido"
- Eliminate per-switch `isLoadingInitial` / cold `initChatView` re-runs and summary waterfalls when changing threads, switch synchronously from memory or `kite.chat.thread.*` cache with sequence-guarded background refresh, hold the current thread steady until a cold target loads so no spinner flash occurs, and animate single-pane/agent thread swaps with Kite standard crossfade and handoff motion tokens (`tweens.fade`, `tweens.swap`, `shift.handoff`) honoring reduced motion and preserving split-pane layout.

## Tasks

- [x] T1. S3 — Restore and persist last active `WorkMode` (`agent` | `code` | `chat`). Route: `inline`.
- [x] T2. S2 — Fix `SpinnerIcon` / `.animate-spin` and accelerate Thread (`ChatView` + Rust chat IPC + `useChatSession` cache hydration). Route: `inline`.
- [x] T3. S1 — Fix frontend startup bottlenecks (`loadBootstrap` double-run, `Sidebar` probe loop, `DiffWorkerPoolProvider` root eagerness, route lazy-loading, vendor chunking, splash hold). Route: `inline`.
- [x] T4. S1 — Fix Rust backend startup blocking (`.setup()` dispatch/core daemon backgrounding, shim metadata check instead of full binary read, startup workspace validation). Route: `inline`.
- [x] T5. S4 — Document root causes, pre/post modularization traceability comparison, and prevention guardrails. Route: `inline`.
- [x] T6. S1-S4 — Full verification (`tsc`, `vitest`, `cargo test`, `vite build` bundle comparison, reference audit) and close ODD. Route: `inline`.
- [x] T7. S5 — Eliminate per-switch Thread reload/spinner flash and add fluid Thread crossfade/handoff transitions (`useChatSession`, `ThreadGrid`, `SingleThreadPane`, `AgentChatShell`) + update docs. Route: `inline`.

## Log

L1. User (2026-11-13): actualmetne noto ciertos problemas de rendimiento para abrir la aplicacion, basicamente se demora demasiado a comparacion de antes, con antes me refiero a aprox 5 dias A ver, mira, realmente no sé la fecha exacta, pero fue antes de hacer ese cambio masivo que hicimos de modularizacion bastante grande y bueno, Creo que podemos hacer ciertas verificaciones. Para entender qué fue lo que pasó, por qué se obtiene un rendimiento tan distinto. ¿Cómo podemos corregir y cómo podemos mejorar esta versión? Al igual que optimizar de cara al futuro para que sea más rápido, la apertura. Otras cosas, que son puntos bastante específicos que me gustaría cambiar. En la parte de thread, apenas se coloca, la parte de thread, aparece como, una loguito cargando, pero el logo es fijo y, no sé por qué aparece de hecho. Quiero decir. La carga de la parte de thread debería ser más rápida. Entonces, son cosas que tenemos que llegar a corregir. Em. Ya no quiero que code sea por defecto lo que yo vea al abrir la aplicación, sino que, ojalá pueda ser lo último que deje abierto. Quiero decir, si yo dejé la parte de code por último abierto antes de cerrar la aplicación, ok. Que se abra con code. Pero si yo dejé la parte de thread o la parte de agent. Como último al cerrar la aplicación, que se abra desde eso. Esa vista, perdón. Entonces, a mi parecer tenemos que analizar. ¿Qué pasó? Ver cómo corregimos. ¿Puedes tener un Word Tree con la versión de esa fecha? Para comparar el rendimiento. Y hacer una trazabilidad de cosas que pudimos haber cambiado. En cuanto al código, espera y demás. Para, de vuelta, optimizar como tal.
L2. User (2026-11-13): Okey, sí, me parece. Mira, ta. También quiero que dejes documentado todo lo que serían las correcciones y las causas como tal. Por si es que en algún momento tenemos este error nuevamente. Quiero que vayas con todas las correcciones como tal.
L3. User (2026-11-13): okey la verdad quedo muy rapido, es perfecto, una cosa que no me gusto mucho es el paso de un thread a otro, como que se hace raro el cambio, es brusco no muy fluido pero si es rapido
