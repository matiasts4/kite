import { AnimatePresence, motion } from 'motion/react';
import { motionSurfaceClass } from '../../../surface';
import { usePresence } from '../../../usePresence';
import { useLabMotion, useLabReduce } from '../../context';
import { SceneButton, type CompareVariant } from '../../frame';
import { CloseIcon } from '../../ui';

export function QuotaCard({ mode, onClose }: { mode: CompareVariant; onClose: () => void }) {
  return (
    <>
      <div className="cmp-popover__head">
        <strong>Cuota del workspace</strong>
        <SceneButton
          mode={mode}
          variant="icon"
          onClick={onClose}
          aria-label="Cerrar cuota"
        >
          <CloseIcon size={12} />
        </SceneButton>
      </div>
      <p>72% restante este mes.</p>
      <div className="cmp-meter cmp-meter--sm">
        <div className="cmp-meter__fill" style={{ width: '72%' }} />
      </div>
      <div className="p5-popover__foot">
        <span>Quedan 1.284 tickets</span>
        <span>Renueva el 1.º</span>
      </div>
    </>
  );
}

export function QuotaSurface({
  mode,
  open,
  onClose,
  align = 'end',
}: {
  mode: CompareVariant;
  open: boolean;
  onClose: () => void;
  align?: 'start' | 'end';
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div className={`p5-anchor-pop p5-anchor-pop--${align}`}>
        <div className={`cmp-popover ${motionSurfaceClass(presence.phase, 'popover')}`}>
          <QuotaCard mode={mode} onClose={onClose} />
        </div>
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={`p5-anchor-pop p5-anchor-pop--${align}`}
          initial={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.popover,
            y: reduce ? 0 : -motionTokens.travel(4),
            filter: motionTokens.surfaceBlur,
          }}
          animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
          exit={{
            opacity: 0,
            scale: reduce ? 1 : motionTokens.scale.popover,
            y: reduce ? 0 : -motionTokens.travel(4),
            filter: motionTokens.surfaceBlur,
            transition: motionTokens.tweens.dismiss,
          }}
          transition={motionTokens.springs.pop}
          style={{ transformOrigin: align === 'end' ? 'top right' : 'top left' }}
        >
          <div className="cmp-popover">
            <QuotaCard mode={mode} onClose={onClose} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
