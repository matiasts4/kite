import { useState } from 'react';
import {
  readDefaultFollowUp,
  writeDefaultFollowUp,
  type FollowUpMode,
} from '../chat/composerPrimaryAction';
import {
  readToolVisibility,
  writeToolVisibility,
  type ToolVisibilityMode,
} from '../chat/toolVisibility';

const ROWS: Array<{ id: ToolVisibilityMode; title: string; detail: string }> = [
  { id: 'show-all', title: 'Mostrar todo', detail: 'Todas las acciones permanecen visibles en el hilo.' },
  {
    id: 'hide-successful',
    title: 'Ocultar exitosas',
    detail: 'Las acciones en curso y fallidas permanecen visibles. Las finalizadas con éxito se contraen.',
  },
  { id: 'hide-all', title: 'Ocultar todo', detail: 'Solo se muestra Pensando mientras el turno está en curso.' },
  {
    id: 'zen',
    title: 'Modo Zen',
    detail: 'Los mensajes intermedios del asistente permanecen ocultos hasta la respuesta final.',
  },
];

const FOLLOW_UP_ROWS: Array<{ id: FollowUpMode; title: string; detail: string }> = [
  {
    id: 'queue',
    title: 'Encolar mensaje (Queue)',
    detail: 'Agrega el seguimiento a la cola FIFO y lo envía automáticamente al terminar el turno actual.',
  },
  {
    id: 'steer',
    title: 'Redirigir turno (Steer)',
    detail: 'Interrumpe el turno activo y envía tu mensaje de seguimiento de inmediato.',
  },
];

export function ChatSettingsTab() {
  const [mode, setMode] = useState<ToolVisibilityMode>(() => readToolVisibility());
  const [followUpMode, setFollowUpMode] = useState<FollowUpMode>(() => readDefaultFollowUp());

  return (
    <>
      <section className="settings-group" aria-labelledby="settings-chat-visibility">
        <h2 id="settings-chat-visibility" className="settings-group__title">
          Visibilidad de herramientas
        </h2>
        <div className="ui-card" role="radiogroup" aria-labelledby="settings-chat-visibility">
          {ROWS.map((row) => {
            const selected = mode === row.id;
            return (
              <button
                key={row.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`ui-card__row settings-row settings-choice-row${selected ? ' is-selected' : ''}`}
                onClick={() => {
                  setMode(row.id);
                  writeToolVisibility(row.id);
                }}
              >
                <div className="settings-row__copy">
                  <h3 className="settings-row__title">{row.title}</h3>
                  <p>{row.detail}</p>
                </div>
                <div className="settings-row__control">
                  <span
                    className={`settings-radio-dot${selected ? ' is-selected' : ''}`}
                    aria-hidden="true"
                  />
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="settings-group" aria-labelledby="settings-chat-followup">
        <h2 id="settings-chat-followup" className="settings-group__title">
          Acción al enviar con turno activo
        </h2>
        <div className="ui-card" role="radiogroup" aria-labelledby="settings-chat-followup">
          {FOLLOW_UP_ROWS.map((row) => {
            const selected = followUpMode === row.id;
            return (
              <button
                key={row.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`ui-card__row settings-row settings-choice-row${selected ? ' is-selected' : ''}`}
                onClick={() => {
                  setFollowUpMode(row.id);
                  writeDefaultFollowUp(row.id);
                }}
              >
                <div className="settings-row__copy">
                  <h3 className="settings-row__title">{row.title}</h3>
                  <p>{row.detail}</p>
                </div>
                <div className="settings-row__control">
                  <span
                    className={`settings-radio-dot${selected ? ' is-selected' : ''}`}
                    aria-hidden="true"
                  />
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </>
  );
}
