import React from 'react';
import {
  ZedMemoryNote,
  ZedPersonaConfig,
} from '../../../../lib/operator/operatorConfig';
import { invokeCommand } from '../../../../lib/ipc';

export interface ZedMemorySectionProps {
  persona: ZedPersonaConfig;
  onPersonaChange: <K extends keyof ZedPersonaConfig>(
    key: K,
    value: ZedPersonaConfig[K]
  ) => void;
  memoryNotes: ZedMemoryNote[];
  newNoteText: string;
  onNewNoteTextChange: (val: string) => void;
  onAddMemoryNote: () => void;
  onDeleteMemoryNote: (id: string) => void;
}

export const ZedMemorySection: React.FC<ZedMemorySectionProps> = ({
  persona,
  onPersonaChange,
  memoryNotes,
  newNoteText,
  onNewNoteTextChange,
  onAddMemoryNote,
  onDeleteMemoryNote,
}) => {
  return (
    <section className="settings-group">
      <h2 className="settings-group__title">Memoria Compartida de Zed</h2>
      <div className="ui-card">
        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Recordar entre sesiones</h3>
            <p>
              Conserva notas clave y resúmenes de llamadas para que Zed mantenga el contexto del
              proyecto.
            </p>
          </div>
          <div className="settings-row__control" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              type="button"
              className="secondary-button"
              title="persona.json, USER.md, MEMORY.md y journal.json en la carpeta local de memoria."
              onClick={() => {
                void invokeCommand('zed_memory_reveal').catch((err) => {
                  console.error('[ZedTab] zed_memory_reveal failed:', err);
                });
              }}
            >
              Reveal folder
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={persona.rememberBetweenCalls}
              className={`ui-switch${persona.rememberBetweenCalls ? ' is-on' : ''}`}
              onClick={() =>
                onPersonaChange('rememberBetweenCalls', !persona.rememberBetweenCalls)
              }
            >
              <span aria-hidden="true" className="ui-switch__knob" />
            </button>
          </div>
        </div>

        <div className="ui-card__row settings-row">
          <div className="settings-row__copy">
            <h3 className="settings-row__title">Al finalizar cada intervención</h3>
            <p>Qué registro conserva Zed después de ejecutar comandos.</p>
          </div>
          <div className="settings-row__control">
            <fieldset aria-label="Al finalizar cada intervención" className="ui-segmented">
              {(
                [
                  { id: 'summary', label: 'Save summary' },
                  { id: 'transcript', label: 'Save transcript' },
                  { id: 'nothing', label: 'Nothing' },
                ] as const
              ).map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  aria-pressed={persona.afterCallMode === mode.id}
                  className="ui-segmented__item"
                  onClick={() => onPersonaChange('afterCallMode', mode.id)}
                >
                  <span>{mode.label}</span>
                </button>
              ))}
            </fieldset>
          </div>
        </div>

        {/* Memory Notes List */}
        <div
          className="ui-card__row"
          style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 18px' }}
        >
          <h3 className="settings-row__title" style={{ margin: 0 }}>
            Notas en memoria ({memoryNotes.length})
          </h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              className="zed-settings__input"
              value={newNoteText}
              onChange={(e) => onNewNoteTextChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onAddMemoryNote();
              }}
              placeholder="Añadir nota persistente para Zed (ej. El backend corre en el puerto 4000)..."
              style={{ flex: 1 }}
            />
            <button type="button" className="secondary-button" onClick={onAddMemoryNote}>
              Guardar nota
            </button>
          </div>

          {memoryNotes.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              {memoryNotes.map((note) => (
                <div
                  key={note.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '7px 10px',
                    borderRadius: 7,
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid rgba(255, 255, 255, 0.06)',
                    fontSize: 12,
                  }}
                >
                  <span>{note.content}</span>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => onDeleteMemoryNote(note.id)}
                    style={{ padding: '2px 8px', fontSize: 11 }}
                  >
                    Eliminar
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
