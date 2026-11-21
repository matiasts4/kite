import type {
  ReleaseCategory,
  RawReleaseItem,
  ReleaseItem,
  ReleaseNote,
  RawReleaseNote,
} from './changelog/types';
import { RELEASES_RECENT } from './changelog/releasesRecent';
import { RELEASES_EARLY } from './changelog/releasesEarly';

export type {
  ReleaseCategory,
  RawReleaseItem,
  ReleaseItem,
  ReleaseNote,
  RawReleaseNote,
};

/** Official historical and current releases for Kite Code Desktop */
export const KITE_RELEASES: RawReleaseNote[] = [
  {
    version: '0.1.78',
    tag: 'v0.1.78',
    date: 'Nov 21, 2026',
    title: 'SETH orquestador conversacional con retorno de subagentes y captura VAD sin silencio',
    items: [
      {
        kind: 'added',
        description: 'Orquestador conversacional SETH con hilo de voz anclado y subagentes exploradores en solo lectura (explore vs odd/execute), reservando launch_thread para pedidos explicitos de hilo aparte.',
      },
      {
        kind: 'added',
        description: 'Lazo cerrado de retorno de subagentes (subagentReturnWatcher): al terminar un subagente hijo lee su salida real via dispatch_read, guarda hallazgos y los narra por voz respetando VoiceTurnArbitrator y barge-in.',
      },
      {
        kind: 'added',
        description: 'Memoria viva rodante de sesion larga (WorkingContext) por hilo de voz con tema actual, decisiones acordadas, hallazgos de subagentes y compactacion automatica de turnos antiguos mas alla de la ventana de 8 turnos.',
      },
      {
        kind: 'added',
        description: 'Lectura real de resultados de subagentes e hilos en narrate_summary (incluyendo consultas como "como va el subagente" o "que encontro el explorador") y hallazgos visibles en el roster del proyecto.',
      },
      {
        kind: 'fixed',
        description: 'Compuerta de captura PCM por VAD en modo de voz continuo con pre-roll de 400 ms y recorte de silencio final a 250 ms para evitar acumular silencio en RAM y facturar tiempo vacio en STT.',
      },
    ],
  },
  {
    version: '0.1.77',
    tag: 'v0.1.77',
    date: 'Nov 21, 2026',
    title: 'Nuevos fondos cosmicos de escenario y mejora de Aurora Boreal',
    items: [
      {
        kind: 'added',
        description: 'Nuevos fondos de escenario cosmicos: Horizonte de Eventos (agujero negro con disco de acrecion luminoso) y Claro de Luna (luna sobre oceano nocturno estrellado).',
      },
      {
        kind: 'changed',
        description: 'Renovado el fondo Aurora Boreal con cintas organicas luminosas sobre fiordo nordico reflejado en el agua.',
      },
      {
        kind: 'fixed',
        description: 'Permitida la invocacion directa del generador de imagenes integrado en Thread Mode dentro del hook de subagentes.',
      },
    ],
  },
  {
    version: '0.1.76',
    tag: 'v0.1.76',
    date: 'Nov 20, 2026',
    title: 'Modo de voz SETH: barge-in real, streaming de baja latencia e inteligencia contextual',
    items: [
      {
        kind: 'added',
        description: 'Barge-in acustico real durante la narracion TTS con captura AudioWorklet persistente, buffer pre-roll de 400 ms, VAD adaptativo por piso de ruido y arbitraje de turnos sin solapamientos ni reinicios cada 8 segundos.',
      },
      {
        kind: 'added',
        description: 'Streaming HTTP nativo en Rust con cliente pooled keep-alive (proxy_operator_http_stream), streaming LLM a TTS por oraciones en turnos conversacionales y telemetria completa de latencia de voz (vad, stt, llm.first_token, tts.first_audio).',
      },
      {
        kind: 'added',
        description: 'Conciencia estricta del workspace activo (terminales, hilos, subagentes y agentes autonomos sin fugas entre proyectos), memoria episodica persistente por workspace y recuperacion temporal para consultas entre sesiones.',
      },
      {
        kind: 'added',
        description: 'Normalizador fonetico STT en espanol, polaridad mixta por clausula, matriz de superficies hilo/subagente/agente/terminal y desambiguacion activa con maximo una pregunta concreta antes de delegar.',
      },
      {
        kind: 'fixed',
        description: 'Prosodia hablada limpia sin UUIDs, rutas de disco, URLs ni muletillas de plantilla, identidad SETH conectada al planner y preservacion de metricas tokenCounts en trazas y runLedger.',
      },
    ],
  },
  {
    version: '0.1.75',
    tag: 'v0.1.75',
    date: 'Nov 20, 2026',
    title: 'Envio instantaneo en Voice Mode, soporte en Agentes y sesion fijada al hilo',
    items: [
      {
        kind: 'fixed',
        description: 'En Voice Mode, el mensaje hablado aparece al instante como burbuja del usuario y limpia el cuadro de texto mientras el asistente piensa, evitando que parezca congelado durante respuestas largas.',
      },
      {
        kind: 'fixed',
        description: 'Fijado el hilo destino y el modo thread antes de invocar al planner para que las respuestas nunca se descarten si cambia la vista o se finaliza la sesion en curso.',
      },
      {
        kind: 'fixed',
        description: 'Soporte completo de turnos de voz, estado en vivo y envio hibrido en AgentChatShell (modo Agentes), y tecla Escape acotada solo al orbe flotante visible para no cerrar Voice Mode en hilos.',
      },
    ],
  },
  {
    version: '0.1.74',
    tag: 'v0.1.74',
    date: 'Nov 20, 2026',
    title: 'Estabilidad de Voice Mode, resumen hablado completo y delegacion ODD-first',
    items: [
      {
        kind: 'added',
        description: 'Orquestacion conversacional en Voice Mode con memoria por hilo y delegacion ODD-first a hilos, subagentes reales (dispatch_run) y agentes autonomos con recibos clicables en la conversacion.',
      },
      {
        kind: 'changed',
        description: 'Resumenes hablados concisos separados de los recibos tecnicos detallados, presupuesto del planner ampliado a 1400 tokens y recorte de resumenes en limites de oracion.',
      },
      {
        kind: 'fixed',
        description: 'Estabilidad de entrada y ciclo de vida en Voice Mode con corte automatico por silencio basado en energia RMS (VAD), manejo limpio de errores fatales de STT, respeto de microfono silenciado al rearmar, cierre limpio de sesion y eliminacion del orbe WebGL oculto duplicado.',
      },
      {
        kind: 'fixed',
        description: 'Eliminado el corte de narracion por tiempo en sintesis nativa, corregido el fallback automatico de ElevenLabs a voz nativa y resuelto el falso positivo del filtro de eco en respuestas conversacionales.',
      },
    ],
  },
  {
    version: '0.1.73',
    tag: 'v0.1.73',
    date: 'Nov 19, 2026',
    title: 'Refinamiento visual de burbujas, acciones flotantes y densidad glass en Thread',
    items: [
      {
        kind: 'changed',
        description: 'Estilo mate 3D sutil casi solido para burbujas de mensajes del usuario consistente en modo oscuro, claro y glass.',
      },
      {
        kind: 'changed',
        description: 'Mayor densidad glass en el compositor, selector de modelo, tiras de archivos modificados y contexto, y tarjetas de subagentes en chat y RightDock.',
      },
      {
        kind: 'fixed',
        description: 'Reubicacion y placa esmerilada legible para acciones de mensajes del usuario junto con menu popover vertical estructurado para Edit from here.',
      },
    ],
  },
  {
    version: '0.1.72',
    tag: 'v0.1.72',
    date: 'Nov 19, 2026',
    title: 'Indicadores configurables de actividad de agentes y color',
    items: [
      {
        kind: 'added',
        description: 'Indicadores de actividad de agentes seleccionables en Configuracion -> Apariencia con 8 estilos geometricos (Matriz neural, Barras activas, Pulso sereno, Cometa Kite, Grilla 3x3, Pulso en linea, Anillo fluido y Flujo activo) y vista previa compacta en vivo.',
      },
      {
        kind: 'added',
        description: 'Selector de color configurable para el indicador de actividad con sincronizacion automatica al acento del tema, paleta rapida y color hexadecimal personalizado.',
      },
      {
        kind: 'changed',
        description: 'Reemplazo de la orbita anterior por Matriz neural como indicador predeterminado y soporte de animacion reducida en todas las variantes.',
      },
    ],
  },
  {
    version: '0.1.71',
    tag: 'v0.1.71',
    date: 'Nov 19, 2026',
    title: 'Optimizacion de contexto Fase 1: filtros sin fugas y Auto-CCR',
    items: [
      {
        kind: 'added',
        description: 'Techo universal Auto-CCR (16,000 chars) en comandos de kite-ctx que conserva cabecera, errores intermedios, cola y recuperacion <<ccr:HASH>>.',
      },
      {
        kind: 'fixed',
        description: 'Resolucion compartida de subcomandos con flags globales (npx --prefix, npm --prefix, git -C/-c, cargo --manifest-path) y omision de hooks en git -C commit.',
      },
      {
        kind: 'changed',
        description: 'Filtros mejorados para git grep/rg (reparto por archivo + CCR), git diff/show (plegado de lockfiles y stat-first), git status por carpetas y cargo check/build con warnings deduplicados.',
      },
      {
        kind: 'fixed',
        description: 'Descubrimiento de sesiones Antigravity en profundidad 4 con deteccion de reescrituras por hook, y atribucion de agentes en hilos por rol sin exponer titulos de usuario.',
      },
    ],
  },
  {
    version: '0.1.70',
    tag: 'v0.1.70',
    date: 'Nov 19, 2026',
    title: 'Estabilidad de subagentes, streaming fluido y eliminacion de consolas externas',
    items: [
      {
        kind: 'fixed',
        description: 'Eliminacion de ventanas externas de consola en Windows al generar borradores de agentes mediante hidden_exec::run.',
      },
      {
        kind: 'fixed',
        description: 'Limpieza deterministica de arboles de procesos descendientes con Job Objects en hidden_exec::run para evitar procesos huerfanos y bloqueos de pipes.',
      },
      {
        kind: 'fixed',
        description: 'Aislamiento de pruebas unitarias del backend Rust para evitar ejecuciones reales de CLIs externas durante cargo test.',
      },
      {
        kind: 'changed',
        description: 'Streaming de chat mas fluido con coalescencia de deltas a 24 ms, texto suavizado y mejoras en el renderizado del hilo y tarjetas de subagentes.',
      },
      {
        kind: 'fixed',
        description: 'Recuperacion y reconciliacion mas robusta de turnos y subagentes interrumpidos, paginacion completa de eventos y limpieza de estado tras errores.',
      },
    ],
  },
  {
    version: '0.1.69',
    tag: 'v0.1.69',
    date: 'Nov 19, 2026',
    title: 'Optimizacion profunda de memoria RAM, GPU y recursos en reposo',
    items: [
      {
        kind: 'changed',
        description: 'Optimizacion integral de RAM y persistencia SQLite en Rust: eliminacion de duplicacion permanente del estado en memoria, guardado incremental solo de hilos modificados, checkpoint de WAL acotado y lecturas directas en el daemon sin cargar historiales de chat.',
      },
      {
        kind: 'changed',
        description: 'Code-splitting y carga diferida de vistas de diffs, Mermaid, modales frios, monitor de recursos y Zed Strip, con pool unico compartido de workers de diffs, eliminacion de importaciones muertas de xterm y reduccion de iconos estaticos.',
      },
      {
        kind: 'changed',
        description: 'Reduccion de capas GPU y compositor eliminando doble blur en fondos, sustituyendo backdrop-filter permanente en paneles por superficies tintadas, suspendiendo capas de modos inactivos y reemplazando miniaturas pesadas en Personalizaciones.',
      },
      {
        kind: 'changed',
        description: 'Ajuste del pool persistente de sesiones con limite mas acotado, limpieza deterministica de arboles de procesos mediante Job Objects en Windows y limites acotados para historial de eventos y comandos.',
      },
      {
        kind: 'changed',
        description: 'Externalizacion de vistas previas base64 de adjuntos con lectura bajo demanda y cache LRU, limpieza de adjuntos al enviar, resumenes livianos sin items en localStorage y limites LRU en cachés de hilos, archivos y git diffs.',
      },
      {
        kind: 'changed',
        description: 'Optimizacion de memoria en terminal con cache LRU acotada sin clonado por frame de filas sin cambios, scrollback por defecto ajustado y runtime Tokio acotado en el daemon.',
      },
      {
        kind: 'fixed',
        description: 'Eliminacion de ciclos de polling y despertares en reposo en notificaciones, buzon de agentes, ejecuciones activas compartidas, panel derecho oculto, bucle TCP bloqueante de dispatch y planificadores reutilizables de terminal.',
      },
      {
        kind: 'added',
        description: 'Figuras interactivas de 8 modos en WebGL2 para Modo Voz y Asistente Zed con miniaturas PNG pre-renderizadas de bajo consumo.',
      },
    ],
  },
  {
    version: '0.1.68',
    tag: 'v0.1.68',
    date: 'Nov 18, 2026',
    title: 'Plataforma autonoma de agentes, auto-scroll estable y mejoras visuales en Thread',
    items: [
      {
        kind: 'added',
        description: 'Plataforma autonoma de agentes multi-proveedor con enlace real de workspace y Places, memoria dinamica, user.txt compartido, indice incremental de hilos, creacion y edicion con borrador por IA, habilidades con telemetria y tarjetas de reflexion post-turno.',
      },
      {
        kind: 'added',
        description: 'Herramientas CLI y MCP de agente (kite_thread, kite_memory, kite_routine, kite_teammate) con control de permisos y plugins, resolucion de perfiles entre los 7 proveedores, activacion en frio por mensaje, rutinas en segundo plano, AutoPilot multi-turno e inbox con enlaces directos.',
      },
      {
        kind: 'changed',
        description: 'Tarjeta ChangedFilesCard acoplada al borde superior del compositor con despliegue hacia arriba e icono de microfono alineado opticamente en la barra de entrada.',
      },
      {
        kind: 'fixed',
        description: 'Auto-scroll continuo en vivo y seleccion estable de texto sin saltos ni reinicios al arrastrar en Thread, Agent Chat, inspector de subagentes y Swarm Board.',
      },
      {
        kind: 'fixed',
        description: 'Superficies opacas en selector de subagentes, vista previa del riel lateral y monitor de recursos sin filtracion de fondo, junto con silencio de avisos y sonidos al terminar subagentes y workers.',
      },
    ],
  },
  {
    version: '0.1.67',
    tag: 'v0.1.67',
    date: 'Nov 18, 2026',
    title: 'Inspector compacto de subagentes, organizacion lateral y estabilidad MCP',
    items: [
      {
        kind: 'changed',
        description: 'Reestructuracion compacta del inspector de subagentes en RightDock (header fijo en 2 filas, selector desplegable SubagentRunSwitcher con buscador, Task Brief a ancho completo, Jump to latest sin solapamiento y agrupacion de fallos vacios).',
      },
      {
        kind: 'changed',
        description: 'Organizacion de subagentes en la barra lateral izquierda con resumen nativo de ejecuciones activas, indicador orbital limpio, toggle persistente, sincronizacion de resaltado y limite de 3 filas con +N more.',
      },
      {
        kind: 'changed',
        description: 'Modelo predeterminado de subagentes configurado a gemini-4-hydrogen en Antigravity con configuracion editable desde Ajustes, enlace de workspace y Places en AgentsView, y preservacion de instrucciones de repositorio en modo Agents.',
      },
      {
        kind: 'fixed',
        description: 'Separacion de llamadas spawn frente a wait/read/send para eliminar tarjetas repetidas o fantasma con auto-reparacion de hilos persistidos, esquema PreToolUse compatible por agente, timeouts acotados en kite dispatch mcp (120s/150s) y reduccion de polling en dispatch_audit.',
      },
    ],
  },
  {
    version: '0.1.66',
    tag: 'v0.1.66',
    date: 'Nov 18, 2026',
    title: 'Plugin unificado kite-dispatch, MCP de subagentes y mejoras en Thread',
    items: [
      {
        kind: 'added',
        description: 'Servidor MCP nativo (kite dispatch mcp) con herramientas kite_subagent_run, kite_subagent_send, kite_subagent_wait, kite_subagent_read y kite_swarm, interceptor PreToolUse/BeforeTool (kite dispatch hook-subagent) y regla concisa rules/AGENTS.md sin skills sueltas.',
      },
      {
        kind: 'added',
        description: 'Delegacion paralela de multiples subagentes (--task repetible, --count y batch members en Swarm) y envio de tareas de seguimiento sobre subagentes existentes (kite dispatch send thread:<id> --wait) con tarjetas nativas en Thread y RightDock.',
      },
      {
        kind: 'changed',
        description: 'Ruteo unificado de subagentes y workers hacia el tier de modelos livianos (defaultDelegation -> stack -> modelo rapido) con limite seguro de effort y migracion de roles de ejemplo a command: auto.',
      },
      {
        kind: 'fixed',
        description: 'Supresion de avisos internos duplicados (wait --children all|any, internalDispatch), recuperacion de subagentes e hilos interrumpidos, y correccion de tablas Markdown en Thread (ancho en paneles amplios, columnas laterales y saltos <br>).',
      },
    ],
  },
  {
    version: '0.1.65',
    tag: 'v0.1.65',
    date: 'Nov 18, 2026',
    title: 'Hooks obligatorios de contexto, compresión in-process y proxy MCP',
    items: [
      {
        kind: 'changed',
        description: 'Hooks y plugins obligatorios (`PreToolUse`, `BeforeTool` y plugins nativos) en `kite ctx init` para Antigravity, Claude Code, Codex, Gemini CLI, Cursor, OpenCode y Copilot, con soporte para cadenas de comandos compuestas (`&&` y `;`) en `kite ctx hook-rewrite`.',
      },
      {
        kind: 'changed',
        description: 'Compresión automática in-process en el runtime de Kite para historiales de conversación largos (`runtime:thread_history`) y handoffs de subagentes (`runtime:subagent_handoff`), preservando anclas de inicio/cierre y referencias reversibles `<<ccr:HASH>>`.',
      },
      {
        kind: 'added',
        description: 'proxy stdio ligero `kite ctx mcp-proxy` para comprimir respuestas extensas de servidores MCP sin demonios HTTP adicionales, junto con el auditor `kite ctx discover` y filtros declarativos personalizados (`.kite/ctx-filters.json`).',
      },
    ],
  },
  {
    version: '0.1.64',
    tag: 'v0.1.64',
    date: 'Nov 18, 2026',
    title: 'Motor de contexto kite-ctx, integracion multi-agente y ahorro por funcionalidad',
    items: [
      {
        kind: 'added',
        description: 'Motor modular de optimizacion de contexto en Rust puro sin dependencias ML (kite-ctx) con compresion sin perdida, compresor tabular JSON, deduplicacion de lecturas por sesion, recuperacion reversible CCR, handoffs compartidos y alineacion KV-cache.',
      },
      {
        kind: 'added',
        description: 'Comandos CLI kite ctx (read, exec, compress, retrieve, share, stats, init, hook-rewrite, kv-check) e instalacion automatica de hooks y skills en todos los agentes locales con atribucion de sesion, agente, proveedor, modelo y proyecto.',
      },
      {
        kind: 'added',
        description: 'Nueva pestana Contexto en el Monitor de Recursos con ahorro acumulado y por sesion, cuota preservada, desglose por agente, modelo, canal y por funcionalidad, mas acceso directo desde Resumen.',
      },
    ],
  },
  {
    version: '0.1.63',
    tag: 'v0.1.63',
    date: 'Nov 17, 2026',
    title: 'Recuperacion de turnos congelados en Antigravity, curado de errores post-respuesta y tarjetas unicas de subagente',
    items: [
      {
        kind: 'fixed',
        description: 'Recuperacion automatica de turnos de Antigravity desde su transcripcion en disco cuando se corta stdout tras errores transitorios, liquidando herramientas previas interrumpidas y podando en vivo el aviso de inactividad.',
      },
      {
        kind: 'changed',
        description: 'Conservacion del identificador de conversacion durante el turno activo frente a cambios de cuenta y guardia contra cierre prematuro mientras haya subagentes o comandos en segundo plano en ejecucion.',
      },
      {
        kind: 'fixed',
        description: 'Adopcion unica de subagentes para evitar tarjetas duplicadas por delegacion, lectura legible de reportes estructurados JSON y envoltura de chips en el inspector lateral.',
      },
      {
        kind: 'fixed',
        description: 'Curado idempotente de desconexiones posteriores a respuestas ya entregadas, limpieza de fallos previos al iniciar o completar turnos y recicle limpio de sesiones persistentes tras errores de red.',
      },
    ],
  },
  {
    version: '0.1.62',
    tag: 'v0.1.62',
    date: 'Nov 17, 2026',
    title: 'Entrega completa de imagenes adjuntas a agentes, cola FIFO persistente mientras trabaja el agente y asociacion de carpetas en Thread',
    items: [
      {
        kind: 'fixed',
        description: 'Entrega real de imagenes pegadas y archivos adjuntos a todos los agentes conectados mediante resolucion de ruta en disco, inferencia MIME, banderas de archivo y soporte de turnos con solo imagenes.',
      },
      {
        kind: 'added',
        description: 'Miniaturas de previsualizacion para imagenes adjuntas en el compositor, el historial de mensajes y la cola de ejecucion, ademas de traspaso automatico de adjuntos desde borradores en Agent Chat.',
      },
      {
        kind: 'fixed',
        description: 'Cola persistente de mensajes enviados mientras el agente trabaja (QueuedRunsControl) sincronizada entre cambios de conversacion en Thread y Agent Chat, con despacho automatico FIFO al terminar el turno.',
      },
      {
        kind: 'changed',
        description: 'Tarjetas de mensajes en cola ancladas sobre el compositor con edicion en el lugar conservando el borrador actual, envio inmediato (Send now / Steer) y control desplegable de elementos.',
      },
      {
        kind: 'fixed',
        description: 'Asociacion explicita de conversaciones a carpetas de proyecto, generacion automatica y regeneracion de titulos de conversacion, y agrupacion unificada en tiempo real de ejecucion de herramientas.',
      },
    ],
  },
  {
    version: '0.1.61',
    tag: 'v0.1.61',
    date: 'Nov 17, 2026',
    title: 'Translucidez global en 4 niveles, terminales cristalinas, transicion Code-Thread fluida y Settings en espanol',
    items: [
      {
        kind: 'added',
        description: 'Sistema reutilizable de vidrio esmerilado en 4 niveles (--glass-*) con adopcion global en Sidebar, Files, Diffs (incluido Shadow DOM), Settings, Quotas, Notificaciones, Composers, Modales y Popovers.',
      },
      {
        kind: 'added',
        description: 'Terminales translucidas en GhostGrid 2D mediante contexto alfa y limpieza selectiva sobre paneles esmerilados en modos Code y Agent.',
      },
      {
        kind: 'changed',
        description: 'Interfaz de Agent armonizada visualmente con Thread y traduccion completa al espanol en Customizations, Settings y Plugins.',
      },
      {
        kind: 'changed',
        description: 'Limpieza de presets de wallpaper descartados y superposiciones SVG para mejorar el contraste sobre Aurora Mesh, Alpine Dusk y Solar Horizon.',
      },
      {
        kind: 'fixed',
        description: 'Transicion fluida entre Code y Thread conservando la posicion de scroll y dimensiones exactas sin doble parpadeo ni saltos al inicio de la conversacion.',
      },
      {
        kind: 'fixed',
        description: 'Fluidez de scroll en hilos largos eliminando animaciones continuas de fondo, desenfoques anidados en listas y mediciones sin throttle en ThreadTurnRail.',
      },
    ],
  },
  {
    version: '0.1.60',
    tag: 'v0.1.60',
    date: 'Nov 17, 2026',
    title: 'Wallpapers en alta resolucion, paneles con translucidez real y figuras tematicas en vistas activas',
    items: [
      {
        kind: 'added',
        description: 'Seis wallpapers tematicos en alta resolucion (1920x1080) integrados en StageBackdrop y en las previsualizaciones de Customizations (Aurora Mesh, Alpine Dusk, Solar Horizon, Cyber Prism, Architect Grid y Editorial Paper).',
      },
      {
        kind: 'changed',
        description: 'Translucidez real de vidrio esmerilado en todos los paneles principales, chat central, inspector de subagentes, tarjetas y composer para que el fondo se aprecie a traves de toda la interfaz y no solo entre bordes.',
      },
      {
        kind: 'changed',
        description: 'Activacion automatica de superficies translucidas al usar cualquier escena de fondo con opacidad predeterminada al 56% (ajustable de 15% a 95%) y atenuacion optimizada al 14%.',
      },
      {
        kind: 'added',
        description: 'Ilustraciones y figuras tematicas (ThemeHeroFigure) integradas en los estados iniciales de Thread, Agent y el dock de Subagentes.',
      },
    ],
  },
  {
    version: '0.1.59',
    tag: 'v0.1.59',
    date: 'Nov 16, 2026',
    title: 'Temas visuales multicapa, fondos de escenario, vidrio esmerilado y mejoras de interfaz',
    items: [
      {
        kind: 'added',
        description: 'Sistema de temas visuales multicapa con paquetes de tema, fondos de escenario, figuras decorativas, efecto de vidrio esmerilado y control de contraste.',
      },
      {
        kind: 'added',
        description: 'Paleta daltonizada para diffs, sincronizacion cromatica en el canvas de terminal y panel de personalizacion con importacion y exportacion de perfiles.',
      },
      {
        kind: 'changed',
        description: 'Mejoras en el visor de diffs de columna unica y nuevos iconos orbitales de estado para agentes y subagentes laterales.',
      },
      {
        kind: 'changed',
        description: 'Persistencia optimizada del modo de trabajo seleccionado al iniciar la aplicacion.',
      },
    ],
  },
  {
    version: '0.1.58',
    tag: 'v0.1.58',
    date: 'Nov 16, 2026',
    title: 'Estabilidad en Thread sin congelamientos, persistencia diferencial y sincronizacion de subagentes',
    items: [
      {
        kind: 'fixed',
        description: 'Eliminados bloqueos y congelamientos en Thread (Application Hang 1002) corrigiendo el deadlock AB-BA entre persist y threads, desacople de locks en checkpoints, settle, swarm y dispatch_wire',
      },
      {
        kind: 'changed',
        description: 'Activado SQLite WAL con synchronous NORMAL y busy_timeout de 5000ms, sincronizacion diferencial de threads por revision y timestamp, y persistencia asincrona coalesced en persist_async',
      },
      {
        kind: 'fixed',
        description: 'Pasados a async con spawn_blocking todos los comandos bloqueantes restantes en chat, git, handoff y actividad de agentes para evitar trabas en el hilo UI',
      },
      {
        kind: 'fixed',
        description: 'Aumentada la cola de eventos de transporte a 8192 preservando frames terminales, retencion de 120s tras cierre de turnos largos y reconciliacion resyncRequired sin cortar pollers activos',
      },
      {
        kind: 'fixed',
        description: 'Guards contra solapamiento de intervalos en live runs, dictado y agentes, proteccion contra regresiones de estado asentado en useChatSession y recarga en vivo del inspector de subagentes',
      },
      {
        kind: 'fixed',
        description: 'Separadas consultas de gestion de subagentes como llamadas dinamicas, soporte de payloads en arreglo y transcript URI nativos, herencia de modelo en inspector y ocultamiento de sobres internos de despacho',
      },
    ],
  },
  {
    version: '0.1.57',
    tag: 'v0.1.57',
    date: 'Nov 15, 2026',
    title: 'Cambio automático de cuenta al 0% de cuota y cierre seguro de procesos residuales',
    items: [
      {
        kind: 'added',
        description: 'Cambio automático de cuenta al alcanzar el 0% de cuota con política opt-in configurable por proveedor, circuit breaker y anti-rebote entre cuota y terminal',
      },
      {
        kind: 'added',
        description: 'Confirmación interactiva en notificaciones y toast con selector de modelo alternativo cuando la cuenta destino tiene un tier o catálogo distinto',
      },
      {
        kind: 'added',
        description: 'Continuación automática en Thread tras confirmar o ejecutar un cambio de cuenta y panel compartido en Cuentas, Cuotas y modal de cambio',
      },
      {
        kind: 'fixed',
        description: 'Detección y cierre selectivo de procesos residuales en segundo plano al cambiar de cuenta sin afectar la aplicación base',
      },
      {
        kind: 'fixed',
        description: 'Validación contra catálogo fresco al aprobar cambios pendientes y deduplicación por hilo de confirmaciones concurrentes',
      },
    ],
  },
  {
    version: '0.1.56',
    tag: 'v0.1.56',
    date: 'Nov 14, 2026',
    title: 'Configuraciones y Proveedores sin freezes, cache SWR y cambio fluido entre threads',
    items: [
      {
        kind: 'fixed',
        description: 'Eliminados freezes en Configuraciones, Proveedores, Cuotas, Cuentas, Subagentes y Notificaciones pasando comandos Rust bloqueantes a async (spawn_blocking) con lotes SQLite y locks acotados',
      },
      {
        kind: 'fixed',
        description: 'Eliminada inversión de bloqueo AB-BA en instantáneas de notificaciones bajo ejecución concurrente',
      },
      {
        kind: 'changed',
        description: 'Carga diferida (React.lazy) de las 15 pestañas en Configuraciones, diferimiento de IPCs de voz/audio hasta abrir la pestaña Voice y limpieza de capas backdrop-filter y SelectMenu',
      },
      {
        kind: 'changed',
        description: 'Caché SWR instantánea y sondeos paralelos con invalidación por escritura para cuotas, cuentas CLI, modelos por thread, plugins y actualizaciones de agentes',
      },
      {
        kind: 'fixed',
        description: 'Persistencia con debounce de 350 ms y flush en Zed/Operator y transición suave entre threads sin parpadeo del indicador de carga',
      },
    ],
  },
  {
    version: '0.1.55',
    tag: 'v0.1.55',
    date: 'Nov 13, 2026',
    title: 'Optimización de arranque, Thread rápido y persistencia de vista',
    items: [
      {
        kind: 'fixed',
        description: 'Optimizado el arranque inicial con carga diferida de rutas, overlays, Mermaid y workers de diffs',
      },
      {
        kind: 'changed',
        description: 'Aislamiento de runtime en Vite para excluir chunks pesados de la precarga inicial',
      },
      {
        kind: 'fixed',
        description: 'Eliminado el doble bootstrap al abrir la aplicación y reducido el splash mínimo a 250 ms',
      },
      {
        kind: 'fixed',
        description: 'Inicialización no bloqueante en Rust para dispatch wire, shims por metadatos y daemon sincronizado sin frenar la ventana',
      },
      {
        kind: 'fixed',
        description: 'Reparada la animación del spinner en Thread, hidratación instantánea desde caché y lecturas SQLite sin escrituras innecesarias',
      },
      {
        kind: 'added',
        description: 'Reapertura automática en la última vista activa (Agent, Code o Thread) al reiniciar',
      },
      {
        kind: 'added',
        description: 'Nuevo visor unificado de diffs con resaltado de sintaxis y mejoras de subagentes y swarm',
      },
    ],
  },
  {
    version: '0.1.54',
    tag: 'v0.1.54',
    date: 'Nov 12, 2026',
    title: 'Correcciones en Thread: sidebar, diff stats y turn rail',
    items: [
      {
        kind: 'fixed',
        description: 'Restaurado listado completo de chats en la sidebar lateral',
      },
      {
        kind: 'fixed',
        description: 'Corregido calculo de estadisticas (+N -M) y visualizacion de archivos modificados',
      },
      {
        kind: 'fixed',
        description: 'Posicionamiento elevado del riel de turnos y margenes contra colision con iconos',
      },
      {
        kind: 'fixed',
        description: 'Perfeccionada geometria circular del indicador de actividad Working',
      },
    ],
  },
  {
    version: '0.1.53',
    tag: 'v0.1.53',
    date: 'Nov 12, 2026',
    title: 'Modularización y optimización arquitectónica',
    items: [
      {
        kind: 'changed',
        description: 'modularización de 15 módulos monolíticos de backend en submódulos cohesivos',
      },
      {
        kind: 'changed',
        description: 'descomposición de páginas complejas en frontend React',
      },
      {
        kind: 'changed',
        description: 'encapsulamiento de estado y extracción de módulos spawn y codec en terminal',
      },
    ],
  },
  ...RELEASES_RECENT,
  ...RELEASES_EARLY,
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
