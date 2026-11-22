import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useId,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { BrandLogo } from '../views/agents/engineMetadata';
import { surfaceMotion, surfaceOrigin } from '../../motion/standard/surfaces';
import { springs } from '../../motion/standard/tokens';
import './selectMenuMotion.css';

export interface SelectMenuRow {
  id: string;
  title: string;
  detail?: string;
  badge?: string;
  disabled?: boolean;
  selected?: boolean;
  engine?: string;
  icon?: React.ReactNode;
  sectionTitle?: string;
  ruleBefore?: boolean;
}

export interface SelectMenuProps {
  label: string;
  help?: string;
  value?: string | null;
  rows: SelectMenuRow[];
  onSelect: (id: string) => void;
  disabled?: boolean;
  locked?: boolean;
  searchable?: boolean;
  minWidth?: number;
  closeOnSelect?: boolean;
  triggerLabel?: React.ReactNode;
  triggerEngine?: string;
  triggerIcon?: React.ReactNode;
  triggerBadge?: React.ReactNode;
  variant?: 'field' | 'toolbar';
  panelTitle?: string;
  panelDetail?: string;
  panelEngine?: string;
  panelIcon?: React.ReactNode;
  className?: string;
  searchPlaceholder?: string;
  searchLabel?: string;
  emptyLabel?: string;
}

function rowMatchesQuery(row: SelectMenuRow, raw: string): boolean {
  const q = raw.trim().toLocaleLowerCase();
  if (!q) return true;
  const hay = `${row.title} ${row.detail ?? ''} ${row.id}`.toLocaleLowerCase();
  return q.split(/\s+/).filter(Boolean).every((token) => hay.includes(token));
}

