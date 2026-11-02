import type { CompareView } from '../../frame';
import { StadiumButtonsSection } from './StadiumButtonsSection';
import { ButtonsSection } from './ButtonsSection';
import { IconsSection } from './IconsSection';
import { InputsSection } from './InputsSection';
import { InterruptionSection } from './InterruptionSection';
import { SelectionSection } from './SelectionSection';
import './controls.css';

export function ControlsPage({ view }: { view: CompareView }) {
  return (
    <div className="p1-page" data-page="01" data-view={view}>
      <StadiumButtonsSection view={view} />
      <ButtonsSection view={view} />
      <IconsSection view={view} />
      <SelectionSection view={view} />
      <InputsSection view={view} />
      <InterruptionSection view={view} />
    </div>
  );
}
