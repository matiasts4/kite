# Carril navegador + Ego Lite

Kite **instalable** y `npm run tauri dev` no cambian. Para pruebas con agentes en navegador:

```bash
npm run dev:browser
```

- UI: http://127.0.0.1:1430
- API IPC mock: http://127.0.0.1:1421
- Modo Agent: solo **Antigravity** (fixture)
- Zed: planificador **local** (heurístico), sin API keys

## Ego Lite en Windows (instalado)

CLI (si no está en PATH):

```powershell
$ego = "C:\Program Files\Citro Labs\ego lite\Application\0.6.0.16\ego-browser.exe"
& $ego skill
```

Automatización (PowerShell, ver guía `ego-browser skill`):

```powershell
& $ego nodejs -e "const task = await taskSpace('kite smoke'); await task.page('p1').goto('http://127.0.0.1:1430'); console.log(await task.page('p1').snapshot());"
```

Smoke sin Ego (Playwright, requiere `npm run dev:browser` en marcha):

```bash
npm run verify:browser:smoke
```

## Ego Lite vs lo que “ve” el agente

Ego Lite puede operar de dos maneras (consulta siempre `ego-browser skill` en tu versión):

1. **Interacción visual** — snapshot / DOM / accesibilidad, clic, tecleo como un usuario.
2. **Scripts de la skill** — herramientas aprendidas por sitio (patrón en `learnings/`).

Para Kite conviene empezar **visual** con selectores estables (`data-testid`, `aria-label`). Los scripts de skill son opcionales cuando el flujo esté estable.

## Recorrido — resumen de sesión / agente (terminales)

1. En Zed: `abre 2 terminales con antigravity` → deben aparecer paneles **Orion** y **Nova** en modo Code.
2. Luego: `resume qué dijo el agente Nova` o `qué está haciendo Orion`.
3. En `[data-testid="zed-status"]` debe aparecer texto basado en el **buffer de terminal** (en carril navegador es simulado pero coherente; con planificador local también resume).

Automatizado en `npm run verify:browser:smoke` (segunda fase).

## Recorrido 1 — Zed (asistente)

1. Abrir http://127.0.0.1:1430 (el asistente debería abrirse solo).
2. En la píldora flotante, usar el **campo de texto visible** bajo el orb (solo en carril navegador).
3. Escribir en `[data-testid="zed-input"]` → clic en `[data-testid="zed-send"]`.
4. Afirmar en `[data-testid="zed-status"]` texto de etapa o respuesta (p. ej. “Listo”, recibo heurístico).

## Recorrido 2 — Agent (Antigravity)

1. Confirmar modo **Agent** en el toggle «Work mode» (`aria-label="Work mode"`, botón «Agent»).
2. Ver agente **Antigravity** en la barra lateral.
3. Abrir o crear chat; escribir en `[data-testid="agent-chat-input"]`.
4. Clic en `[data-testid="agent-chat-send"]`.
5. Ver mensaje del asistente con prefijo `[Antigravity]` (respuesta simulada del mock).

## Límites del carril

- Terminales ConPTY, WebView2 embebido, updater y vault nativo: no disponibles.
- Acciones de Zed que abren terminal real se simulan o fallan con recibo parcial según el mock.
