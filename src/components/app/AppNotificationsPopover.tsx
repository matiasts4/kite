import React from 'react';
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
  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="notification-popover-overlay"
          {...surfaceMotion('scrim')}
          onClick={onClose}
        >
          {(() => {
            const popoverWidth = 320;
            const margin = 10;
            let top = '38px';
            let right = '12px';
            let arrowRight = 24;

            if (anchor) {
              // Snug 2px offset under the bell button: caret tip sits directly against button bottom
              top = `${Math.round(anchor.bottom + 2)}px`;
              const bellCenter = anchor.left + anchor.width / 2;
              // Target arrow at ~24px from popover right edge (half-width of 10px arrow = 5px, so center is at 29px)
              const targetPopoverRight = window.innerWidth - bellCenter - 29;
              const clampedPopoverRight = Math.max(
                margin,
                Math.min(window.innerWidth - popoverWidth - margin, targetPopoverRight)
              );
              right = `${Math.round(clampedPopoverRight)}px`;

              const cardRightEdge = window.innerWidth - clampedPopoverRight;
              const calculatedArrowRight = cardRightEdge - bellCenter - 5;
              arrowRight = Math.max(16, Math.min(popoverWidth - 26, Math.round(calculatedArrowRight)));
            }

            return (
              <motion.div
                {...surfaceMotion('popover')}
                className="notification-popover-anchor"
                style={{
                  top,
                  right,
                  ['--arrow-right' as any]: `${arrowRight}px`,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <NotificationsView
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
          })()}
        </motion.div>
      )}
    </AnimatePresence>
  );
};
