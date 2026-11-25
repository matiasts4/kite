import React, { useId, useRef } from 'react';
import './primitives.css';

export type TabsSize = 'sm' | 'md';

export interface TabItem {
  id: string;
  label: React.ReactNode;
  disabled?: boolean;
  badge?: React.ReactNode;
  content?: React.ReactNode;
}

export interface TabsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  items: TabItem[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  size?: TabsSize;
}

export const Tabs: React.FC<TabsProps> = ({
  items,
  value,
  onChange,
  ariaLabel,
  size = 'md',
  className = '',
  ...rest
}) => {
  const baseId = useId();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const activeItem = items.find((item) => item.id === value);

  const moveFocus = (targetItem: TabItem | undefined) => {
    if (!targetItem) return;
    onChange(targetItem.id);
    tabRefs.current[targetItem.id]?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    const enabledItems = items.filter((item) => !item.disabled);
    if (enabledItems.length === 0) return;

    const currentItem = items[currentIndex];
    const enabledIdx = enabledItems.findIndex((item) => item.id === currentItem?.id);

    if (event.key === 'ArrowRight') {
      event.preventDefault();
      const next = enabledItems[(enabledIdx + 1) % enabledItems.length];
      moveFocus(next);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      const prev = enabledItems[(enabledIdx - 1 + enabledItems.length) % enabledItems.length];
      moveFocus(prev);
    } else if (event.key === 'Home') {
      event.preventDefault();
      moveFocus(enabledItems[0]);
    } else if (event.key === 'End') {
      event.preventDefault();
      moveFocus(enabledItems[enabledItems.length - 1]);
    }
  };

  return (
    <div className={['kite-tabs', className].filter(Boolean).join(' ')} {...rest}>
      <div role="tablist" aria-label={ariaLabel} className="kite-tabs__list">
        {items.map((item, idx) => {
          const isSelected = item.id === value;
          const tabId = `${baseId}-tab-${item.id}`;
          const panelId = `${baseId}-panel-${item.id}`;

          return (
            <button
              key={item.id}
              ref={(el) => {
                tabRefs.current[item.id] = el;
              }}
              id={tabId}
              type="button"
              role="tab"
              aria-selected={isSelected}
              aria-controls={item.content !== undefined ? panelId : undefined}
              tabIndex={isSelected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => {
                if (!item.disabled) onChange(item.id);
              }}
              onKeyDown={(event) => handleKeyDown(event, idx)}
              className={['kite-tabs__tab', `kite-tabs__tab--${size}`].join(' ')}
            >
              <span>{item.label}</span>
              {item.badge}
            </button>
          );
        })}
      </div>
      {activeItem && activeItem.content !== undefined && (
        <div
          role="tabpanel"
          id={`${baseId}-panel-${activeItem.id}`}
          aria-labelledby={`${baseId}-tab-${activeItem.id}`}
          className="kite-tabs__panel"
        >
          {activeItem.content}
        </div>
      )}
    </div>
  );
};
