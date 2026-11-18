import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { surfaceMotion } from '../../motion/standard/surfaces';
import { NotificationsView } from '../views/NotificationsView';
import { writeKitePref } from '../../lib/kitePrefs';
import type { WorkMode } from '../Sidebar';
import type { NotificationsSnapshot } from '../../types';

export interface AppNotificationsPopoverProps {
  isOpen: boolean;
  anchor: DOMRect | null;
  notifSnapshot: NotificationsSnapshot | null;
  onClose: () => void;
  setSelectedAgentId: (id: string | null) => void;
  setSelectedThreadId: (id: string | null) => void;
  setWorkMode: (mode: WorkMode) => void;
  setSettingsOpen: (open: boolean) => void;
}

export const AppNotificationsPopover: React.FC<AppNotificationsPopoverProps> = ({
  isOpen,
  anchor,
  notifSnapshot,
  onClose,
  setSelectedAgentId,
  setSelectedThreadId,
  setWorkMode,
  setSettingsOpen,
}) => {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; right: number }>({
    top: 44,
    right: 16,
  });

  useEffect(() => {
    if (!isOpen) return;
    const updatePosition = () => {
      if (anchor) {
        const margin = 12;
        const top = Math.round(anchor.bottom + 6);
        const right = Math.max(margin, Math.round(window.innerWidth - anchor.right));
        setPosition({ top, right });
      } else {
        setPosition({ top: 44, right: 16 });
      }
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    return () => window.removeEventListener('resize', updatePosition);
  }, [isOpen, anchor]);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (popoverRef.current && target && !popoverRef.current.contains(target)) {
        if (!target.closest('.notification-bell')) {
          onClose();
        }
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  const popoverNode = (
    <motion.div
      {...surfaceMotion('popover')}
      ref={popoverRef}
      role="dialog"
      aria-label="Notifications"
      className="notification-center notification-center--popover"
      style={{
        position: 'fixed',
        top: `${position.top}px`,
        right: `${position.right}px`,
        transformOrigin: 'top right',
        zIndex: 10001,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <NotificationsView
        embedded
        externalSnapshot={notifSnapshot}
        onClose={onClose}
        onNavigateAgent={(id) => {
          setSelectedAgentId(id);
          setWorkMode('agent');
          onClose();
        }}
        onNavigateThread={(threadId, agentId) => {
          if (agentId) {
            setSelectedAgentId(agentId);
            setWorkMode('agent');
          } else {
            setWorkMode('code');
          }
          setSelectedThreadId(threadId);
          onClose();
        }}
        onNavigateMode={(m) => {
          setWorkMode(m);
          onClose();
        }}
        onOpenSettings={() => {
          onClose();
          setSettingsOpen(true);
          try {
            writeKitePref('settingsTab', 'notifications');
          } catch (_) {}
        }}
      />
    </motion.div>
  );

  if (typeof document === 'undefined') return null;

  return createPortal(
    <AnimatePresence>{isOpen && popoverNode}</AnimatePresence>,
    document.body
  );
};
