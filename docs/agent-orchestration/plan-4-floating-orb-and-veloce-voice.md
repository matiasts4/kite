# Plan 4 — Rediseño a Esfera Pura del Asistente Flotante y Conexión de Voz con Veloce (ODD)

> **Destinatario:** Asistente de implementación y revisores del sistema.
> **Idioma:** Toda interfaz visible, avisos, notas y síntesis de voz (TTS) en **español**. Código, eventos y tipos en inglés.
> **Regla de oro de marca:** La aplicación es **Kite Code**. Queda estrictamente prohibido utilizar o copiar nombres, marcas o términos de proyectos anteriores. Toda la terminología debe ser nativa de Kite.

---

## 0. Diagnóstico y Necesidad del Segundo Rediseño

### 0.1 Problemas Actuales Identificados
1. **Sobrecarga Visual y Pérdida de Simplicidad:**
   - La ventana flotante actual (`ZedStrip.tsx`) contiene un popover rectangular pesado (`.zed-float__card`) con pestañas (`Comando`, `Registros`), un campo de texto `input`, botones de ejemplos y controles laterales que ocupan gran parte de la pantalla e interfieren con el flujo de trabajo del editor y terminales.
   - El orbe quedó reducido a un tamaño pequeño de 46px arrinconado en una base lateral con múltiples botones expuestos.
2. **Entrada Manual en vez de Voz Directa:**
   - Para accionar el asistente se depende primordialmente de escribir en el cuadro de texto manual, a pesar de que la visión de este asistente es ser un compañero por voz y comandos rápidos naturales.
   - En entornos de desarrollo se puede enlazar un motor de voz local (**Veloce** u otro ASR con `faster-whisper`) para dictado de baja latencia.
3. **Consumo de Recursos y Lag del Orbe:**
   - El bucle de renderizado WebGL en `ZedOrb.tsx` (`requestAnimationFrame`) ejecutaba llamadas continuas actualizando 6 variables CSS en el DOM cada frame (`el.style.setProperty`), provocando recálculos de estilo forzados (*forced reflow/style recalculation*) en el hilo principal de la aplicación.
   - No existía un modo de reposo (*sleep mode*) real que detuviera los ciclos GPU/CPU cuando el orbe está inactivo y el cursor no está interactuando.
4. **Falta de Configuración de Voz del Asistente:**
   - La pestaña de voz en Ajustes (`VoiceTab.tsx`) contiene opciones de dictado general pero carece de una sección específica para configurar el motor de dictado, atajo y retroalimentación del Asistente Operador.

---

## 1. Objetivos del Plan

1. **Esfera Flotante Pura (72px):**
   - Eliminar por completo el cajón rectangular de texto, las pestañas de comandos y registros del widget flotante.
   - Retornar a la simplicidad del diseño esférico puro: esfera de 72px centrada, arrastrable libremente con clip circular.
   - Micro-controles sutiles revelados al pasar el cursor (*hover* o foco): botón de micrófono, contador/tally de recibos en curso y botón de cerrar.
   - Pastilla de estado flotante (`.zed-float__note`): muestra de forma compacta el estado actual (*"Escuchando…"*, *"Pensando…"*, *"Abrí 2 terminales con Grok"*), ocultándose tras unos segundos de inactividad.
2. **Optimización Radical de Rendimiento (Cero Lag):**
   - Implementar *sleep mode* automático en `ZedOrb.tsx`: tras 2 segundos en estado inactivo sin movimiento de ratón, pausar el bucle `requestAnimationFrame`.
   - Limitar la actualización de estilos CSS en el DOM solo cuando el cambio supere un umbral perceptible (`delta > 0.005`).
   - Ajustar el shader WebGL (`orbRenderer.ts`) con resolución interna controlada (`dpr <= 1.5`) y precisión balanceada.
3. **Integración con motor de voz local (Veloce u otro ASR compatible):**
   - Detectar la presencia del motor configurado (p. ej. instalación local de Veloce / `com.veloce.app` en AppData).
   - Proveer un puente de dictado que active la escucha al pulsar el micrófono de la esfera o atajo, transcriba el audio con alta velocidad y envíe el texto directamente a `runOperatorTurn(transcripción)`.
   - Soporte para fallback transparente a la Web Speech API del navegador en caso de que el motor nativo esté en arranque o no disponible.
