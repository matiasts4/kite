import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useLabMotion, useLabReduce } from '../../context';
import {
  CompareScene,
  SceneButton,
  type CompareVariant,
  type CompareView,
} from '../../frame';
import { SwapLabel } from '../../ui';

/* -------------------------------------------------------------------------- */
/* Scene 4 — Skeletons and spinners                                           */
/* -------------------------------------------------------------------------- */

export function Spinner({
  mode,
  size = 14,
}: {
  mode: CompareVariant;
  size?: number;
}) {
  const reduce = useLabReduce();

  if (mode === 'kite') {
    return (
      <span
        className="p3-spinner p3-spinner--css"
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
    );
  }

  return (
    <motion.span
      className="p3-spinner"
      style={{ width: size, height: size }}
      aria-hidden="true"
      animate={
        reduce
          ? { rotate: 0, opacity: [1, 0.4, 1] }
          : { rotate: 360, opacity: 1 }
      }
      transition={
        reduce
          ? { duration: 1.8, repeat: Infinity, ease: 'easeInOut' }
          : { duration: 0.9, repeat: Infinity, ease: 'linear' }
      }
    />
  );
}

function ProfileSkeleton() {
  return (
    <div className="p3-skel" aria-hidden="true">
      <div className="p3-skel__profile">
        <span className="p3-skel__avatar p3-shimmer" />
        <div className="p3-skel__lines">
          <span className="p3-skel__bar p3-shimmer" style={{ width: '58%' }} />
          <span className="p3-skel__bar p3-shimmer" style={{ width: '36%' }} />
        </div>
      </div>
      <span className="p3-skel__bar p3-shimmer p3-skel__bar--wide" />
      <span className="p3-skel__bar p3-shimmer" style={{ width: '86%' }} />
      <div className="p3-skel__stats">
        <span className="p3-skel__block p3-shimmer" />
        <span className="p3-skel__block p3-shimmer" />
        <span className="p3-skel__block p3-shimmer" />
      </div>
    </div>
  );
}

function ProfileContent() {
  return (
    <div className="p3-profile">
      <span className="p3-avatar" aria-hidden="true">
        KV
      </span>
      <div className="p3-profile__copy">
        <strong>Kite View</strong>
        <span>Workspace de Ana · 14 miembros</span>
      </div>
      <span className="cmp-badge">pro</span>
      <div className="p3-profile__stats">
        <div>
          <span>Hilos</span>
          <strong>12</strong>
        </div>
        <div>
          <span>Runs</span>
          <strong>48</strong>
        </div>
        <div>
          <span>Tickets</span>
          <strong>660</strong>
        </div>
      </div>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="p3-page-preview" aria-hidden="true">
      <div className="p3-page-preview__head">
        <span className="p3-skel__bar p3-shimmer" style={{ width: '44%' }} />
        <span className="p3-skel__bar p3-shimmer" style={{ width: '20%' }} />
      </div>
      {[0, 1, 2].map((row) => (
        <div key={row} className="p3-page-preview__row">
          <span className="p3-skel__bar p3-shimmer" style={{ width: '54%' }} />
          <span className="p3-skel__block p3-shimmer p3-skel__block--sm" />
        </div>
      ))}
    </div>
  );
}

function PageContent() {
  const runs = [
    { id: 'feat/motion', state: 'ok', detail: 'hace 2 min' },
    { id: 'fix/dock', state: 'ok', detail: 'hace 18 min' },
    { id: 'agents/preview', state: 'warn', detail: 'ayer' },
  ];
  return (
    <div className="p3-page-preview">
      {runs.map((run) => (
        <div key={run.id} className="p3-page-preview__row p3-page-preview__row--loaded">
          <span>{run.id}</span>
          <span className={`cmp-badge${run.state === 'warn' ? ' p3-badge--warn' : ''}`}>
            {run.state === 'ok' ? 'ok' : 'warn'}
          </span>
          <span className="p3-hint">{run.detail}</span>
        </div>
      ))}
    </div>
  );
}

