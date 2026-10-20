# Handoff agente → terminal hija (buzón `.kite/inbox`)

Canal para que un agente que corre **dentro de una terminal de Kite** pida abrir otra terminal o inyectar un prompt, sin pasar el cuerpo de la tarea por argv del proceso hijo.

## Comandos (desde la terminal del agente padre)

```bash
node scripts/kite-agent.mjs agents
node scripts/kite-agent.mjs spawn --engine antigravity --task .kite/tasks/foo.md
node scripts/kite-agent.mjs inject --target Orion --task .kite/tasks/foo.md
```

- El archivo referido por `--task` debe contener la **tarea completa** (especificación, rutas, criterios). Kite lee ese archivo y entrega el texto íntegro a la terminal hija vía spawn + proyectil + `kite:terminal-staged-prompt` + `write_terminal`.
- El script **no invoca** Grok, Claude, Codex, Antigravity, OpenCode ni ningún CLI de modelo; solo escribe una solicitud JSON en `<cwd>/.kite/inbox/` y espera `<id>.result.json` (hasta 8 s).
- Variables opcionales: `KITE_SOURCE_SESSION` y `KITE_PANE_ID` se copian a la solicitud para trazabilidad.

## Requisitos

1. Kite Code abierto con el **mismo workspace** (`cwd`) que la terminal donde corre el comando.
2. Vista **Code** montada (`CodeWorkspace` hace poll cada ~500 ms).

## Flujo

1. El padre escribe `.kite/tasks/<tarea>.md` con el contenido completo.
2. Ejecuta `node scripts/kite-agent.mjs spawn ...` (o `inject`).
3. La app consume el `.request.json`, planifica el handoff y responde con `.result.json`.
4. La prueba real — que la terminal hija **empiece a trabajar** con ese prompt — la hace el usuario con su motor instalado.

## Errores habituales

- *«La app Kite no recogió la orden…»*: no hay workspace abierto o el poll no está activo.
- Rutas con `..` o fuera del cwd del workspace: rechazadas en el planificador.

## Tests locales (sin modelos)

```bash
npx vitest run src/lib/agentHandoff.test.ts
cargo test --lib agent_inbox --manifest-path src-tauri/Cargo.toml
node --test scripts/kite-agent.test.mjs
```
