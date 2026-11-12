import type { CompareView } from '../../frame';
import { ToastsSection } from './ToastsSection';
import { BannersSection } from './BannersSection';
import { ProgressSection } from './ProgressSection';
import { SkeletonsSection } from './SkeletonsSection';
import { BadgesSection } from './BadgesSection';
import './feedback.css';

export function FeedbackPage({ view }: { view: CompareView }) {
  return (
    <div className="p3-page" data-page="03" data-view={view}>
      <ToastsSection view={view} />
      <BannersSection view={view} />
      <ProgressSection view={view} />
      <SkeletonsSection view={view} />
      <BadgesSection view={view} />
    </div>
  );
}

export { ToastsSection } from './ToastsSection';
export { BannersSection } from './BannersSection';
export { ProgressSection } from './ProgressSection';
export { SkeletonsSection } from './SkeletonsSection';
export { BadgesSection } from './BadgesSection';
