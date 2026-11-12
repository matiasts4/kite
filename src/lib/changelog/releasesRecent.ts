import type { RawReleaseNote } from './types';

export const RELEASES_RECENT: RawReleaseNote[] = [
  {
    version: '0.1.52',
    tag: 'v0.1.52',
    date: 'Nov 11, 2026',
    title: 'Thread Voice Mode, Operator Traces and Archiving Overhaul',
    items: [
      {
        kind: 'added',
        description: 'live thread voice mode with trace timeline and locked assistant footer',
      },
      {
        kind: 'added',
        description: 'cross-cli chat index and thread dispatch reach',
      },
      {
        kind: 'fixed',
        description: 'route thread archiving correctly and overhaul archived chats modal',
      },
      {
        kind: 'fixed',
        description: 'permit tool execution in persistent plan mode',
      },
      {
        kind: 'fixed',
        description: 'pure CSS styling and background Zed engine wiring for voice mode',
      },
    ],
  },
  {
    version: '0.1.51',
    tag: 'v0.1.51',
    date: 'Nov 7, 2026',
    title: 'Delegation paste stability and canonical codename assignment',
    items: [
      {
        kind: 'fixed',
        description: 'wrap multiline terminal paste in bracketed paste to prevent queue flooding',
      },
      {
        kind: 'fixed',
        description: 'assign canonical codenames to delegated agents',
      },
      {
        kind: 'fixed',
        description: 'distinguish idle/done prompts from genuine blocked approvals',
      },
    ],
  },
  {
    version: '0.1.50',
    tag: 'v0.1.50',
    date: 'Nov 7, 2026',
    title: 'Dispatch manual CLI & skill roots fix',
    items: [
      {
        kind: 'fixed',
        description: 'Strip SKILL.md YAML frontmatter and guard leading hyphens when passing system prompts to Grok and Claude Code CLI',
      },
      {
        kind: 'added',
        description: 'Expand dispatch skill installation across OpenCode, Gemini, Copilot, Kimi, Amp, and shared agent skill directories',
      },
    ],
  },
  {
    version: '0.1.49',
    tag: 'v0.1.49',
    date: 'Nov 7, 2026',
    title: 'Dispatch skill channel',
    items: [
      {
        kind: 'fixed',
        description: 'Agents receive the dispatch manual as a skill file, not the first chat message.',
      },
      {
        kind: 'added',
        description: 'The dispatch skill is installed into existing agent skill directories.',
      },
    ],
  },
  {
    version: '0.1.48',
    tag: 'v0.1.48',
    date: 'Nov 7, 2026',
    title: 'Dispatch and local updates',
    items: [
      {
        kind: 'added',
        description: 'dispatch CLI to launch, send, wait, and kill agents',
      },
      {
        kind: 'added',
        description: 'agents receive the complete dispatch manual at start',
      },
      {
        kind: 'fixed',
        description: 'updater signing key for the local feed',
      },
    ],
  },
  {
    version: '0.1.47',
    tag: 'v0.1.47',
    date: 'Nov 4, 2026',
    title: 'Restore de terminales AntiGravity y Grok',
    items: [
      {
        kind: 'fixed',
        description: 'Primer frame al restaurar terminales: espera geometría estable del pane, snapshot completo tras el resize del PTY y un empujón de una fila para que AntiGravity y OpenCode redibujen',
      },
      {
        kind: 'fixed',
        description: 'El canvas no pinta deltas vacíos hasta el primer frame completo',
      },
      {
        kind: 'fixed',
        description: 'Caret visible en AntiGravity al restaurar',
      },
      {
        kind: 'changed',
        description: 'Cursor de puntero por defecto sobre las terminales',
      },
      {
        kind: 'added',
        description: 'Restore de sesiones Grok con descubrimiento en ~/.grok/sessions y arranque con -r <id>',
      },
    ],
  },
  {
    version: '0.1.46',
    tag: 'v0.1.46',
    date: 'Nov 4, 2026',
    title: 'Sidebar: nombres de ventana y remocion de badge de proveedor',
    items: [
      {
        kind: 'fixed',
        description: 'Reemplazar nombres de agente en la cabecera de ventana por \'Ventana N\'',
      },
      {
        kind: 'fixed',
        description: 'Eliminar badge de texto de proveedor en subpaneles de la barra lateral',
      },
    ],
  },
  {
    version: '0.1.45',
    tag: 'v0.1.45',
    date: 'Nov 4, 2026',
    title: 'Kite Core Daemon framed IPC, terminal canvas binario y reordenamiento de paneles',
    items: [
      {
        kind: 'added',
        description: 'Arquitectura desacoplada \'kite-core\' daemon con IPC framed binario de 9 bytes y control de flujo por créditos',
      },
      {
        kind: 'added',
        description: 'Codec de snapshot binario empaquetado para terminal con reutilización de memoria in-place en Canvas 2D',
      },
      {
        kind: 'added',
        description: 'Reordenamiento interactivo de paneles de terminal mediante arrastrar y soltar (drag & drop)',
      },
      {
        kind: 'added',
        description: 'Árbol de sesiones multiterminal colapsable en la barra lateral con insignias de marcas y jerarquía visual',
      },
      {
        kind: 'fixed',
        description: 'Recuperación y repintado forzado de pantalla completa ante pérdidas de secuencia de frames en el canvas',
      },
      {
        kind: 'changed',
        description: 'Eliminación definitiva de la superficie DOM heredada (XtermDomSurface) en favor del motor Canvas exclusivo',
      },
      {
        kind: 'changed',
        description: 'Telemetría de recursos del sistema con desglose detallado por proyecto y terminal en el monitor de memoria',
      },
    ],
  },
  {
    version: '0.1.44',
    tag: 'v0.1.44',
    date: 'Nov 2, 2026',
    title: 'Estabilización de Terminal Canvas, Enfoque y Scroll en Agentes',
    items: [
      {
        kind: 'fixed',
        description: 'Restauración de captura de pulsaciones de teclado y auto-enfoque en terminal Canvas (GhostGrid 2D)',
      },
      {
        kind: 'fixed',
        description: 'Propagación y sincronización de isFocused en paneles de agentes y workspace (Antigravity, Cursor, etc.)',
      },
      {
        kind: 'fixed',
        description: 'Restauración de paquetes SGR para rueda de ratón y clics en aplicaciones TUI interactivas',
      },
      {
        kind: 'fixed',
        description: 'Prevención de desenfoque por defecto del navegador en mousedown sobre superficie de terminal',
      },
      {
        kind: 'changed',
        description: 'removed: Retirada de badges e indicadores "GhostGrid 2D" en las cabeceras de paneles y barras de herramientas',
      },
    ],
  },
  {
    version: '0.1.43',
    tag: 'v0.1.43',
    date: 'Nov 2, 2026',
    title: 'Arquitectura Modular, Estabilización de Terminal y Monitor de Recursos',
    items: [
      {
        kind: 'changed',
        description: 'Arquitectura modular y desacoplamiento de componentes centrales (TerminalView, TerminalCanvasSurface, CodeWorkspace, RightDock y SystemResourcePopover)',
      },
      {
        kind: 'added',
        description: 'Módulos dedicados para renderizado de Canvas 2D, seguimiento de ratón, codificación de teclas y sincronización de sesiones PTY',
      },
      {
        kind: 'fixed',
        description: 'Corrección del desplazamiento de viewport (scrollback) con deltaLines en motor Canvas 2D',
      },
      {
        kind: 'fixed',
        description: 'Sincronización de redimensionamiento PTY en superficie DOM de xterm',
      },
      {
        kind: 'fixed',
        description: 'Restauración completa de selección con ratón, auto-scroll y copia al portapapeles en terminal',
      },
      {
        kind: 'fixed',
        description: 'Soporte nativo para arrastre de archivos y pegado de imágenes en terminal',
      },
      {
        kind: 'fixed',
        description: 'Persistencia de configuración de filtros y procesos en monitor de recursos del sistema',
      },
      {
        kind: 'changed',
        description: 'Componentes de cuotas y selector de cuentas desacoplados en submódulos especializados',
      },
    ],
  },
  {
    version: '0.1.42',
    tag: 'v0.1.42',
    date: 'Nov 01, 2026',
    title: 'Motor de Terminal 2D, Eliminación de Artefactos ConPTY y Streaming Continuo',
    items: [
      {
        kind: 'fixed',
        description: 'Desincronización de ancho de celda en glifos VS16 (U+FE0F) y secuencias ZWJ en Windows ConPTY que causaba fragmentos y caracteres desplazados',
      },
      {
        kind: 'added',
        description: 'Superficie de renderizado procedural Canvas 2D con rasterizador de glifos box/block/braille',
      },
      {
        kind: 'added',
        description: 'Motor de terminal virtual nativo en Rust con snapshots atómicos y soporte de actualizaciones sincronizadas DEC 2026',
      },
      {
        kind: 'changed',
        description: 'Lanzamiento directo de ejecutables de agentes bajo ConPTY eliminando wrappers innecesarios',
      },
      {
        kind: 'fixed',
        description: 'Parpadeo y desincronización de scrollback al alternar entre motores de renderizado',
      },
      {
        kind: 'added',
        description: 'Polling en segundo plano para terminales aparcadas en memoria',
      },
      {
        kind: 'changed',
        description: 'Desactivar estrangulamiento de timers de WebView2 en segundo plano',
      },
      {
        kind: 'fixed',
        description: 'Eliminar congelamiento y aceleración x5 en terminales al cambiar de proyecto o ventana',
      },
      {
        kind: 'fixed',
        description: 'Omitir repintados costosos de xterm mientras la terminal no es visible',
      },
    ],
  },
  {
    version: '0.1.41',
    tag: 'v0.1.41',
    date: 'Oct 29, 2026',
    title: 'Ajuste Estabilizado de Terminal, Apariencia Personalizable y Enrutamiento de Atajos',
    items: [
      {
        kind: 'added',
        description: 'personalización de apariencia y tipografía en Settings (modo DOM ClearType vs WebGL GPU)',
      },
      {
        kind: 'added',
        description: 'cálculo geométrico y ajuste estabilizado de viewport ConPTY con StableCellFitAddon',
      },
      {
        kind: 'fixed',
        description: 'preservación de buffers al reconectar sesiones PTY activas',
      },
      {
        kind: 'fixed',
        description: 'delegación de tecla Escape a la terminal sin abortar asistentes u overlays',
      },
      {
        kind: 'fixed',
        description: 'aislamiento de directorio de datos WebView2 para desarrollo y producción',
      },
    ],
  },
  {
    version: '0.1.40',
    tag: 'v0.1.40',
    date: 'Oct 28, 2026',
    title: 'Estabilización ConPTY de Terminal, Paleta de Comandos y Mejoras en Zed',
    items: [
      {
        kind: 'added',
        description: 'Paleta de comandos integrada y enrutamiento global de atajos de teclado',
      },
      {
        kind: 'added',
        description: 'Persistencia local de preferencias de tema, paleta de colores y shell predeterminado',
      },
      {
        kind: 'added',
        description: 'Apertura nativa de archivos y opción de revelado en el explorador del sistema operativo',
      },
      {
        kind: 'added',
        description: 'Trazabilidad en tiempo real de ejecución del operador y handoff inteligente de terminales para Zed',
      },
      {
        kind: 'added',
        description: 'Detección de disponibilidad del terminal antes de despachar el proyectil de prompt',
      },
      {
        kind: 'fixed',
        description: 'Eliminación de ghosting de texto y sincronización geométrica de ConPTY en el terminal',
      },
      {
        kind: 'fixed',
        description: 'Renderizado continuo de filas y eliminación de huecos en arte ASCII y caracteres de bloque',
      },
      {
        kind: 'fixed',
        description: 'Prevención de congelamiento de texto residual al restaurar el buffer alternativo de pantalla',
      },
      {
        kind: 'fixed',
        description: 'Normalización de codificación de consola para agentes en terminales Windows',
      },
      {
        kind: 'changed',
        description: 'Consolidación y rediseño unificado de pestañas de configuración y cuentas',
      },
      {
        kind: 'changed',
        description: 'Indicador activo optimizado para la lista de workspaces y limpieza del panel lateral',
      },
    ],
  },
  {
    version: '0.1.39',
    tag: 'v0.1.39',
    date: 'Oct 27, 2026',
    title: 'Voz Hiperrealista ElevenLabs para Zed, Composer Moderno y Control de Razonamiento',
    items: [
      {
        kind: 'added',
        description: 'Integración de ElevenLabs Streaming TTS para el asistente Zed con soporte v4 turbo y fallback nativo',
      },
      {
        kind: 'added',
        description: 'Selector y control de esfuerzo de razonamiento dinámico por modelo en el composer',
      },
      {
        kind: 'added',
        description: 'Configuración de voces curadas y personalizadas en Ajustes > Voz y Zed',
      },
      {
        kind: 'added',
        description: 'Sistema integrado de notificaciones toast flotantes con Sileo',
      },
      {
        kind: 'added',
        description: 'Telemetría de sistema con desglose granular de subprocesos y memoria privada',
      },
      {
        kind: 'fixed',
        description: 'Sincronización de repositorios y ramas Git entre vistas de Agente e Hilos sin desfase',
      },
      {
        kind: 'fixed',
        description: 'Posicionamiento anclado mediante portales y scroll optimizado en selectores de modelos',
      },
    ],
  },
  {
    version: '0.1.38',
    tag: 'v0.1.38',
    date: 'Oct 25, 2026',
    title: 'Gestión de Ramas Git en Hilos, Selector de Workspace y Optimización del Chat',
    items: [
      {
        kind: 'added',
        description: 'Selector interactivo de ramas Git con búsqueda y creación instantánea de nuevas ramas',
      },
      {
        kind: 'added',
        description: 'Selector desplegable de proyecto (workspace) en la cabecera para reasignar hilos de trabajo',
      },
      {
        kind: 'changed',
        description: 'Edición y guardado in-place del título del chat mediante clic directo',
      },
      {
        kind: 'changed',
        description: 'Reemplazo del icono de nuevo chat por un icono de suma intuitivo',
      },
      {
        kind: 'fixed',
        description: 'Eliminación del panel lateral ThreadInspector y simplificación del frame de chat',
      },
    ],
  },
  {
    version: '0.1.37',
    tag: 'v0.1.37',
    date: 'Oct 25, 2026',
    title: 'Conmutación Asíncrona de Cuentas, Restauración de Sesiones y Estabilidad de Terminal',
    items: [
      {
        kind: 'added',
        description: 'Conmutador desplegable flotante de cuentas superpuesto en el popover de Cuotas',
      },
      {
        kind: 'added',
        description: 'Restauración automática de la conversación y sesión activa de AntiGravity al reiniciar o cambiar de cuenta',
      },
      {
        kind: 'fixed',
        description: 'Eliminación del congelamiento de la interfaz durante el cambio de cuenta con ejecución asíncrona',
      },
      {
        kind: 'fixed',
        description: 'Corrección de caracteres fantasma y artefactos en la terminal reseteando el estado ANSI al reconectar',
      },
      {
        kind: 'fixed',
        description: 'Corrección del bloqueo de dimensiones de la terminal en 80 columnas sincronizando tamaño real de filas y columnas',
      },
      {
        kind: 'changed',
        description: 'Optimización del apagado y reinicio de agentes reduciendo latencia y timeouts',
      },
    ],
  },
  {
    version: '0.1.36',
    tag: 'v0.1.36',
    date: 'Oct 25, 2026',
    title: 'Consolidacion de Sistema de Diseno y Pestanas Dinamicas',
    items: [
      {
        kind: 'added',
        description: 'Sistema unificado de border-radius y tokens semánticos en visual-language y Tailwind',
      },
      {
        kind: 'changed',
        description: 'Estandarización de alturas y controles en paneles laterales a 32px y 28px',
      },
      {
        kind: 'added',
        description: 'Pestañas Prompts y Tasks configurables y cerrables a demanda en RightDock',
      },
      {
        kind: 'fixed',
        description: 'Rediseño visual del botón Commit en DiffsView alineado con el tema principal',
      },
      {
        kind: 'changed',
        description: 'Integración de directrices estrictas de diseño y arquitectura en AGENTS.md',
      },
    ],
  },
  {
    version: '0.1.35',
    tag: 'v0.1.35',
    date: 'Oct 25, 2026',
    title: 'Restauracion de ZedOrb WebGL2 y Fluidez en Barra de Tareas',
    items: [
      {
        kind: 'changed',
        description: 'feat(zed): Restaurar el renderizador WebGL2 de ZedOrb con optimizacion inteligente de tasa de cuadros y pausa en minimizado',
      },
      {
        kind: 'changed',
        description: 'perf(taskbar): Eliminar mas de 110,000 escrituras sincronas en app.log durante eventos de ventana y restauracion',
      },
      {
        kind: 'changed',
        description: 'perf(titlebar): Restaurar mini-orbe ligero acelerado por GPU eliminando animaciones CSS continuas y capas SVG pesadas',
      },
      {
        kind: 'changed',
        description: 'perf(focus): Debounce en refreshGit (1.2s), metricas de sistema (2s) y cuotas (2.5s) al reactivar o enfocar la aplicacion',
      },
      {
        kind: 'changed',
        description: 'perf(terminal): Cachear sesiones de proveedor ya vinculadas evitando re-resolucion innecesaria',
      },
    ],
  },
  {
    version: '0.1.34',
    tag: 'v0.1.34',
    date: 'Oct 25, 2026',
    title: 'Eliminacion de Bucles de E/S y Bloqueos de Arranque',
    items: [
      {
        kind: 'fixed',
        description: 'Eliminar escaneo periodico de 70MB de transcripciones y contencion en terminal.rs',
      },
      {
        kind: 'fixed',
        description: 'Desactivar llamadas bloqueantes a Windows Restart Manager (rstrtmgr.dll) en resolucion de sesiones',
      },
      {
        kind: 'changed',
        description: 'perf: Reemplazar raymarching WebGL2 continuo en ZedOrb por esfera CSS acelerada por hardware',
      },
      {
        kind: 'changed',
        description: 'perf: Reducir polling IPC inactivo de terminal de 90ms a 220ms conservando 40ms en escritura',
      },
      {
        kind: 'changed',
        description: 'perf: Acelerar animacion de mini-orbe en barra de titulo con capas de composicion GPU',
      },
    ],
  },
  {
    version: '0.1.33',
    tag: 'v0.1.33',
    date: 'Oct 25, 2026',
    title: 'Estabilización y Rendimiento de Arranque',
    items: [
      {
        kind: 'fixed',
        description: 'Eliminar shaders WebGL (ReadPixels) y loops de canvas raymarching en vistas de produccion para evitar bloqueos',
      },
      {
        kind: 'fixed',
        description: 'Resolver contencion en el bucle principal de WebView2 y limpiar procesos huerfanos al iniciar',
      },
      {
        kind: 'fixed',
        description: 'Optimizar animaciones de la orbe Zed en la barra de titulo con degradados acelerados por hardware',
      },
      {
        kind: 'changed',
        description: 'Mejorar el lanzador de escritorio limpiando procesos residuales y liberando candados de EBWebView',
      },
      {
        kind: 'changed',
        description: 'Sincronizar catalogo de modelos de Grok y Cursor con sus respectivas CLIs',
      },
    ],
  },
  {
    version: '0.1.32',
    tag: 'v0.1.32',
    date: 'Oct 24, 2026',
    title: 'Gobernanza de Plugins y Asignación de Motores de IA',
    items: [
      {
        kind: 'added',
        description: 'Selector interactivo de proveedores para motores de IA',
      },
      {
        kind: 'added',
        description: 'Asignación granular por agente con switches sincronizados',
      },
      {
        kind: 'fixed',
        description: 'Validación estricta de credenciales en plugins antes de conectar',
      },
      {
        kind: 'changed',
        description: 'Modal rediseñado con componente Sheet nativo y tokens de diseño',
      },
    ],
  },
  {
    version: '0.1.31',
    tag: 'v0.1.31',
    date: 'Oct 24, 2026',
    title: 'Validación de Credenciales y Selección de Proveedores en Plugins',
    items: [
      {
        kind: 'added',
        description: 'Modal de detalles con Sheet oficial y pestañas para Configuración, Proveedores de IA y Agentes',
      },
      {
        kind: 'added',
        description: 'Selector interactivo de proveedores para habilitar/deshabilitar plugins por motor de IA (Claude, Codex, Antigravity, OpenCode, Cursor, Gemini, Grok)',
      },
      {
        kind: 'added',
        description: 'Asignación granular por agente con switches individuales y sincronización con perfiles',
      },
      {
        kind: 'changed',
        description: 'Reemplazo completo de modales flotantes por el componente Sheet nativo con tokens de diseño auténticos',
      },
      {
        kind: 'fixed',
        description: 'Validación estricta de credenciales en plugins antes de conectar, previniendo falsos estados activos',
      },
    ],
  },
  {
    version: '0.1.30',
    tag: 'v0.1.30',
    date: 'Oct 24, 2026',
    title: 'Refinamiento de UI y Proveedores en Plugins',
    items: [
      {
        kind: 'added',
        description: 'Visualización de proveedores y motores compatibles (Claude Code, Codex, Antigravity, OpenCode, Cursor, Gemini) en el modal de detalles',
      },
      {
        kind: 'changed',
        description: 'Diseño minimalista y limpio en las tarjetas del catálogo de Plugins',
      },
      {
        kind: 'changed',
        description: 'Enrutamiento de gobernanza de plugins directamente a la pestaña Ajustes de cada agente',
      },
      {
        kind: 'fixed',
        description: 'Eliminación de elementos visuales saturados en las tarjetas del catálogo',
      },
    ],
  },
  {
    version: '0.1.29',
    tag: 'v0.1.29',
    date: 'Oct 24, 2026',
    title: 'Ecosistema de Plugins y Cobertura de Agentes',
    items: [
      {
        kind: 'added',
        description: 'Catálogo canónico de 29 plugins para servicios externos y herramientas de agentes',
      },
      {
        kind: 'added',
        description: 'Modal interactivo de configuración de credenciales (API keys / puertos MCP) y permisos por plugin',
      },
      {
        kind: 'added',
        description: 'Cobertura bidireccional de agentes con gobernanza granular de plugins',
      },
      {
        kind: 'added',
        description: 'Pila compacta de mini-avatares en tarjetas conectadas mostrando los agentes activos',
      },
      {
        kind: 'added',
        description: 'Sincronización en segundo plano cada 2000ms con detección de foco',
      },
      {
        kind: 'changed',
        description: 'Integración automática de plugins conectados en el catálogo MCP de Agent Settings',
      },
      {
        kind: 'fixed',
        description: 'Control de acceso en modo sólo lectura para herramientas con mutaciones',
      },
    ],
  },
  {
    version: '0.1.28',
    tag: 'v0.1.28',
    date: 'Oct 24, 2026',
    title: 'Laboratorio de Animaciones y Ajustes Visuales',
    items: [
      {
        kind: 'added',
        description: 'Laboratorio interactivo de efectos visuales y motion en el puerto 1430',
      },
      {
        kind: 'changed',
        description: 'Preservacion de la interfaz nativa y personalizacion del chat composer',
      },
      {
        kind: 'changed',
        description: 'Sincronizacion de metricas de telemetria y cuotas en la barra superior',
      },
      {
        kind: 'fixed',
        description: 'Estabilizacion de dependencias WebGL y eliminacion de img-fx',
      },
    ],
  },
];
