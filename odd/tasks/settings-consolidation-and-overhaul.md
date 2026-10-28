# Consolidación, Limpieza y Estandarización de Configuraciones (Settings Overhaul)

Objective: Consolidar la arquitectura de ajustes y preferencias de Kite Code, eliminando elementos huérfanos o hardcodeados, suprimiendo vistas y controles duplicados entre Voice, Zed, Account y Cuotas, adoptando el componente estándar `SelectMenu` en reemplazo de `<select>` nativos, adaptando los campos de API Keys a los estándares de diseño y optimizando la carga del Changelog mediante renderizado progresivo.
Branch: Shared working tree (`main` / `feat/agent-sessions`).
Delivery strategy: `single-pr`.
Test runner: `npx vitest run`; typecheck: `npx tsc --noEmit`.

---

## 1. Contexto y Diagnóstico del Problema

La auditoría exhaustiva sobre `src/components/views/settings/` y `SettingsView.tsx` reveló seis categorías críticas de inconsistencia y fragmentación:

### 1.1. Elementos Hardcodeados, Huérfanos o Sin Efecto Real (Dead UI)
1. **Privacidad y Diagnósticos (`GeneralTab.tsx`)**: El interruptor de diagnósticos modifica un estado React en memoria (`telemetryPrefs.diagnostics`) en `SettingsView.tsx` que no persiste en `localStorage` ni invoca comandos IPC de Tauri. Al cerrar la vista, el valor vuelve a `false`.
2. **Pestaña Agents & Models (`ModelsTab.tsx`)**:
   - *Respaldo offline automático*: Guarda una clave de respaldo offline huérfana en `localStorage`, pero ningún otro módulo o proceso de inferencia en toda la aplicación lee esta clave.
   - *Comunicación inter-agente*: Guarda una clave de mensajería inter-agente en `localStorage`, ignorando por completo el sistema real de `allowAgentMessaging` gestionado individualmente por perfil de agente en SQLite/IPC.
   - *Modelo del chat*: Es un texto estático informativo ("Se elige en la conversación"). No tiene funcionalidad de configuración.
   - *Medidor de cuota*: Duplica controles ya presentes en la pestaña de Cuotas.
3. **Pestaña Remote (`SettingsView.tsx`)**:
   - Tarjeta inline 100% estática con badge "En desarrollo para v0.2.0". No existe backend, IPC ni sync móvil.
4. **Pestaña Import (`SettingsView.tsx`)**:
   - Botón inline que dispara un `alert()` nativo de navegador.
5. **Discord Rich Presence (`GeneralTab.tsx`)**:
   - Tarjeta informativa con badge "Próximamente en v0.2" sin backend.
6. **Prefijos heredados en Almacenamiento Local**:
   - Uso de claves con prefijo legacy (`palette`, `theme`, `settingsTab`, `terminalShell`, `offlineFallback`, `agentMessaging`, `showPaneContext`), lo cual viola las directrices de limpieza e integridad de Kite.

### 1.2. Listas Desplegables (`<select>`) que Rompen el Lenguaje Visual
En múltiples pestañas se utilizan etiquetas HTML nativas `<select>` con estilos inline arbitrarios (`borderRadius: 6px`, `colorScheme: dark`, colores fijos `#f4f4f6` sobre fondos `#18181d`):
- `VoiceTab.tsx` (selector de micrófono).
- `ZedAudioSection.tsx` (selector de micrófono duplicado).
- `ZedPersonaSection.tsx` (modelos ElevenLabs, voces, idioma y velocidad).
- `AccountTab.tsx` (selector de cuenta Google).
- `GeneralTab.tsx` (selector de shell de terminal).
- `TelemetryTab.tsx` (filtros de proveedor, modelo y tipo de tarea).

**Impacto**:
- Incumplen el contrato de radio semántico de 8px (`var(--control-radius)`) de `AGENTS.md`.
- En tema Claro (Light Mode), los estilos fijos oscuros generan incompatibilidad cromática e ilegibilidad.
- No utilizan el componente estándar `SelectMenu` (`src/components/ui/SelectMenu.tsx`), el cual ofrece animaciones con Motion, accesibilidad de teclado y tokens de diseño unificados.

