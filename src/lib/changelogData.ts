export type ReleaseCategory = 'added' | 'changed' | 'fixed' | 'security';

export interface RawReleaseItem {
  kind: ReleaseCategory;
  description: string;
}

export interface ReleaseItem {
  kind: ReleaseCategory;
  category: ReleaseCategory;
  description: string;
  text: string;
}

export interface ReleaseNote {
  version: string;
  tag: string;
  date: string;
  title?: string;
  isCurrent?: boolean;
  isIncoming?: boolean;
  items: ReleaseItem[];
}

export interface RawReleaseNote {
  version: string;
  tag: string;
  date: string;
  title?: string;
  items: RawReleaseItem[];
}

/** Official historical and current releases for Kite Code Desktop */
export const KITE_RELEASES: RawReleaseNote[] = [
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
  {
    version: '0.1.26',
    tag: 'v0.1.26',
    date: 'Oct 22, 2026',
    title: 'Cuotas a tu medida: agregá, ordená y fijá proveedores',
    items: [
      {
        kind: 'added',
        description: 'Agregá proveedores de cuotas manualmente desde Configuración → Cuotas',
      },
      {
        kind: 'changed',
        description: 'Todos los proveedores arrancan deshabilitados; solo se monitorean los que agregues',
      },
      {
        kind: 'fixed',
        description: 'La pastilla de cuotas sigue visible aunque no tengas proveedores agregados',
      },
      {
        kind: 'changed',
        description: 'La barra superior muestra solo el icono y el porcentaje, sin tiempo de reseteo',
      },
      {
        kind: 'added',
        description: 'Reordená proveedores con flechas y fijá cuál se muestra en la barra',
      },
      {
        kind: 'fixed',
        description: 'Navegación con flechas y rueda en el popover cuando hay más de tres proveedores',
      },
      {
        kind: 'changed',
        description: 'La primera actualización reinicia la lista de proveedores monitoreados; tus claves y sesiones se conservan',
      },
    ],
  },
  {
    version: '0.1.25',
    tag: 'v0.1.25',
    date: 'Oct 22, 2026',
    title: 'OpenCode Go sincroniza su cuota real',
    items: [
      {
        kind: 'added',
        description: 'Detección automática de credenciales desde OpenCode (opencode.db y auth.json), OPENCODE_API_KEY y la configuración de OpenCode.',
      },
      {
        kind: 'added',
        description: 'Diagnóstico visible con fuente de credencial, endpoint, estado HTTP y errores por ventana.',
      },
      {
        kind: 'changed',
        description: 'La configuración de OpenCode Go usa una API key opcional y deja de pedir la cookie y el workspace legacy.',
      },
      {
        kind: 'fixed',
        description: 'OpenCode Go consulta la API oficial de uso y muestra las ventanas de 5 horas, semanal y mensual en lugar de un 0% fijo.',
      },
    ],
  },
  {
    version: '0.1.24',
    tag: 'v0.1.24',
    date: 'Oct 22, 2026',
    title: 'Soporte oficial para Gentle Shell',
    items: [
      {
        kind: 'added',
        description: 'Integración oficial de Gentle Shell en el catálogo de agentes y nueva sesión',
      },
      {
        kind: 'fixed',
        description: 'Soporte para scroll nativo fluido en terminales de Gentle Shell evitando bloqueo de pantalla alterna',
      },
      {
        kind: 'added',
        description: 'Detección y ciclo de vida de procesos de Gentle Shell en el backend',
      },
    ],
  },
  {
    version: '0.1.23',
    tag: 'v0.1.23',
    date: 'Oct 20, 2026',
    title: 'Zed suelta el microfono y devuelve el volumen',
    items: [
      {
        kind: 'fixed',
        description: 'Pedir qué hay en una terminal ahora la narra, y si está vacía dice que no hay nada, en lugar de inyectar un comando.',
      },
      {
        kind: 'fixed',
        description: 'Después de una orden, un toque en Zed vuelve a abrir el micrófono y la siguiente instrucción no se pierde.',
      },
      {
        kind: 'fixed',
        description: 'Si el micrófono está ocupado, Zed suelta su propia captura y lo explica en español.',
      },
      {
        kind: 'fixed',
        description: 'El volumen de las otras apps vuelve al cerrar o minimizar Zed, si la escucha falla, y al salir de Kite.',
      },
      {
        kind: 'changed',
        description: 'La transcripción ya no depende de una clave escrita en el programa; si falta la de Cloudflare o Grok, Ajustes lo dice.',
      },
    ],
  },
  {
    version: '0.1.22',
    tag: 'v0.1.22',
    date: 'Oct 19, 2026',
    title: 'Supresion de demonios huerfanos de Antigravity y aislamiento de procesos',
    items: [
      {
        kind: 'fixed',
        description: 'Inyección estricta de AGY_CLI_DISABLE_AUTO_UPDATE=true en Rust (main, quota, chat, terminal, hidden_exec) para suprimir el demonio en segundo plano de agy.',
      },
      {
        kind: 'fixed',
        description: 'Aislamiento total de ventanas de consola en Windows 11 impidiendo la delegación a WindowsTerminal.exe.',
      },
      {
        kind: 'security',
        description: 'Configuración persistente a nivel de usuario en Windows para evitar ejecuciones huérfanas de background updater.',
      },
    ],
  },
  {
    version: '0.1.21',
    tag: 'v0.1.21',
    date: 'Oct 19, 2026',
    title: 'Supresion de consolas en sesiones de agentes y servidores MCP',
    items: [
      {
        kind: 'fixed',
        description: 'Prevención de destellos de terminal en la inicialización de servidores MCP (windowsHide activado).',
      },
      {
        kind: 'fixed',
        description: 'Inyección de AGY_CLI_DISABLE_AUTO_UPDATE=true en terminales y agentes ConPTY para bloquear daemons huérfanos de agy.',
      },
      {
        kind: 'changed',
        description: 'Sanitización de nombres de archivo de sesión en el gestor de portapapeles.',
      },
    ],
  },
  {
    version: '0.1.20',
    tag: 'v0.1.20',
    date: 'Oct 19, 2026',
    title: 'Eliminacion definitiva de delegacion de Windows Terminal con CREATE_NO_WINDOW',
    items: [
      {
        kind: 'fixed',
        description: 'Reemplazo definitivo de CREATE_NEW_CONSOLE por CREATE_NO_WINDOW en hidden_exec para impedir la delegación a Windows Terminal en Windows 11',
      },
      {
        kind: 'fixed',
        description: 'Aislamiento completo de procesos en segundo plano para consultas de cuotas de Antigravity y servidores MCP',
      },
      {
        kind: 'changed',
        description: 'Supresión de asignación de consolas en la ejecución oculta de subprocesos y herramientas CLI',
      },
    ],
  },
  {
    version: '0.1.19',
    tag: 'v0.1.19',
    date: 'Oct 18, 2026',
    title: 'Corrección de congelamiento en terminales y respuesta interactiva instantánea',
    items: [
      {
        kind: 'fixed',
        description: 'Elimina el bloqueo asíncrono en enqueueWrite que dejaba las terminales oscuras y no responsivas',
      },
    ],
  },
  {
    version: '0.1.18',
    tag: 'v0.1.18',
    date: 'Oct 18, 2026',
    title: 'Optimizaciones de Rendimiento y Prevencion de Congelamiento',
    items: [
      {
        kind: 'fixed',
        description: 'Prevenir congelamiento de UI tras periodos en segundo plano con banderas anti-suspension en WebView2',
      },
      {
        kind: 'fixed',
        description: 'Eliminar escritura sincrona a app.log en el bucle principal de eventos (MainEventsCleared)',
      },
      {
        kind: 'changed',
        description: 'Polling adaptativo en terminales integradas con reduccion del 75% en reposo y 95% en segundo plano',
      },
      {
        kind: 'changed',
        description: 'Pausa automatica en el muestreo de procesos del sistema cuando la ventana esta oculta',
      },
      {
        kind: 'changed',
        description: 'Debounce de 2.5s en comprobador de actualizaciones al recuperar foco de la ventana',
      },
    ],
  },
  {
    version: '0.1.17',
    tag: 'v0.1.17',
    date: 'Oct 18, 2026',
    title: 'Eliminacion de ventanas emergentes de consola y optimizacion en segundo plano',
    items: [
      {
        kind: 'fixed',
        description: 'Eliminación de ventanas emergentes de PowerShell y Windows Terminal al consultar cuotas de Antigravity',
      },
      {
        kind: 'fixed',
        description: 'Aislamiento estricto de procesos en segundo plano con flags CREATE_NO_WINDOW y CREATE_NEW_CONSOLE en hidden_exec',
      },
      {
        kind: 'fixed',
        description: 'Prevención de apertura de consolas al consultar modelos CLI de Antigravity',
      },
      {
        kind: 'added',
        description: 'Refinamiento de la barra de control de asistencia ZedStrip y renderizado suave de ZedOrb',
      },
      {
        kind: 'changed',
        description: 'Optimización del tiempo de respuesta en la comprobación periódica de cuotas de Antigravity',
      },
    ],
  },
  {
    version: '0.1.16',
    tag: 'v0.1.16',
    date: 'Oct 18, 2026',
    title: 'Estabilidad de doble instancia y optimización del Asistente',
    items: [
      {
        kind: 'fixed',
        description: 'Aislamiento completo de carpetas WebView2 entre desarrollo e instalada para evitar bloqueos y congelamientos',
      },
      {
        kind: 'fixed',
        description: 'Asistente Zed cerrado por defecto al abrir la aplicación sin píldora flotante automática',
      },
      {
        kind: 'fixed',
        description: 'Corrección en el script de desarrollo para preservar el bloqueo de la aplicación de producción',
      },
      {
        kind: 'changed',
        description: 'Optimización del renderizado de la esfera ZedOrb evitando WebGL en orbes pequeños y manteniendo animación suave continua',
      },
    ],
  },
  {
    version: '0.1.15',
    tag: 'v0.1.15',
    date: 'Oct 18, 2026',
    title: 'Zed Operator & Floating Orb Assistant',
    items: [
      {
        kind: 'added',
        description: 'Floating Zed Orb and interactive assistant with organic fluid animations and drag controls.',
      },
      {
        kind: 'added',
        description: 'Operator Runtime protocol with autonomous subagent dispatcher and task runner.',
      },
      {
        kind: 'added',
        description: 'Settings Zed tab for operator configuration, Grok cloud transcription, and speech toggles.',
      },
      {
        kind: 'changed',
        description: 'ConPTY terminal paste handler with bracketed paste mode and multiline sanitization.',
      },
      {
        kind: 'fixed',
        description: 'Stabilized background thread synchronization for IPC command channels.',
      },
    ],
  },
  {
    version: '0.1.14',
    tag: 'v0.1.14',
    date: 'Oct 17, 2026',
    title: 'ConPTY Terminal Resilience & Launch Automation',
    items: [
      {
        kind: 'added',
        description: 'Windows ConPTY terminal keepalive daemon and auto-reconnection on window resize.',
      },
      {
        kind: 'added',
        description: 'Standalone PowerShell desktop launch script (scripts/launch-desktop-app.ps1).',
      },
      {
        kind: 'changed',
        description: 'Pruned legacy release artifacts and build cache to optimize installer packaging.',
      },
      {
        kind: 'fixed',
        description: 'Fixed terminal cursor drift and background flicker during heavy process execution.',
      },
    ],
  },
  {
    version: '0.1.13',
    tag: 'v0.1.13',
    date: 'Oct 16, 2026',
    title: 'System Telemetry & Updater Daemon',
    items: [
      {
        kind: 'added',
        description: 'Hardware telemetry monitoring CPU, memory, and disk usage with real-time HUD badge.',
      },
      {
        kind: 'added',
        description: 'Auto-healing background feed server daemon (scripts/feed-server.mjs) on port 9101.',
      },
      {
        kind: 'changed',
        description: 'One-command atomic release pipeline (scripts/release.mjs) with NSIS bundling and Minisign verification.',
      },
      {
        kind: 'fixed',
        description: 'Eliminated feed server port collision and zombie child process leaks.',
      },
    ],
  },
  {
    version: '0.1.12',
    tag: 'v0.1.12',
    date: 'Oct 16, 2026',
    title: 'Agent Memory Mind & Local Autopilot',
    items: [
      {
        kind: 'added',
        description: 'Persistent SQLite memory engine (agent_mind.rs) for long-term agent contextual memory.',
      },
      {
        kind: 'added',
        description: 'Autonomous local autopilot execution loop with step-by-step goal verification.',
      },
      {
        kind: 'changed',
        description: 'Configurable agent memory budgets and note caps in Agent Settings.',
      },
      {
        kind: 'fixed',
        description: 'Memory leak during repeated subagent task state serialization.',
      },
    ],
  },
  {
    version: '0.1.11',
    tag: 'v0.1.11',
    date: 'Oct 16, 2026',
    title: 'Unified Navigation & App Capabilities',
    items: [
      {
        kind: 'added',
        description: 'Unified sidebar navigation with dedicated views for Agents, Workspaces, Chat, and Settings.',
      },
      {
        kind: 'added',
        description: 'Custom modal system (What\'s New modal, Launch Preset modal, Keyboard Shortcuts).',
      },
      {
        kind: 'changed',
        description: 'Responsive view docking and collapsible rail navigation.',
      },
      {
        kind: 'security',
        description: 'Sanitized IPC layer and sandboxed WebView2 execution bounds.',
      },
    ],
  },
  {
    version: '0.1.10',
    tag: 'v0.1.10',
    date: 'Oct 16, 2026',
    title: 'Accounts Vault & Quota Telemetry',
    items: [
      {
        kind: 'added',
        description: 'Multi-account switcher with secure local token storage for AI providers.',
      },
      {
        kind: 'added',
        description: 'Live subscription quota monitor and token usage telemetry graphs.',
      },
      {
        kind: 'fixed',
        description: 'Token refresh race condition during simultaneous agent requests.',
      },
    ],
  },
  {
    version: '0.1.9',
    tag: 'v0.1.9',
    date: 'Oct 15, 2026',
    title: 'Tickets Management & MCP Integration',
    items: [
      {
        kind: 'added',
        description: 'Native ticket management board and task dispatcher for autonomous coding runs.',
      },
      {
        kind: 'added',
        description: 'Model Context Protocol (MCP) server configuration manager and tool discovery.',
      },
      {
        kind: 'changed',
        description: 'Real-time ticket status updates synchronized with background agent actions.',
      },
    ],
  },
  {
    version: '0.1.8',
    tag: 'v0.1.8',
    date: 'Oct 15, 2026',
    title: 'Agent Roster & Autonomous Routine Engine',
    items: [
      {
        kind: 'added',
        description: 'Multi-agent roster supporting customized system prompts, engine selection, and role specializations.',
      },
      {
        kind: 'added',
        description: 'Background routine scheduler with interval and event-based triggers.',
      },
      {
        kind: 'fixed',
        description: 'Process cleanup on routine cancellation or engine timeout.',
      },
    ],
  },
  {
    version: '0.1.7',
    tag: 'v0.1.7',
    date: 'Oct 15, 2026',
    title: 'Workspaces & Live Files Explorer',
    items: [
      {
        kind: 'added',
        description: 'Native workspace filesystem explorer with recursive tree navigation and file search.',
      },
      {
        kind: 'added',
        description: 'Integrated code editor with markdown preview and diff visualization.',
      },
      {
        kind: 'changed',
        description: 'File watcher performance optimized with debounce and gitignore filtering.',
      },
    ],
  },
  {
    version: '0.1.6',
    tag: 'v0.1.6',
    date: 'Oct 15, 2026',
    title: 'Streaming ACP Protocol & Approval Handling',
    items: [
      {
        kind: 'added',
        description: 'Streaming Agent Communication Protocol (ACP) for low-latency token and tool output.',
      },
      {
        kind: 'added',
        description: 'Human-in-the-loop tool execution approval prompts with inline diff reviews.',
      },
      {
        kind: 'changed',
        description: 'Enhanced chat composer with multiline expansion and command palette autocomplete.',
      },
      {
        kind: 'security',
        description: 'Strict path traversal guards and execution approval enforcement.',
      },
    ],
  },
  {
    version: '0.1.5',
    tag: 'v0.1.5',
    date: 'Oct 16, 2026',
    title: 'Dynamic Versioning & Interactive Changelog',
    items: [
      {
        kind: 'added',
        description: 'Dynamic version synchronization across all Settings tabs (General, About, Changelog, Footer).',
      },
      {
        kind: 'added',
        description: 'Interactive Changelog view displaying complete release history with incoming update previews.',
      },
      {
        kind: 'fixed',
        description: 'Eliminated hardcoded legacy version numbers from GeneralTab, ChangelogTab, and modals.',
      },
      {
        kind: 'changed',
        description: 'Synchronized What\'s New modal directly with Kite Code release ledger.',
      },
    ],
  },
  {
    version: '0.1.4',
    tag: 'v0.1.4',
    date: 'Oct 16, 2026',
    title: 'Reactive Updater & Vector Branding',
    items: [
      {
        kind: 'added',
        description: 'Reactive updater singleton store synchronizing Sidebar, Circular indicator, and Settings in real time.',
      },
      {
        kind: 'added',
        description: 'Auto-healing feed server: background daemon automatically starts on update requests.',
      },
      {
        kind: 'changed',
        description: 'Replaced raster TitleBar logo with 100% crisp vector SVG full-bleed icon.',
      },
      {
        kind: 'fixed',
        description: 'Transparent update diagnostics: displays connection errors with one-click retry.',
      },
      {
        kind: 'fixed',
        description: 'Persistent feed directory configured to prevent build tools from clearing release artifacts.',
      },
    ],
  },
  {
    version: '0.1.3',
    tag: 'v0.1.3',
    date: 'Oct 16, 2026',
    title: 'Crisp Terminal Mark & Download Optimization',
    items: [
      {
        kind: 'changed',
        description: 'Redesigned terminal monogram mark with high-contrast chevron and terminal cursor.',
      },
      {
        kind: 'fixed',
        description: 'Enabled HTTP Content-Length headers for exact update download percentage calculation.',
      },
      {
        kind: 'fixed',
        description: 'Streamlined HEAD and OPTIONS request handling across local feed endpoints.',
      },
    ],
  },
  {
    version: '0.1.2',
    tag: 'v0.1.2',
    date: 'Oct 16, 2026',
    title: 'Kite Code Brand Identity & Sanitization',
    items: [
      {
        kind: 'added',
        description: 'Brand identity: Kite Code with custom deep-sapphire and cyan identity.',
      },
      {
        kind: 'added',
        description: 'Air-gapped offline runtime and sanitized local persistent storage.',
      },
      {
        kind: 'changed',
        description: 'Interactive TitleBar with dedicated Agent, Code, and Thread mode switchers.',
      },
    ],
  },
  {
    version: '0.1.1',
    tag: 'v0.1.1',
    date: 'Oct 15, 2026',
    title: 'ConPTY Terminal & Multi-Agent Orchestration',
    items: [
      {
        kind: 'added',
        description: 'Native ConPTY Windows terminal daemon with hardware-accelerated rendering and automatic resizing.',
      },
      {
        kind: 'added',
        description: 'Multi-agent orchestration supporting local models and cloud providers in parallel.',
      },
      {
        kind: 'fixed',
        description: 'Eliminated terminal window flickering during background quota and process probing.',
      },
    ],
  },
  {
    version: '0.1.0',
    tag: 'v0.1.0',
    date: 'Oct 15, 2026',
    title: 'Initial Autonomous Desktop Release',
    items: [
      {
        kind: 'added',
        description: 'Embedded WebView2 browser surface with bounded layout preservation.',
      },
      {
        kind: 'added',
        description: 'Local Token and Subscription quota telemetry.',
      },
      {
        kind: 'security',
        description: 'Strict process isolation and secure minisign signature verification for updates.',
      },
    ],
  },
];

