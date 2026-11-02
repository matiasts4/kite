import type { CompareView } from '../../frame';
import { AlertsScene } from '../../scenes';
import { AgentsScene } from './AgentsScene';
import { OnboardingScene } from './OnboardingScene';
import { PlaygroundScene } from './PlaygroundScene';
import './scenes-b.css';

/**
 * Page 07 — system scenes.
 *
 * The notifications/usage scene is the one already shipped in `scenes.tsx`;
 * this page imports it untouched so both pages drive the same component. The
 * other three scenes own their state and render every control twice.
 */
export function ScenesBPage({ view }: { view: CompareView }) {
  return (
    <>
      <AlertsScene view={view} />
      <AgentsScene view={view} />
      <OnboardingScene view={view} />
      <PlaygroundScene view={view} />
    </>
  );
}
