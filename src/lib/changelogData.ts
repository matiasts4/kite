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