### 1.3. Rotura Estética de Campos API Key y Controles Horizontales
- En `VoiceTab.tsx`, el campo de Grok API Key utiliza la clase CSS `.ui-input` (que no existe en la hoja de estilos).
- Al insertarse en `.settings-row__control` junto a botones de "Ver" y "Guardar", se sobrepasa el ancho asignado (`max-width: 55%`), comprimiendo la columna de descripción (`.settings-row__copy`) a menos de 180px y provocando saltos de línea antiestéticos o desbordamientos horizontales.
- Falta estandarización hacia la clase de diseño `.ui-field` y layout apilado (`.settings-row--stacked`) para campos de credenciales.

### 1.4. Duplicidad Masiva entre Pestañas
1. **Voice vs. Asistente Zed**:
   - `VoiceTab.tsx` y `ZedAudioSection.tsx` duplican exactamente:
     - El listado y selector de micrófono.
     - La prueba de audio en vivo (VU Meter con `startMicrophoneTest`).
     - La sesión de prueba de transcripción con cuenta regresiva de 8 segundos (`startTranscriptionTestSession`).
     - La configuración de API Key de Grok para transcripción (`kite_grok_transcription_api_key`).
     - La configuración de ElevenLabs API Key y selector de motor TTS (`operatorCfg.elevenlabsApiKey`).
2. **Account vs. Cuotas y Cuentas**:
   - `QuotasTab.tsx` contiene el panel maestro de proveedores detectados, Bóveda de Cuentas (`AccountVault`), alternador de sesiones (`AccountSwitcherModal`) y verificación de cuotas.
   - `AccountTab.tsx` contiene un perfil cosmético ("Kite User" con avatar `K`), un botón que redirige a Cuotas, una lista duplicada de sesiones CLI escaneadas y un modal estático de políticas legales.
3. **General vs. Terminal**:
   - El control segmentado "Destino de enlaces web (URLs)" se encuentra duplicado tanto en `GeneralTab.tsx` como en la pestaña `Terminal` de `SettingsView.tsx`.
   - La selección de shell de terminal está en General en lugar de estar agrupada en Terminal.

### 1.5. Changelog Ineficiente e Inescalable
- `ChangelogTab.tsx` renderiza de manera lineal el 100% de los lanzamientos devueltos por `getReleases()`. Con el crecimiento de versiones, esto provoca sobrecarga en el DOM y un scroll excesivo.
- Falta un renderizado progresivo que muestre las 2 versiones más recientes por defecto y permita expandir el historial con un botón interactivo.

### 1.6. Desconexión en la Configuración de Proveedores
- Los proveedores de inferencia del core (Antigravity, Claude Code, Codex, Grok, OpenCode) están gestionados en `QuotasTab` mediante detección de CLI y Bóveda SQLite.
- Los proveedores del operador Zed (OpenCode Go, Vercel, Cloudflare, etc.) se gestionan en `ZedProvidersSection` con `OperatorConfig`.
- La pestaña intermedia `Agents & Models` no conecta modelos ni proveedores, actuando como un puente desconectado que confunde al usuario.

---

## 2. Especificaciones de Diseño y Arquitectura (Specs)

### S1. Depuración y Eliminación de Dead UI
- **Privacidad y Diagnósticos**: Conectar el interruptor de diagnósticos locales a persistencia real (`localStorage.getItem('kite.diagnostics_enabled')` y evento `kite:diagnostics-preference-changed`) o suprimirlo si no existe backend que lo consuma.
- **Pestaña Agents & Models**: Suprimir la pestaña zombi `models` / `agents` del menú de Settings. La configuración profunda de agentes (nombre, avatar, instrucciones, esfuerzo, plugins) reside en `AgentsView` / `AgentSettingsTab`. Las cuotas y modelos de inferencia se unifican en la pestaña de Proveedores y Cuentas.
- **Pestañas Placeholder**:
  - Ocultar la pestaña `remote` hasta que exista la implementación en v0.2.
  - Eliminar el disparador de `import` con `alert()` de navegador.
  - Retirar la tarjeta de Discord Rich Presence de `GeneralTab` mientras no haya daemon IPC asociado.
- **Migración de Claves de Almacenamiento**:
  - Migrar todas las claves con prefijo legacy a `kite.*` (`kite.palette`, `kite.theme`, `kite.settingsTab`, `kite.terminalShell`, `kite.showPaneContext`), manteniendo lectura fallback para no alterar configuraciones existentes.