const ChevronDownIcon: React.FC<{ size?: number; className?: string }> = ({ size = 10, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

const CircleCheckIcon: React.FC<{ size?: number; strokeWidth?: number; className?: string }> = ({
  size = 14,
  strokeWidth = 2.5,
  className = '',
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <circle cx="12" cy="12" r="10" />
    <polyline points="9 12 11 14 15 10" />
  </svg>
);

const LockIcon: React.FC<{ size?: number; className?: string }> = ({ size = 9, className = '' }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

const MENU_Z = 10200;
const OVERLAY_LIFT = 20;

/** Lists portaled beside a modal must paint above that modal, not behind it. */
function overlayMenuZIndex(element: HTMLElement): number {
  let max = 0;
  let node: HTMLElement | null = element;
  while (node) {
    const style = window.getComputedStyle(node);
    const positioned =
      style.position === 'fixed' || style.position === 'absolute' || style.position === 'sticky';
    const z = Number.parseInt(style.zIndex, 10);
    if (positioned && Number.isFinite(z) && z > max) max = z;
    node = node.parentElement;
  }
  return Math.max(MENU_Z, max + OVERLAY_LIFT);
}

interface CoordsState {
  left: number;
  top: number;
  width: number;
  origin: 'top' | 'bottom';
  room: number;
  zIndex: number;
  portalHost: HTMLElement;
}

function findFixedContainingBlock(portalHost: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = portalHost;
  while (node && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    const webkitBackdropFilter = (
      style as CSSStyleDeclaration & { webkitBackdropFilter?: string }
    ).webkitBackdropFilter;
    const hasTransform = Boolean(style.transform) && style.transform !== 'none';
    const hasFilter = Boolean(style.filter) && style.filter !== 'none';
    const hasBackdrop =
      (Boolean(style.backdropFilter) && style.backdropFilter !== 'none') ||
      (Boolean(webkitBackdropFilter) && webkitBackdropFilter !== 'none');
    const hasPerspective = Boolean(style.perspective) && style.perspective !== 'none';
    const hasContain =
      Boolean(style.contain) && /\b(layout|paint|strict|content)\b/.test(style.contain);
    if (hasTransform || hasFilter || hasBackdrop || hasPerspective || hasContain) {
      return node;
    }
    // A modal <dialog open> paints in the browser Top Layer, so outer ancestors
    // never establish a fixed-position containing block for its descendants.
    if (node.tagName === 'DIALOG' && node.hasAttribute('open')) {
      return null;
    }
    node = node.parentElement;
  }
  return null;
}

function getAnchoredGeometry(element: HTMLElement) {
  const openDialog = element.closest('dialog[open]') as HTMLElement | null;
  const scaledHost = element.closest('.app-frame--scaled') as HTMLElement | null;
  const portalHost = openDialog ?? scaledHost ?? document.body;
  const containingBlock = findFixedContainingBlock(portalHost);
  const hostRect = containingBlock?.getBoundingClientRect();
  const rawScale = Number(
    openDialog && !containingBlock
      ? 1
      : scaledHost
        ? window.getComputedStyle(scaledHost).getPropertyValue('--ui-scale')
        : 1
  );
  const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
  const originX = hostRect?.left ?? 0;
  const originY = hostRect?.top ?? 0;
  const rect = element.getBoundingClientRect();
  const winWidth = window.innerWidth;
  const winHeight = window.innerHeight;
  const zIndex = overlayMenuZIndex(element);

  let clipLeft = -originX / scale;
  let clipTop = -originY / scale;
  let clipRight = (winWidth - originX) / scale;
  let clipBottom = (winHeight - originY) / scale;

  if (containingBlock && hostRect) {
    const cbStyle = window.getComputedStyle(containingBlock);
    const clipsX = cbStyle.overflowX && cbStyle.overflowX !== 'visible';
    const clipsY = cbStyle.overflowY && cbStyle.overflowY !== 'visible';
    if (clipsX) {
      clipLeft = Math.max(clipLeft, 0);
      clipRight = Math.min(clipRight, hostRect.width / scale);
    }
    if (clipsY) {
      clipTop = Math.max(clipTop, 0);
      clipBottom = Math.min(clipBottom, hostRect.height / scale);
    }
  }

  return {
    bounds: {
      left: (rect.left - originX) / scale,
      top: (rect.top - originY) / scale,
      right: (rect.right - originX) / scale,
      bottom: (rect.bottom - originY) / scale,
      width: rect.width / scale,
      height: rect.height / scale,
    },
    viewport: {
      left: clipLeft,
      top: clipTop,
      right: clipRight,
      bottom: clipBottom,
      width: Math.max(0, clipRight - clipLeft),
      height: Math.max(0, clipBottom - clipTop),
    },
    zIndex,
    portalHost,
  };
}

const GAP = 7;
const MARGIN_BOTTOM = 12;
const EDGE_PADDING = 8;
const MIN_WIDTH = 304;
const DEFAULT_MAX_HEIGHT = 336;
const MIN_ROOM = 120;

export const SelectMenu: React.FC<SelectMenuProps> = ({
  searchable = false,
  label,
  help,
  value,
  rows,
  onSelect,
  disabled = false,
  locked = false,
  minWidth = MIN_WIDTH,
  closeOnSelect = true,
  triggerLabel,
  triggerEngine,
  triggerIcon,
  triggerBadge,
  variant = 'field',
  panelTitle,
  panelDetail,
  panelEngine,
  panelIcon,
  className = '',
  searchPlaceholder = 'Search models…',
  searchLabel = 'Search models',
  emptyLabel = 'No items match your search.',
}) => {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [coords, setCoords] = useState<CoordsState | null>(null);
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const openRef = useRef(isOpen);
  openRef.current = isOpen;
  const menuId = useId();

  const maxRowsHeight = rows.length > 7 ? DEFAULT_MAX_HEIGHT : Infinity;
  const maxRowsHeightRef = useRef(maxRowsHeight);
  maxRowsHeightRef.current = maxRowsHeight;

  const filteredRows = useMemo(
    () => rows.filter((row) => rowMatchesQuery(row, query)),
    [query, rows]
  );

  const enabledRows = useMemo(() => filteredRows.filter((r) => !r.disabled), [filteredRows]);

  const closeMenu = useCallback((restoreFocus = true) => {
    setIsOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus({ preventScroll: true });
    }
  }, []);

  const handleExitComplete = useCallback(() => {
    // Keep the last geometry while the exit plays, then release it.
    setCoords(null);
    setPanelEl(null);
  }, []);

  const attachPanel = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    setPanelEl(node);
  }, []);

  // A leaving panel keeps the element it last rendered, so its inline style is
  // stale: switch pointer events off when the exit actually starts.
  const handlePanelAnimationStart = useCallback(() => {
    const node = panelRef.current;
    if (node) node.style.pointerEvents = openRef.current ? '' : 'none';
  }, []);

  const openMenu = useCallback(() => {
    if (disabled) return;
    setQuery('');
    setHighlightedId(rows.some((r) => r.id === value && !r.disabled) ? (value ?? null) : null);
    setIsOpen(true);
  }, [disabled, rows, value]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    // Batch all layout reads (trigger rect, viewport, panel/rows geometry) before updating state.
    const { bounds, viewport, zIndex, portalHost } = getAnchoredGeometry(trigger);
    const panelOffsetHeight = panelEl ? panelEl.offsetHeight : 0;
    const rowsEl = rowsRef.current;
    const rowsClientHeight = rowsEl ? rowsEl.clientHeight : 0;
    const rowsScrollHeight = rowsEl ? rowsEl.scrollHeight : 0;

    const width = Math.min(
      Math.max(bounds.width, minWidth),
      Math.max(160, viewport.width - EDGE_PADDING * 2)
    );
    const left = Math.max(
      viewport.left + EDGE_PADDING,
      Math.min(bounds.left, viewport.right - width - EDGE_PADDING)
    );

    const spaceBelow = viewport.bottom - bounds.bottom - MARGIN_BOTTOM - EDGE_PADDING;
    const spaceAbove = bounds.top - viewport.top - MARGIN_BOTTOM - EDGE_PADDING;

    let panelHeight = 0;
    if (panelEl) {
      if (rowsEl) {
        const maxRows = maxRowsHeightRef.current;
        const desiredRowsHeight = Number.isFinite(maxRows)
          ? Math.min(rowsScrollHeight, maxRows)
          : rowsScrollHeight;
        const chromeHeight = Math.max(0, panelOffsetHeight - rowsClientHeight);
        panelHeight = chromeHeight + desiredRowsHeight;
      } else {
        panelHeight = panelOffsetHeight;
      }
    }
    if (panelHeight === 0) {
      panelHeight = spaceBelow < 200 && spaceAbove > spaceBelow ? Math.min(spaceAbove, 180) : 0;
    }

    const placeAbove = panelHeight > spaceBelow && (panelHeight <= spaceAbove || spaceAbove > spaceBelow);
    const room = Math.max(MIN_ROOM, placeAbove ? spaceAbove : spaceBelow);

    const top = placeAbove
      ? Math.max(viewport.top + EDGE_PADDING, bounds.top - MARGIN_BOTTOM - Math.min(panelHeight || room, room))
      : bounds.bottom + GAP;

    const origin: 'top' | 'bottom' = placeAbove ? 'bottom' : 'top';

    setCoords((prev) => {
      if (
        prev &&
        prev.left === left &&
        prev.top === top &&
        prev.width === width &&
        prev.origin === origin &&
        prev.room === room &&
        prev.zIndex === zIndex &&
        prev.portalHost === portalHost
      ) {
        return prev;
      }
      return {
        left,
        top,
        width,
        origin,
        room,
        zIndex,
        portalHost,
      };
    });
  }, [minWidth, panelEl]);

  const schedulePositionUpdate = useCallback(() => {
    if (rafIdRef.current !== null) {
      window.cancelAnimationFrame(rafIdRef.current);
    }
    rafIdRef.current = window.requestAnimationFrame(() => {
      rafIdRef.current = null;
      if (openRef.current) {
        updatePosition();
      }
    });
  }, [updatePosition]);

  useLayoutEffect(() => {
    if (isOpen) {
      updatePosition();
    }
  }, [isOpen, updatePosition]);

  useLayoutEffect(() => {
    if (!isOpen || !panelEl || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(schedulePositionUpdate);
    ro.observe(panelEl);
    if (triggerRef.current) ro.observe(triggerRef.current);
    const scaledHost = triggerRef.current?.closest('.app-frame--scaled');
    if (scaledHost) ro.observe(scaledHost);
    const openDialog = triggerRef.current?.closest('dialog[open]');
    if (openDialog && openDialog !== scaledHost) ro.observe(openDialog);
    return () => {
      ro.disconnect();
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [isOpen, panelEl, schedulePositionUpdate]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (
        panelRef.current?.contains(target) ||
        triggerRef.current?.contains(target) ||
        (target instanceof Element && target.closest('[data-select-menu]'))
      ) {
        return;
      }
      closeMenu(false);
    };

    const handleBlur = () => closeMenu(false);
    const handleScroll = (e: Event) => {
      const target = e.target as Node | null;
      if (target && panelRef.current?.contains(target)) {
        return;
      }
      schedulePositionUpdate();
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('resize', schedulePositionUpdate);
    window.addEventListener('scroll', handleScroll, true);

    return () => {
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('resize', schedulePositionUpdate);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isOpen, closeMenu, schedulePositionUpdate]);

  useEffect(() => {
    if (!isOpen) return;
    const frame = window.requestAnimationFrame(() => {
      if (searchable && searchInputRef.current) {
        searchInputRef.current.focus({ preventScroll: true });
      } else {
        panelRef.current?.focus({ preventScroll: true });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isOpen, searchable]);

  const handlePick = (row: SelectMenuRow) => {
    if (row.disabled) return;
    if (closeOnSelect) {
      closeMenu(true);
    }
    onSelect(row.id);
  };

  const handleTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (isOpen || disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
      e.preventDefault();
      openMenu();
    }
  };

  const handlePanelKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (enabledRows.length === 0) return;
      const currentIndex = enabledRows.findIndex((r) => r.id === highlightedId);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const nextIndex =
        currentIndex < 0
          ? 0
          : (currentIndex + step + enabledRows.length) % enabledRows.length;
      setHighlightedId(enabledRows[nextIndex].id);
      return;
    }

    if (e.key === 'Home') {
      if (enabledRows.length > 0) {
        e.preventDefault();
        setHighlightedId(enabledRows[0].id);
      }
      return;
    }

    if (e.key === 'End') {
      if (enabledRows.length > 0) {
        e.preventDefault();
        setHighlightedId(enabledRows[enabledRows.length - 1].id);
      }
      return;
    }

    if (e.key === 'Enter' || (e.key === ' ' && e.target !== searchInputRef.current)) {
      e.preventDefault();
      const current = enabledRows.find((r) => r.id === highlightedId);
      if (current) {
        handlePick(current);
      }
    }
  };

  const effectiveMaxRowsHeight = coords ? Math.min(maxRowsHeight, coords.room) : maxRowsHeight;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        title={help ?? label}
        disabled={disabled}
        onClick={() => (isOpen ? closeMenu(true) : openMenu())}
        onKeyDown={handleTriggerKeyDown}
        className={`select-menu-trigger select-menu-trigger--${variant}${
          isOpen ? ' select-menu-trigger--open' : ''
        } ${className}`.trim()}
      >
        {triggerEngine ? (
          <BrandLogo engine={triggerEngine} size={13} />
        ) : triggerIcon ? (
          <span aria-hidden="true" className="select-menu-trigger__icon">
            {triggerIcon}
          </span>
        ) : null}

        {triggerLabel ? (
          <span className="select-menu-trigger__label">{triggerLabel}</span>
        ) : null}

        {triggerBadge ? (
          <span className="select-menu-trigger__badge">{triggerBadge}</span>
        ) : null}

        {locked ? (
          <LockIcon size={9} className="select-menu-trigger__lock" />
        ) : (
          <ChevronDownIcon size={10} className="select-menu-trigger__chevron" />
        )}
      </button>

      {coords &&
        createPortal(
          <AnimatePresence onExitComplete={handleExitComplete}>
            {isOpen ? (
              <motion.div
                key="select-menu"
                {...surfaceMotion('popover')}
                transition={springs.pop}
                id={menuId}
                ref={attachPanel}
                data-select-menu="true"
                role={searchable ? 'dialog' : 'listbox'}
                aria-label={panelTitle ?? label}
                tabIndex={-1}
                onKeyDown={handlePanelKeyDown}
                onAnimationStart={handlePanelAnimationStart}
                className={`select-menu select-menu--from-${coords.origin} select-menu--motion${
                  searchable ? ' select-menu--searchable' : ''
                }`}
                style={{
                  position: 'fixed',
                  zIndex: coords.zIndex,
                  left: `${coords.left}px`,
                  top: `${coords.top}px`,
                  width: `${coords.width}px`,
                  maxHeight: `${coords.room}px`,
                  transformOrigin: surfaceOrigin(coords.origin),
                  '--select-menu-rows-max': `${effectiveMaxRowsHeight}px`,
                } as React.CSSProperties}
              >
                {panelTitle ? (
                  <>
                    <div className="select-menu__header">
                      <span className="select-menu__header-text">
                        <span className="select-menu__header-title">{panelTitle}</span>
                        {panelDetail ? (
                          <span className="select-menu__header-detail">{panelDetail}</span>
                        ) : null}
                      </span>
                      {panelEngine ? (
                        <span className="select-menu__header-mark">
                          <BrandLogo engine={panelEngine} size={15} />
                        </span>
                      ) : panelIcon ? (
                        <span aria-hidden="true" className="select-menu__header-mark">
                          {panelIcon}
                        </span>
                      ) : null}
                    </div>
                    <span aria-hidden="true" className="select-menu__rule" />
                  </>
                ) : null}

                {searchable ? (
                  <input
                    ref={searchInputRef}
                    type="text"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded="true"
                    aria-label={searchLabel}
                    placeholder={searchPlaceholder}
                    value={query}
                    onChange={(e) => {
                      const val = e.currentTarget.value;
                      setQuery(val);
                      const firstMatch = rows.find(
                        (row) => !row.disabled && rowMatchesQuery(row, val)
                      );
                      setHighlightedId(firstMatch ? firstMatch.id : null);
                    }}
                    className="select-menu__search"
                  />
                ) : null}

                {filteredRows.length === 0 ? (
                  <div className="select-menu__empty" role="status">
                    {emptyLabel}
                  </div>
                ) : null}

                <div ref={rowsRef} className="select-menu__rows" role="listbox">
                  {filteredRows.map((row) => {
                    const isSelected = row.selected ?? row.id === value;
                    const isHighlighted = row.id === highlightedId;
                    const hasMark = row.engine !== undefined || row.icon !== undefined;

                    return (
                      <React.Fragment key={row.id}>
                        {row.sectionTitle ? (
                          <div className="select-menu__section">{row.sectionTitle}</div>
                        ) : null}
                        {row.ruleBefore ? (
                          <span aria-hidden="true" className="select-menu__rule" />
                        ) : null}
                        <div
                          id={`${menuId}-${row.id}`}
                          role="option"
                          aria-selected={isSelected}
                          aria-disabled={row.disabled || undefined}
                          data-highlighted={isHighlighted ? 'true' : undefined}
                          tabIndex={-1}
                          onClick={() => handlePick(row)}
                          onPointerMove={() => {
                            if (!row.disabled) setHighlightedId(row.id);
                          }}
                          className={`select-menu__row${hasMark ? ' select-menu__row--marked' : ''}`}
                        >
                          {isHighlighted ? (
                            <motion.span
                              layoutId={`${menuId}-highlight`}
                              className="select-menu__row-highlight"
                              data-selected={isSelected ? 'true' : undefined}
                              transition={springs.highlight}
                              initial={false}
                              aria-hidden="true"
                            />
                          ) : null}

                          {row.engine !== undefined ? (
                            <span className="select-menu__row-mark">
                              <BrandLogo engine={row.engine} size={16} />
                            </span>
                          ) : row.icon !== undefined ? (
                            <span aria-hidden="true" className="select-menu__row-mark">
                              {row.icon}
                            </span>
                          ) : null}

                          <span className="select-menu__row-text">
                            <span className="select-menu__row-title">{row.title}</span>
                            {row.detail ? (
                              <span className="select-menu__row-detail">{row.detail}</span>
                            ) : null}
                          </span>

                          {row.badge ? (
                            <span className="select-menu__row-badge">{row.badge}</span>
                          ) : null}

                          <span className="select-menu__row-check">
                            {isSelected ? (
                              <motion.span
                                layoutId={closeOnSelect ? `${menuId}-check` : undefined}
                                className="select-menu__check-surface"
                                transition={springs.highlight}
                                initial={false}
                              >
                                <CircleCheckIcon
                                  size={14}
                                  strokeWidth={2.5}
                                  className="select-menu__check-disc"
                                />
                              </motion.span>
                            ) : null}
                          </span>
                        </div>
                      </React.Fragment>
                    );
                  })}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>,
          coords.portalHost
        )}
    </>
  );
};
