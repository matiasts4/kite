import React, { useState, useEffect, useRef, useId, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

export interface WhatsNewModalProps {
  isOpen: boolean;
  onClose: () => void;
}

import { useAppUpdater } from '../../../hooks/useAppUpdater';
import { getReleases, type ReleaseCategory as ChangeCategory } from '../../../lib/changelogData';

// Clean inline SVG components (zero Lucide, zero emojis)
const IconSparkles: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    <path d="M5 3v4" />
    <path d="M19 17v4" />
    <path d="M3 5h4" />
    <path d="M17 19h4" />
  </svg>
);

const IconArrowUpRight: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M7 17 17 7" />
    <path d="M7 7h10v10" />
  </svg>
);

const IconWrench: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);

const IconShieldCheck: React.FC<{ size?: number }> = ({ size = 13 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

type SvgIconComponent = React.FC<{ size?: number }>;

const CATEGORY_META: Record<
  ChangeCategory,
  { label: string; colorVar: string; icon: SvgIconComponent }
> = {
  added: {
    label: 'New',
    colorVar: '--status-running',
    icon: IconSparkles,
  },
  changed: {
    label: 'Improved',
    colorVar: '--brand-electric-blue',
    icon: IconArrowUpRight,
  },
  fixed: {
    label: 'Fixed',
    colorVar: '--brand-amber',
    icon: IconWrench,
  },
  security: {
    label: 'Security',
    colorVar: '--text-primary',
    icon: IconShieldCheck,
  },
};

const ACK_KEY = 'bmone.releaseNotes.acknowledgedVersion';

function getUiScale(el: HTMLElement | null): number {
  const scaled = el?.closest('.app-frame--scaled') ?? document.querySelector('.app-frame--scaled');
  if (!scaled) return 1;
  const val = Number(window.getComputedStyle(scaled).getPropertyValue('--ui-scale'));
  return Number.isFinite(val) && val > 0 ? val : 1;
}

export const WhatsNewModal: React.FC<WhatsNewModalProps> = ({ isOpen, onClose }) => {
  const headingId = useId();
  const modalRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const { currentVersion } = useAppUpdater();
  const releases = getReleases(currentVersion);
  const currentRelease = releases.find((r) => r.isCurrent) || releases[0];
  const selectedVersion = currentRelease.version;
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useLayoutEffect(() => {
    if (isOpen) {
      setScale(getUiScale(modalRef.current));
    }
  }, [isOpen]);

  // Subtle animated canvas background in the hero banner
  useEffect(() => {
    if (!isOpen) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let width = (canvas.width = canvas.parentElement?.clientWidth || 540);
    let height = (canvas.height = 136);

    const particles: Array<{ x: number; y: number; r: number; dx: number; dy: number; alpha: number }> = [];
    for (let i = 0; i < 40; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.5 + 0.5,
        dx: (Math.random() - 0.5) * 0.35,
        dy: (Math.random() - 0.5) * 0.35,
        alpha: Math.random() * 0.6 + 0.2,
      });
    }

    const render = () => {
      ctx.clearRect(0, 0, width, height);

      const gradient = ctx.createRadialGradient(width * 0.7, height * 0.5, 5, width * 0.7, height * 0.5, width * 0.6);
      gradient.addColorStop(0, 'rgba(59, 130, 246, 0.18)');
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      for (const p of particles) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(147, 197, 253, ${p.alpha})`;
        ctx.fill();

        p.x += p.dx;
        p.y += p.dy;
        if (p.x < 0) p.x = width;
        if (p.x > width) p.x = 0;
        if (p.y < 0) p.y = height;
        if (p.y > height) p.y = 0;
      }
      animationFrameId = requestAnimationFrame(render);
    };

    render();

    const handleResize = () => {
      if (canvas && canvas.parentElement) {
        width = canvas.width = canvas.parentElement.clientWidth;
        height = canvas.height = 136;
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', handleResize);
    };
  }, [isOpen]);

  // Keyboard navigation: Escape or Enter closes dialog
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;
      if (e.key === 'Escape' || e.key === 'Enter') {
        try {
          localStorage.setItem(ACK_KEY, currentRelease.version);
        } catch {
          // ignore
        }
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, currentRelease.version]);

  const handleDismiss = () => {
    try {
      localStorage.setItem(ACK_KEY, currentRelease.version);
    } catch {
      // ignore
    }
    onClose();
  };

  if (!isOpen) return null;

  const activeRelease = releases.find((r) => r.version === selectedVersion) || currentRelease;

  const filteredItems = activeRelease.items.filter((item) => {
    if (selectedCategory === 'all') return true;
    return item.category === selectedCategory;
  });

  const counts = {
    all: currentRelease.items.length,
    added: currentRelease.items.filter((i) => i.category === 'added').length,
    changed: currentRelease.items.filter((i) => i.category === 'changed').length,
    fixed: currentRelease.items.filter((i) => i.category === 'fixed').length,
    security: currentRelease.items.filter((i) => i.category === 'security').length,
  };

  const categories = (['added', 'changed', 'fixed', 'security'] as ChangeCategory[])
    .map((cat) => ({
      id: cat,
      label: CATEGORY_META[cat].label,
      colorVar: CATEGORY_META[cat].colorVar,
      count: counts[cat],
    }))
    .filter((c) => c.count > 0);

  const content = (
    <div
      ref={modalRef}
      className="whats-new-layer"
      style={{ '--sheet-scale': String(scale) } as React.CSSProperties}
    >
      <div
        aria-hidden="true"
        className="whats-new-layer__scrim"
        onClick={handleDismiss}
      />
      <section
        aria-labelledby={headingId}
        aria-modal="true"
        className="whats-new"
        role="dialog"
      >
        {/* Hero Section */}
        <header className="whats-new__hero">
          <canvas ref={canvasRef} className="whats-new__canvas" data-ready="true" />
          <div className="whats-new__hero-copy">
            <p className="whats-new__badge">
              <IconSparkles size={11} />
              What’s new
            </p>
            <h2 className="whats-new__title" id={headingId}>
              Kite <span className="whats-new__version">{currentRelease.version}</span>
            </h2>
            <p className="whats-new__meta">
              {currentRelease.date} · {counts.all} updates in this build
            </p>
          </div>
        </header>

        {/* Category Filter Tabs */}
        <div aria-label="Filter changes" className="whats-new__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={selectedCategory === 'all'}
            className="whats-new__tab"
            onClick={() => setSelectedCategory('all')}
          >
            All <span className="whats-new__count">{counts.all}</span>
          </button>
          {categories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              role="tab"
              aria-selected={selectedCategory === cat.id}
              className="whats-new__tab"
              style={{ '--kind-ink': `var(${cat.colorVar})` } as React.CSSProperties}
              onClick={() => setSelectedCategory(cat.id)}
            >
              <span aria-hidden="true" className="whats-new__dot" />
              {cat.label} <span className="whats-new__count">{cat.count}</span>
            </button>
          ))}
        </div>

        {/* Release Items Body */}
        <div className="whats-new__body scroll-quiet" tabIndex={0}>
          <section aria-label={`Kite ${currentRelease.version}`} className="whats-new__release">
            <ul className="whats-new__items">
              {filteredItems.map((item, idx) => {
                const meta = CATEGORY_META[item.category];
                const IconComponent = meta.icon;
                return (
                  <li
                    key={idx}
                    className="whats-new__item"
                    style={
                      {
                        '--kind-ink': `var(${meta.colorVar})`,
                        '--reveal-index': String(Math.min(idx, 10)),
                      } as React.CSSProperties
                    }
                  >
                    <span className="whats-new__tile" title={meta.label}>
                      <IconComponent size={13} />
                    </span>
                    <span className="whats-new__text">{item.text}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>

        {/* Footer */}
        <footer className="whats-new__footer">
          <p className="whats-new__hint">Every release lives in Settings → Changelog</p>
          <div>
            <button
              type="button"
              className="primary-button"
              onClick={handleDismiss}
            >
              <span>Got it</span>
              <span aria-hidden="true" className="whats-new__kbd">↵</span>
            </button>
          </div>
        </footer>
      </section>
    </div>
  );

  return typeof document !== 'undefined'
    ? createPortal(content, document.querySelector('.app-frame--scaled') ?? document.body)
    : content;
};