/**
 * Normalizes release notes with current version tagging and incoming update preview.
 */
export function getReleases(
  currentVersion: string,
  updateInfo?: { available?: boolean; version?: string | null; notes?: string | null } | null
): ReleaseNote[] {
  const normCurrent = currentVersion.replace(/^v/, '').trim();
  const list: ReleaseNote[] = KITE_RELEASES.map((rel) => ({
    ...rel,
    isCurrent: rel.version === normCurrent,
    items: rel.items.map((it) => ({
      ...it,
      category: it.kind,
      text: it.description,
    })),
  }));

  // If there's an available update not yet in the static list, prepend it dynamically!
  if (updateInfo?.available && updateInfo.version) {
    const incomingVer = updateInfo.version.replace(/^v/, '').trim();
    const alreadyPresent = list.some((r) => r.version === incomingVer);
    if (!alreadyPresent) {
      const dynamicItems: ReleaseItem[] = updateInfo.notes
        ? updateInfo.notes
            .split('\n')
            .map((line) => line.trim().replace(/^[-*•]\s*/, ''))
            .filter(Boolean)
            .map((desc) => {
              const lower = desc.toLowerCase();
              const kind: ReleaseCategory = lower.startsWith('fix')
                ? 'fixed'
                : lower.startsWith('sec')
                ? 'security'
                : lower.startsWith('add') || lower.startsWith('feat')
                ? 'added'
                : 'changed';
              return { kind, category: kind, description: desc, text: desc };
            })
        : [
            {
              kind: 'added',
              category: 'added',
              description: `Actualización oficial Kite Code v${incomingVer} lista para instalar.`,
              text: `Actualización oficial Kite Code v${incomingVer} lista para instalar.`,
            },
          ];

      list.unshift({
        version: incomingVer,
        tag: `v${incomingVer}`,
        date: 'Próxima actualización',
        title: `Versión ${incomingVer} (Disponible)`,
        isCurrent: false,
        isIncoming: true,
        items: dynamicItems,
      });
    }
  }

  return list;
}
