import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { usePresence } from '../../../usePresence';
import { motionSurfaceClass } from '../../../surface';
import { useLabMotion, useLabReduce } from '../../context';
import type { CompareVariant } from '../../frame';
import { CheckIcon, ChevronDownIcon } from '../../ui';
import { useCanHover, type Direction } from './shared';

export type MenuEntry =
  | { kind: 'separator'; id: string }
  | { kind: 'action'; id: string; label: string; danger?: boolean; hint?: string }
  | { kind: 'check'; id: string; label: string; checked: boolean }
  | { kind: 'submenu'; id: string; label: string; items: { id: string; label: string }[] };

export interface MenuPanelProps {
  mode: CompareVariant;
  entries: MenuEntry[];
  onAction: (id: string) => void;
  onToggleCheck: (id: string) => void;
  onRequestClose: (restoreFocus: boolean) => void;
  autoFocus: boolean;
}

export function Submenu({
  mode,
  items,
  labelledBy,
  autoFocus,
  onPick,
  onBack,
}: {
  mode: CompareVariant;
  items: { id: string; label: string }[];
  labelledBy: string;
  autoFocus: boolean;
  onPick: (id: string) => void;
  onBack: () => void;
}) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const highlightKey = useId();
  const [hovered, setHovered] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    if (!autoFocus) return;
    itemRefs.current.get(items[0]?.id)?.focus();
    // Focus only when the submenu is opened from the keyboard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  const move = (delta: number) => {
    const index = items.findIndex((item) => itemRefs.current.get(item.id) === document.activeElement);
    const next = (index + delta + items.length) % items.length;
    itemRefs.current.get(items[next]?.id)?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Escape' || event.key === 'ArrowLeft' || event.key === 'Tab') {
      event.preventDefault();
      onBack();
    }
  };

  const rows = items.map((item) => (
    <button
      key={item.id}
      ref={(node) => {
        if (node) itemRefs.current.set(item.id, node);
        else itemRefs.current.delete(item.id);
      }}
      type="button"
      role="menuitem"
      tabIndex={-1}
      className="cmp-menu__item"
      onPointerEnter={() => setHovered(item.id)}
      onFocus={() => setHovered(item.id)}
      onClick={() => onPick(item.id)}
    >
      {mode === 'animate' && hovered === item.id && (
        <motion.span
          layoutId={`p2-submenu-highlight-${highlightKey}`}
          className="cmp-menu__highlight"
          initial={false}
          transition={reduce ? tokens.tweens.instant : tokens.springs.highlight}
          aria-hidden="true"
        />
      )}
      <span className="cmp-menu__label">{item.label}</span>
    </button>
  ));

  if (mode === 'kite') {
    return (
      <div
        className="cmp-menu p2-submenu p2-menu--kite"
        role="menu"
        aria-labelledby={labelledBy}
        onKeyDown={handleKeyDown}
      >
        {rows}
      </div>
    );
  }

  return (
    <motion.div
      className="cmp-menu p2-submenu p2-menu--animate"
      role="menu"
      aria-labelledby={labelledBy}
      onKeyDown={handleKeyDown}
      initial={{ opacity: 0, scale: reduce ? 1 : tokens.scale.menu }}
      animate={{ opacity: 1, scale: 1, transition: tokens.tweens.menu }}
      style={{ transformOrigin: 'top left' }}
    >
      {rows}
    </motion.div>
  );
}

