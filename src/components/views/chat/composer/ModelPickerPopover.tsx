import React, {
  useState,
  useRef,
  useMemo,
  useEffect,
  useCallback,
  useLayoutEffect,
} from 'react';
import { createPortal } from 'react-dom';
import { ChatProvider, AUTOMATIC_MODEL_ID } from '../types';
import { DriverDeclaration, DriverChoice } from '../../../../lib/session/types';
import { BrandLogo } from '../../agents/engineMetadata';
import { SearchIcon, CheckIcon } from '../ChatIcons';
import { ComposerControl, ComposerControlChevron } from './ComposerControl';
import { getAnchoredPopoverCoords, PopoverCoords } from './anchoredPosition';

const DEFAULT_PROVIDERS: Record<string, { label: string; vendor: string }> = {
  claude: { label: 'Anthropic', vendor: 'Anthropic PBC' },
  openai: { label: 'OpenAI', vendor: 'OpenAI LLC' },
  gemini: { label: 'Google DeepMind', vendor: 'Google LLC' },
  deepseek: { label: 'DeepSeek', vendor: 'DeepSeek AI' },
  openrouter: { label: 'OpenRouter', vendor: 'OpenRouter Inc.' },
  xai: { label: 'xAI', vendor: 'xAI Corp.' },
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
  ensureDynamicModels?: (provider: ChatProvider) => void;
  onSelectModel: (modelId: string | null) => void;
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
      ensureDynamicModels?.(provider);
    }
  }, [isOpen, provider, ensureDynamicModels]);

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
    (e: React.MouseEvent, prov: ChatProvider, modelId: string) => {
      e.stopPropagation();
      setFavorites((prev) => {
        const exists = prev.some((f) => f.provider === prov && f.modelId === modelId);
        const next = exists
          ? prev.filter((f) => !(f.provider === prov && f.modelId === modelId))
          : [...prev, { provider: prov, modelId }];
        saveFavorites(next);
        return next;
      });
    },
    []
  );

  const displayedModels = useMemo<DriverChoice[]>(() => {
    let list: DriverChoice[] = [];
    if (activeRailTab === 'favorites') {
      const favoriteIds = new Set(
        favorites.filter((f) => f.provider === provider).map((f) => f.modelId)
      );
      list = models.filter((m) => favoriteIds.has(m.id));
    } else {
      list = models;
    }

    if (!searchQuery.trim()) {
      return list;
    }

    const q = searchQuery.toLowerCase().trim();
    return list.filter(
      (m: DriverChoice) =>
        m.label.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (m.detail && m.detail.toLowerCase().includes(q))
    );
  }, [activeRailTab, favorites, models, provider, searchQuery]);

  const handleSelectModelRow = (selectedId: string) => {
    if (selectedId === AUTOMATIC_MODEL_ID) {
      onSelectModel(null);
    } else {
      onSelectModel(selectedId);
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
        disabled={disabled || models.length === 0}
        data-state={isOpen ? 'open' : 'closed'}
        onClick={() => {
          if (!disabled && models.length > 0) {
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
            style={{
              left: `${coords.left}px`,
              top: `${coords.top}px`,
            }}
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
                  displayedModels.map((item: DriverChoice) => {
                    const isSelected = item.id === currentModelId;
                    const favored = isFavorite(provider, item.id);
                    const badge = getModelBadge(item);

                    return (
                      <div
                        key={item.id}
                        role="option"
                        aria-selected={isSelected}
                        tabIndex={0}
                        onClick={() => handleSelectModelRow(item.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            handleSelectModelRow(item.id);
                          }
                        }}
                        className={`kite-model-item ${
                          isSelected ? 'kite-model-item--selected' : ''
                        }`}
                      >
                        <div className="kite-model-item-left">
                          <span className="shrink-0 inline-flex items-center">
                            <BrandLogo
                              engine={activeTabProviderRow.engine ?? activeTabProviderRow.id}
                              label={activeTabProviderRow.label}
                              size={14}
                            />
                          </span>
                          <span className="kite-model-item-label">{item.label}</span>
                          {badge && <span className="kite-model-item-badge">{badge}</span>}
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
                              onClick={(e) => toggleFavorite(e, provider, item.id)}
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
                      : 'No models available'}
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
