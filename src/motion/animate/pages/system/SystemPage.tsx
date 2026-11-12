import type { CompareView } from '../../frame';
import { TokenReference } from './TokenReference';
import { LevelMatrix } from './LevelMatrix';
import { ReducedMotionSection } from './ReducedMotionSection';
import { ParitySection } from './ParitySection';
import { InterruptionSection } from './InterruptionSection';
import './system.css';

export function SystemPage({ view }: { view: CompareView }) {
  return (
    <div className="p9-page" data-page="09" data-view={view}>
      <TokenReference />
      <LevelMatrix />
      <ReducedMotionSection />
      <ParitySection view={view} />
      <InterruptionSection view={view} />
    </div>
  );
}
