import type { CompareView } from '../../frame';
import { SharedElementScene } from './SharedElementScene';
import { ReorderScene } from './ReorderScene';
import { KanbanScene } from './KanbanScene';
import { ScrollScene } from './ScrollScene';
import { ViewTransitionScene } from './ViewTransitionScene';
import './gestures.css';

export {
  SharedElementScene,
  ReorderScene,
  KanbanScene,
  ScrollScene,
  ViewTransitionScene,
};

export function GesturesPage({ view }: { view: CompareView }) {
  return (
    <>
      <SharedElementScene view={view} />
      <ReorderScene view={view} />
      <KanbanScene view={view} />
      <ScrollScene view={view} />
      <ViewTransitionScene view={view} />
    </>
  );
}
