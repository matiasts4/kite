import { AnimatePresence, motion } from 'motion/react';
import { usePresence } from '../../usePresence';
import { motionSurfaceClass } from '../../surface';
import { useLabMotion, useLabReduce } from '../context';
import { SceneButton, type CompareVariant } from '../frame';
import { CloseIcon } from '../ui';
import { CHAT_MODELS, type ChatModelId } from './chatData';

function ModelContent({
  mode,
  model,
  onModel,
  onClose,
}: {
  mode: CompareVariant;
  model: ChatModelId;
  onModel: (next: ChatModelId) => void;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const active = CHAT_MODELS.find((item) => item.id === model) ?? CHAT_MODELS[0];

  return (
    <>
      <div className="cmp-popover__head">
        <strong>Modelo y cuota</strong>
        <SceneButton mode={mode} variant="icon" onClick={onClose} aria-label="Cerrar cuota">
          <CloseIcon size={12} />
        </SceneButton>
      </div>
      {mode === 'animate' ? (
        <motion.div
          className="p6-models"
          role="radiogroup"
          aria-label="Modelo"
          initial="hidden"
          animate="show"
          variants={{ show: { transition: { staggerChildren: motionTokens.stagger } } }}
        >
          {CHAT_MODELS.map((item) => {
            const selected = item.id === model;
            return (
              <motion.button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`p6-model${selected ? ' is-active' : ''}`}
                onClick={() => onModel(item.id)}
                variants={{
                  hidden: {
                    opacity: 0,
                    y: reduce ? 0 : motionTokens.travel(4),
                    filter: motionTokens.itemBlur,
                  },
                  show: {
                    opacity: 1,
                    y: 0,
                    filter: 'blur(0px)',
                    transition: motionTokens.tweens.reveal,
                  },
                }}
              >
                {selected && (
                  <motion.span
                    layoutId="cmp-chat-model"
                    className="p6-model__indicator"
                    initial={false}
                    transition={motionTokens.springs.highlight}
                  />
                )}
                <span className="p6-model__text">
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
                <span className="p6-model__quota">{item.quota}%</span>
              </motion.button>
            );
          })}
        </motion.div>
      ) : (
        <div className="p6-models" role="radiogroup" aria-label="Modelo">
          {CHAT_MODELS.map((item) => {
            const selected = item.id === model;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`p6-model${selected ? ' is-active' : ''}`}
                onClick={() => onModel(item.id)}
              >
                <span className="p6-model__text">
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
                <span className="p6-model__quota">{item.quota}%</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="p6-quota">
        <span>Cuota restante</span>
        <strong>{active.quota}%</strong>
      </div>
      <div className="cmp-meter cmp-meter--sm p6-quota-meter">
        {mode === 'animate' ? (
          <motion.div
            key={active.id}
            className="cmp-meter__fill p6-quota-meter__fill"
            style={{ width: `${active.quota}%` }}
            initial={{ x: reduce ? 0 : '-100%' }}
            animate={{ x: 0 }}
            transition={motionTokens.springs.number}
          />
        ) : (
          <div className="cmp-meter__fill" style={{ width: `${active.quota}%` }} />
        )}
      </div>
      <p className="cmp-muted">Se renueva el 1 de cada mes.</p>
    </>
  );
}

export function ModelPopover({
  mode,
  open,
  model,
  onModel,
  onClose,
}: {
  mode: CompareVariant;
  open: boolean;
  model: ChatModelId;
  onModel: (next: ChatModelId) => void;
  onClose: () => void;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const presence = usePresence(open);

  if (mode === 'kite') {
    if (!presence.mounted) return null;
    return (
      <div className={`cmp-popover ${motionSurfaceClass(presence.phase, 'popover')}`}>
        <ModelContent mode={mode} model={model} onModel={onModel} onClose={onClose} />
      </div>
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="cmp-popover"
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
          style={{ transformOrigin: 'top right' }}
        >
          <ModelContent mode={mode} model={model} onModel={onModel} onClose={onClose} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
