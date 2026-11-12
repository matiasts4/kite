import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGlobalShortcuts, SHORTCUT_TRIGGERED_EVENT } from './useGlobalShortcuts';
import { saveShortcut, resetAllShortcuts } from './shortcutsRegistry';

describe('useGlobalShortcuts hook', () => {
  beforeEach(() => {
    localStorage.clear();
    resetAllShortcuts();
    vi.restoreAllMocks();
  });

  it('triggers handler when default shortcut combination is pressed', () => {
    const onToggleSidebar = vi.fn();
    renderHook(() =>
      useGlobalShortcuts({
        platform: 'windows',
        handlers: {
          'toggle-sidebar': onToggleSidebar,
        },
      })
    );

    // Press Ctrl+B
    const event = new KeyboardEvent('keydown', {
      key: 'b',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('dispatches SHORTCUT_TRIGGERED_EVENT when matched', () => {
    const eventListener = vi.fn();
    window.addEventListener(SHORTCUT_TRIGGERED_EVENT, eventListener);

    renderHook(() =>
      useGlobalShortcuts({
        platform: 'windows',
      })
    );

    const event = new KeyboardEvent('keydown', {
      key: 'p',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(eventListener).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { id: 'command-palette' },
      })
    );

    window.removeEventListener(SHORTCUT_TRIGGERED_EVENT, eventListener);
  });

  it('responds to custom updated shortcut', () => {
    const onToggleSidebar = vi.fn();
    renderHook(() =>
      useGlobalShortcuts({
        platform: 'windows',
        handlers: {
          'toggle-sidebar': onToggleSidebar,
        },
      })
    );

    // Save custom keys for toggle-sidebar: Ctrl+Shift+X inside act
    act(() => {
      saveShortcut('toggle-sidebar', ['Ctrl', 'Shift', 'X'], 'windows');
    });

    // Press old Ctrl+B -> should NOT trigger
    const oldEvent = new KeyboardEvent('keydown', {
      key: 'b',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(oldEvent);
    expect(onToggleSidebar).not.toHaveBeenCalled();

    // Press new Ctrl+Shift+X -> should trigger
    const newEvent = new KeyboardEvent('keydown', {
      key: 'x',
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(newEvent);
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });

  it('does not hijack plain typing inside an input element', () => {
    const onModeAgent = vi.fn();
    renderHook(() =>
      useGlobalShortcuts({
        platform: 'windows',
        handlers: {
          'mode-agent': onModeAgent,
        },
      })
    );

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();

    // Pressing 'a' inside input
    const charEvent = new KeyboardEvent('keydown', {
      key: 'a',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(charEvent, 'target', { value: input });
    window.dispatchEvent(charEvent);

    expect(onModeAgent).not.toHaveBeenCalled();
    expect(charEvent.defaultPrevented).toBe(false);

    document.body.removeChild(input);
  });

  it('does not consume Escape when the target is a textarea inside .xterm', () => {
    const onBackEsc = vi.fn(() => true);
    const eventListener = vi.fn();
    window.addEventListener(SHORTCUT_TRIGGERED_EVENT, eventListener);

    renderHook(() =>
      useGlobalShortcuts({
        platform: 'windows',
        handlers: {
          'back-esc': onBackEsc,
        },
      })
    );

    const host = document.createElement('div');
    host.className = 'xterm';
    const textarea = document.createElement('textarea');
    host.appendChild(textarea);
    document.body.appendChild(host);

    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'target', { value: textarea });
    window.dispatchEvent(event);

    expect(onBackEsc).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(eventListener).not.toHaveBeenCalled();

    window.removeEventListener(SHORTCUT_TRIGGERED_EVENT, eventListener);
    document.body.removeChild(host);
  });

  it('does not consume Escape when the back-esc handler returns false', () => {
    const onBackEsc = vi.fn(() => false);
    renderHook(() =>
      useGlobalShortcuts({
        platform: 'windows',
        handlers: {
          'back-esc': onBackEsc,
        },
      })
    );

    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(onBackEsc).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it('consumes Escape when the back-esc handler returns true', () => {
    const onBackEsc = vi.fn(() => true);
    renderHook(() =>
      useGlobalShortcuts({
        platform: 'windows',
        handlers: {
          'back-esc': onBackEsc,
        },
      })
    );

    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(onBackEsc).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('still consumes Ctrl+P when the target is inside .xterm', () => {
    const onCommandPalette = vi.fn();
    renderHook(() =>
      useGlobalShortcuts({
        platform: 'windows',
        handlers: {
          'command-palette': onCommandPalette,
        },
      })
    );

    const host = document.createElement('div');
    host.className = 'xterm';
    const textarea = document.createElement('textarea');
    host.appendChild(textarea);
    document.body.appendChild(host);

    const event = new KeyboardEvent('keydown', {
      key: 'p',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, 'target', { value: textarea });
    window.dispatchEvent(event);

    expect(onCommandPalette).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);

    document.body.removeChild(host);
  });
});
