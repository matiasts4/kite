import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useLabMotion } from '../../context';
import { CompareScene, SceneButton, type CompareVariant, type CompareView } from '../../frame';
import { ChevronDownIcon } from '../../ui';

/* -------------------------------------------------------------------------- */
/* Scene 2 — Table: sorting, selection, hover, expandable rows, bulk select    */
/* -------------------------------------------------------------------------- */

type SortKey = 'name' | 'tokens' | 'updated';
type SortDir = 'asc' | 'desc';
type RowStatus = 'ok' | 'warn' | 'idle';

interface TableRow {
  id: string;
  name: string;
  kind: string;
  tokens: number;
  updated: number;
  status: RowStatus;
  detail: string;
}

const ROWS: TableRow[] = [
  {
    id: 'r1',
    name: 'contract.ts',
    kind: 'motion',
    tokens: 412,
    updated: 2,
    status: 'ok',
    detail: 'Constantes de entrada y salida, más el helper de reduced motion.',
  },
  {
    id: 'r2',
    name: 'surface.ts',
    kind: 'motion',
    tokens: 208,
    updated: 18,
    status: 'ok',
    detail: 'Nombre de la clase CSS que corresponde a cada fase de una superficie.',
  },
  {
    id: 'r3',
    name: 'usePresence.ts',
    kind: 'hook',
    tokens: 164,
    updated: 26,
    status: 'warn',
    detail: 'Mantiene el overlay montado durante MOTION_EXIT_MS antes de quitarlo.',
  },
  {
    id: 'r4',
    name: 'motion.css',
    kind: 'style',
    tokens: 690,
    updated: 41,
    status: 'ok',
    detail: 'Keyframes compartidos: popover, panel, scrim y fila.',
  },
  {
    id: 'r5',
    name: 'AnimateLab.tsx',
    kind: 'lab',
    tokens: 948,
    updated: 64,
    status: 'idle',
    detail: 'Shell del laboratorio: nivel, tempo, vista y página activa.',
  },
  {
    id: 'r6',
    name: 'data.css',
    kind: 'style',
    tokens: 1240,
    updated: 3,
    status: 'ok',
    detail: 'Estilos de esta página, aislados bajo el prefijo p4-.',
  },
];

const SORT_LABEL: Record<SortKey, string> = {
  name: 'Archivo',
  tokens: 'Tokens',
  updated: 'Editado',
};

const STATUS_TEXT: Record<RowStatus, string> = {
  ok: 'listo',
  warn: 'revisar',
  idle: 'sin uso',
};

function HeaderCheck({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      className="p4-check"
      checked={checked}
      onChange={onChange}
      aria-label="Seleccionar todas las filas"
    />
  );
}

interface TableColumnProps {
  mode: CompareVariant;
  rows: TableRow[];
  sort: { key: SortKey; dir: SortDir };
  selection: Set<string>;
  expandedId: string | null;
  onSort: (key: SortKey) => void;
  onToggleRow: (id: string) => void;
  onToggleAll: () => void;
  onClearSelection: () => void;
  onToggleExpanded: (id: string) => void;
}