### S2. Estandarización de Listas Desplegables con `SelectMenu`
- Reemplazar todas las etiquetas `<select>` nativas e inline styles por el componente accesible `SelectMenu` (`src/components/ui/SelectMenu.tsx`).
- Aplicar altura estándar de 32px (`--vl-control-md`) para triggers principales y 28px (`--vl-control-sm`) para barras compactas.
- Cumplir el radio estricto de 8px (`var(--control-radius)` / `rounded-control`) en contenedores, items y menús emergentes.
- Garantizar que los menús funcionen de forma idéntica en tema Claro (`kite-light`, `github-light`, etc.) y Oscuro (`kite-dark`, `tokyo-night`, etc.) consumiendo tokens CSS (`--bg-surface`, `--text-primary`, `--separator`, `--block-stroke`).

### S3. Normalización de Campos para API Keys y Credenciales
- Para filas que reciben claves de API (Grok, ElevenLabs, OpenCode Go, Vercel, etc.):
  - Utilizar el diseño apilado `.settings-row--stacked` o extender `.settings-row` para que el campo de texto se expanda al 100% en una sub-fila dedicada.
  - Reemplazar `.ui-input` por `.ui-field` con fuente monospace legible, tamaño de fuente 12px, altura de 32px y radio de 8px.
  - Integrar botones compactos de visibilidad (Ver/Ocultar con icono SVG) y guardado con feedback transicional sin deformar el ancho de las etiquetas de texto.

### S4. Consolidación de Pestañas y Eliminación de Duplicados
1. **Unificación de Ajustes de Audio y Asistente**:
   - `VoiceTab`: Especializada en transcripción de voz a texto (Dictado local con Whisper, atajos de dictado, selección de micrófono del sistema, cues de audio y calibración VU Meter).
   - `ZedTab`: Conserva la configuración de la Persona del Asistente (sintetizador TTS, voces, ElevenLabs, modelo de pensamiento, latencia y memoria), delegando la configuración del micrófono a los parámetros unificados del sistema (`kite_selected_mic_device_id`).
   - Extraer la suite de prueba de micrófono y VU Meter a un subcomponente reutilizable (`src/components/views/settings/voice/MicCalibrationCard.tsx`) para no duplicar 150 líneas de código.
2. **Consolidación de Cuentas y Cuotas**:
   - Faccionar `QuotasTab` como la vista integral **"Cuentas y Proveedores"** (`quotas`).
   - Integrar la información de políticas de privacidad local como una sección limpia en `General` o al pie de `Proveedores`.
   - Eliminar `AccountTab` independiente para evitar tener dos pestañas con el mismo propósito.
3. **Reorganización de Terminal**:
   - Mover la selección de shell por defecto (`terminalShell`) desde `GeneralTab` hacia la pestaña dedicada `Terminal`.
   - Mantener una única fuente de verdad para "Destino de enlaces web" en `TerminalTab`.

### S5. Paginación Progresiva del Changelog
- Modificar `ChangelogTab.tsx`:
  - Por defecto, renderizar únicamente las 2 versiones más recientes (la versión en curso y la inmediatamente anterior o entrante).
  - Si existen más de 2 versiones en `getReleases()`, mostrar un botón inferior estilizado: `Mostrar versiones anteriores (N restantes)`.
  - Al pulsar, desplegar progresivamente en bloques de 5 o el total restante, con opción de contraer.
  - Prevenir sobrecarga del DOM y reducir el tiempo de renderizado de la pestaña a < 15ms.

### S6. Matriz Limpia de Pestañas en la Barra Lateral
La navegación lateral de `SettingsView.tsx` quedará estructurada en grupos lógicos y semánticos:

1. **General** (Apariencia modo claro/oscuro, autoguardado, actualizaciones de software).
2. **Customizations** (Temas y paletas de color con previews visuales).
3. **Terminal** (Shell por defecto, destino de enlaces web, estado del daemon nativo).
4. **Notifications** (Alertas de agentes, sonido de campanilla, notificaciones del sistema).
5. **Voice & Dictado** (Dictado por voz, selección de micrófono, prueba VU Meter y Speech-to-Text).
6. **Asistente Zed** (Personalidad de Zed, síntesis TTS ElevenLabs/Browser, pasarela multi-modelo, latencia y notas de memoria).
7. **Cuentas y Proveedores** (Bóveda de credenciales, rotación de cuentas, CLI autenticadas y límites de cuota en tiempo real).
8. **Plugins** (Herramientas y MCPs de agentes).
9. **Shortcuts** (Atajos de teclado y combinaciones rápidas).
10. **Changelog** (Novedades de la versión y notas de entrega con vista progresiva).

