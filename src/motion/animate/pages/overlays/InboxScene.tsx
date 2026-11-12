import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { motionSurfaceClass } from '../../../surface';
import { usePresence } from '../../../usePresence';
import { useLabMotion, useLabReduce } from '../../context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from '../../frame';
import { BellIcon, CheckIcon, ChevronDownIcon, CloseIcon } from '../../ui';
import { useEscapeClose } from './shared';
import { QuotaSurface } from './QuotaSurface';

/* -------------------------------------------------------------------------- */
/* Scene 5 — Notification center, quota and file picker                        */
/* -------------------------------------------------------------------------- */

type InboxSurface = 'none' | 'notifications' | 'quota' | 'picker';

interface NotificationItem {
  id: string;
  title: string;
  detail: string;
  time: string;
  tone: 'ok' | 'warn';
  read: boolean;
}

const SEED_NOTIFICATIONS: NotificationItem[] = [
  {
    id: 'n1',
    title: 'Sesión completada',
    detail: 'feat/motion · revisión del contrato',
    time: '4 min',
    tone: 'ok',
    read: false,
  },
  {
    id: 'n2',
    title: 'Presupuesto al 72%',
    detail: 'Quedan 1.284 tickets este mes',
    time: '22 min',
    tone: 'warn',
    read: false,
  },
  {
    id: 'n3',
    title: 'Nuevo modelo disponible',
    detail: 'Kite 2 · Opus ya está en el selector',
    time: '1 h',
    tone: 'ok',
    read: true,
  },
];

const FILES = [
  { path: 'src/motion/contract.ts', size: '1.8 kB' },
  { path: 'src/motion/surface.ts', size: '2.1 kB' },
  { path: 'src/motion/usePresence.ts', size: '0.9 kB' },
  { path: 'src/motion/animate/frame.tsx', size: '4.6 kB' },
  { path: 'src/motion/animate/tokens.ts', size: '5.2 kB' },
];

function NotificationRow({
  mode,
  item,
  onToggle,
}: {
  mode: CompareVariant;
  item: NotificationItem;
  onToggle: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const className = `p5-notif${item.read ? ' is-read' : ''}`;
  const content = (
    <>
      <span className="p5-notif__mark" aria-hidden="true">
        {mode === 'animate' ? (
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={item.read ? 'read' : 'unread'}
              className="p5-notif__mark-inner"
              initial={{ opacity: 0, scale: reduce ? 1 : motionTokens.scale.icon }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: reduce ? 1 : motionTokens.scale.icon }}
              transition={motionTokens.tweens.swap}
            >
              {item.read ? (
                <CheckIcon size={11} className="p5-notif__check" />
              ) : (
                <span className={`p5-notif__dot p5-notif__dot--${item.tone}`} />
              )}
            </motion.span>
          </AnimatePresence>
        ) : item.read ? (
          <CheckIcon size={11} className="p5-notif__check" />
        ) : (
          <span className={`p5-notif__dot p5-notif__dot--${item.tone}`} />
        )}
      </span>
      <span className="p5-notif__body">
        <strong>{item.title}</strong>
        <span>{item.detail}</span>
      </span>
      <span className="p5-notif__time">{item.time}</span>
    </>
  );

  if (mode === 'animate') {
    return (
      <motion.button
        type="button"
        layout="position"
        className={className}
        onClick={onToggle}
        aria-label={item.read ? `Marcar ${item.title} como no leída` : `Marcar ${item.title} como leída`}
      >
        {content}
      </motion.button>
    );
  }

  return (
    <button
      type="button"
      className={className}
      onClick={onToggle}
      aria-label={item.read ? `Marcar ${item.title} como no leída` : `Marcar ${item.title} como leída`}
    >
      {content}
    </button>
  );
}