export function TableScene({ view }: { view: CompareView }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: 'updated',
    dir: 'asc',
  });
  const [selection, setSelection] = useState<Set<string>>(() => new Set());
  const [expandedId, setExpandedId] = useState<string | null>('r3');

  const rows = [...ROWS].sort((a, b) => {
    const factor = sort.dir === 'asc' ? 1 : -1;
    if (sort.key === 'name') return a.name.localeCompare(b.name) * factor;
    return (a[sort.key] - b[sort.key]) * factor;
  });

  const sortBy = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: 'asc' }
    );
  };

  const toggleRow = (id: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelection((prev) => {
      const next = new Set(prev);
      const all = rows.every((row) => next.has(row.id));
      rows.forEach((row) => {
        if (all) next.delete(row.id);
        else next.add(row.id);
      });
      return next;
    });
  };

  return (
    <CompareScene
      index="02"
      title="Tabla con orden, selección y detalle"
      target="FilesTable · BulkActions · RowDisclosure"
      note="Ordená por columna, seleccioná filas y abrí un detalle. Kite recompone el orden y el detalle de golpe; Animate UI desliza las filas sobre spring.reflow y despliega el detalle con transition.disclosure."
      view={view}
    >
      {(mode) => (
        <TableColumn
          mode={mode}
          rows={rows}
          sort={sort}
          selection={selection}
          expandedId={expandedId}
          onSort={sortBy}
          onToggleRow={toggleRow}
          onToggleAll={toggleAll}
          onClearSelection={() => setSelection(new Set())}
          onToggleExpanded={(id) =>
            setExpandedId((current) => (current === id ? null : id))
          }
        />
      )}
    </CompareScene>
  );
}

