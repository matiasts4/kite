import type { CompareView } from '../../frame';
import { CardsScene } from './cards';
import { ListsScene } from './lists';
import { NumbersScene } from './numbers';
import { StreamsScene } from './streams';
import { TableScene } from './table';
import { TextScene } from './text';
import './data.css';

export function DataPage({ view }: { view: CompareView }) {
  return (
    <div className="p4-page" data-page="04" data-view={view}>
      <ListsScene view={view} />
      <TableScene view={view} />
      <CardsScene view={view} />
      <NumbersScene view={view} />
      <TextScene view={view} />
      <StreamsScene view={view} />
    </div>
  );
}
