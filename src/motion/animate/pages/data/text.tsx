import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import { CompareScene, SceneButton, type CompareVariant, type CompareView } from '../../frame';

/* -------------------------------------------------------------------------- */
/* Scene 5 — Text: rotating, morphing, typing, splitting, rolling             */
/* -------------------------------------------------------------------------- */

const ROTATING_WORDS = ['revisa', 'escribe', 'despliega'];
const MORPH_PHRASES = ['Guardando…', 'Guardado'];
const MORPH_WIDTH = Math.max(...MORPH_PHRASES.map((phrase) => Array.from(phrase).length));
const TYPING_TEXT = 'npx tsc --noEmit · 0 errores en 2,1 s';
const SPLIT_TEXT = 'La línea se reparte sin mover el párrafo.';
const ROLLING_WORDS = ['LISTO', 'FALLO', 'CALMA'];

function RotatingLine({ mode, word }: { mode: CompareVariant; word: string }) {
  const motionTokens = useLabMotion();

  return (
    <span className="p4-textline">
      <span>Tu agente</span>
      <span className="p4-rotate">
        {ROTATING_WORDS.map((item) => (
          <span key={item} className="p4-rotate__ghost" aria-hidden="true">
            {item}
          </span>
        ))}
        <span className="p4-rotate__live">
          {mode === 'animate' ? (
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={word}
                className="p4-rotate__word"
                initial={{ y: '100%', opacity: 0, filter: motionTokens.swapBlur }}
                animate={{
                  y: 0,
                  opacity: 1,
                  filter: 'blur(0px)',
                  transition: motionTokens.tweens.swap,
                }}
                exit={{
                  y: '-100%',
                  opacity: 0,
                  filter: motionTokens.swapBlur,
                  transition: motionTokens.tweens.swap,
                }}
              >
                {word}
              </motion.span>
            </AnimatePresence>
          ) : (
            <span key={word} className="p4-rotate__word p4-word-in">
              {word}
            </span>
          )}
        </span>
      </span>
      <span>y vuelve con el diff.</span>
    </span>
  );
}

function MorphText({ mode, phrase }: { mode: CompareVariant; phrase: string }) {
  const motionTokens = useLabMotion();
  const chars = Array.from(phrase.padEnd(MORPH_WIDTH, ' '));

  return (
    <span className="p4-morph">
      <span className="p4-sr">{phrase}</span>
      <span className="p4-morph__slots" aria-hidden="true">
        {chars.map((char, index) => (
          <span key={index} className="p4-morph__slot">
            {mode === 'animate' ? (
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={char === ' ' ? 'space' : char}
                  className="p4-morph__ch"
                  initial={{ opacity: 0, filter: motionTokens.swapBlur, y: 2 }}
                  animate={{
                    opacity: 1,
                    filter: 'blur(0px)',
                    y: 0,
                    transition: motionTokens.tweens.swap,
                  }}
                  exit={{
                    opacity: 0,
                    filter: motionTokens.swapBlur,
                    y: -2,
                    transition: motionTokens.tweens.swap,
                  }}
                >
                  {char === ' ' ? '\u00A0' : char}
                </motion.span>
              </AnimatePresence>
            ) : (
              <span className="p4-morph__ch">{char === ' ' ? '\u00A0' : char}</span>
            )}
          </span>
        ))}
      </span>
    </span>
  );
}

function TypingText({ mode, text }: { mode: CompareVariant; text: string }) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();

  return (
    <span className="p4-typing">
      <span className="p4-typing__chars">
        {Array.from(text).map((char, index) => {
          const glyph = char === ' ' ? '\u00A0' : char;
          if (mode === 'animate' && !reduce) {
            return (
              <motion.span
                key={index}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={motionTokens.tweens.swap}
              >
                {glyph}
              </motion.span>
            );
          }
          return <span key={index}>{glyph}</span>;
        })}
      </span>
      {mode === 'animate' ? (
        <motion.span
          className="p4-caret"
          aria-hidden="true"
          animate={reduce ? { opacity: 1 } : { opacity: [1, 1, 0, 0] }}
          transition={
            reduce ? { duration: 0 } : { duration: 1, repeat: Infinity, times: [0, 0.5, 0.5, 1] }
          }
        />
      ) : (
        <span className="p4-caret p4-caret--css" aria-hidden="true" />
      )}
    </span>
  );
}