function TableColumn({
  mode,
  rows,
  sort,
  selection,
  expandedId,
  onSort,
  onToggleRow,
  onToggleAll,
  onClearSelection,
  onToggleExpanded,
}: TableColumnProps) {
  const motionTokens = useLabMotion();
  const uid = useId();
  const selectedCount = rows.filter((row) => selection.has(row.id)).length;
  const allSelected = rows.length > 0 && selectedCount === rows.length;
  const someSelected = selectedCount > 0 && !allSelected;

  const clearSelection = (event: ReactMouseEvent<HTMLButtonElement>) => {
    const root = event.currentTarget.closest<HTMLElement>('[data-engine]');
    onClearSelection();
    requestAnimationFrame(() => {
      root?.querySelector<HTMLElement>('.p4-thead__check input')?.focus();
    });
  };

  return (
    <div className="p4-table" data-engine={mode}>
      <div className="p4-table__head">
        <div>
          <strong>Archivos del workspace</strong>
          <span className="p4-hint">
            {selectedCount > 0 ? `${selectedCount} seleccionadas` : 'seleccioná para acciones en lote'}
          </span>
        </div>
        <span className="cmp-badge">{rows.length} filas</span>
      </div>

      {mode === 'animate' ? (
        <AnimatePresence initial={false}>
          {selectedCount > 0 && (
            <motion.div
              key="bulk"
              className="p4-bulk"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={motionTokens.tweens.disclosure}
              style={{ overflow: 'hidden' }}
            >
              <span>
                <strong>{selectedCount}</strong> filas seleccionadas
              </span>
              <SceneButton
                mode={mode}
                variant="ghost"
                className="cmp-btn--sm"
                onClick={clearSelection}
              >
                Limpiar
              </SceneButton>
            </motion.div>
          )}
        </AnimatePresence>
      ) : (
        selectedCount > 0 && (
          <div className="p4-bulk">
            <span>
              <strong>{selectedCount}</strong> filas seleccionadas
            </span>
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={clearSelection}
            >
              Limpiar
            </SceneButton>
          </div>
        )
      )}

      <div
        className="p4-table__grid"
        role="table"
        aria-label="Archivos del workspace"
        aria-rowcount={rows.length + 1 + (expandedId ? 1 : 0)}
        aria-colcount={6}
      >
      <div className="p4-thead" role="row">
        <div role="columnheader" className="p4-thead__check">
          <HeaderCheck checked={allSelected} indeterminate={someSelected} onChange={onToggleAll} />
        </div>
        {(Object.keys(SORT_LABEL) as SortKey[]).map((key) => {
          const active = sort.key === key;
          const ariaSort = active
            ? sort.dir === 'asc'
              ? 'ascending'
              : 'descending'
            : undefined;
          return (
            <div key={key} role="columnheader" aria-sort={ariaSort}>
              <button type="button" className={`p4-th${active ? ' is-active' : ''}`} onClick={() => onSort(key)}>
                {SORT_LABEL[key]}
                {mode === 'animate' ? (
                  <motion.span
                    className="p4-sort"
                    animate={{ rotate: active && sort.dir === 'asc' ? 180 : 0 }}
                    transition={motionTokens.springs.press}
                  >
                    <ChevronDownIcon size={9} />
                  </motion.span>
                ) : (
                  <span className={`p4-sort${active && sort.dir === 'asc' ? ' is-up' : ''}`}>
                    <ChevronDownIcon size={9} />
                  </span>
                )}
              </button>
            </div>
          );
        })}
        <div role="columnheader" className="p4-thead__status">
          Estado
        </div>
        <div role="columnheader" aria-label="Detalle" />
      </div>

      {rows.map((row) => {
        const selected = selection.has(row.id);
        const expanded = expandedId === row.id;
        const detailId = `${uid}-detail-${row.id}`;

        const cells = (
          <>
            <div role="cell" className="p4-thead__check">
              <input
                type="checkbox"
                className="p4-check"
                checked={selected}
                onChange={() => onToggleRow(row.id)}
                aria-label={`Seleccionar ${row.name}`}
              />
            </div>
            <div role="cell" className="p4-cell p4-cell--name">
              {row.name}
            </div>
            <div role="cell" className="p4-cell p4-cell--num">
              {row.tokens}
            </div>
            <div role="cell" className="p4-cell p4-cell--num">
              {row.updated} min
            </div>
            <div role="cell" className="p4-cell">
              <span className={`p4-status p4-status--${row.status}`}>
                <i aria-hidden="true" />
                {STATUS_TEXT[row.status]}
              </span>
            </div>
            <div role="cell" className="p4-table__expand">
              <SceneButton
                mode={mode}
                variant="ghost"
                className="cmp-btn--icon p4-expand"
                aria-label={`Detalle de ${row.name}`}
                aria-expanded={expanded}
                aria-controls={detailId}
                onClick={() => onToggleExpanded(row.id)}
              >
                {mode === 'animate' ? (
                  <motion.span
                    animate={{ rotate: expanded ? 180 : 0 }}
                    transition={motionTokens.springs.press}
                  >
                    <ChevronDownIcon size={10} />
                  </motion.span>
                ) : (
                  <ChevronDownIcon
                    size={10}
                    className={`p4-expand__icon${expanded ? ' is-open' : ''}`}
                  />
                )}
              </SceneButton>
            </div>
          </>
        );

        const detailBody = (
          <div role="cell" className="p4-detailrow__inner">
            <span className="p4-label">Detalle</span>
            <p>{row.detail}</p>
            <div className="p4-detailrow__meta">
              <span className="cmp-badge">{row.kind}</span>
              <span className="cmp-badge">{row.tokens} tokens</span>
              <span className="cmp-badge">hace {row.updated} min</span>
            </div>
          </div>
        );

        return (
          <Fragment key={row.id}>
            {mode === 'animate' ? (
              <motion.div
                role="row"
                aria-selected={selected}
                layout="position"
                className={`p4-trow${selected ? ' is-selected' : ''}`}
                transition={motionTokens.itemSpring}
              >
                {cells}
              </motion.div>
            ) : (
              <div
                role="row"
                aria-selected={selected}
                className={`p4-trow${selected ? ' is-selected' : ''}`}
              >
                {cells}
              </div>
            )}

            {mode === 'animate' ? (
              <AnimatePresence initial={false}>
                {expanded && (
                  <motion.div
                    key="detail"
                    id={detailId}
                    role="row"
                    className="p4-detailrow"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={motionTokens.tweens.disclosure}
                    style={{ overflow: 'hidden' }}
                  >
                    {detailBody}
                  </motion.div>
                )}
              </AnimatePresence>
            ) : (
              expanded && (
                <div id={detailId} role="row" className="p4-detailrow">
                  {detailBody}
                </div>
              )
            )}
          </Fragment>
        );
      })}
      </div>
    </div>
  );
}
