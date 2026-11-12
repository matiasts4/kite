import React from 'react';

export interface TerminalFindBarProps {
  isOpen: boolean;
  query: string;
  count: number;
  index: number;
  findInputRef: React.Ref<HTMLInputElement>;
  onChangeQuery: (query: string) => void;
  onStepFind: (delta: -1 | 1) => void;
  onClose: () => void;
}

export const TerminalFindBar: React.FC<TerminalFindBarProps> = ({
  isOpen,
  query,
  count,
  index,
  findInputRef,
  onChangeQuery,
  onStepFind,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
    <form
      className="terminal-canvas-find"
      onSubmit={(event) => {
        event.preventDefault();
        onStepFind(1);
      }}
    >
      <input
        ref={findInputRef}
        aria-label="Buscar en la terminal"
        placeholder="Buscar"
        value={query}
        onChange={(event) => onChangeQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            onStepFind(event.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="terminal-canvas-find__count">
        {count === 0 ? '0' : `${index + 1}/${count}`}
      </span>
      <button type="button" aria-label="Anterior" onClick={() => onStepFind(-1)}>
        ↑
      </button>
      <button type="button" aria-label="Siguiente" onClick={() => onStepFind(1)}>
        ↓
      </button>
      <button
        type="button"
        aria-label="Cerrar búsqueda"
        onClick={onClose}
      >
        ×
      </button>
    </form>
  );
};