function NotificationPanel({
  mode,
  open,
  items,
  unread,
  onToggleRead,
  onMarkAll,
  onClear,
  onRestore,
  onClose,
}: {
  mode: CompareVariant;
  open: boolean;
  items: NotificationItem[];
  unread: number;
  onToggleRead: (id: string) => void;
  onMarkAll: () => void;
  onClear: () => void;
  onRestore: () => void;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);

  const panel = (
    <>
      <div className="p5-panel__head">
        <span className="p5-panel__title">Notificaciones</span>
        {unread > 0 && <span className="p5-panel__count">{unread}</span>}
        <SceneButton
          mode={mode}
          variant="icon"
          onClick={onClose}
          aria-label="Cerrar notificaciones"
        >
          <CloseIcon size={12} />
        </SceneButton>
      </div>

      {items.length === 0 ? (
        <div className="p5-empty">
          <BellIcon size={18} />
          <strong>Sin notificaciones</strong>
          <span>Cuando un agente termine una tarea, la vas a ver acá.</span>
          <SceneButton mode={mode} variant="ghost" className="cmp-btn--sm" onClick={onRestore}>
            Restaurar demo
          </SceneButton>
        </div>
      ) : (
        <div className="p5-panel__list">
          {items.map((item) => (
            <NotificationRow
              key={item.id}
              mode={mode}
              item={item}
              onToggle={() => onToggleRead(item.id)}
            />
          ))}
        </div>
      )}

      <div className="p5-panel__foot">
        <SceneButton
          mode={mode}
          variant="ghost"
          className="cmp-btn--sm"
          onClick={onMarkAll}
          disabled={unread === 0}
        >
          Marcar todo
        </SceneButton>
        <SceneButton
          mode={mode}
          variant="ghost"
          className="cmp-btn--sm"
          onClick={onClear}
          disabled={items.length === 0}
        >
          Limpiar
        </SceneButton>
      </div>
    </>
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div className={`p5-panel ${motionSurfaceClass(presence.phase, 'popover')}`}>
        {panel}
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="p5-panel"
          initial={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.popover,
            y: reduce ? 0 : -4,
            filter: motionTokens.surfaceBlur,
          }}
          animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
          exit={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.popover,
            y: reduce ? 0 : -4,
            filter: motionTokens.surfaceBlur,
            transition: motionTokens.tweens.dismiss,
          }}
          transition={motionTokens.springs.pop}
          style={{ transformOrigin: 'top right' }}
        >
          {panel}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function FilePicker({
  mode,
  open,
  query,
  onQuery,
  onPick,
}: {
  mode: CompareVariant;
  open: boolean;
  query: string;
  onQuery: (value: string) => void;
  onPick: (path: string) => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);
  const files = FILES.filter((file) =>
    file.path.toLowerCase().includes(query.trim().toLowerCase())
  );

  const content = (
    <>
      <div className="p5-picker__head">
        <span>Abrir archivo</span>
        <kbd className="p5-kbd">⌘P</kbd>
      </div>
      <div className="p5-picker__search">
        <input
          className="p5-picker__input"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Filtrar archivos…"
          aria-label="Filtrar archivos"
        />
      </div>
      <div className="p5-picker__list">
        {files.length === 0 ? (
          <div className="p5-picker__empty">Sin coincidencias.</div>
        ) : (
          files.map((file) => (
            <button
              key={file.path}
              type="button"
              className="p5-picker__item"
              onClick={() => onPick(file.path)}
            >
              <span>{file.path}</span>
              <small>{file.size}</small>
            </button>
          ))
        )}
      </div>
    </>
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div className={`p5-picker ${motionSurfaceClass(presence.phase, 'popover')}`}>
        {content}
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="p5-picker"
          initial={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.menu,
            y: reduce ? 0 : -4,
          }}
          animate={{
            opacity: 1,
            scale: 1,
            y: 0,
            transition: motionTokens.tweens.menu,
          }}
          exit={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.menu,
            y: reduce ? 0 : -4,
            transition: motionTokens.tweens.dismiss,
          }}
          style={{ transformOrigin: 'top left' }}
        >
          {content}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function InboxStage({
  mode,
  surface,
  items,
  unread,
  pickerQuery,
  selectedFile,
  onToggleSurface,
  onCloseSurface,
  onToggleRead,
  onMarkAll,
  onClear,
  onRestore,
  onPickerQuery,
  onPick,
}: {
  mode: CompareVariant;
  surface: InboxSurface;
  items: NotificationItem[];
  unread: number;
  pickerQuery: string;
  selectedFile: string | null;
  onToggleSurface: (next: Exclude<InboxSurface, 'none'>) => void;
  onCloseSurface: () => void;
  onToggleRead: (id: string) => void;
  onMarkAll: () => void;
  onClear: () => void;
  onRestore: () => void;
  onPickerQuery: (value: string) => void;
  onPick: (path: string) => void;
}) {
  return (
    <div className="p5-stage p5-stage--inbox">
      {surface !== 'none' && (
        <div
          className="p5-clickaway"
          onClick={onCloseSurface}
          aria-hidden="true"
        />
      )}

      <div className="p5-inbox-head">
        <div className="p5-anchor p5-bell">
          <SceneButton
            mode={mode}
            variant="icon"
            aria-label={`Notificaciones${unread > 0 ? `, ${unread} sin leer` : ''}`}
            aria-expanded={surface === 'notifications'}
            onClick={() => onToggleSurface('notifications')}
          >
            <BellIcon size={14} />
          </SceneButton>
          {unread > 0 && (
            <span className="p5-bell__badge" aria-hidden="true">
              {unread}
            </span>
          )}
          <NotificationPanel
            mode={mode}
            open={surface === 'notifications'}
            items={items}
            unread={unread}
            onToggleRead={onToggleRead}
            onMarkAll={onMarkAll}
            onClear={onClear}
            onRestore={onRestore}
            onClose={onCloseSurface}
          />
        </div>

        <div className="p5-anchor">
          <SceneButton
            mode={mode}
            variant="ghost"
            className="cmp-chip"
            aria-expanded={surface === 'quota'}
            onClick={() => onToggleSurface('quota')}
          >
            Kite 2 · 72%
            <ChevronDownIcon size={11} />
          </SceneButton>
          <QuotaSurface
            mode={mode}
            open={surface === 'quota'}
            onClose={onCloseSurface}
            align="start"
          />
        </div>

        <div className="p5-anchor p5-inbox-head__file">
          <SceneButton
            mode={mode}
            variant="ghost"
            className="cmp-btn--sm"
            aria-expanded={surface === 'picker'}
            onClick={() => onToggleSurface('picker')}
          >
            Abrir archivo
          </SceneButton>
          <FilePicker
            mode={mode}
            open={surface === 'picker'}
            query={pickerQuery}
            onQuery={onPickerQuery}
            onPick={onPick}
          />
        </div>
      </div>

      <p className="p5-hint">
        Panel, cuota y selector comparten una sola superficie: abrir una cierra la otra.
        Las filas no leídas se marcan con un click.
      </p>

      <div className="p5-mock" aria-hidden="true">
        <div className="p5-mock__head">
          <span>Actividad</span>
          <span>{items.length} eventos</span>
        </div>
        <div className="p5-mock__row">
          <span className="p5-mock__dot p5-mock__dot--green" />
          El agente terminó la revisión de overlays.
        </div>
        <div className="p5-mock__row">
          <span className="p5-mock__dot p5-mock__dot--accent" />
          La cuota del workspace sigue en 72%.
        </div>
        <div className="p5-mock__row">
          <span className="p5-mock__dot" />
          Tres archivos esperan revisión.
        </div>
      </div>

      <p className="p5-status">
        {selectedFile ? `Archivo abierto: ${selectedFile}` : 'Ningún archivo abierto todavía.'}
      </p>
    </div>
  );
}

