import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { CheckIcon, SearchIcon } from '../ChatIcons';
import { BrandLogo } from '../../../ui/BrandLogo';
import {
  AUTOMATIC_MODEL_ID,
  PROVIDER_CATALOG,
  type ChatProvider,
} from '../types';
import type { DriverDeclaration, DriverChoice } from '../../../../lib/session/types';
import { ComposerControl, ComposerControlChevron } from './ComposerControl';

const FAVORITES_STORAGE_KEY = 'kite.modelFavorites.v1';

interface FavoriteModelEntry {
  provider: ChatProvider;
  modelId: string;
}

function loadFavorites(): FavoriteModelEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is FavoriteModelEntry =>
        item && typeof item.provider === 'string' && typeof item.modelId === 'string'
    );
  } catch {
    return [];
  }
}

function saveFavorites(favorites: FavoriteModelEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites));
  } catch {
    // Ignore storage write errors
  }
}

const StarSvg: React.FC<{ filled?: boolean; className?: string }> = ({
  filled = false,
  className = 'size-3.5',
}) => (
  <svg
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

function getModelBadge(model: DriverChoice): string | null {
  const lowerId = model.id.toLowerCase();
  const lowerLabel = model.label.toLowerCase();
  if (model.id === AUTOMATIC_MODEL_ID) return 'Default';
  if (
    lowerId.includes('flash') ||
    lowerId.includes('haiku') ||
    lowerId.includes('mini') ||
    lowerLabel.includes('fast')
  ) {
    return 'Fast';
  }
  if (
    lowerId.includes('opus') ||
    lowerId.includes('pro') ||
    lowerId.includes('max') ||
    lowerLabel.includes('max')
  ) {
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

  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setActiveRailTab(provider);
  }, [provider]);

  useEffect(() => {
    if (isOpen) {
      setSearchQuery('');
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
      ensureDynamicModels?.(provider);
    }
  }, [isOpen, provider, ensureDynamicModels]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
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
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const providers = useMemo<DriverChoice[]>(() => {
    if (declaration.providers && declaration.providers.length > 0) {
      return declaration.providers;
    }
    return (Object.keys(PROVIDER_CATALOG) as ChatProvider[]).map((id) => ({
      id,
      label: PROVIDER_CATALOG[id].label,
      detail: PROVIDER_CATALOG[id].vendor,
      engine: PROVIDER_CATALOG[id].engineId ?? id,
    }));
  }, [declaration.providers]);

  const activeProviderRow =
    providers.find((row) => row.id === provider) ??
    ({
      id: provider,
      label: PROVIDER_CATALOG[provider]?.label ?? declaration.driver,
      engine: PROVIDER_CATALOG[provider]?.engineId ?? declaration.driver,
    } as DriverChoice);

  const models = declaration.models ?? [];
  const currentModelId = model || AUTOMATIC_MODEL_ID;
  const currentModelOption = models.find((m) => m.id === currentModelId);
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
      (m) =>
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
    <div ref={containerRef} className="relative inline-block">
      {/* Trigger Pill */}
      <ComposerControl
        role="combobox"
        aria-label="Model"
        aria-expanded={isOpen}
        title={modelReason || `Model: ${currentModelName}`}
        disabled={disabled || models.length === 0}
        data-state={isOpen ? 'open' : 'closed'}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <BrandLogo
          engine={activeProviderRow.engine ?? activeProviderRow.id}
          label={activeProviderRow.label}
          size={14}
          className="shrink-0"
        />
        <span className="truncate max-w-[150px] text-foreground font-medium">
          {modelTriggerLabel}
        </span>
        <ComposerControlChevron />
      </ComposerControl>

      {/* Popover Card (Two Columns: Left Provider Rail + Right Searchable Model List) */}
      {isOpen && !disabled && (
        <div
          role="dialog"
          aria-label="Select model and provider"
          className="absolute bottom-[calc(100%+8px)] left-0 w-[360px] h-[340px] rounded-dialog border border-border bg-surface-elevated/95 backdrop-blur-xl shadow-2xl flex flex-row overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-100"
        >
          {/* Left Vertical Provider Rail */}
          <div className="w-11 bg-surface/50 border-r border-border p-1.5 flex flex-col items-center gap-1 shrink-0">
            {/* Favorites Star Tab */}
            <button
              type="button"
              title="Favorite Models"
              aria-label="Favorite Models"
              onClick={() => setActiveRailTab('favorites')}
              className={`relative size-8 rounded-control inline-flex items-center justify-center border-0 bg-transparent cursor-pointer transition-colors ${
                activeRailTab === 'favorites'
                  ? 'bg-selected-row text-warning'
                  : 'text-icon-muted hover:text-foreground hover:bg-hover-row'
              }`}
            >
              {activeRailTab === 'favorites' && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-primary rounded-full" />
              )}
              <StarSvg filled={activeRailTab === 'favorites'} className="size-4" />
            </button>

            <span className="w-6 h-px bg-border my-0.5 shrink-0" aria-hidden="true" />

            {/* Provider Icons List */}
            <div className="flex-1 overflow-y-auto flex flex-col items-center gap-1 w-full no-scrollbar">
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
                    className={`relative size-8 rounded-control inline-flex items-center justify-center border-0 bg-transparent cursor-pointer transition-colors ${
                      isTabActive
                        ? 'bg-selected-row text-foreground'
                        : 'text-icon-muted hover:text-foreground hover:bg-hover-row'
                    }`}
                  >
                    {isTabActive && (
                      <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-primary rounded-full" />
                    )}
                    <BrandLogo
                      engine={p.engine ?? p.id}
                      label={p.label}
                      size={16}
                      className="size-4 shrink-0"
                    />
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right Model List Column */}
          <div className="flex-1 flex flex-col min-w-0 bg-popover/80">
            {/* Search Input Bar */}
            <div className="h-9 px-2.5 border-b border-border flex items-center gap-2 shrink-0">
              <SearchIcon size={14} className="text-muted-foreground shrink-0" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search models..."
                aria-label="Search models"
                className="w-full bg-transparent border-0 text-xs text-foreground placeholder:text-muted-foreground outline-none"
              />
            </div>

            {/* Subheader */}
            <div className="px-2.5 pt-2 pb-1 flex items-center justify-between text-2xs font-semibold uppercase tracking-wider text-muted-foreground shrink-0">
              <span>
                {activeRailTab === 'favorites'
                  ? 'Favorite Models'
                  : `${activeTabProviderRow.label} Models`}
              </span>
              {activeTabProviderRow.detail && activeRailTab !== 'favorites' && (
                <span className="font-normal normal-case text-muted-foreground truncate max-w-[120px]">
                  {activeTabProviderRow.detail}
                </span>
              )}
            </div>

            {/* Scrollable Model Options */}
            <div
              role="listbox"
              aria-label={`${activeTabProviderRow.label} Models`}
              className="flex-1 overflow-y-auto p-1.5 flex flex-col gap-0.5"
            >
              {displayedModels.length > 0 ? (
                displayedModels.map((item) => {
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
                      className={`h-8 px-2.5 rounded-control flex items-center justify-between gap-2 text-xs cursor-pointer transition-colors group shrink-0 ${
                        isSelected
                          ? 'bg-selected-row text-foreground'
                          : 'text-secondary-label hover:text-foreground hover:bg-hover-row'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <BrandLogo
                          engine={activeTabProviderRow.engine ?? activeTabProviderRow.id}
                          label={activeTabProviderRow.label}
                          size={14}
                          className="size-3.5 shrink-0"
                        />
                        <span className="truncate font-medium text-foreground">
                          {item.label}
                        </span>
                        {badge && (
                          <span className="text-2xs px-1.5 py-0.5 rounded-xs bg-surface-elevated text-secondary-label shrink-0">
                            {badge}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {isSelected && (
                          <CheckIcon size={14} className="size-3.5 text-primary shrink-0" />
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
                            className={`size-5 rounded-xs inline-flex items-center justify-center border-0 bg-transparent cursor-pointer transition-opacity ${
                              favored
                                ? 'opacity-100 text-warning'
                                : 'opacity-0 group-hover:opacity-100 text-icon-muted hover:text-foreground'
                            }`}
                          >
                            <StarSvg filled={favored} className="size-3" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="py-8 px-3 text-center text-xs text-muted-foreground">
                  No matching models found.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
