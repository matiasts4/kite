import React from 'react';
import { motion } from 'motion/react';
import { tweens } from '../../../motion/standard/tokens';
import './quotas-tab.css';

export interface SettingsMasterDetailProps {
  label: string;
  sidebar: React.ReactNode;
  detail: React.ReactNode;
  detailKey?: string;
  nested?: boolean;
  flushDetail?: boolean;
  style?: React.CSSProperties;
  className?: string;
}

/**
 * Shared list + detail shell used by provider accounts and the Zed assistant.
 * Same markup and classes so the two settings surfaces stay visually in sync.
 */
export const SettingsMasterDetail: React.FC<SettingsMasterDetailProps> = ({
  label,
  sidebar,
  detail,
  detailKey,
  nested = false,
  flushDetail = false,
  style,
  className = '',
}) => {
  return (
    <div
      className={`qt-providers-container settings-master-detail${
        nested ? ' settings-master-detail--nested' : ''
      }${className ? ` ${className}` : ''}`}
      style={style}
      aria-label={label}
    >
      <div className="qt-providers-sidebar">{sidebar}</div>
      <div className="qt-providers-detail" data-flush={flushDetail ? '' : undefined}>
        <motion.div
          key={detailKey}
          className="settings-master-detail__panel"
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={tweens.reveal}
        >
          {detail}
        </motion.div>
      </div>
    </div>
  );
};

export interface SettingsMasterDetailItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  meta?: React.ReactNode;
}

export function SettingsMasterDetailList({
  label,
  items,
  selectedId,
  onSelect,
}: {
  label: string;
  items: SettingsMasterDetailItem[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const move = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') {
      return;
    }
    event.preventDefault();
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? Math.min(index + 1, items.length - 1)
            : Math.max(index - 1, 0);
    const next = items[nextIndex];
    if (!next || next.id === selectedId) return;
    onSelect(next.id);
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
      '[data-master-detail-item]'
    );
    buttons?.[nextIndex]?.focus();
  };

  return (
    <div className="qt-providers-sidebar__scroll" aria-label={label}>
      {items.map((item, index) => {
        const selected = item.id === selectedId;
        return (
          <button
            key={item.id}
            type="button"
            aria-current={selected ? 'page' : undefined}
            data-master-detail-item=""
            data-selected={selected ? '' : undefined}
            className="qt-providers-sidebar__item"
            onClick={() => onSelect(item.id)}
            onKeyDown={(event) => move(event, index)}
          >
            {item.icon}
            <span className="qt-providers-sidebar__name">{item.label}</span>
            {item.meta}
          </button>
        );
      })}
    </div>
  );
}
