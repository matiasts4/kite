import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AnimateLab } from './AnimateLab';
import motionLabSource from '../MotionLab.tsx?raw';

function stubMatchMedia() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function renderPage(id: string) {
  window.history.replaceState({}, '', `/?animate=${id}`);
  return render(<AnimateLab />);
}

beforeEach(() => {
  stubMatchMedia();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      root = null;
      rootMargin = '';
      thresholds = [];
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    }
  );
  vi.stubGlobal('scrollTo', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.motion;
});

describe('page shell and expansion (S9, S10, S11)', () => {
  it('exposes eleven numbered pages, keeps the nav and syncs ?animate=<n>', () => {
    const { container } = renderPage('1');
    const nav = container.querySelectorAll('.alab-pagenav__item');
    expect(nav).toHaveLength(11);
    fireEvent.click(nav[5]);
    expect(window.location.search).toBe('?animate=6');
    expect(container.querySelectorAll('.alab-pagenav__item')).toHaveLength(11);
    expect(container.querySelector('.alab-pagenav__item[aria-current="page"]')).not.toBeNull();
  });

  it.each(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'])(
    'page %s renders through the shared frame and is not a placeholder',
    (id) => {
      const { container, unmount } = renderPage(id);
      expect(container.textContent).not.toMatch(/en construcción/i);
      expect(container.querySelectorAll('.cmp-scene').length).toBeGreaterThan(0);
      expect(container.querySelectorAll('.cmp-grid')).not.toHaveLength(0);
      expect(container.querySelectorAll('.cmp-pane').length).toBeGreaterThanOrEqual(2);
      expect(container.querySelectorAll('.cmp-btn, .p10-btn, .p11-demo-btn, .p11-metal-btn').length).toBeGreaterThan(0);
      unmount();
    }
  );
});

describe('visual language page (S14)', () => {
  it('compares actual and proposed controls', () => {
    const { container } = renderPage('10');
    expect(container.querySelectorAll('.cmp-scene')).toHaveLength(5);
    expect(container.querySelectorAll('.p10-check')).toHaveLength(5);
    expect(container.querySelectorAll('.p10-radio')).toHaveLength(3);
    expect(container.querySelectorAll('.p10-switch')).toHaveLength(2);
    expect(container.querySelectorAll('.p10-field')).toHaveLength(4);
    expect(container.querySelectorAll('.p10-btn').length).toBeGreaterThanOrEqual(20);
    expect(container.querySelectorAll('.p10-card')).toHaveLength(4);
    expect(container.textContent).toContain('Actual');
    expect(container.textContent).toContain('Propuesto');
  });

  it('disables level and tempo because the page is about shape', () => {
    renderPage('10');
    expect(screen.getByRole('radio', { name: 'Subtle' })).toBeDisabled();
    expect(screen.getByRole('slider', { name: 'Tempo de Animate UI' })).toBeDisabled();
  });
});

