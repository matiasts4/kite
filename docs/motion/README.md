# Laboratorio de movimiento (Kite)

Guía permanente para cambios visuales de animación, transición y micro-interacción. El laboratorio es el lugar donde se **ven y se ajustan** antes de tocar el producto.

## Dónde vive

| Qué | Ruta |
|-----|------|
| Página de laboratorio (solo `dev`) | `src/motion/MotionLab.tsx` + `src/motion/motionLab.css` |
| Cómo abrirla | `http://127.0.0.1:1420/?motion` (el query `motion` en `src/main.tsx` carga el lab y **no** monta `App`) |
| Contrato (duraciones, reduced motion, borde vivo, proyectil) | `src/motion/contract.ts` |
| Presencia (montar durante la salida) | `src/motion/usePresence.ts` |
| Clases de superficie | `src/motion/surface.ts` → `motion.css` |
| Intro de arranque | `src/motion/AppIntro.tsx` |

El lab ya importa `index.css` porque `main.tsx` lo carga antes del dynamic import. Los estilos reales de la app (orbe, menús, sheets) están disponibles dentro de `?motion`.

## Regla de trabajo

1. **Probar en el lab primero.** Una sección nueva en `MotionLab` reproduce el gesto con los mismos tokens (`--motion-enter`, `--motion-exit`, `--motion-ease`) o, si el componente ya tiene look propio, **montando el componente real** (no un sustituto de CSS).
2. **Ajustar ahí** con el interruptor “Reduced motion” (`document.documentElement.dataset.motion`).
3. **Portar a producción solo cuando el usuario lo apruebe.** Copiar la curva aceptada al componente de producto. No adelantar el port “porque ya se ve bien”.
4. **No animar el cambio Agent / Code / Thread.** `.mode-layer` y `.mode-toggle` quedan instantáneos.
5. **Sin librería nueva de animación** (sin Framer Motion). Transform y opacidad. Salida con `usePresence` (~140 ms) antes de desmontar.
6. **Respetar `prefersReducedMotion()`** del contrato (y el override del lab).

## Qué ya está en el lab vs. en el producto

El lab sigue siendo el lugar para **probar gestos nuevos** antes de portarlos. Las superficies del kit están alineadas lab ↔ prod salvo lo marcado como futuro (p. ej. kanban de Tasks).

| Área | Producción | Lab (`?motion`) |
|------|------------|-----------------|
| Intro | `AppIntro` | demo repetible |
| Popovers / menús | cuotas, recursos, notificaciones, `SelectMenu`, context sidebar | Popover / Menús |
| Paneles | sidebars izq/der | LeftRail / Dock |
| Transcript | agente + thread | Transcript |
| Modales | Sheet, What's new, Usage, Quota, Account switcher, Agent resume | Modales |
| Diffs | `DiffsView` + `diffsMotion.ts` | mismas clases `diffs.css` |
| Zed | proyectil + ack | orbe `ZedOrb` 72px + proyectil |
| Tasks | drag nativo | nota demo |

**Sin tocar:** conmutación Agent / Code / Thread (`.mode-layer`).

## Cómo agregar una sección

1. Función `*Demo` en `MotionLab.tsx`, montada desde `MotionLab`.
2. Estilos solo de la maqueta en `motionLab.css` (prefijo `motion-lab__`). Si hace falta el look real, importar el componente de `src/components` y **no** duplicar su shader ni su CSS.
3. Nota corta en la sección: qué archivo de producto se tocaría después (`DiffsView`, `ZedStrip`, etc.).
4. Reduced motion: si la animación es nueva, apagarla bajo `html[data-motion='reduce']` y `@media (prefers-reduced-motion: reduce)`.

## Verificación

- Abrir `?motion`, ejercitar la sección (abrir/cerrar, no solo un pantallazo).
- Probar reduced motion.
- `npx tsc --noEmit` y los tests del área que se porte después (el lab en sí no tiene suite; el contrato sí: `src/motion/contract.test.ts`).
