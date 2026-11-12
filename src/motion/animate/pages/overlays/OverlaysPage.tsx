import type { CompareView } from '../../frame';
import { DialogScene } from './DialogScene';
import { SheetScene } from './SheetScene';
import { AnchorScene } from './AnchorScene';
import { PaletteScene } from './PaletteScene';
import { InboxScene } from './InboxScene';
import './overlays.css';

export { DialogScene } from './DialogScene';
export { SheetScene } from './SheetScene';
export { AnchorScene } from './AnchorScene';
export { PaletteScene } from './PaletteScene';
export { InboxScene } from './InboxScene';

export function OverlaysPage({ view }: { view: CompareView }) {
  return (
    <div className="p5-page" data-page="05" data-view={view}>
      <DialogScene view={view} />
      <SheetScene view={view} />
      <AnchorScene view={view} />
      <PaletteScene view={view} />
      <InboxScene view={view} />
    </div>
  );
}
