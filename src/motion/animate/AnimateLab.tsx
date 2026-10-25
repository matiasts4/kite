import { useEffect, useLayoutEffect, useMemo, useState, type ComponentType } from 'react';
import ReactDOM from 'react-dom/client';
import { motion, MotionConfig } from 'motion/react';
import { prefersReducedMotion } from '../contract';
import { LabMotionContext, LabReduceContext } from './context';
import { createLabTokens, type LabLevel } from './tokens';
import './animateLab.css';
import type { CompareView } from './frame';
import { ControlsPage } from './pages/controls/ControlsPage';
import { NavigationPage } from './pages/navigation/NavigationPage';
import { FeedbackPage } from './pages/feedback/FeedbackPage';
import { DataPage } from './pages/data/DataPage';
import { OverlaysPage } from './pages/overlays/OverlaysPage';
import { ScenesAPage } from './pages/scenes-a/ScenesAPage';
import { ScenesBPage } from './pages/scenes-b/ScenesBPage';
import { GesturesPage } from './pages/gestures/GesturesPage';
import { SystemPage } from './pages/system/SystemPage';
import { VisualPage } from './pages/visual/VisualPage';
import { LibrariesDevPage } from './pages/libraries/LibrariesDevPage';
import { ArrowRightIcon } from './ui';

const LEVELS: { id: LabLevel; label: string; hint: string }[] = [
  { id: 'subtle', label: 'Subtle', hint: 'El token de cada rol, sin extra' },
  { id: 'more', label: 'More', hint: 'Más recorrido y blur.surface' },
  { id: 'expressive', label: 'Expressive', hint: 'Recorrido largo y spring.bounce' },
];

const VIEWS: { id: CompareView; label: string }[] = [
  { id: 'split', label: 'Lado a lado' },
  { id: 'kite', label: 'Kite hoy' },
  { id: 'animate', label: 'Animate UI' },
];

interface LabPage {
  id: string;
  label: string;
  component: ComponentType<{ view: CompareView }>;
  viewLabels?: Partial<Record<CompareView, string>>;
}

const PAGES: LabPage[] = [
  { id: '1', label: 'Controles', component: ControlsPage },
  { id: '2', label: 'Navegación', component: NavigationPage },
  { id: '3', label: 'Feedback', component: FeedbackPage },
  { id: '4', label: 'Datos', component: DataPage },
  { id: '5', label: 'Overlays', component: OverlaysPage },
  { id: '6', label: 'Escenas A', component: ScenesAPage },
  { id: '7', label: 'Escenas B', component: ScenesBPage },
  { id: '8', label: 'Gestos', component: GesturesPage },
  { id: '9', label: 'Sistema', component: SystemPage },
  {
    id: '10',
    label: 'Lenguaje',
    component: VisualPage,
    viewLabels: { kite: 'Actual', animate: 'Propuesto' },
  },
  {
    id: '11',
    label: 'Libraries.dev',
    component: LibrariesDevPage,
    viewLabels: { kite: 'Kite Estándar', animate: 'Libraries.dev FX' },
  },
];

function readPageFromUrl(): string {
  const raw = new URLSearchParams(window.location.search).get('animate');
  return PAGES.some((page) => page.id === raw) ? (raw as string) : '1';
}

