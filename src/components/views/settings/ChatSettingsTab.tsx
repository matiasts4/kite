import { useState } from 'react';
import {
  readToolVisibility,
  writeToolVisibility,
  type ToolVisibilityMode,
} from '../chat/toolVisibility';

const ROWS: Array<{ id: ToolVisibilityMode; title: string; detail: string }> = [
  { id: 'show-all', title: 'Show all', detail: 'Every action stays in the thread.' },
  { id: 'hide-successful', title: 'Hide successful', detail: 'Running and failed actions stay. Finished successes fold away.' },
  { id: 'hide-all', title: 'Hide all', detail: 'Only Thinking shows while the turn is working.' },
  { id: 'zen', title: 'Zen', detail: 'Intermediate assistant messages stay hidden until the final reply.' },
];

export function ChatSettingsTab() {
  const [mode, setMode] = useState<ToolVisibilityMode>(() => readToolVisibility());

  return (
    <section className="settings-group" aria-labelledby="settings-chat-visibility">
      <h3 id="settings-chat-visibility">Tool visibility</h3>
      <div className="settings-choice-list">
        {ROWS.map((row) => (
          <button
            key={row.id}
            type="button"
            className="settings-choice"
            aria-pressed={mode === row.id}
            onClick={() => {
              setMode(row.id);
              writeToolVisibility(row.id);
            }}
          >
            <strong>{row.title}</strong>
            <span>{row.detail}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
