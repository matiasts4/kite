import React, { useState, useMemo, useEffect, useRef } from 'react';
import { getShortcuts, getPlatform } from '../../lib/shortcuts/shortcutsRegistry';
import { SupportedPlatform } from '../../lib/shortcuts/types';
import { CODE_LAUNCH_ENGINES, engineLogo } from '../code/engineCatalog';
import type { AgentProfile } from '../../types';
import './commandPalette.css';

export interface CommandPaletteItem {
  id: string;
  label: string;
  subtitle?: string;
  category: 'Spawn Agente' | 'Agentes' | 'Modos' | 'Navegación' | 'Terminal' | 'Voz';
  shortcutId?: string;
  iconUrl?: string | null;
  glyph?: React.ReactNode;
  keywords?: string[];
  run: () => void;
}

export interface CommandPaletteModalProps {
  isOpen: boolean;
  onClose: () => void;
  agents?: AgentProfile[];
  onLaunchAgent?: (engineId: string, displayName: string) => void;
  onSelectAgent?: (agentId: string) => void;
  onSelectMode?: (mode: 'agent' | 'code' | 'chat') => void;
  onToggleSidebar?: () => void;
  onToggleDock?: () => void;
  onToggleOperator?: () => void;
  onToggleVoice?: () => void;
  onOpenSettings?: (tab?: string) => void;
  onNewTerminal?: () => void;
  onSplitPane?: (axis: 'vertical' | 'horizontal') => void;
  onClosePane?: () => void;
  onSaveFile?: () => void;
  platform?: SupportedPlatform;
}

const ENGINE_SEARCH_ALIASES: Record<string, string[]> = {
  'claude-code': ['cloud', 'claude', 'anthropic', 'sonnet', 'opus'],
  codex: ['codex', 'openai', 'chatgpt', 'gpt'],
  cursor: ['cursor', 'anysphere'],
  gemini: ['gemini', 'google', 'deepmind'],
  'github-copilot': ['copilot', 'github', 'microsoft'],
  droid: ['droid', 'factory'],
  'open-code': ['opencode', 'open code', 'free'],
  'deep-seek': ['deepseek', 'deep seek', 'r1'],
  grok: ['grok', 'xai', 'elon', 'twitter'],
  kimi: ['kimi', 'moonshot'],
  amp: ['amp', 'sourcegraph'],
  antigravity: ['antigravity', 'anti gravity', 'google', 'deepmind', 'agy'],
  'gentle-shell': ['gentle', 'gentle shell', 'terminal'],
  aider: ['aider', 'cli'],
  muse: ['muse'],
};