describe('complete scenes (S5, S8)', () => {
  it('page 06 renders chat, settings and workspace scenes with two panes each', () => {
    const { container } = renderPage('6');
    expect(container.querySelectorAll('.cmp-scene').length).toBeGreaterThanOrEqual(4);
    expect(container.querySelectorAll('.cmp-chat__transcript')).toHaveLength(2);
    expect(container.querySelectorAll('.cmp-composer')).toHaveLength(2);
    expect(container.querySelectorAll('.cmp-tabs').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelectorAll('.cmp-workspace__rail')).toHaveLength(2);
  });

  it('page 07 renders the usage/notifications surface in both panes', () => {
    const { container } = renderPage('7');
    expect(container.querySelectorAll('.cmp-notifications')).toHaveLength(2);
  });

  it('adds a chat message sent from the Kite column to both panes', () => {
    const { container } = renderPage('6');
    const scene = [...container.querySelectorAll('.cmp-scene')].find((candidate) =>
      candidate.querySelector('.cmp-composer')
    );
    expect(scene).toBeTruthy();
    const panes = scene!.querySelectorAll('.cmp-pane');
    const input = panes[0].querySelector('.cmp-composer__input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Hola' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(within(panes[0] as HTMLElement).getByText('Hola')).toBeInTheDocument();
    expect(within(panes[1] as HTMLElement).getByText('Hola')).toBeInTheDocument();
  });

  it('mirrors a settings tab change from the Animate column', () => {
    const { container } = renderPage('6');
    const scene = [...container.querySelectorAll('.cmp-scene')].find((candidate) =>
      candidate.querySelector('.cmp-tabs')
    );
    expect(scene).toBeTruthy();
    const panes = scene!.querySelectorAll('.cmp-pane');
    fireEvent.click(within(panes[1] as HTMLElement).getByRole('tab', { name: 'Modelos' }));
    expect(within(panes[0] as HTMLElement).getByText('Modelo por defecto')).toBeInTheDocument();
  });
});

describe('controls (S4)', () => {
  it('scopes level/tempo to Animate UI and reduced motion to both', () => {
    const { container } = renderPage('6');
    const kitePane = container.querySelector('.cmp-scene .cmp-pane') as HTMLElement;
    const before = kitePane.innerHTML;
    const sceneCount = container.querySelectorAll('.cmp-scene').length;
    fireEvent.click(screen.getByRole('radio', { name: 'Expressive' }));
    fireEvent.change(screen.getByRole('slider', { name: 'Tempo de Animate UI' }), {
      target: { value: '1.6' },
    });
    expect(kitePane.innerHTML).toBe(before);
    fireEvent.click(screen.getByRole('radio', { name: 'Animate UI' }));
    expect(container.querySelectorAll('.cmp-pane')).toHaveLength(sceneCount);
    fireEvent.click(screen.getByRole('radio', { name: 'Kite hoy' }));
    expect(screen.getByRole('radio', { name: 'Subtle' })).toBeDisabled();
    expect(screen.getByRole('slider', { name: 'Tempo de Animate UI' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Reduced motion'));
    expect(document.documentElement.dataset.motion).toBe('reduce');
  });
});

describe('libraries.dev suite page (S15)', () => {
  it('renders all libraries.dev showcase scenes', () => {
    const { container } = renderPage('11');
    expect(container.querySelectorAll('.cmp-scene')).toHaveLength(5);
    expect(container.textContent).toContain('Libraries.dev');
  });
});

describe('page 02 navigation with real header & sidebar scenes', () => {
  it('renders Scene A, B, and C at the top of page 2 with authentic TitleBar and Sidebar', () => {
    const { container } = renderPage('2');

    // Verify Scene A (TitleBar)
    expect(container.textContent).toContain('Barra superior completa (TitleBar real)');
    expect(container.querySelector('.titlebar')).not.toBeNull();
    expect(container.querySelector('.brand-lockup')).not.toBeNull();
    expect(container.querySelector('[data-rail-toggle]')).not.toBeNull();
    expect(container.querySelector('[data-testid="operator-toggle"]')).not.toBeNull();
    expect(container.querySelector('.zed-mini-orb')).not.toBeNull();

    // Verify Scene B (Isolated controls)
    expect(container.textContent).toContain('Controles clave de la cabecera (inspección aislada)');
    expect(container.textContent).toContain('Selector de Modo Superior');
    expect(container.textContent).toContain('Consumo y Cuotas IA');
    expect(container.textContent).toContain('Recursos del Sistema');
    expect(container.textContent).toContain('Asistente Zed (Mini-Orb)');
    expect(container.querySelector('.p2-standalone-zed')).not.toBeNull();
    expect(container.textContent).toContain('Ultra Plan');

    // Verify Scene C (Sidebar & rosters)
    expect(container.textContent).toContain('Barra lateral real (Sidebar y rosters)');
    expect(container.querySelector('[data-testid="sidebar"]')).not.toBeNull();
    expect(container.textContent).toContain('Antigravity Lead');
    expect(container.textContent).toContain('Federico');
  });

  it('interacts with the TitleBar mode switcher and Zed assistant toggle on Page 2', () => {
    const { container } = renderPage('2');
    const zedBtn = container.querySelector('[data-testid="operator-toggle"]') as HTMLButtonElement;
    expect(zedBtn).not.toBeNull();
    expect(zedBtn.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(zedBtn);
    expect(zedBtn.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('lab links (S6)', () => {
  it('links from the preview back to ?motion', () => {
    const { container } = renderPage('1');
    expect(container.querySelector('.alab-topbar a[href="?motion"]')).not.toBeNull();
  });

  it('links from MotionLab to ?animate', () => {
    expect(motionLabSource).toContain('href="?animate"');
  });
});