function SplitLine({
  mode,
  seq,
}: {
  mode: CompareVariant;
  seq: number;
}) {
  const motionTokens = useLabMotion();
  const reduce = useLabReduce();
  const words = SPLIT_TEXT.split(' ');

  if (mode === 'kite') {
    return (
      <span key={seq} className="p4-split-kite p4-block-in">
        {SPLIT_TEXT}
      </span>
    );
  }

  return (
    <span className="p4-split">
      <span className="p4-sr">{SPLIT_TEXT}</span>
      <span className="p4-split__words" aria-hidden="true">
        {words.map((word, index) => (
          <motion.span
            key={`${seq}-${index}`}
            initial={
              seq === 0 || reduce
                ? false
                : { opacity: 0, y: motionTokens.travel(6), filter: motionTokens.itemBlur }
            }
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{
              ...motionTokens.tweens.reveal,
              delay: index * motionTokens.stagger,
            }}
          >
            {word}
          </motion.span>
        ))}
      </span>
    </span>
  );
}

function RollingWord({
  mode,
  word,
  seq,
}: {
  mode: CompareVariant;
  word: string;
  seq: number;
}) {
  const motionTokens = useLabMotion();

  return (
    <span className="p4-roll">
      <span className="p4-sr">{word}</span>
      {Array.from(word).map((char, index) => (
        <span key={index} className="p4-roll__slot" aria-hidden="true">
          {mode === 'animate' ? (
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={`${seq}-${index}`}
                initial={{ y: '100%', opacity: 0 }}
                animate={{ y: 0, opacity: 1, transition: motionTokens.tweens.swap }}
                exit={{ y: '-100%', opacity: 0, transition: motionTokens.tweens.swap }}
              >
                {char}
              </motion.span>
            </AnimatePresence>
          ) : (
            <span key={`${seq}-${index}`} className="p4-roll__letter">
              {char}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

export function TextScene({ view }: { view: CompareView }) {
  const [wordIndex, setWordIndex] = useState(0);
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [typedCount, setTypedCount] = useState(0);
  const [splitSeq, setSplitSeq] = useState(0);
  const [rollIndex, setRollIndex] = useState(0);
  const [rollSeq, setRollSeq] = useState(0);
  const reduce = useLabReduce();

  useEffect(() => {
    if (typedCount >= TYPING_TEXT.length) return undefined;
    const timer = window.setTimeout(() => setTypedCount((current) => current + 1), 38);
    return () => window.clearTimeout(timer);
  }, [typedCount]);

  useEffect(() => {
    if (reduce && typedCount < TYPING_TEXT.length) setTypedCount(TYPING_TEXT.length);
  }, [reduce, typedCount]);

  return (
    <CompareScene
      index="05"
      title="Texto que cambia sin mover la línea"
      target="RotatingText · MorphingText · TypingText · SplittingText · RollingText"
      note="Cada disparador cambia el estado compartido. La palabra rotativa reserva el ancho mayor y conserva la línea base de la frase; el resto de la línea no se mueve. Kite cambia el texto con un fundido corto, Animate UI entra y sale por blur y desplazamiento."
      view={view}
    >
      {(mode) => (
        <div className="p4-text" data-engine={mode}>
          <div className="p4-text__row">
            <span className="p4-text__name">Palabra rotativa</span>
            <div className="p4-text__demo">
              <RotatingLine mode={mode} word={ROTATING_WORDS[wordIndex]} />
              <span className="p4-baseline">línea base compartida</span>
            </div>
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={() => setWordIndex((current) => (current + 1) % ROTATING_WORDS.length)}
            >
              Siguiente
            </SceneButton>
          </div>

          <div className="p4-text__row">
            <span className="p4-text__name">Texto que muta</span>
            <div className="p4-text__demo">
              <MorphText mode={mode} phrase={MORPH_PHRASES[phraseIndex]} />
            </div>
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={() => setPhraseIndex((current) => (current + 1) % MORPH_PHRASES.length)}
            >
              Mutar
            </SceneButton>
          </div>

          <div className="p4-text__row">
            <span className="p4-text__name">Texto que se escribe</span>
            <div className="p4-text__demo">
              <TypingText mode={mode} text={TYPING_TEXT.slice(0, typedCount)} />
            </div>
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={() => setTypedCount(0)}
            >
              Escribir
            </SceneButton>
          </div>

          <div className="p4-text__row">
            <span className="p4-text__name">Texto repartido</span>
            <div className="p4-text__demo">
              <SplitLine mode={mode} seq={splitSeq} />
            </div>
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={() => setSplitSeq((current) => current + 1)}
            >
              Repartir
            </SceneButton>
          </div>

          <div className="p4-text__row">
            <span className="p4-text__name">Texto rodante</span>
            <div className="p4-text__demo">
              <RollingWord mode={mode} word={ROLLING_WORDS[rollIndex]} seq={rollSeq} />
            </div>
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={() => {
                setRollIndex((current) => (current + 1) % ROLLING_WORDS.length);
                setRollSeq((current) => current + 1);
              }}
            >
              Rodar
            </SceneButton>
          </div>
        </div>
      )}
    </CompareScene>
  );
}