export const CommandPaletteModal: React.FC<CommandPaletteModalProps> = ({
  isOpen,
  onClose,
  agents = [],
  onLaunchAgent,
  onSelectAgent,
  onSelectMode,
  onToggleSidebar,
  onToggleDock,
  onToggleOperator,
  onToggleVoice,
  onOpenSettings,
  onNewTerminal,
  onSplitPane,
  onClosePane,
  onSaveFile,
  platform: propPlatform,
}) => {
  const platform = propPlatform || getPlatform();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const shortcuts = useMemo(() => getShortcuts(platform), [platform, isOpen]);

  const allItems: CommandPaletteItem[] = useMemo(() => {
    const list: CommandPaletteItem[] = [];

    // 1. Engine Spawning (Claude, Antigravity, OpenCode, Grok, Gemini, etc.)
    for (const engine of CODE_LAUNCH_ENGINES) {
      const aliases = ENGINE_SEARCH_ALIASES[engine.wireId] || [];
      list.push({
        id: `spawn-${engine.wireId}`,
        label: `Spawn ${engine.displayName}`,
        subtitle: `${engine.vendor} · Iniciar sesión de agente en el espacio de trabajo`,
        category: 'Spawn Agente',
        iconUrl: engineLogo(engine.wireId),
        keywords: [
          engine.wireId,
          engine.displayName.toLowerCase(),
          engine.shortDisplayName.toLowerCase(),
          engine.vendor.toLowerCase(),
          ...aliases,
        ],
        run: () => {
          onLaunchAgent?.(engine.wireId, engine.displayName);
        },
      });
    }

    // 2. Existing Custom Saved Agents
    for (const agent of agents) {
      list.push({
        id: `agent-${agent.id}`,
        label: `Abrir agente ${agent.name}`,
        subtitle: `${agent.engine} · ${agent.purpose || 'Agente guardado'}`,
        category: 'Agentes',
        iconUrl: agent.avatar || engineLogo(agent.engine),
        keywords: [agent.name.toLowerCase(), agent.engine.toLowerCase(), (agent.purpose || '').toLowerCase()],
        run: () => {
          onSelectAgent?.(agent.id);
        },
      });
    }

    // 3. Navigation & Mode Switchers
    list.push(
      {
        id: 'mode-agent',
        label: 'Switch to Agent Mode',
        subtitle: 'Espacio de orquestación y administración de agentes',
        category: 'Modos',
        shortcutId: 'mode-agent',
        keywords: ['agent', 'agentes', 'modo'],
        run: () => onSelectMode?.('agent'),
      },
      {
        id: 'mode-code',
        label: 'Switch to Code Workspace Mode',
        subtitle: 'Espacio de trabajo multi-panel con terminales y editor',
        category: 'Modos',
        shortcutId: 'mode-code',
        keywords: ['code', 'codigo', 'workspace', 'paneles'],
        run: () => onSelectMode?.('code'),
      },
      {
        id: 'mode-chat',
        label: 'Switch to Chat Mode',
        subtitle: 'Modo conversacional y de consultas con modelos',
        category: 'Modos',
        shortcutId: 'mode-chat',
        keywords: ['chat', 'conversacion', 'thread', 'hilo'],
        run: () => onSelectMode?.('chat'),
      },
      {
        id: 'toggle-sidebar',
        label: 'Toggle Lateral Sidebar',
        subtitle: 'Mostrar u ocultar la barra lateral izquierda',
        category: 'Navegación',
        shortcutId: 'toggle-sidebar',
        keywords: ['sidebar', 'barra', 'lateral'],
        run: () => onToggleSidebar?.(),
      },
      {
        id: 'toggle-dock',
        label: 'Toggle Right Dock / Browser',
        subtitle: 'Mostrar u ocultar el panel derecho y navegador web',
        category: 'Modos',
        shortcutId: 'toggle-dock',
        keywords: ['dock', 'browser', 'panel derecho', 'navegador'],
        run: () => onToggleDock?.(),
      },
      {
        id: 'toggle-operator',
        label: 'Toggle Zed Assistant',
        subtitle: 'Invocar o minimizar el asistente flotante de voz y control',
        category: 'Voz',
        shortcutId: 'toggle-operator',
        keywords: ['zed', 'asistente', 'operador', 'operator', 'orb'],
        run: () => onToggleOperator?.(),
      },
      {
        id: 'dictation-toggle',
        label: 'Toggle Voice Dictation',
        subtitle: 'Iniciar o detener la grabación de voz a texto',
        category: 'Voz',
        shortcutId: 'dictation-toggle',
        keywords: ['voice', 'voz', 'dictado', 'microfono'],
        run: () => onToggleVoice?.(),
      },
      {
        id: 'open-settings',
        label: 'Open Settings',
        subtitle: 'Abrir el panel de configuración global',
        category: 'Navegación',
        shortcutId: 'open-settings',
        keywords: ['settings', 'configuracion', 'preferencias', 'opciones'],
        run: () => onOpenSettings?.(),
      },
      {
        id: 'open-shortcuts',
        label: 'Open Keyboard Shortcuts',
        subtitle: 'Ver y personalizar todos los atajos de teclado',
        category: 'Navegación',
        keywords: ['shortcuts', 'keybindings', 'atajos', 'teclado', 'teclas'],
        run: () => onOpenSettings?.('keybindings'),
      },
      {
        id: 'new-terminal',
        label: 'Open New Terminal Session',
        subtitle: 'Abrir una nueva terminal PowerShell/Bash en el espacio activo',
        category: 'Terminal',
        shortcutId: 'new-terminal',
        keywords: ['terminal', 'consola', 'shell', 'bash', 'powershell'],
        run: () => onNewTerminal?.(),
      },
      {
        id: 'split-vertical',
        label: 'Split Pane Vertically',
        subtitle: 'Dividir el panel enfocado en dos columnas lado a lado',
        category: 'Terminal',
        shortcutId: 'split-vertical',
        keywords: ['split', 'dividir', 'vertical', 'columna'],
        run: () => onSplitPane?.('vertical'),
      },
      {
        id: 'split-horizontal',
        label: 'Split Pane Horizontally',
        subtitle: 'Dividir el panel enfocado arriba y abajo',
        category: 'Terminal',
        shortcutId: 'split-horizontal',
        keywords: ['split', 'dividir', 'horizontal', 'fila'],
        run: () => onSplitPane?.('horizontal'),
      },
      {
        id: 'close-pane',
        label: 'Close Active Pane',
        subtitle: 'Cerrar el panel de terminal o editor enfocado',
        category: 'Terminal',
        shortcutId: 'close-pane',
        keywords: ['close', 'cerrar', 'pane', 'panel'],
        run: () => onClosePane?.(),
      },
      {
        id: 'save-file',
        label: 'Save Active File',
        subtitle: 'Guardar cambios en el archivo activo en FilesView',
        category: 'Terminal',
        shortcutId: 'save-file',
        keywords: ['save', 'guardar', 'archivo', 'file'],
        run: () => onSaveFile?.(),
      }
    );

    return list;
  }, [
    agents,
    onLaunchAgent,
    onSelectAgent,
    onSelectMode,
    onToggleSidebar,
    onToggleDock,
    onToggleOperator,
    onToggleVoice,
    onOpenSettings,
    onNewTerminal,
    onSplitPane,
    onClosePane,
    onSaveFile,
  ]);

  const filtered = useMemo(() => {
    if (!query.trim()) return allItems;
    const rawQ = query.toLowerCase().trim();
    // Normalize spaces and hyphens for flexible queries (e.g. "anti gravity" -> "antigravity")
    const collapsedQ = rawQ.replace(/[\s\-_]+/g, '');

    return allItems.filter((item) => {
      const rawLabel = item.label.toLowerCase();
      const rawSubtitle = (item.subtitle || '').toLowerCase();
      const rawCategory = item.category.toLowerCase();

      const collapsedLabel = rawLabel.replace(/[\s\-_]+/g, '');
      const collapsedSubtitle = rawSubtitle.replace(/[\s\-_]+/g, '');

      // Check standard inclusion
      if (
        rawLabel.includes(rawQ) ||
        rawSubtitle.includes(rawQ) ||
        rawCategory.includes(rawQ) ||
        collapsedLabel.includes(collapsedQ) ||
        collapsedSubtitle.includes(collapsedQ)
      ) {
        return true;
      }

      // Check keywords
      if (item.keywords) {
        return item.keywords.some((kw) => {
          const kwLow = kw.toLowerCase();
          const kwCollapsed = kwLow.replace(/[\s\-_]+/g, '');
          return kwLow.includes(rawQ) || kwCollapsed.includes(collapsedQ);
        });
      }

      return false;
    });
  }, [allItems, query]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filtered]);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  // Scroll selected element into view smoothly
  useEffect(() => {
    if (!listRef.current) return;
    const selectedElement = listRef.current.querySelector(
      `[data-index="${selectedIndex}"]`
    ) as HTMLElement | null;
    if (selectedElement && typeof selectedElement.scrollIntoView === 'function') {
      selectedElement.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, filtered.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filtered.length) % Math.max(1, filtered.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = filtered[selectedIndex];
      if (selected) {
        selected.run();
        onClose();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="command-palette-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Paleta de comandos y lanzador de agentes"
    >
      <div className="command-palette-card">
        <div className="command-palette-search-wrapper">
          <svg
            className="command-palette-search-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="command-palette-input"
            placeholder="Escribe un comando o proveedor de agente (ej. antigravity, claude, opencode)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        <div className="command-palette-list" ref={listRef} role="listbox">
          {filtered.length === 0 ? (
            <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-faint)' }}>
              No se encontraron agentes ni comandos para &ldquo;{query}&rdquo;.
            </div>
          ) : (
            filtered.map((item, idx) => {
              const shortcut = item.shortcutId
                ? shortcuts.find((s) => s.id === item.shortcutId)
                : undefined;
              const keys = shortcut ? shortcut.customKeys || shortcut.defaultKeys : [];
              const isSelected = idx === selectedIndex;
              const isSpawn = item.category === 'Spawn Agente';

              return (
                <button
                  key={item.id}
                  data-index={idx}
                  type="button"
                  className={`command-palette-item ${isSelected ? 'command-palette-item--selected' : ''}`}
                  onClick={() => {
                    item.run();
                    onClose();
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  role="option"
                  aria-selected={isSelected}
                >
                  <div className="command-palette-item__label-group">
                    <div className="command-palette-item__icon-container">
                      {item.iconUrl ? (
                        <img
                          src={item.iconUrl}
                          alt=""
                          className="command-palette-item__logo"
                          onError={(e) => {
                            // Hide broken image and fall back to clean glyph
                            (e.target as HTMLElement).style.display = 'none';
                          }}
                        />
                      ) : (
                        <svg
                          className="command-palette-item__glyph"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="4 17 10 11 4 5" />
                          <line x1="12" y1="19" x2="20" y2="19" />
                        </svg>
                      )}
                    </div>

                    <div className="command-palette-item__text-group">
                      <span className="command-palette-item__label">{item.label}</span>
                      {item.subtitle && (
                        <span className="command-palette-item__subtitle">{item.subtitle}</span>
                      )}
                    </div>
                  </div>

                  <div className="command-palette-item__meta">
                    <span
                      className={`command-palette-item__category ${
                        isSpawn ? 'command-palette-item__category--spawn' : ''
                      }`}
                    >
                      {item.category}
                    </span>

                    {keys.length > 0 && (
                      <div className="command-palette-item__shortcut">
                        {keys.map((k, kIdx) => (
                          <kbd key={kIdx} className="command-palette-kbd">
                            {k}
                          </kbd>
                        ))}
                      </div>
                    )}
                  </div>
                </button>
              );
            })
          )}
        </div>

        <div className="command-palette-footer">
          <div className="command-palette-footer-hints">
            <span>
              <kbd className="command-palette-kbd">↑</kbd> <kbd className="command-palette-kbd">↓</kbd> Navegar
            </span>
            <span>
              <kbd className="command-palette-kbd">↵</kbd> Ejecutar / Spawn
            </span>
            <span>
              <kbd className="command-palette-kbd">Esc</kbd> Cerrar
            </span>
          </div>
          <span>Kite Command & Agent Dispatcher</span>
        </div>
      </div>
    </div>
  );
};
