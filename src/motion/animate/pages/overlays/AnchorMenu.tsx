import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { motionSurfaceClass } from '../../../surface';
import { usePresence } from '../../../usePresence';
import { useLabMotion, useLabReduce } from '../../context';
import type { CompareVariant } from '../../frame';
import { ChevronDownIcon } from '../../ui';

interface SubmenuEntry {
  id: string;
  label: string;
}

const SUBMENU_ITEMS: SubmenuEntry[] = [
  { id: 'copy-link', label: 'Copiar enlace' },
  { id: 'send-email', label: 'Enviar por correo' },
  { id: 'export-md', label: 'Exportar Markdown' },
];

export function SubmenuSurface({
  mode,
  open,
  onSelect,
}: {
  mode: CompareVariant;
  open: boolean;
  onSelect: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setHovered(null);
  }, [open]);

  const items = SUBMENU_ITEMS.map((item) =>
    mode === 'animate' ? (
      <button
        key={item.id}
        type="button"
        role="menuitem"
        className="cmp-menu__item"
        onPointerEnter={() => setHovered(item.id)}
        onFocus={() => setHovered(item.id)}
        onBlur={() => setHovered(null)}
        onClick={onSelect}
      >
        {hovered === item.id && (
          <motion.span
            layoutId="p5-submenu-highlight"
            className="cmp-menu__highlight"
            initial={false}
            transition={motionTokens.springs.highlight}
          />
        )}
        <span className="cmp-menu__label">{item.label}</span>
      </button>
    ) : (
      <button
        key={item.id}
        type="button"
        role="menuitem"
        className="cmp-menu__item"
        onClick={onSelect}
      >
        {item.label}
      </button>
    )
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div
        className={`cmp-menu p5-submenu ${motionSurfaceClass(presence.phase, 'popover')}`}
        role="menu"
      >
        {items}
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="cmp-menu p5-submenu p5-menu--motion"
          role="menu"
          initial={{ opacity: 0, scale: reduce ? 1 : motionTokens.scale.menu }}
          animate={{ opacity: 1, scale: 1, transition: motionTokens.tweens.menu }}
          exit={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.menu,
            transition: motionTokens.tweens.dismiss,
          }}
          style={{ transformOrigin: 'top left' }}
        >
          {items}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function MenuSurface({
  mode,
  open,
  submenuOpen,
  onSubmenu,
  onClose,
}: {
  mode: CompareVariant;
  open: boolean;
  submenuOpen: boolean;
  onSubmenu: (value: boolean) => void;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setHovered(null);
  }, [open]);

  const item = (
    id: string,
    label: string,
    options: { danger?: boolean; submenu?: boolean; icon?: boolean } = {}
  ) =>
    mode === 'animate' ? (
      <button
        key={id}
        type="button"
        role="menuitem"
        aria-haspopup={options.submenu ? 'menu' : undefined}
        aria-expanded={options.submenu ? submenuOpen : undefined}
        className={`cmp-menu__item${options.danger ? ' cmp-menu__item--danger' : ''}`}
        onPointerEnter={() => {
          setHovered(id);
          if (options.submenu) onSubmenu(true);
        }}
        onFocus={() => {
          setHovered(id);
          if (options.submenu) onSubmenu(true);
        }}
        onBlur={() => setHovered(null)}
        onClick={() => {
          if (options.submenu) onSubmenu(!submenuOpen);
          else onClose();
        }}
      >
        {hovered === id && (
          <motion.span
            layoutId="p5-menu-highlight"
            className="cmp-menu__highlight"
            initial={false}
            transition={motionTokens.springs.highlight}
          />
        )}
        <span className="cmp-menu__label">{label}</span>
        {options.submenu && (
          <ChevronDownIcon size={11} className="p5-chevron-right" />
        )}
      </button>
    ) : (
      <button
        key={id}
        type="button"
        role="menuitem"
        aria-haspopup={options.submenu ? 'menu' : undefined}
        aria-expanded={options.submenu ? submenuOpen : undefined}
        className={`cmp-menu__item${options.danger ? ' cmp-menu__item--danger' : ''}`}
        onPointerEnter={() => {
          if (options.submenu) onSubmenu(true);
        }}
        onClick={() => {
          if (options.submenu) onSubmenu(!submenuOpen);
          else onClose();
        }}
      >
        <span className="cmp-menu__label">{label}</span>
        {options.submenu && (
          <ChevronDownIcon size={11} className="p5-chevron-right" />
        )}
      </button>
    );

  const menu = (
    <>
      {item('open', 'Abrir en el editor')}
      <div className="p5-submenu-anchor">
        {item('share', 'Compartir', { submenu: true })}
        <SubmenuSurface mode={mode} open={submenuOpen} onSelect={onClose} />
      </div>
      {item('archive', 'Archivar', { danger: true })}
    </>
  );

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div
        className={`cmp-menu p5-menu ${motionSurfaceClass(presence.phase, 'popover')}`}
        role="menu"
        onPointerLeave={() => {
          setHovered(null);
          onSubmenu(false);
        }}
      >
        {menu}
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="cmp-menu p5-menu p5-menu--motion"
          role="menu"
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
          onPointerLeave={() => {
            setHovered(null);
            onSubmenu(false);
          }}
        >
          {menu}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
