# Startup responsiveness and hidden Windows consoles

Objective: Keep the Kite window interactive while it boots, and never flash external console windows on launch.
Branch: `feat/response-thread` (current checkout).
Delivery strategy: `ask-on-risk`.
Test runner: `npx tsc --noEmit`; `npx vitest run`; `cargo test -p kite-code --lib hidden_exec bootstrap` (and focused Rust tests added here).

## Specs

S1. "Apenas lanzo la aplicación, se me spawnean como diez. Ventanas que son como de terminales" — Launching Kite (installed or `npm run app`) must not open external `reg.exe`, `cmd.exe`, or Windows Terminal windows. PATH refresh for missing CLIs stays hidden and is cached for the process.
S2. "si yo clic. Me congela la aplicación, me dice por ejemplo en espera o no responde" — Clicks during startup must not put the window into Windows "Not Responding". Bootstrap SQLite and other first-paint IPC run off the UI thread (`async` + `spawn_blocking`).
S3. "no hiciéramos que se pegara, sino que, por ejemplo, apareciera cargando" — The existing boot cover / intro remains until bootstrap finishes. The window keeps pumping messages so that cover can paint. No new spinner design.
S4. "esto, antes ya sucedía. Se supone. Lo habíamos corregido. Pero al parecer no quedó tan corregido" / "luego de ese formateo empezaron a aparecer" — The post-format PATH miss must not reintroduce visible consoles. `CREATE_NO_WINDOW` stays on `hidden_exec`. Do not switch it back to `CREATE_NEW_CONSOLE`.

## Tasks

- [x] T1. S1, S4 — Hide and cache Windows registry PATH lookup. Route: inline. Reopened: `reg.exe` + CREATE_NO_WINDOW still flashes Windows Terminal; native registry API, no process.
- [x] T2. S2, S3 — Move `bootstrap` (and persist warmup) off the UI thread. Route: inline.
- [x] T3. S2 — Move `list_saved_accounts` off the UI thread. Route: inline.
- [x] T4. S1–S4 — Focused tests + typecheck. Route: inline.
- [x] T5. S1, S4 — Replace `reg.exe` PATH query with Win32 registry (no console child). Route: inline.

## Log

L3. User (2026-11-07): "sigo viendo, mmm, lo que son las ventanas, cada vez que. Abro la aplicación, entonces quiero que verifiques que corrijas". `Command::creation_flags(CREATE_NO_WINDOW)` still lets conhost/Windows Terminal flash for console-subsystem `reg.exe` (same class as the old powershell quota flash). `query_registry_path` now uses `RegOpenKeyExW` / `RegQueryValueExW`; no `reg.exe`.
L2. T1–T4 done. `fresh_registry_path` uses CREATE_NO_WINDOW and OnceLock cache. `bootstrap` and `list_saved_accounts` are async + spawn_blocking; setup warms SQLite off the UI thread. Tests: parse_reg_path_output x3, bootstrap_sync, list_saved_accounts_direct, hidden_exec capture — all ok. `npx tsc --noEmit` ok. Desktop window not relaunched (do not kill a running kite-code).
L1. User (2026-11-07): Mira, recientemente me di cuenta de varias cosas. Y que podríamos llegar a mejorar, en nuestra aplicación. Una de estas es. Que cuando, por ejemplo, estoy iniciando. Eh, la aplicación carga muchas cosas al principio. Y si yo clic. Me congela la aplicación, me dice por ejemplo en espera o no responde. El típico error de Windows, básicamente. Esto es algo que podemos manejar y que mejoraría bastante? Si es que. Por ejemplo, no hiciéramos que se pegara, sino que, por ejemplo, apareciera cargando o algo así. Entonces, tenemos que enfocarnos en mejorar todo ese tipo de cosas. A mi parecer, sucede porque son. Ejecución de tareas sincrónicas en lugar de asincrónicas. No sé si es por eso, pero bueno. Diría que tenemos que manejar claramente todo ese tipo de carga de cosas. De esa forma no se congelaría la pantalla y, y bueno. La verdad es que sucede bastante eso de que se congela. Sucede tanto en, la versión instalada como en la de desarrollo. Otro punto importante. O error. Es, la aparición de. Terminales o ventanas. Apenas lanzo la aplicación, se me, spawnean como diez. Ventanas que son como de terminales, creo. Em, esto, antes ya sucedía. Se supone. Lo habíamos corregido. Pero al parecer no quedó tan corregido. Básicamente nosotros se formateó el equipo. Y bueno, luego de ese formateo empezaron a aparecer este tipo de errores. Tenemos que llegar a corregir completamente. Eh, todo tipo de incidencias para que no vuelvan a suceder y bueno, hacer la aplicación más profesional como tal. Quiero decir. Considerar ese tipo de carga. Eh, que no se frisee. Todo ese tipo de cosas.
