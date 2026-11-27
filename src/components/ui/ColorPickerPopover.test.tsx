import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ColorPickerPopover,
  hexToHsv,
  hsvToHex,
  normalizeHexColor,
} from './ColorPickerPopover';

describe('ColorPickerPopover', () => {
  it('converts between HEX and HSV cleanly and normalizes 3-digit / 6-digit hex inputs', () => {
    expect(normalizeHexColor('#abc')).toBe('#aabbcc');
    expect(normalizeHexColor('38BDF8')).toBe('#38bdf8');
    expect(normalizeHexColor('#22d3ee')).toBe('#22d3ee');
    expect(normalizeHexColor('not-a-hex')).toBeNull();

    const hsv = hexToHsv('#38bdf8');
    expect(hsv.h).toBeGreaterThan(190);
    expect(hsv.h).toBeLessThan(205);
    expect(hsvToHex(hsv.h, hsv.s, hsv.v)).toMatch(/^#[0-9a-f]{6}$/);
    expect(hsvToHex(0, 100, 100)).toBe('#ff0000');
    expect(hsvToHex(120, 100, 100)).toBe('#00ff00');
  });

  it('opens an in-app popover, selects curated swatches, accepts hex typing, and closes on Escape', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <ColorPickerPopover
        ariaLabel="Color personalizado del indicador"
        dialogLabel="Selector de color del indicador"
        onChange={onChange}
        value="#4ade80"
      />
    );

    const trigger = screen.getByRole('button', { name: /Color personalizado del indicador/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByRole('dialog', { name: /Selector de color del indicador/i })
    ).toBeInTheDocument();

    const cyanSwatch = screen.getByRole('button', { name: /Elegir #38bdf8/i });
    await user.click(cyanSwatch);
    expect(onChange).toHaveBeenCalledWith('#38bdf8');

    const hexInput = screen.getByLabelText(/Código hexadecimal/i);
    fireEvent.change(hexInput, { target: { value: '#ff66aa' } });
    expect(onChange).toHaveBeenCalledWith('#ff66aa');

    const hueSlider = screen.getByLabelText(/Tono/i);
    fireEvent.change(hueSlider, { target: { value: '270' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.stringMatching(/^#[0-9a-f]{6}$/));

    await user.keyboard('{Escape}');
    expect(
      screen.queryByRole('dialog', { name: /Selector de color del indicador/i })
    ).not.toBeInTheDocument();
  });
});