4. **Configuración Dedicada en `VoiceTab.tsx`:**
   - Sección clara en Ajustes -> Voz: **"Asistente Operador"** para elegir el motor de dictado (Veloce / Whisper / Sistema), verificar el estado de conexión del motor, y ajustar la activación por voz.

---

## 2. Arquitectura de Componentes

```
┌────────────────────────────────────────────────────────────────────────┐
│                              Kite Code                                 │
│                                                                        │
│   ┌──────────────────────────────────────────────────────────────┐     │
│   │               Floating Assistant Orb (72px)                  │     │
│   │                                                              │     │
│   │     [Hover Controls: 🎤 Mic  •  📋 Tally  •  ✕ Close]         │     │
│   │                                                              │     │
│   │                      ╭──────────────╮                        │     │
│   │                      │  Kite Orb    │ (WebGL Plasma / Glass) │     │
│   │                      │    (72px)    │ (Sleep-Mode Optimized) │     │
│   │                      ╰──────────────╯                        │     │
│   │                             │                                │     │
│   │             ┌───────────────┴───────────────┐                │     │
│   │             ▼                               ▼                │     │
│   │     ┌───────────────┐               ┌───────────────┐        │     │
│   │     │  Status Pill  │               │ Receipts Plate│        │     │
│   │     │ (Escuchando…/ │               │ (Lista chips  │        │     │
│   │     │  Verificado)  │               │   acciones)   │        │     │
│   │     └───────────────┘               └───────────────┘        │     │
│   └─────────────────────────────┬────────────────────────────────┘     │
│                                 │                                      │
│             Transcribe Final    │                                      │
│                                 ▼                                      │
│                  ┌──────────────────────────────┐                      │
│                  │  runOperatorTurn(transcript) │                      │
│                  └──────────────┬───────────────┘                      │
│                                 │                                      │
│                                 ▼                                      │
│            ┌──────────────────────────────────────────┐                │
│            │   Receipts & Verified Voice Synthesis    │                │
│            └──────────────────────────────────────────┘                │
│                                                                        │
│   ┌──────────────────────────────────────────────────────────────┐     │
│   │                   Ajustes -> Pestaña Voz                     │     │
│   │                                                              │     │
│   │  [ Dictado General ]        [ Asistente Operador ]           │     │
│   │  - Idioma: Auto (es)        - Motor: Veloce (Local Fast ASR) │     │
│   │  - Dispositivo de entrada   - Estado: Conectado (v0.1.5)     │     │
│   │  - Atajo global: Ctrl+Sh+D  - Atajo: Pulsar Orbe / Voz       │     │
│   └──────────────────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Especificación Técnica por Módulo

### 3.1 `ZedOrb.tsx` y `orbRenderer.ts` (Rendimiento)
- **Modo Reposo (*Sleep Mode*):**
  - Variable `isSleepingRef`: Cuando el estado es `idle` o `muted`, no hay entrada de audio (`level < 0.01`) y el puntero no se mueve, se congela el RAF tras 1.5 segundos.
  - Al recibir eventos de puntero (`onPointerMove`), cambio de estado a `listening`/`thinking`/`speaking` o audio entrante, se reactiva el RAF instantáneamente.
- **Throttling de DOM Style Properties:**
  - Solo invocar `el.style.setProperty` si el cambio en `nextLevel` excede `0.005` o si `curTilt` ha cambiado respecto al frame anterior.
- **Shader WebGL:**
  - Capar el DPR del canvas a `Math.min(window.devicePixelRatio || 1, 1.5)` para evitar saturar GPUs en pantallas Retina/4K.
  - Asegurar liberación de texturas y buffers al desmontar.

### 3.2 `ZedStrip.tsx` (Rediseño Visual a Esfera Pura)
- **Eliminación de Elementos Obsoletos:**
  - Remover `.zed-float__card`, el formulario de input manual y las pestañas `Comando`/`Registros` del widget flotante.
  - Remover los botones de comandos de ejemplo.
- **Estructura Reconstruida (Nativa Kite Code):**
  - `.zed-float`: contenedor con posicionamiento absoluto/fijo y límites automáticos en viewport (`clampPoint`).
  - `.zed-float__orb`: orbe central de 72px (`<ZedOrb size={72} ... />`).
  - `.zed-float__handle`: área circular de arrastre transparente superpuesta sobre la esfera con cursor `grab`/`grabbing`.
  - `.zed-float__controls`: micro-barra de acciones flotante con animación suave al hacer hover:
    - Botón de micrófono (`zed-float__control`): activa la escucha de voz con Veloce / Web Speech.
    - Contador de acciones (`zed-float__tally`): muestra el número de acciones activas; al hacer clic, despliega la tarjeta de recibos verificados (`.zed-float__receipt-plate`).
    - Botón de cierre (`zed-float__control--end`): oculta el orbe.
  - `.zed-float__words`: contenedor de notas flotantes:
    - `.zed-float__note`: pastilla semántica con borde reactivo (azul al escuchar, ámbar al pensar, verde al finalizar, rojo en error).

### 3.3 Integración de Voz con Veloce (`src/lib/operator/voice/veloceVoice.ts`)
- **Detección y enlace con el operador:**
  - Comprobar la presencia del runtime en `com.veloce.app` (`C:\Users\PC\AppData\Roaming\com.veloce.app\python-embed\python.exe` y `audio_engine_embedded.py`) o en `D:\veloce`.
  - Ofrecer el hook `useOperatorVoice`:
    - `isListening`: boolean.
    - `audioLevel`: number (para alimentar la vibración volumétrica del orbe en tiempo real).
    - `transcript`: string (texto parcial y final).
    - `startListening()`: Inicia la captura.
    - `stopListening()`: Detiene la captura y devuelve el texto final a `runOperatorTurn`.

### 3.4 Configuración en `VoiceTab.tsx`
- Añadir sección:
  ```tsx
  <section className="settings-group">
    <h2 className="settings-group__title">Asistente Operador</h2>
    <div className="ui-card">
      {/* Selector de motor: Veloce (Local Fast) vs Sistema */}
      {/* Estado de detección del motor Veloce */}
      {/* Opciones de auto-envío y síntesis TTS */}
    </div>
  </section>
  ```

---

## 4. Fases de Ejecución

| Fase | Tarea | Entregables / Verificación |
|---|---|---|
| **F1** | Planificación ODD | ✅ Completado. Documento maestro en `docs/agent-orchestration/plan-4-floating-orb-and-veloce-voice.md`. |
| **F2** | Optimización de rendimiento del Orbe | ✅ Completado. Sleep mode en `ZedOrb.tsx`, throttling de estilos DOM y cap de DPR a 1.5 en `orbRenderer.ts`. |
| **F3** | Rediseño visual a Esfera Pura 72px | ✅ Completado. `ZedStrip.tsx` y `zedFloat.css`: esfera pura de 72px, micro-controles en hover y pill de estado reactiva sin cajón de texto. |
| **F4** | Módulo de Voz Veloce | ✅ Completado. `src/lib/operator/voice/veloceVoice.ts` y hook `useOperatorVoice.ts` con tests unitarios pasando. |
| **F5** | Ajustes de Voz | ✅ Completado. Sección "Asistente Operador (Voz y Dictado)" integrada en `VoiceTab.tsx`. |
| **F6** | Verificación y Cierre | ✅ Completado. `npx tsc --noEmit` = 0 errores; 37 suites de pruebas y 207 tests pasando al 100%. |

---

## 5. Criterios de Aceptación (Definition of Done)

- [x] Widget flotante transformado en esfera pura de 72px sin cajón de texto ni pestañas cuadradas.
- [x] Arrastre suave por la pantalla con retención de posición en `localStorage`.
- [x] Controles sutiles en hover (Micrófono, Acciones, Cerrar) y pastilla de estado informativa.
- [x] Rendimiento optimizado: orbe entra en sleep mode cuando no hay interacción; 0 lag en el hilo principal.
- [x] Soporte de dictado por voz integrado con el motor Veloce / reconocimiento local.
- [x] Configuración del Asistente integrada armoniosamente en la pestaña Voz de Ajustes.
- [x] `npx tsc --noEmit` compila con 0 errores.
- [x] Todas las pruebas existentes y nuevas pasan en `npm test` (37 suites, 207 tests).
