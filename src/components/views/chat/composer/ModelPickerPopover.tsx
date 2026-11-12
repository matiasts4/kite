import React, {
  useState,
  useRef,
  useMemo,
  useEffect,
  useCallback,
  useLayoutEffect,
} from 'react';
import { createPortal } from 'react-dom';
import { composerMenuStyle } from './composerMenu';
import { ChatProvider, AUTOMATIC_MODEL_ID } from '../types';
import { catalogEmptyMessage, type CatalogEmptyKind } from '../catalogEmptyState';
import { DriverDeclaration, DriverChoice } from '../../../../lib/session/types';
import { BrandLogo } from '../../agents/engineMetadata';
import { SearchIcon, CheckIcon } from '../ChatIcons';
import { ComposerControl, ComposerControlChevron } from './ComposerControl';
import { getAnchoredPopoverCoords, PopoverCoords } from './anchoredPosition';

const DEFAULT_PROVIDERS: Record<string, { label: string; vendor: string }> = {
  antigravity: { label: 'Antigravity', vendor: 'Google DeepMind' },
  claude: { label: 'Claude Code', vendor: 'Anthropic PBC' },
  codex: { label: 'Codex', vendor: 'OpenAI LLC' },
  grok: { label: 'Grok Build', vendor: 'xAI Corp.' },
  opencode: { label: 'OpenCode', vendor: 'OpenCode' },
  cursor: { label: 'Cursor Agent', vendor: 'Cursor' },
  gemini: { label: 'Gemini CLI', vendor: 'Google LLC' },
  openai: { label: 'OpenAI', vendor: 'OpenAI LLC' },
  deepseek: { label: 'DeepSeek', vendor: 'DeepSeek AI' },
  openrouter: { label: 'OpenRouter', vendor: 'OpenRouter Inc.' },
  ollama: { label: 'Ollama', vendor: 'Local Runtime' },
};

// AUTOMATIC_MODEL_ID is imported from ../types

const StarSvg: React.FC<{ filled?: boolean; className?: string; size?: number }> = ({
  filled = false,
  className = '',
  size = 14,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

interface FavoriteModelEntry {
  provider: ChatProvider;
  modelId: string;
  label?: string;
  detail?: string;
}

interface DisplayedModelItem extends DriverChoice {
  itemProvider?: ChatProvider;
}

const STORAGE_KEY = 'kite_favorite_models_v1';

function loadFavorites(): FavoriteModelEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveFavorites(favs: FavoriteModelEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(favs));
  } catch {
    // Ignore storage errors
  }
}

function getModelBadge(model: DriverChoice): string | null {
  if (model.id === AUTOMATIC_MODEL_ID) return 'Default';
  const label = model.label.toLowerCase();
  const id = model.id.toLowerCase();
  if (label.includes('flash') || label.includes('haiku') || label.includes('mini') || label.includes('speed')) {
    return 'Fast';
  }
  if (label.includes('opus') || label.includes('max') || id.includes('opus') || id.includes('deepseek-r1')) {
    return 'Max';
  }
  return null;
}

export interface ModelPickerPopoverProps {
  provider: ChatProvider;
  model: string | null;
  declaration: DriverDeclaration;
  disabled?: boolean;
  modelReason?: string | null;
  catalogState?: CatalogEmptyKind | null;
  ensureDynamicModels?: (provider: ChatProvider) => void;
  onSelectModel: (modelId: string | null, targetProvider?: ChatProvider) => void;
  onSelectProvider: (provider: ChatProvider) => void;
}

const PANEL_WIDTH = 384;
const PANEL_HEIGHT = 352;

