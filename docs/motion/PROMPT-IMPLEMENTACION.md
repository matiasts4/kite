# Prompt para implementación — Kit de movimiento Kite

Copiá el bloque siguiente y entregalo al agente o al desarrollador que ejecute el trabajo.

---

## Bloque para copiar

```
Contexto: Kite Code (React + Vite + Tauri). Estamos estandarizando animaciones, transiciones y micro-interacciones con un kit propio en `src/motion/`, sin Framer Motion ni librerías nuevas de animación. Solo transform y opacity; duraciones en `src/motion/contract.ts` (`MOTION_ENTER_MS` 180, `MOTION_EXIT_MS` 140, `APP_INTRO_MIN_MS` 2000). Salidas con `usePresence` (`src/motion/usePresence.ts`) para no desmontar de golpe. Clases vía `motionSurfaceClass` en `src/motion/surface.ts` e import global `src/motion/motion.css` desde `src/index.css`.

Regla de oro — lab antes que producto:
1. Diseñar y ajustar en el laboratorio de movimiento: `http://127.0.0.1:1420/?motion` (solo dev; `src/main.tsx` carga `MotionLab` cuando hay query `motion`).
2. Añadir o extender una sección `*Demo` en `src/motion/MotionLab.tsx` y estilos de maqueta en `src/motion/motionLab.css` (prefijo `motion-lab__`). Si el gesto depende del look real (ej. orbe Zed), montar el componente de producción en el lab — no un círculo o mock inventado.
3. Validar con el toggle “Reduced motion” del lab y con `prefersReducedMotion()` del contrato.
4. Portar a producción solo tras aprobación explícita del product owner. Diff mínimo en el componente destino; reutilizar `usePresence` + clases existentes antes de inventar keyframes nuevos.
5. NO tocar la conmutación instantánea Agent / Code / Thread: `.mode-layer` en `src/index.css` y `.mode-toggle` en TitleBar.

Documentación de referencia en repo: `docs/motion/README.md`.

---

Ya implementado en producción (mantener coherencia con el contrato; no refactorizar sin necesidad):
- Cuotas / recursos / notificaciones: popover con `usePresence`
- Sidebar derecha (`RightDock`): panel in/out
- Sidebar izquierda: panel-left + `onRailPresenceChange` en `App.tsx`
- Menús: `SelectMenu`, `SidebarContextMenu` (popover)
- Modales/sheets: `Sheet`, `WhatsNewModal`, `UsageDashboardModal`, `QuotaSettingsModal`, `AccountSwitcherModal`, `AgentPaneResumeModal`, `ArchivedChatsModal` (Sheet)
- Diffs: `useDiffsMenuPresence` en `DiffsView`, `diffs-pop-out` en `diffs.css` (scrim + modal)
- Agente y Thread: transcript — `useTranscriptMotion`, `useTranscriptLiveEdge`, `motion-row-in`, columna agente `--chat-column-agent`
- Zed: proyectil (`PromptProjectileOverlay`), terminal `motion-terminal-in`, `pulseZedOrb` / `kite:zed-orb-ack`, coreografía `dispatchPromptWhenPaneReady`
- Intro de arranque: `AppIntro` en `App.tsx` (mínimo 2s + bootstrap listo)

Backlog residual (baja prioridad / futuro):
- Tasks: motion al soltar tarjeta en kanban (solo documentado en lab)
- Files: sin motion dedicado
- Settings full-screen: transición opcional (settings reemplaza shell; no es modal)

Laboratorio — Zed (referencia visual):
- Sección Zed monta `ZedOrb` real a 72px con botones de estado (`connected`, `listening`, `thinking`, `speaking`, `error`, etc.) + escenario de proyectil. No modificar `ZedOrb.tsx` / `orbRenderer.ts` salvo bug; ajustes de motion del ack van en wrapper `zed-float__orb` + `motion-orb-ack`.

Primitivos del kit (4 familias):
- Popover (anclas: cuota, menús)
- Panel (sidebars)
- Row (transcript, acciones)
- Proyectil (compositor → terminal / Zed)

Tareas típicas que te pueden pedir:
A) Nueva superficie: lab → aprobación → port a componente concreto.
B) Completar backlog lab→prod (diffs menús, etc.).
C) Nueva sección en MotionLab para una feature (settings overlay, effort panel, etc.) sin port hasta aprobación.

Verificación obligatoria:
- `npx tsc --noEmit`
- Tests del área tocada (ej. `DiffsView.test.tsx`, `RightDock.test.tsx`, `PromptProjectileOverlay.test.tsx`, `src/motion/contract.test.ts`)
- Probar `?motion` y la ruta de producto afectada
- Respetar reduced motion en CSS (`motion.css` y bloques `@media (prefers-reduced-motion: reduce)`)

Restricciones:
- No commitear salvo que te lo pidan
- No editar planes en `.cursor/plans/` salvo instrucción
- Minimizar scope; no añadir dependencias de animación
- Seguir convenciones del archivo que edites (imports, naming, tests existentes)

Entregable esperado por tarea:
1. Qué se probó en `?motion` (sección)
2. Qué se portó a producción (archivos) o explícitamente “solo lab”
3. Cómo verificar en 2–3 pasos
```

---

## Uso

- Para **solo laboratorio**: pedí explícitamente “no portar a producción”.
- Para **port concreto**: nombrá la sección del lab y el componente destino (ej. “portar salida de menús de diffs desde lab a `DiffsView.tsx`”).
- Adjuntá o referenciá `docs/motion/README.md` y este archivo en el ticket.
