import type { CompareView } from '../../frame';
import { ChatScene, SettingsScene, WorkspaceScene } from '../../scenes';
import { TasksScene } from './TasksScene';
import './scenes-a.css';

const PAGE_NOTES = [
  'Un estado por escena',
  'Overlays con usePresence',
  'Tokens + reduced motion',
];

export function ScenesAPage({ view }: { view: CompareView }) {
  return (
    <div className="p6-scenes" data-page="06" data-view={view}>
      <section className="p6-intro">
        <div className="p6-intro__copy">
          <span className="alab-eyebrow">06 · Escenas de trabajo</span>
          <h2>Chat, ajustes, workspace y tablero</h2>
          <p>
            Cuatro piezas completas y compactas. Cada acción hecha en una columna cambia el mismo
            estado en la otra; solo cambia el motor que anima el resultado. El rail, el editor, el
            terminal y el sheet viven dentro de la escena, no tocan producción.
          </p>
        </div>
        <ul className="p6-intro__notes">
          {PAGE_NOTES.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </section>

      <ChatScene view={view} />
      <SettingsScene view={view} />
      <WorkspaceScene view={view} />
      <TasksScene view={view} />
    </div>
  );
}