export const ModelPickerPopover: React.FC<ModelPickerPopoverProps> = ({
  provider,
  model,
  declaration,
  disabled = false,
  modelReason,
  catalogState = null,
  ensureDynamicModels,
  onSelectModel,
  onSelectProvider,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeRailTab, setActiveRailTab] = useState<'favorites' | ChatProvider>(provider);
  const [favorites, setFavorites] = useState<FavoriteModelEntry[]>(() => loadFavorites());
  const [coords, setCoords] = useState<PopoverCoords | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setActiveRailTab(provider);
  }, [provider]);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    setCoords(getAnchoredPopoverCoords(triggerRef.current, PANEL_WIDTH, PANEL_HEIGHT, 8, 'top'));
  }, []);

  useLayoutEffect(() => {
    if (isOpen) {
      updatePosition();
    }
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (isOpen) {
      setSearchQuery('');
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
      if (activeRailTab === 'favorites') {
        const unique = new Set([provider, ...favorites.map((f) => f.provider)]);
        unique.forEach((p) => ensureDynamicModels?.(p));
      } else {
        ensureDynamicModels?.(activeRailTab as ChatProvider);
      }
    }
  }, [isOpen, provider, activeRailTab, favorites, ensureDynamicModels]);

  // Close on outside click or escape
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current &&
        !triggerRef.current.contains(target) &&
        panelRef.current &&
        !panelRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
    };
  }, [isOpen, updatePosition]);

  const providers = useMemo<DriverChoice[]>(() => {
    if (declaration.providers && declaration.providers.length > 0) {
      return declaration.providers;
    }
    return (Object.keys(DEFAULT_PROVIDERS) as ChatProvider[]).map((id) => ({
      id,
      label: DEFAULT_PROVIDERS[id]?.label ?? id,
      detail: DEFAULT_PROVIDERS[id]?.vendor ?? '',
      engine: id,
    }));
  }, [declaration.providers]);

  const activeProviderRow =
    providers.find((row: DriverChoice) => row.id === provider) ??
    ({
      id: provider,
      label: DEFAULT_PROVIDERS[provider]?.label ?? declaration.driver,
      engine: declaration.driver,
    } as DriverChoice);

  const models = declaration.models ?? [];
  const currentModelId = model || AUTOMATIC_MODEL_ID;
  const currentModelOption = models.find((m: DriverChoice) => m.id === currentModelId);
  const currentModelName =
    !model || model === AUTOMATIC_MODEL_ID
      ? 'Automatic'
      : currentModelOption?.label || model;
  const modelTriggerLabel = currentModelName.replace(/^Claude /u, '');

  const isFavorite = useCallback(
    (prov: ChatProvider, modelId: string) => {
      return favorites.some((f) => f.provider === prov && f.modelId === modelId);
    },
    [favorites]
  );

  const toggleFavorite = useCallback(
    (
      e: React.MouseEvent,
      prov: ChatProvider,
      modelId: string,
      modelLabel?: string,
      modelDetail?: string
    ) => {
      e.stopPropagation();
      setFavorites((prev) => {
        const exists = prev.some((f) => f.provider === prov && f.modelId === modelId);
        const next = exists
          ? prev.filter((f) => !(f.provider === prov && f.modelId === modelId))
          : [...prev, { provider: prov, modelId, label: modelLabel, detail: modelDetail }];
        saveFavorites(next);
        return next;
      });
    },
    []
  );

  const displayedModels = useMemo<DisplayedModelItem[]>(() => {
    let list: DisplayedModelItem[] = [];
    if (activeRailTab === 'favorites') {
      list = favorites.map((fav) => {
        const match = fav.provider === provider ? models.find((m) => m.id === fav.modelId) : undefined;
        return {
          id: fav.modelId,
          label: match?.label ?? fav.label ?? fav.modelId,
          detail: match?.detail ?? fav.detail ?? DEFAULT_PROVIDERS[fav.provider]?.label ?? fav.provider,
          engine: fav.provider,
          itemProvider: fav.provider,
        };
      });
    } else {
      list = models.map((m) => ({
        ...m,
        itemProvider: provider,
      }));
    }

    if (!searchQuery.trim()) {
      return list;
    }

    const q = searchQuery.toLowerCase().trim();
    return list.filter(
      (m: DisplayedModelItem) =>
        m.label.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.detail && m.detail.toLowerCase().includes(q))
    );
  }, [activeRailTab, favorites, models, provider, searchQuery]);

  const handleSelectModelRow = (item: DisplayedModelItem) => {
    const targetProv = item.itemProvider || provider;
    if (targetProv !== provider) {
      onSelectProvider(targetProv);
    }
    if (item.id === AUTOMATIC_MODEL_ID) {
      onSelectModel(null, targetProv);
    } else {
      onSelectModel(item.id, targetProv);
    }
    setIsOpen(false);
  };

  const activeTabProviderRow =
    providers.find((row) => row.id === activeRailTab) ?? activeProviderRow;

  return (
    <>
      {/* Trigger Pill */}
      <ComposerControl
        ref={triggerRef}
        role="combobox"
        aria-label="Model"
        aria-expanded={isOpen}
        title={modelReason || `Model: ${currentModelName}`}
        disabled={disabled}
        data-state={isOpen ? 'open' : 'closed'}
        onClick={() => {
          if (!disabled) {
            setIsOpen((prev) => !prev);
          }
        }}
      >
        <span className="shrink-0 inline-flex items-center">
          <BrandLogo
            engine={activeProviderRow.engine ?? activeProviderRow.id}
            label={activeProviderRow.label}
            size={14}
          />
        </span>
        <span className="kite-composer-control-label font-medium text-foreground" title={modelTriggerLabel}>
          {modelTriggerLabel}
        </span>
        <ComposerControlChevron />
      </ComposerControl>

      {/* Floating Two-Column Popover Card via Portal */}
      {isOpen &&
        coords &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Select model and provider"
            className="kite-floating-card kite-model-picker-card"
            style={composerMenuStyle({
              left: `${coords.left}px`,
              top: `${coords.top}px`,
            })}
          >
            {/* Left Rail: Favorites + Providers */}
            <div className="kite-model-rail">
              {/* Favorites Star Tab */}
              <button
                type="button"
                title="Favorite Models"
                aria-label="Favorite Models"
                onClick={() => setActiveRailTab('favorites')}
                className={`kite-model-rail-btn ${
                  activeRailTab === 'favorites' ? 'kite-model-rail-btn--active' : ''
                }`}
                style={{ color: activeRailTab === 'favorites' ? '#eab308' : undefined }}
              >
                {activeRailTab === 'favorites' && <span className="kite-model-rail-indicator" />}
                <StarSvg filled={activeRailTab === 'favorites'} size={15} />
              </button>

              <span className="kite-model-rail-divider" aria-hidden="true" />

              {/* Provider Buttons */}
              <div className="kite-model-rail-list">
                {providers.map((p) => {
                  const isTabActive = activeRailTab === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      title={p.label}
                      aria-label={p.label}
                      onClick={() => {
                        setActiveRailTab(p.id as ChatProvider);
                        ensureDynamicModels?.(p.id as ChatProvider);
                        if (p.id !== provider) {
                          onSelectProvider(p.id as ChatProvider);
                        }
                      }}
                      className={`kite-model-rail-btn ${
                        isTabActive ? 'kite-model-rail-btn--active' : ''
                      }`}
                    >
                      {isTabActive && <span className="kite-model-rail-indicator" />}
                      <span className="shrink-0 inline-flex items-center">
                        <BrandLogo
                          engine={p.engine ?? p.id}
                          label={p.label}
                          size={15}
                        />
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Right Panel: Search Bar + Model Options */}
            <div className="kite-model-content">
              {/* Search Bar */}
              <div className="kite-model-search-wrap">
                <SearchIcon size={14} className="text-muted-foreground shrink-0" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search models..."
                  aria-label="Search models"
                  className="kite-model-search-input"
                />
              </div>

              {/* Category Header */}
              <div className="kite-model-section-header">
                <span>
                  {activeRailTab === 'favorites'
                    ? 'Favorite Models'
                    : `${activeTabProviderRow.label} Models`}
                </span>
                {activeTabProviderRow.detail && activeRailTab !== 'favorites' && (
                  <span
                    style={{
                      fontWeight: 400,
                      textTransform: 'none',
                      color: 'var(--muted-foreground)',
                    }}
                  >
                    {activeTabProviderRow.detail}
                  </span>
                )}
              </div>

              {/* Model Options List */}
              <div
                role="listbox"
                aria-label={`${activeTabProviderRow.label} Models`}
                className="kite-model-list"
              >
                {displayedModels.length > 0 ? (
                  displayedModels.map((item: DisplayedModelItem) => {
                    const itemProv = item.itemProvider || provider;
                    const isSelected = itemProv === provider && item.id === currentModelId;
                    const favored = isFavorite(itemProv, item.id);
                    const badge = getModelBadge(item);
                    const itemProviderRow =
                      providers.find((row) => row.id === itemProv) ?? {
                        id: itemProv,
                        label: DEFAULT_PROVIDERS[itemProv]?.label ?? itemProv,
                        engine: itemProv,
                      };

                    return (
                      <div
                        key={`${itemProv}:${item.id}`}
                        role="option"
                        aria-selected={isSelected}
                        tabIndex={0}
                        onClick={() => handleSelectModelRow(item)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleSelectModelRow(item);
                          }
                        }}
                        className={`kite-model-item ${
                          isSelected ? 'kite-model-item--selected' : ''
                        }`}
                      >
                        <div className="kite-model-item-left">
                          <span className="shrink-0 inline-flex items-center">
                            <BrandLogo
                              engine={itemProviderRow.engine ?? itemProviderRow.id}
                              label={itemProviderRow.label}
                              size={14}
                            />
                          </span>
                          <span className="kite-model-item-label">{item.label}</span>
                          {badge && <span className="kite-model-item-badge">{badge}</span>}
                          {activeRailTab === 'favorites' && (
                            <span
                              className="kite-model-item-badge"
                              style={{
                                opacity: 0.7,
                                marginLeft: 'auto',
                                marginRight: '0.25rem',
                              }}
                            >
                              {itemProviderRow.label}
                            </span>
                          )}
                        </div>

                        <div className="kite-model-item-right">
                          {isSelected && (
                            <CheckIcon
                              size={14}
                              className="shrink-0"
                              style={{ color: 'var(--primary, #3b82f6)' }}
                            />
                          )}
                          {item.id !== AUTOMATIC_MODEL_ID && (
                            <button
                              type="button"
                              aria-label={
                                favored
                                  ? `Unfavorite ${item.label}`
                                  : `Favorite ${item.label}`
                              }
                              onClick={(e) =>
                                toggleFavorite(e, itemProv, item.id, item.label, item.detail)
                              }
                              className={`kite-model-star-btn ${
                                favored ? 'kite-model-star-btn--fav' : ''
                              }`}
                            >
                              <StarSvg filled={favored} size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div
                    style={{
                      padding: '2rem 1rem',
                      textAlign: 'center',
                      fontSize: '0.75rem',
                      color: 'var(--muted-foreground, #71717a)',
                    }}
                  >
                    {searchQuery.trim()
                      ? `No models match "${searchQuery}"`
                      : activeRailTab === 'favorites'
                      ? 'No favorite models saved yet. Click the star on any model to save it here.'
                      : catalogEmptyMessage(catalogState ?? 'empty', provider)}
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
