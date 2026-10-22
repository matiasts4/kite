import React from 'react';
import { usePresence } from './usePresence';
import { motionSurfaceClass } from './surface';
import './appIntro.css';

export interface AppIntroProps {
  open: boolean;
}

export const AppIntro: React.FC<AppIntroProps> = ({ open }) => {
  const presence = usePresence(open);
  if (!presence.mounted) return null;

  const layerMotion = motionSurfaceClass(presence.phase, 'scrim');
  const panelMotion = motionSurfaceClass(presence.phase, 'modal');

  return (
    <div
      className={`app-intro${layerMotion ? ` ${layerMotion}` : ''}`}
      role="status"
      aria-live="polite"
      aria-busy={presence.phase === 'in'}
      aria-label="Starting Kite"
    >
      <div className={`app-intro__panel${panelMotion ? ` ${panelMotion}` : ''}`}>
        <img src="/assets/kite-symbol.svg" alt="" className="app-intro__mark" width={56} height={56} />
        <span className="app-intro__title">Kite</span>
        <p className="app-intro__hint">Preparing your workspace…</p>
      </div>
    </div>
  );
};