export function MenuPanel({
  mode,
  entries,
  onAction,
  onToggleCheck,
  onRequestClose,
  autoFocus,
}: MenuPanelProps) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const canHover = useCanHover();
  const highlightKey = useId();
  const [hovered, setHovered] = useState<string | null>(null);
  const [submenu, setSubmenu] = useState<{ id: string; focusFirst: boolean } | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());

  const focusables = entries.filter((entry) => entry.kind !== 'separator');

  useEffect(() => {
    if (!autoFocus) return;
    const first = focusables[0];
    if (first) itemRefs.current.get(first.id)?.focus();
    // The menu mounts (or remounts) when it opens; focus once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  const focusItem = (index: number) => {
    const entry = focusables[index];
    if (entry) itemRefs.current.get(entry.id)?.focus();
  };

  const closeSubmenu = () => {
    if (!submenu) return;
    const trigger = itemRefs.current.get(submenu.id);
    setSubmenu(null);
    trigger?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('.p2-submenu')) return;

    const current = focusables.findIndex(
      (entry) => itemRefs.current.get(entry.id) === document.activeElement
    );

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const next = current < 0 ? 0 : (current + delta + focusables.length) % focusables.length;
      focusItem(next);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusItem(event.key === 'Home' ? 0 : focusables.length - 1);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (submenu) closeSubmenu();
      else onRequestClose(true);
      return;
    }
    if (event.key === 'Tab') {
      onRequestClose(false);
      return;
    }
    if (event.key === 'ArrowRight') {
      const entry = focusables[current];
      if (entry?.kind === 'submenu') {
        event.preventDefault();
        setSubmenu({ id: entry.id, focusFirst: true });
      }
      return;
    }
    if (event.key === 'ArrowLeft' && submenu) {
      event.preventDefault();
      closeSubmenu();
    }
  };

  const choose = (id: string) => {
    onAction(id);
    onRequestClose(true);
  };

  return (
    <div
      className="p2-menu-panel"
      role="none"
      onKeyDown={handleKeyDown}
      onPointerLeave={() => {
        setHovered(null);
        setSubmenu(null);
      }}
    >
      {entries.map((entry) => {
        if (entry.kind === 'separator') {
          return <div key={entry.id} className="p2-menu__sep" role="separator" />;
        }

        if (entry.kind === 'submenu') {
          return (
            <div
              key={entry.id}
              className="p2-sub-wrap"
              role="none"
              onPointerEnter={
                canHover
                  ? () => {
                      setHovered(entry.id);
                      setSubmenu((current) =>
                        current?.id === entry.id ? current : { id: entry.id, focusFirst: false }
                      );
                    }
                  : undefined
              }
            >
              <button
                id={`${highlightKey}-${entry.id}`}
                ref={(node) => {
                  if (node) itemRefs.current.set(entry.id, node);
                  else itemRefs.current.delete(entry.id);
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-haspopup="menu"
                aria-expanded={submenu?.id === entry.id}
                className="cmp-menu__item"
                onPointerEnter={() => setHovered(entry.id)}
                onFocus={() => setHovered(entry.id)}
                onClick={() =>
                  setSubmenu((current) =>
                    current?.id === entry.id ? null : { id: entry.id, focusFirst: true }
                  )
                }
              >
                {mode === 'animate' && hovered === entry.id && (
                  <motion.span
                    layoutId={`p2-menu-highlight-${highlightKey}`}
                    className="cmp-menu__highlight"
                    initial={false}
                    transition={reduce ? tokens.tweens.instant : tokens.springs.highlight}
                    aria-hidden="true"
                  />
                )}
                <span className="cmp-menu__label">{entry.label}</span>
                <span className="p2-menu-item__chevron" aria-hidden="true">
                  <ChevronDownIcon size={11} />
                </span>
              </button>
              {submenu?.id === entry.id && (
                <Submenu
                  mode={mode}
                  items={entry.items}
                  labelledBy={`${highlightKey}-${entry.id}`}
                  onPick={choose}
                  onBack={closeSubmenu}
                  autoFocus={submenu.focusFirst}
                />
              )}
            </div>
          );
        }

        const isCheck = entry.kind === 'check';
        return (
          <button
            key={entry.id}
            ref={(node) => {
              if (node) itemRefs.current.set(entry.id, node);
              else itemRefs.current.delete(entry.id);
            }}
            type="button"
            role={isCheck ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={isCheck ? entry.checked : undefined}
            tabIndex={-1}
            className={`cmp-menu__item${entry.kind === 'action' && entry.danger ? ' cmp-menu__item--danger' : ''}`}
            onPointerEnter={
              canHover
                ? () => {
                    setHovered(entry.id);
                    setSubmenu(null);
                  }
                : undefined
            }
            onFocus={() => setHovered(entry.id)}
            onClick={() => {
              if (entry.kind === 'check') onToggleCheck(entry.id);
              else choose(entry.id);
            }}
          >
            {mode === 'animate' && hovered === entry.id && (
              <motion.span
                layoutId={`p2-menu-highlight-${highlightKey}`}
                className="cmp-menu__highlight"
                initial={false}
                transition={reduce ? tokens.tweens.instant : tokens.springs.highlight}
                aria-hidden="true"
              />
            )}
            {isCheck && (
              <span className={`p2-menu-item__check${entry.checked ? ' is-checked' : ''}`}>
                {mode === 'animate' && entry.checked ? (
                  <motion.span
                    initial={{ opacity: 0, scale: reduce ? 1 : tokens.scale.icon }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={reduce ? tokens.tweens.instant : tokens.tweens.swap}
                  >
                    <CheckIcon size={11} />
                  </motion.span>
                ) : (
                  <CheckIcon size={11} />
                )}
              </span>
            )}
            <span className="cmp-menu__label">{entry.label}</span>
            {entry.kind === 'action' && entry.hint && (
              <span className="p2-menu-item__hint">{entry.hint}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export interface MenuSurfaceProps {
  mode: CompareVariant;
  open: boolean;
  entries: MenuEntry[];
  onAction: (id: string) => void;
  onToggleCheck: (id: string) => void;
  onClose: () => void;
  onRestoreFocus: () => void;
  autoFocus: boolean;
  labelledBy: string;
  className?: string;
  style?: CSSProperties;
  surfaceId?: string;
  layoutId?: string;
  contentKey?: string;
  handoffDirection?: Direction;
  animateContent?: boolean;
}

export function MenuSurface({
  mode,
  open,
  entries,
  onAction,
  onToggleCheck,
  onClose,
  onRestoreFocus,
  autoFocus,
  labelledBy,
  className = '',
  style,
  surfaceId,
  layoutId,
  contentKey,
  handoffDirection = 1,
  animateContent = false,
}: MenuSurfaceProps) {
  const tokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);
  const classes = `cmp-menu p2-menu p2-menu--${mode} ${className}`.trim();

  const requestClose = (restoreFocus: boolean) => {
    onClose();
    if (restoreFocus) window.requestAnimationFrame(onRestoreFocus);
  };

  const panel = (
    <MenuPanel
      mode={mode}
      entries={entries}
      onAction={onAction}
      onToggleCheck={onToggleCheck}
      onRequestClose={requestClose}
      autoFocus={autoFocus}
    />
  );

  const content =
    animateContent && mode === 'animate' ? (
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={contentKey ?? 'menu'}
          className="p2-menu-content"
          role="none"
          initial={{
            opacity: 0,
            x: reduce ? 0 : handoffDirection * tokens.shift.handoff,
          }}
          animate={{ opacity: 1, x: 0, transition: tokens.tweens.fade }}
          exit={{
            opacity: 0,
            x: reduce ? 0 : -handoffDirection * tokens.shift.handoff,
            transition: tokens.tweens.fade,
          }}
        >
          {panel}
        </motion.div>
      </AnimatePresence>
    ) : (
      panel
    );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div
        id={surfaceId}
        className={`${classes} ${motionSurfaceClass(presence.phase, 'popover')}`}
        style={style}
        role="menu"
        aria-labelledby={labelledBy}
      >
        {content}
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          id={surfaceId}
          className={classes}
          style={{ transformOrigin: 'top left', ...style }}
          role="menu"
          aria-labelledby={labelledBy}
          layoutId={layoutId}
          transition={layoutId ? tokens.springs.selection : undefined}
          initial={{ opacity: 0, scale: reduce ? 1 : tokens.scale.menu }}
          animate={{ opacity: 1, scale: 1, transition: tokens.tweens.menu }}
          exit={{
            opacity: 0,
            scale: reduce ? 1 : tokens.scale.menu,
            transition: tokens.tweens.dismiss,
          }}
        >
          {content}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