function SkeletonColumn({
  mode,
  cardLoading,
  pageLoading,
  saving,
  syncing,
  saveNote,
  onReloadCard,
  onReloadPage,
  onSave,
  onSync,
}: {
  mode: CompareVariant;
  cardLoading: boolean;
  pageLoading: boolean;
  saving: boolean;
  syncing: boolean;
  saveNote: string;
  onReloadCard: () => void;
  onReloadPage: () => void;
  onSave: () => void;
  onSync: () => void;
}) {
  const motionTokens = useLabMotion();

  return (
    <div className="p3-pane" data-mode={mode}>
      <div className="p3-skel-grid">
        <section className="p3-demo-card" aria-busy={cardLoading} aria-live="polite">
          <div className="p3-demo-card__head">
            <span className="p3-panel__label">Tarjeta del workspace</span>
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={onReloadCard}
              disabled={cardLoading}
            >
              Recargar
            </SceneButton>
          </div>

          {mode === 'kite' ? (
            cardLoading ? (
              <ProfileSkeleton />
            ) : (
              <div className="motion-row-in">
                <ProfileContent />
              </div>
            )
          ) : (
            <div className="p3-crossfade">
              <AnimatePresence mode="popLayout" initial={false}>
                {cardLoading ? (
                  <motion.div
                    key="skeleton"
                    aria-hidden="true"
                    exit={{ opacity: 0, transition: motionTokens.tweens.fade }}
                  >
                    <ProfileSkeleton />
                  </motion.div>
                ) : (
                  <motion.div
                    key="content"
                    initial={{ opacity: 0, filter: motionTokens.surfaceBlur }}
                    animate={{
                      opacity: 1,
                      filter: 'blur(0px)',
                      transition: motionTokens.tweens.reveal,
                    }}
                  >
                    <ProfileContent />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </section>

        <section className="p3-demo-card" aria-busy={pageLoading}>
          <div className="p3-demo-card__head">
            <span className="p3-panel__label">Historial de runs</span>
            <SceneButton
              mode={mode}
              variant="ghost"
              className="cmp-btn--sm"
              onClick={onReloadPage}
              disabled={pageLoading}
            >
              Recargar
            </SceneButton>
          </div>

          {mode === 'kite' ? (
            pageLoading ? (
              <PageSkeleton />
            ) : (
              <div className="motion-row-in">
                <PageContent />
              </div>
            )
          ) : (
            <div className="p3-crossfade">
              <AnimatePresence mode="popLayout" initial={false}>
                {pageLoading ? (
                  <motion.div
                    key="skeleton"
                    aria-hidden="true"
                    exit={{ opacity: 0, transition: motionTokens.tweens.fade }}
                  >
                    <PageSkeleton />
                  </motion.div>
                ) : (
                  <motion.div
                    key="content"
                    initial={{ opacity: 0, filter: motionTokens.surfaceBlur }}
                    animate={{
                      opacity: 1,
                      filter: 'blur(0px)',
                      transition: motionTokens.tweens.reveal,
                    }}
                  >
                    <PageContent />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </section>
      </div>

      <div className="p3-inline" role="status" aria-live="polite">
        {syncing ? (
          <>
            <Spinner mode={mode} size={13} />
            <span>Sincronizando 3 cambios…</span>
          </>
        ) : (
          <>
            <span className="p3-inline__dot" aria-hidden="true" />
            <span>Todo sincronizado</span>
          </>
        )}
        <SceneButton
          mode={mode}
          variant="ghost"
          className="cmp-btn--sm p3-inline__action"
          onClick={onSync}
          disabled={syncing}
        >
          Sincronizar
        </SceneButton>
      </div>

      <div className="p3-toolbar p3-toolbar--between">
        <span className="p3-hint">El shimmer se detiene con reduced motion; el spinner gira más lento.</span>
        <SceneButton
          mode={mode}
          variant="primary"
          className="p3-save-card"
          onClick={onSave}
          disabled={saving}
        >
          {saving && <Spinner mode={mode} size={12} />}
          {mode === 'animate' ? (
            <SwapLabel
              value={saving ? 'Guardando…' : 'Guardar tarjeta'}
              labels={['Guardar tarjeta', 'Guardando…']}
            />
          ) : saving ? (
            'Guardando…'
          ) : (
            'Guardar tarjeta'
          )}
        </SceneButton>
      </div>
      {saveNote && (
        <p className="p3-hint p3-save-note" role="status" aria-live="polite">
          {saveNote}
        </p>
      )}
    </div>
  );
}

export function SkeletonsSection({ view }: { view: CompareView }) {
  const [cardLoading, setCardLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [saveNote, setSaveNote] = useState('');
  const cardTimer = useRef<number | null>(null);
  const pageTimer = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);
  const syncTimer = useRef<number | null>(null);

  useEffect(() => {
    cardTimer.current = window.setTimeout(() => setCardLoading(false), 1400);
    pageTimer.current = window.setTimeout(() => setPageLoading(false), 1850);
    return () => {
      [cardTimer, pageTimer, saveTimer, syncTimer].forEach((timer) => {
        if (timer.current !== null) window.clearTimeout(timer.current);
      });
    };
  }, []);

  const reloadCard = () => {
    if (cardTimer.current !== null) window.clearTimeout(cardTimer.current);
    setCardLoading(true);
    cardTimer.current = window.setTimeout(() => setCardLoading(false), 1400);
  };

  const reloadPage = () => {
    if (pageTimer.current !== null) window.clearTimeout(pageTimer.current);
    setPageLoading(true);
    pageTimer.current = window.setTimeout(() => setPageLoading(false), 1700);
  };

  const saveCard = () => {
    if (saving) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    setSaving(true);
    setSaveNote('');
    saveTimer.current = window.setTimeout(() => {
      setSaving(false);
      setSaveNote('Tarjeta guardada en el workspace.');
    }, 1400);
  };

  const syncNow = () => {
    if (syncing) return;
    if (syncTimer.current !== null) window.clearTimeout(syncTimer.current);
    setSyncing(true);
    syncTimer.current = window.setTimeout(() => setSyncing(false), 1800);
  };

  return (
    <CompareScene
      index="3.4"
      title="Skeletons y spinners"
      target="Skeleton · LoadingButton · Spinner"
      note="Skeleton con shimmer que se cruza con el contenido real, spinner de botón, spinner inline y skeleton de página. Kite cambia en seco con una entrada de 180 ms; Animate UI superpone la salida del skeleton con un fade y revela el contenido desde blur.surface."
      view={view}
    >
      {(mode) => (
        <SkeletonColumn
          mode={mode}
          cardLoading={cardLoading}
          pageLoading={pageLoading}
          saving={saving}
          syncing={syncing}
          saveNote={saveNote}
          onReloadCard={reloadCard}
          onReloadPage={reloadPage}
          onSave={saveCard}
          onSync={syncNow}
        />
      )}
    </CompareScene>
  );
}

export { SkeletonsSection as SkeletonsScene };
