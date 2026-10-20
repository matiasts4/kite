import React from 'react';
import { FocusTimerApp } from './apps/FocusTimerApp';
import { ScratchpadApp } from './apps/ScratchpadApp';
import { BombSprintApp } from './apps/BombSprintApp';
import { KiteVerseApp } from './apps/KiteVerseApp';

export type SidePanelAppId = 'focusTimer' | 'scratchpad' | 'bombSprint' | 'kiteVerse';

export const APP_TITLES: Record<SidePanelAppId, string> = {
  focusTimer: 'Focus Timer',
  scratchpad: 'Scratchpad',
  bombSprint: 'Bomb Sprint',
  kiteVerse: 'KiteVerse',
};

export interface SidePanelAppsViewProps {
  app?: SidePanelAppId | null;
  title?: string;
}

function renderAppContent(app: SidePanelAppId): React.ReactElement | null {
  switch (app) {
    case 'focusTimer':
      return <FocusTimerApp />;
    case 'scratchpad':
      return <ScratchpadApp />;
    case 'bombSprint':
      return <BombSprintApp />;
    case 'kiteVerse':
      return <KiteVerseApp />;
    default:
      return null;
  }
}

// Host container per side panel app tab.
export const SidePanelAppsView: React.FC<SidePanelAppsViewProps> = ({ app, title }) => {
  if (!app) return null;

  return (
    <section aria-label={title || APP_TITLES[app]} className="side-panel-app" data-app={app}>
      {renderAppContent(app)}
    </section>
  );
};
