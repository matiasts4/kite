# Changelog

All notable changes to **Kite Code** will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.22] - 2026-10-20

> Supresion de demonios huerfanos de Antigravity y aislamiento de procesos

### Fixed
- Inyección estricta de AGY_CLI_DISABLE_AUTO_UPDATE=true en Rust (main, quota, chat, terminal, hidden_exec) para suprimir el demonio en segundo plano de agy.
- Aislamiento total de ventanas de consola en Windows 11 impidiendo la delegación a WindowsTerminal.exe.

### Security
- Configuración persistente a nivel de usuario en Windows para evitar ejecuciones huérfanas de background updater.

---

## [0.1.21] - 2026-10-19

> Supresion de consolas en sesiones de agentes y servidores MCP

### Changed
- Sanitización de nombres de archivo de sesión en el gestor de portapapeles.

### Fixed
- Prevención de destellos de terminal en la inicialización de servidores MCP (windowsHide activado).
- Inyección de AGY_CLI_DISABLE_AUTO_UPDATE=1 en terminales y agentes ConPTY para bloquear daemons huérfanos de agy.

---

## [0.1.20] - 2026-10-19

> Eliminacion definitiva de delegacion de Windows Terminal con CREATE_NO_WINDOW

### Changed
- Supresión de asignación de consolas en la ejecución oculta de subprocesos y herramientas CLI

### Fixed
- Reemplazo definitivo de CREATE_NEW_CONSOLE por CREATE_NO_WINDOW en hidden_exec para impedir la delegación a Windows Terminal en Windows 11
- Aislamiento completo de procesos en segundo plano para consultas de cuotas de Antigravity y servidores MCP

---

## [0.1.19] - 2026-10-19

> Corrección de congelamiento en terminales y respuesta interactiva instantánea

### Fixed
- Elimina el bloqueo asíncrono en enqueueWrite que dejaba las terminales oscuras y no responsivas

---

## [0.1.18] - 2026-10-19

> Optimizaciones de Rendimiento y Prevencion de Congelamiento

### Changed
- Polling adaptativo en terminales integradas con reduccion del 75% en reposo y 95% en segundo plano
- Pausa automatica en el muestreo de procesos del sistema cuando la ventana esta oculta
- Debounce de 2.5s en comprobador de actualizaciones al recuperar foco de la ventana

### Fixed
- Prevenir congelamiento de UI tras periodos en segundo plano con banderas anti-suspension en WebView2
- Eliminar escritura sincrona a app.log en el bucle principal de eventos (MainEventsCleared)

---

## [0.1.17] - 2026-10-19

> Eliminacion de ventanas emergentes de consola y optimizacion en segundo plano

### Added
- Refinamiento de la barra de control de asistencia ZedStrip y renderizado suave de ZedOrb

### Changed
- Optimización del tiempo de respuesta en la comprobación periódica de cuotas de Antigravity

### Fixed
- Eliminación de ventanas emergentes de PowerShell y Windows Terminal al consultar cuotas de Antigravity
- Aislamiento estricto de procesos en segundo plano con flags CREATE_NO_WINDOW y CREATE_NEW_CONSOLE en hidden_exec
- Prevención de apertura de consolas al consultar modelos CLI de Antigravity

---

## [0.1.16] - 2026-10-18

> Estabilidad de doble instancia y optimización del Asistente

### Changed
- Optimización del renderizado de la esfera ZedOrb evitando WebGL en orbes pequeños y pausando en reposo

### Fixed
- Aislamiento completo de carpetas WebView2 entre desarrollo e instalada para evitar bloqueos y congelamientos
- Asistente Zed cerrado por defecto al abrir la aplicación sin píldora flotante automática
- Corrección en el script de desarrollo para preservar el bloqueo de la aplicación de producción

---

## [0.1.15] - 2026-10-18

### Added
- Floating Zed orb and interactive dock assistant with sound wave animations and drag controls.
- Operator protocol with autonomous subagent dispatcher and task runner.
- Settings Zed tab for operator configuration, microphone dictation, and speech toggles.

### Changed
- ConPTY terminal paste handler with bracketed paste mode and multiline sanitization.

### Fixed
- Stabilized background thread synchronization for IPC command channels.

---

## [0.1.14] - 2026-10-17

### Added
- Windows ConPTY terminal keepalive daemon and auto-reconnection on window resize.
- Standalone PowerShell desktop launch script (`scripts/launch-desktop-app.ps1`).

### Changed
- Pruned legacy release artifacts and build cache to optimize installer packaging.

### Fixed
- Fixed terminal cursor drift and background flicker during heavy process execution.