export function InboxScene({ view }: { view: CompareView }) {
  const [surface, setSurface] = useState<InboxSurface>('none');
  const [items, setItems] = useState<NotificationItem[]>(() =>
    SEED_NOTIFICATIONS.map((item) => ({ ...item }))
  );
  const [pickerQuery, setPickerQuery] = useState('');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const unread = items.filter((item) => !item.read).length;

  const toggleSurface = (next: Exclude<InboxSurface, 'none'>) => {
    setSurface((current) => (current === next ? 'none' : next));
  };

  const toggleRead = (id: string) => {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, read: !item.read } : item))
    );
  };

  const markAll = () => {
    setItems((current) => current.map((item) => ({ ...item, read: true })));
  };

  const clearAll = () => setItems([]);

  const restore = () => {
    setItems(SEED_NOTIFICATIONS.map((item) => ({ ...item })));
  };

  const pickFile = (path: string) => {
    setSelectedFile(path);
    setSurface('none');
  };

  useEscapeClose(surface !== 'none', () => setSurface('none'));

  return (
    <CompareScene
      index="05"
      title="Notificaciones y cuota"
      target="NotificationCenter · QuotaPopover · FilePicker"
      note="Un solo estado de superficie para el panel, la cuota y el selector de archivos. Marcá leídas, vaciá el panel para ver el estado vacío y abrí un archivo desde el selector."
      view={view}
    >
      {(mode) => (
        <InboxStage
          mode={mode}
          surface={surface}
          items={items}
          unread={unread}
          pickerQuery={pickerQuery}
          selectedFile={selectedFile}
          onToggleSurface={toggleSurface}
          onCloseSurface={() => setSurface('none')}
          onToggleRead={toggleRead}
          onMarkAll={markAll}
          onClear={clearAll}
          onRestore={restore}
          onPickerQuery={setPickerQuery}
          onPick={pickFile}
        />
      )}
    </CompareScene>
  );
}
