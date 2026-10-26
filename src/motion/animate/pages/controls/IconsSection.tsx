import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import { CompareScene, SceneButton, type CompareView } from '../../frame';
import { BellIcon, CheckIcon, ChevronDownIcon, CopyIcon } from '../../ui';
import {
  BookmarkIcon,
  CloudIcon,
  HeartIcon,
  MoonIcon,
  PauseIcon,
  PlayIcon,
  SunIcon,
} from './icons';
import {
  IconSwap,
  P1Block,
  P1Pane,
  P1PlusMinus,
  P1Spinner,
  ToggleIcon,
} from './primitives';

function IconTile({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="p1-icon-tile">
      {children}
      <span className="p1-icon-tile__label">{label}</span>
    </div>
  );
}

export function IconsSection({ view }: { view: CompareView }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const [copied, setCopied] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [added, setAdded] = useState(false);
  const [dark, setDark] = useState(true);
  const [bellCount, setBellCount] = useState(0);
  const [bookmarked, setBookmarked] = useState(false);
  const [liked, setLiked] = useState(false);
  const timers = useRef<number[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach((id) => window.clearTimeout(id));
    },
    []
  );

  const later = (callback: () => void, delay: number) => {
    timers.current.push(window.setTimeout(callback, delay));
  };

  const copy = () => {
    setCopied(true);
    later(() => setCopied(false), 1400);
  };

  const sync = () => {
    if (syncing) return;
    setSyncing(true);
    later(() => setSyncing(false), 1500);
  };

  return (
    <CompareScene
      index="02"
      title="Botones de icono e iconos animados"
      target="IconButton · AnimateIcon · CopyButton"
      note="Qué mirar: copiar, reproducir, cambiar de tema, sumar un filtro y guardar. Kite cruza opacidad y color en 150 ms; Animate UI cruza desde scale(0.5) y blur(2px), y la campana además responde al hover."
      view={view}
    >
      {(mode) => (
        <P1Pane mode={mode}>
          <div className="p1-grid">
            <P1Block title="Intercambios de estado" hint="clic · cambio de estado">
              <div className="p1-icon-grid">
                <IconTile label={copied ? 'Copiado' : 'Copiar'}>
                  <SceneButton
                    mode={mode}
                    variant="icon"
                    className="p1-iconbtn"
                    aria-label={copied ? 'Copiado' : 'Copiar código'}
                    onClick={copy}
                  >
                    <IconSwap
                      mode={mode}
                      active={copied}
                      idle={<CopyIcon size={15} />}
                      activeIcon={<CheckIcon size={15} />}
                    />
                  </SceneButton>
                </IconTile>

                <IconTile label={playing ? 'Pausar' : 'Reproducir'}>
                  <SceneButton
                    mode={mode}
                    variant="icon"
                    className="p1-iconbtn"
                    aria-pressed={playing}
                    aria-label={playing ? 'Pausar reproducción' : 'Reproducir'}
                    onClick={() => setPlaying((value) => !value)}
                  >
                    <IconSwap
                      mode={mode}
                      active={playing}
                      idle={<PlayIcon size={15} />}
                      activeIcon={<PauseIcon size={15} />}
                    />
                  </SceneButton>
                </IconTile>

                <IconTile label="Tema">
                  <SceneButton
                    mode={mode}
                    variant="icon"
                    className="p1-iconbtn"
                    aria-label={dark ? 'Usar tema claro' : 'Usar tema oscuro'}
                    onClick={() => setDark((value) => !value)}
                  >
                    <IconSwap
                      mode={mode}
                      active={dark}
                      idle={<SunIcon size={15} />}
                      activeIcon={<MoonIcon size={15} />}
                      rotate={90}
                    />
                  </SceneButton>
                </IconTile>

                <IconTile label={added ? 'Quitar filtro' : 'Añadir filtro'}>
                  <SceneButton
                    mode={mode}
                    variant="icon"
                    className="p1-iconbtn"
                    aria-pressed={added}
                    aria-label={added ? 'Quitar filtro' : 'Añadir filtro'}
                    onClick={() => setAdded((value) => !value)}
                  >
                    <P1PlusMinus mode={mode} active={added} />
                  </SceneButton>
                </IconTile>
              </div>
            </P1Block>

            <P1Block title="Gestos y favoritos" hint="hover · carga · estado">
              <div className="p1-icon-grid">
                <IconTile label="Campana">
                  <SceneButton
                    mode={mode}
                    variant="icon"
                    className="p1-iconbtn"
                    aria-label={`Notificaciones${bellCount > 0 ? `, ${bellCount} nuevas` : ''}`}
                    onClick={() => setBellCount((value) => value + 1)}
                  >
                    {mode === 'kite' ? (
                      <span
                        key={`bell-${bellCount}`}
                        className={`p1-bell${bellCount > 0 ? ' p1-bell--ring' : ''}`}
                      >
                        <BellIcon size={15} />
                      </span>
                    ) : (
                      <motion.span
                        key={`bell-${bellCount}`}
                        className="p1-bell"
                        animate={
                          bellCount > 0 && !reduce
                            ? { rotate: [0, 12, -9, 7, -4, 0] }
                            : { rotate: 0 }
                        }
                        transition={{ duration: 0.7, ease: 'easeInOut' }}
                      >
                        <motion.span
                          className="p1-bell__hover"
                          whileHover={
                            reduce
                              ? undefined
                              : {
                                  rotate: [0, 10, -7, 5, 0],
                                  transition: { duration: 0.6, ease: 'easeInOut' },
                                }
                          }
                        >
                          <BellIcon size={15} />
                        </motion.span>
                      </motion.span>
                    )}
                    {bellCount > 0 && (
                      <span className="p1-badge-count" aria-hidden="true">
                        {bellCount > 9 ? '9+' : bellCount}
                      </span>
                    )}
                  </SceneButton>
                </IconTile>

                <IconTile label={syncing ? 'Sincronizando' : 'Sincronizar'}>
                  <SceneButton
                    mode={mode}
                    variant="icon"
                    className="p1-iconbtn"
                    aria-label={syncing ? 'Sincronizando' : 'Sincronizar'}
                    aria-disabled={syncing}
                    aria-busy={syncing}
                    onClick={sync}
                  >
                    {syncing ? <P1Spinner mode={mode} /> : <CloudIcon size={15} />}
                  </SceneButton>
                </IconTile>

                <IconTile label={bookmarked ? 'Guardado' : 'Guardar'}>
                  <SceneButton
                    mode={mode}
                    variant="icon"
                    className="p1-iconbtn"
                    aria-pressed={bookmarked}
                    aria-label={bookmarked ? 'Quitar de guardados' : 'Guardar hilo'}
                    onClick={() => setBookmarked((value) => !value)}
                  >
                    <ToggleIcon mode={mode} active={bookmarked}>
                      <BookmarkIcon size={15} filled={bookmarked} />
                    </ToggleIcon>
                  </SceneButton>
                </IconTile>

                <IconTile label={liked ? 'Te gusta' : 'Me gusta'}>
                  <SceneButton
                    mode={mode}
                    variant="icon"
                    className="p1-iconbtn"
                    aria-pressed={liked}
                    aria-label={liked ? 'Quitar me gusta' : 'Me gusta'}
                    onClick={() => setLiked((value) => !value)}
                  >
                    <ToggleIcon mode={mode} active={liked} heart>
                      <HeartIcon size={15} filled={liked} />
                    </ToggleIcon>
                  </SceneButton>
                </IconTile>
              </div>
              <p className="p1-mini-note">
                La campana suena al pasar el puntero y suma un contador al hacer clic.
              </p>
            </P1Block>

            <P1Block
              title="Chevron y despliegue"
              hint="giro · altura"
              className="p1-span-2"
            >
              <SceneButton
                mode={mode}
                variant="ghost"
                className="p1-disclosure__btn"
                aria-expanded={expanded}
                onClick={() => setExpanded((value) => !value)}
              >
                <span>Detalles del hilo</span>
                {mode === 'animate' ? (
                  <motion.span
                    className="p1-chevron-box"
                    animate={{ rotate: expanded ? 180 : 0 }}
                    transition={motionTokens.tweens.disclosure}
                  >
                    <ChevronDownIcon size={13} />
                  </motion.span>
                ) : (
                  <ChevronDownIcon
                    size={13}
                    className={`p1-chevron${expanded ? ' is-open' : ''}`}
                  />
                )}
              </SceneButton>
              {mode === 'animate' ? (
                <AnimatePresence initial={false}>
                  {expanded && (
                    <motion.div
                      key="body"
                      className="p1-disclosure__body"
                      initial={{
                        height: 0,
                        opacity: 0,
                        filter: motionTokens.blur.disclosure,
                      }}
                      animate={{
                        height: 'auto',
                        opacity: 1,
                        filter: 'blur(0px)',
                        transitionEnd: { filter: 'none' },
                        transition: motionTokens.tweens.disclosure,
                      }}
                      exit={{
                        height: 0,
                        opacity: 0,
                        filter: motionTokens.blur.disclosure,
                        transition: motionTokens.tweens.disclosure,
                      }}
                      style={{ overflow: 'hidden' }}
                    >
                      <p className="p1-disclosure__text">
                        El hilo se guarda con sus archivos, su modelo y el último punto de
                        restauración. Nada se envía hasta que lo confirmes.
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              ) : (
                expanded && (
                  <div className="p1-disclosure__body motion-row-in">
                    <p className="p1-disclosure__text">
                      El hilo se guarda con sus archivos, su modelo y el último punto de
                      restauración. Nada se envía hasta que lo confirmes.
                    </p>
                  </div>
                )
              )}
            </P1Block>
          </div>
        </P1Pane>
      )}
    </CompareScene>
  );
}