function LevelPicker({
  level,
  disabled,
  onChange,
  spring,
}: {
  level: LabLevel;
  disabled: boolean;
  onChange: (next: LabLevel) => void;
  spring: ReturnType<typeof createLabTokens>['springs']['selection'];
}) {
  return (
    <div className="alab-segmented" role="radiogroup" aria-label="Intensidad de Animate UI">
      {LEVELS.map((item) => (
        <button
          key={item.id}
          type="button"
          role="radio"
          aria-checked={level === item.id}
          className="alab-segmented__item"
          title={item.hint}
          disabled={disabled}
          onClick={() => onChange(item.id)}
        >
          {level === item.id && (
            <motion.span
              layoutId="alab-level-indicator"
              className="alab-segmented__indicator"
              initial={false}
              transition={spring}
            />
          )}
          <span className="alab-segmented__label">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

function ViewPicker({
  view,
  onChange,
  spring,
  labels,
}: {
  view: CompareView;
  onChange: (next: CompareView) => void;
  spring: ReturnType<typeof createLabTokens>['springs']['selection'];
  labels?: Partial<Record<CompareView, string>>;
}) {
  return (
    <div className="alab-segmented alab-segmented--view" role="radiogroup" aria-label="Vista">
      {VIEWS.map((item) => (
        <button
          key={item.id}
          type="button"
          role="radio"
          aria-checked={view === item.id}
          className="alab-segmented__item"
          onClick={() => onChange(item.id)}
        >
          {view === item.id && (
            <motion.span
              layoutId="alab-view-indicator"
              className="alab-segmented__indicator"
              initial={false}
              transition={spring}
            />
          )}
          <span className="alab-segmented__label">{labels?.[item.id] ?? item.label}</span>
        </button>
      ))}
    </div>
  );
}

function PageNav({
  page,
  onChange,
  spring,
}: {
  page: string;
  onChange: (next: string) => void;
  spring: ReturnType<typeof createLabTokens>['springs']['selection'];
}) {
  return (
    <nav className="alab-pagenav" aria-label="Páginas del laboratorio">
      {PAGES.map((item) => (
        <button
          key={item.id}
          type="button"
          className="alab-pagenav__item"
          aria-current={page === item.id ? 'page' : undefined}
          onClick={() => onChange(item.id)}
        >
          {page === item.id && (
            <motion.span
              layoutId="alab-page-indicator"
              className="alab-pagenav__indicator"
              initial={false}
              transition={spring}
            />
          )}
          <span className="alab-pagenav__index">{item.id.padStart(2, '0')}</span>
          <span className="alab-pagenav__label">{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

export function AnimateLab() {
  const [page, setPage] = useState(() => readPageFromUrl());
  const [view, setView] = useState<CompareView>('split');
  const [level, setLevel] = useState<LabLevel>('subtle');
  const [tempo, setTempo] = useState(1);
  const [reduce, setReduce] = useState(() => prefersReducedMotion());

  useLayoutEffect(() => {
    document.documentElement.dataset.motion = reduce ? 'reduce' : 'full';
    return () => {
      delete document.documentElement.dataset.motion;
    };
  }, [reduce]);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduce(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const previous = document.title;
    document.title = 'Kite · Motion Lab comparison';
    return () => {
      document.title = previous;
    };
  }, []);

  useEffect(() => {
    const lab = document.querySelector<HTMLElement>('.animate-lab');
    if (lab) lab.scrollTop = 0;
  }, [page]);

  const tokens = useMemo(() => createLabTokens(level, tempo), [level, tempo]);
  const kiteOnly = view === 'kite';
  const activePage = PAGES.find((item) => item.id === page) ?? PAGES[0];
  const ActivePage = activePage.component;
  const designOnly = activePage.id === '10';
  const controlsDisabled = kiteOnly || designOnly;

  const selectPage = (next: string) => {
    setPage(next);
    const url = new URL(window.location.href);
    url.searchParams.set('animate', next);
    window.history.replaceState(null, '', url);
  };

  useEffect(() => {
    document.body.classList.add('kite-app');
  }, []);

  return (
    <LabMotionContext.Provider value={tokens}>
      <LabReduceContext.Provider value={reduce}>
        <MotionConfig reducedMotion={reduce ? 'always' : 'never'}>
          <div className="animate-lab kite-app">
            <header className="alab-topbar">
              <div className="alab-topbar__brand">
                <span className="alab-topbar__mark" aria-hidden="true" />
                <span>
                  <strong>Kite</strong>
                  <span className="alab-topbar__slash">/</span>
                  Motion Lab
                </span>
                <span className="alab-topbar__tag">comparison</span>
              </div>

              <div className="alab-controls">
                <ViewPicker
                  view={view}
                  onChange={setView}
                  spring={tokens.springs.selection}
                  labels={activePage.viewLabels}
                />

                <span className="alab-controls__divider" aria-hidden="true" />

                <LevelPicker
                  level={level}
                  disabled={controlsDisabled}
                  onChange={setLevel}
                  spring={tokens.springs.selection}
                />

                <label className={`alab-control${controlsDisabled ? ' is-disabled' : ''}`}>
                  <span>
                    Tempo <strong>×{tempo.toFixed(2)}</strong>
                  </span>
                  <input
                    type="range"
                    min={0.6}
                    max={1.6}
                    step={0.05}
                    value={tempo}
                    disabled={controlsDisabled}
                    aria-label="Tempo de Animate UI"
                    onChange={(event) => setTempo(Number(event.target.value))}
                  />
                </label>

                <label className="alab-check">
                  <input
                    type="checkbox"
                    checked={reduce}
                    onChange={(event) => setReduce(event.target.checked)}
                  />
                  Reduced motion
                </label>

                <a className="alab-link" href="?motion">
                  Motion Lab
                  <ArrowRightIcon size={13} />
                </a>
              </div>

              <PageNav page={page} onChange={selectPage} spring={tokens.springs.selection} />
            </header>

            <main className="alab-wrap">
              <section className="alab-hero">
                <span className="alab-eyebrow">Animate UI · comparación por páginas</span>
                <h1>Los componentes completos, con dos motores</h1>
                <p>
                  Diez páginas, un mismo estado por escena. A la izquierda, lo que Kite hace hoy:
                  CSS de 180 ms de entrada, 140 ms de salida, transform y opacity. A la derecha,
                  Animate UI: springs, retarget al interrumpir, blur y origen en el trigger. La
                  página 10 suma el lenguaje visual: forma, superficie y controles. Los componentes
                  de producción no se tocan.
                </p>
                <ul className="alab-hero__notes">
                  <li>Ruta dev-only <code>?animate</code></li>
                  <li>10 páginas numeradas</li>
                  <li>El nivel y el tempo solo afectan Animate UI</li>
                  <li>Página 10: lenguaje visual, sin cambiar producción</li>
                  <li>Reduced motion apaga el movimiento en ambas</li>
                </ul>
              </section>

              <ActivePage view={view} />

              <footer className="alab-footer">
                <span>
                  Cada página nombra la superficie real a la que mapea. Si una interacción convence,
                  se lleva a su componente real; si no, se descarta sin dejar rastros.
                </span>
                <a className="alab-link" href="?motion">
                  Volver al Motion Lab de Kite
                  <ArrowRightIcon size={13} />
                </a>
              </footer>
            </main>
          </div>
        </MotionConfig>
      </LabReduceContext.Provider>
    </LabMotionContext.Provider>
  );
}

export function renderAnimateLab(root: HTMLElement): void {
  ReactDOM.createRoot(root).render(<AnimateLab />);
}