---

## 3. Plan de Tareas de Implementación (Tasks)

- [ ] **T1 — Auditoría y Limpieza de Dead UI / Prefijos Legacy**:
  - Migrar lecturas y escrituras de `localStorage` de claves heredadas a `kite.*` con fallback seguro.
  - Retirar tarjetas muertas (Discord Rich Presence en General, pestaña Remote inline, alerta de importación).
  - Desacoplar y remover la pestaña zombi `models` / `agents` de la barra de ajustes.
- [ ] **T2 — Estandarización de Selects con `SelectMenu`**:
  - Reemplazar `<select>` en `VoiceTab.tsx` (selector de micrófono) por `SelectMenu`.
  - Reemplazar `<select>` en `GeneralTab.tsx` (selector de shell) por `SelectMenu` y trasladarlo a `TerminalTab`.
  - Reemplazar `<select>` en `ZedPersonaSection.tsx` (ElevenLabs model, voice, language, speed) por `SelectMenu`.
  - Reemplazar `<select>` en `AccountTab.tsx` y `TelemetryTab.tsx`.
  - Verificar que todos respeten el radio de 8px (`var(--control-radius)`) y colores dinámicos en modo Claro/Oscuro.
- [ ] **T3 — Reparación de Layout de Campos API Key y Credenciales**:
  - Aplicar `.settings-row--stacked` o sub-filas de ancho completo en `VoiceTab`, `ZedProvidersSection` y `QuotasTab`.
  - Sustituir clases inexistentes (`.ui-input`) por `.ui-field`.
  - Estandarizar inputs de credenciales con altura de 32px, fuente monospace y botones de acción armonizados.
- [ ] **T4 — Desduplicación de Código de Audio entre Voice y Zed**:
  - Crear componente unificado `MicCalibrationCard.tsx` que agrupe el VU Meter y la prueba de transcripción.
  - Sincronizar la selección de micrófono en una única clave compartida (`kite_selected_mic_device_id`).
  - Limpiar `ZedAudioSection` para que referencie la configuración unificada sin repetir el formulario de VoiceTab.
- [ ] **T5 — Consolidación de Cuentas, Proveedores y Terminal**:
  - Mover la configuración de shell (`terminalShell`) de `GeneralTab` a `Terminal`.
  - Unificar `QuotasTab` como la sección definitiva de "Cuentas y Proveedores".
  - Retirar la redundancia de `AccountTab` de la navegación principal, asegurando que las políticas de privacidad se puedan consultar desde General o About.
- [ ] **T6 — Optimización y Paginación Progresiva del Changelog**:
  - Implementar paginación o limitador inicial de 2 versiones en `ChangelogTab.tsx`.
  - Añadir botón interactivo de "Mostrar versiones anteriores" con animación fluida.
- [ ] **T7 — Verificación de Calidad y Tests**:
  - Ejecutar `npx tsc --noEmit` y resolver cualquier discrepancia de tipos.
  - Ejecutar `npx vitest run src/components/views/settings` asegurando que todos los tests pasen.
  - Ejecutar `node .kite/sanitizer/audit-references.mjs --check` para garantizar 0 fugas de referencias donor.

---

## 4. Criterios de Aceptación y Gobernanza

1. **Cero Elementos Hardcodeados o Mock**: Toda opción visible en la interfaz debe guardar su valor de forma persistente o estar conectada a un comando IPC real.
2. **Cero Duplicación de Ajustes**: Ningún ajuste (micrófono, shell, enlaces web, cuentas CLI) debe aparecer en más de una pestaña a la vez.
3. **Conformidad Visual Absoluta**:
   - Radios: 8px estricto en controles (`var(--control-radius)`), 12px en tarjetas (`var(--card-radius)`).
   - Altura: 32px en inputs y botones principales (`--vl-control-md`), 28px en secundarios (`--vl-control-sm`).
   - Sin `<select>` nativos con estilos oscuros hardcodeados.
4. **Respeto a las Directrices del Repositorio**:
   - `odd/tasks/settings-consolidation-and-overhaul.md` limpio y sanitizado.
   - Sin alteraciones a la geometría o motion del TitleBar mode switcher.
