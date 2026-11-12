import { useRef, useState } from 'react';
import { Reorder } from 'motion/react';
import { useLabMotion } from '../../context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from '../../frame';

/* -------------------------------------------------------------------------- */
/* 08.02 — Reorder                                                             */
/* -------------------------------------------------------------------------- */

const REORDER_LABELS: Record<string, string> = {
  context: 'Contexto',
  tools: 'Herramientas',
  permissions: 'Permisos',
  checks: 'Verificación',
  delivery: 'Entrega',
};

const INITIAL_ORDER = ['context', 'tools', 'permissions', 'checks', 'delivery'];

function ReorderPane({
  mode,
  order,
  note,
  owner,
  onReorder,
}: {
  mode: CompareVariant;
  order: string[];
  note: string;
  owner: CompareVariant | null;
  onReorder: (next: string[], movedId: string) => void;
}) {
  const motionTokens = useLabMotion();
  const rowRefs = useRef(new Map<string, HTMLElement>());

  const place = (id: string, direction: -1 | 1) => {
    const index = order.indexOf(id);
    const to = index + direction;
    if (index < 0 || to < 0 || to >= order.length) return;
    const next = [...order];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved);
    onReorder(next, id);
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  };

  const actions = (id: string, index: number) => (
    <span className="p8-reorder__actions">
      <SceneButton
        mode={mode}
        variant="ghost"
        className="p8-mini"
        aria-label={`Subir ${REORDER_LABELS[id]}`}
        disabled={index === 0}
        onClick={() => place(id, -1)}
      >
        ↑
      </SceneButton>
      <SceneButton
        mode={mode}
        variant="ghost"
        className="p8-mini"
        aria-label={`Bajar ${REORDER_LABELS[id]}`}
        disabled={index === order.length - 1}
        onClick={() => place(id, 1)}
      >
        ↓
      </SceneButton>
    </span>
  );

  return (
    <div className="p8-reorder-scene">
      <span className="p8-kicker">Orden de ejecución</span>

      {mode === 'animate' ? (
        <Reorder.Group
          as="ol"
          axis="y"
          className="p8-reorder"
          values={order}
          onReorder={(next: string[]) => onReorder(next, '')}
          aria-label="Orden de ejecución"
        >
          {order.map((id, index) => (
            <Reorder.Item
              as="li"
              key={id}
              value={id}
              className="p8-reorder__row is-draggable"
              ref={(element: HTMLElement | null) => {
                if (element) rowRefs.current.set(id, element);
              }}
              tabIndex={-1}
              transition={motionTokens.springs.reflow}
              whileDrag={{ zIndex: 2, boxShadow: '0 12px 28px rgba(0, 0, 0, 0.45)' }}
            >
              <span className="p8-reorder__grip" aria-hidden="true">
                ⠿
              </span>
              <span className="p8-reorder__label">{REORDER_LABELS[id]}</span>
              <span className="p8-reorder__pos">{index + 1}</span>
              {actions(id, index)}
            </Reorder.Item>
          ))}
        </Reorder.Group>
      ) : (
        <ol className="p8-reorder" aria-label="Orden de ejecución">
          {order.map((id, index) => (
            <li
              key={id}
              className="p8-reorder__row"
              ref={(element) => {
                if (element) rowRefs.current.set(id, element);
              }}
              tabIndex={-1}
            >
              <span className="p8-reorder__pos">{index + 1}</span>
              <span className="p8-reorder__label">{REORDER_LABELS[id]}</span>
              {actions(id, index)}
            </li>
          ))}
        </ol>
      )}

      <p className="p8-note" aria-live={owner === mode ? 'polite' : 'off'}>
        {note ||
          (mode === 'animate'
            ? 'Arrastrá una fila o usá ↑ ↓: los vecinos abren lugar.'
            : 'Kite mueve la fila con ↑ ↓ y el orden salta.')}
      </p>
    </div>
  );
}

export function ReorderScene({ view }: { view: CompareView }) {
  const [order, setOrder] = useState(INITIAL_ORDER);
  const [note, setNote] = useState('');
  const [owner, setOwner] = useState<CompareVariant | null>(null);

  const commit = (next: string[], movedId: string, from: CompareVariant) => {
    setOrder(next);
    setOwner(from);
    const position = next.indexOf(movedId) + 1;
    setNote(`${REORDER_LABELS[movedId]} pasó a la posición ${position}.`);
  };

  return (
    <CompareScene
      index="02"
      title="Reordenar"
      target="TaskList · reorder"
      note="Una lista de cinco pasos. En Animate UI la fila se arrastra y los vecinos abren lugar con spring.reflow; en Kite solo mueven los botones y el orden salta. ↑ ↓ son el camino de teclado en ambas columnas y el foco queda en la fila movida."
      view={view}
    >
      {(mode) => (
        <ReorderPane
          mode={mode}
          order={order}
          note={note}
          owner={owner}
          onReorder={(next, movedId) => commit(next, movedId, mode)}
        />
      )}
    </CompareScene>
  );
}