---

## [0.1.13] - 2026-10-16

### Added
- Hardware telemetry monitoring CPU, memory, and disk usage with real-time HUD badge.
- Auto-healing background feed server daemon (`scripts/feed-server.mjs`) on port 9101.

### Changed
- One-command atomic release pipeline (`scripts/release.mjs`) with NSIS bundling and Minisign verification.

### Fixed
- Eliminated feed server port collision and zombie child process leaks.

---

## [0.1.12] - 2026-10-16

### Added
- Persistent SQLite memory engine (`agent_mind.rs`) for long-term agent contextual memory.
- Autonomous local autopilot execution loop with step-by-step goal verification.

### Changed
- Configurable agent memory budgets and note caps in Agent Settings.

### Fixed
- Memory leak during repeated subagent task state serialization.

---

## [0.1.11] - 2026-10-16

### Added
- Unified sidebar navigation with dedicated views for Agents, Workspaces, Chat, and Settings.
- Custom modal system (What's New modal, Launch Preset modal, Keyboard Shortcuts).

### Changed
- Responsive view docking and collapsible rail navigation.

### Security
- Sanitized IPC layer and sandboxed WebView2 execution bounds.

---

## [0.1.10] - 2026-10-16

### Added
- Multi-account switcher with secure local token storage for AI providers.
- Live subscription quota monitor and token usage telemetry graphs.

### Fixed
- Token refresh race condition during simultaneous agent requests.

---

## [0.1.9] - 2026-10-15

### Added
- Native ticket management board and task dispatcher for autonomous coding runs.
- Model Context Protocol (MCP) server configuration manager and tool discovery.

### Changed
- Real-time ticket status updates synchronized with background agent actions.

---

## [0.1.8] - 2026-10-15

### Added
- Multi-agent roster supporting customized system prompts, engine selection, and role specializations.
- Background routine scheduler with interval and event-based triggers.

### Fixed
- Process cleanup on routine cancellation or engine timeout.

---

## [0.1.7] - 2026-10-15

### Added
- Native workspace filesystem explorer with recursive tree navigation and file search.
- Integrated code editor with markdown preview and diff visualization.

### Changed
- File watcher performance optimized with debounce and gitignore filtering.

---

## [0.1.6] - 2026-10-15

### Added
- Streaming Agent Communication Protocol (ACP) for low-latency token and tool output.
- Human-in-the-loop tool execution approval prompts with inline diff reviews.

### Changed
- Enhanced chat composer with multiline expansion and command palette autocomplete.

### Security
- Strict path traversal guards and execution approval enforcement.

---

## [0.1.5] - 2026-10-16

### Added
- Dynamic version synchronization across all Settings tabs (General, About, Changelog, Footer).
- Interactive Changelog view displaying complete release history with incoming update previews.

### Changed
- Synchronized What's New modal directly with Kite Code release ledger.

### Fixed
- Eliminated hardcoded legacy version numbers from GeneralTab, ChangelogTab, and modals.

---

## [0.1.4] - 2026-10-16

### Added
- Reactive updater singleton store synchronizing Sidebar, Circular indicator, and Settings in real time.
- Auto-healing feed server: background daemon automatically starts on update requests.

### Changed
- Replaced raster TitleBar logo with 100% crisp vector SVG full-bleed icon.

### Fixed
- Transparent update diagnostics: displays connection errors with one-click retry.
- Persistent feed directory configured to prevent build tools from clearing release artifacts.

---

## [0.1.3] - 2026-10-16

### Changed
- Redesigned terminal monogram mark with high-contrast chevron and terminal cursor.

### Fixed
- Enabled HTTP Content-Length headers for exact update download percentage calculation.
- Streamlined HEAD and OPTIONS request handling across local feed endpoints.

---

## [0.1.2] - 2026-10-16

### Added
- Brand identity: Kite Code with custom deep-sapphire and cyan identity.
- Air-gapped offline runtime and sanitized local persistent storage.

### Changed
- Interactive TitleBar with dedicated Agent, Code, and Thread mode switchers.

---

## [0.1.1] - 2026-10-15

### Added
- Native ConPTY Windows terminal daemon with hardware-accelerated rendering and automatic resizing.
- Multi-agent orchestration supporting local models and cloud providers in parallel.

### Fixed
- Eliminated terminal window flickering during background quota and process probing.

---

## [0.1.0] - 2026-10-15

### Added
- Embedded WebView2 browser surface with bounded layout preservation.
- Local Token and Subscription quota telemetry.

### Security
- Strict process isolation and secure minisign signature verification for updates.
