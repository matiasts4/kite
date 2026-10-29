import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsView } from '../SettingsView';
import {
  getTerminalAppearancePrefs,
  setTerminalAppearancePrefs,
} from '../../../lib/terminalAppearancePrefs';

describe('SettingsView — Terminal Appearance & Typography', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('kite.settingsTab', 'terminal');
    vi.restoreAllMocks();
  });

  it('renders Apariencia y Tipografía section with default values', () => {
    render(<SettingsView />);

    expect(screen.getByText('Apariencia y Tipografía')).toBeInTheDocument();
    expect(screen.getByText('Motor de renderizado')).toBeInTheDocument();
    expect(screen.getByText('Familia tipográfica')).toBeInTheDocument();
    expect(screen.getByText('Tamaño de fuente')).toBeInTheDocument();
    expect(screen.getByText('Altura de línea')).toBeInTheDocument();
    expect(screen.getByText('Estilo del cursor')).toBeInTheDocument();

    // Default renderer is DOM · Clásico
    const domBtn = screen.getByRole('button', { name: /DOM · Clásico/i });
    expect(domBtn).toHaveAttribute('aria-pressed', 'true');

    // Default font size is 13 px
    expect(screen.getByText('13 px')).toBeInTheDocument();

    // Default line height is Clásico (1.16)
    const lineHeightClassic = screen.getByRole('button', { name: /Clásico \(1\.16\)/i });
    expect(lineHeightClassic).toHaveAttribute('aria-pressed', 'true');

    // Default cursor style is Barra
    const cursorBar = screen.getByRole('button', { name: /Barra/i });
    expect(cursorBar).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches renderer mode between DOM and WebGL', async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const webglBtn = screen.getByRole('button', { name: /WebGL · GPU/i });
    await user.click(webglBtn);

    expect(webglBtn).toHaveAttribute('aria-pressed', 'true');
    expect(getTerminalAppearancePrefs().renderer).toBe('webgl');

    const domBtn = screen.getByRole('button', { name: /DOM · Clásico/i });
    await user.click(domBtn);

    expect(domBtn).toHaveAttribute('aria-pressed', 'true');
    expect(getTerminalAppearancePrefs().renderer).toBe('dom');
  });

  it('adjusts font size with stepper buttons and resets to default', async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const incBtn = screen.getByRole('button', { name: 'Aumentar tamaño de fuente' });
    const decBtn = screen.getByRole('button', { name: 'Reducir tamaño de fuente' });

    // Step up to 14 px
    await user.click(incBtn);
    expect(screen.getByText('14 px')).toBeInTheDocument();
    expect(getTerminalAppearancePrefs().fontSize).toBe(14);

    // Reset button should now be visible
    const resetBtn = screen.getByRole('button', { name: /Restablecer/i });
    expect(resetBtn).toBeInTheDocument();

    // Click reset -> goes back to 13 px and reset button disappears
    await user.click(resetBtn);
    expect(screen.getByText('13 px')).toBeInTheDocument();
    expect(getTerminalAppearancePrefs().fontSize).toBe(13);
    expect(screen.queryByRole('button', { name: /Restablecer/i })).not.toBeInTheDocument();

    // Step down to 12 px
    await user.click(decBtn);
    expect(screen.getByText('12 px')).toBeInTheDocument();
    expect(getTerminalAppearancePrefs().fontSize).toBe(12);
  });

  it('switches line height presets', async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const balancedBtn = screen.getByRole('button', { name: /Balanceado \(1\.08\)/i });
    await user.click(balancedBtn);

    expect(balancedBtn).toHaveAttribute('aria-pressed', 'true');
    expect(getTerminalAppearancePrefs().lineHeight).toBe(1.08);

    const compactBtn = screen.getByRole('button', { name: /Compacto \(1\.0\)/i });
    await user.click(compactBtn);

    expect(compactBtn).toHaveAttribute('aria-pressed', 'true');
    expect(getTerminalAppearancePrefs().lineHeight).toBe(1.0);
  });

  it('switches cursor style between Barra, Bloque, and Subrayado', async () => {
    const user = userEvent.setup();
    render(<SettingsView />);

    const blockBtn = screen.getByRole('button', { name: /Bloque/i });
    await user.click(blockBtn);

    expect(blockBtn).toHaveAttribute('aria-pressed', 'true');
    expect(getTerminalAppearancePrefs().cursorStyle).toBe('block');

    const underlineBtn = screen.getByRole('button', { name: /Subrayado/i });
    await user.click(underlineBtn);

    expect(underlineBtn).toHaveAttribute('aria-pressed', 'true');
    expect(getTerminalAppearancePrefs().cursorStyle).toBe('underline');
  });

  it('reacts to external TERMINAL_APPEARANCE_CHANGED_EVENT broadcasts', async () => {
    render(<SettingsView />);

    act(() => {
      setTerminalAppearancePrefs({
        fontSize: 18,
        cursorStyle: 'block',
        lineHeight: 1.08,
        renderer: 'webgl',
      });
    });

    expect(await screen.findByText('18 px')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /WebGL · GPU/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: /Bloque/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Balanceado \(1\.08\)/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });
});
