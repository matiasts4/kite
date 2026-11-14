import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ZedTab } from './ZedTab';
import {
  OPERATOR_CONFIG_DEBOUNCE_MS,
  OPERATOR_CONFIG_STORAGE_KEY,
  resetOperatorConfigDebounceForTest,
} from '../../../lib/operator/config/storage';

vi.mock('../../../lib/ipc', () => ({
  invokeCommand: vi.fn().mockResolvedValue({}),
  isTauriEnvironment: vi.fn(() => false),
}));

vi.mock('../../../lib/operator/voice/zedVoice', () => ({
  listAudioInputDevices: vi.fn().mockResolvedValue([]),
  startMicrophoneTest: vi.fn(),
  startTranscriptionTestSession: vi.fn(),
  releaseOperatorCapture: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib/operator/ttsNarrator', () => ({
  ttsNarrator: {
    speak: vi.fn(),
    stop: vi.fn(),
    getAvailableVoices: vi.fn().mockResolvedValue([]),
  },
  getAvailableVoices: vi.fn().mockResolvedValue([]),
}));

describe('ZedTab Component Refactoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetOperatorConfigDebounceForTest();
  });

  afterEach(() => {
    resetOperatorConfigDebounceForTest();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('navigates assistant sections in the shared master-detail', () => {
    render(<ZedTab />);

    expect(screen.getByText(/Operador y Asistente de IA/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Proveedor$/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText(/Canal y Pasarela de Proveedor IA/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^OpenCode Go/ })).toBeInTheDocument();
    expect(screen.queryByText(/Memoria Compartida de Zed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Identidad y Comportamiento de Zed/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Latencia$/ }));
    expect(screen.getByText(/Rendimiento y Latencia por Proveedor \/ Tarea/i)).toBeInTheDocument();
    expect(screen.queryByText(/Canal y Pasarela de Proveedor IA/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Voz$/ }));
    expect(screen.getByText(/Entrada de Audio y Micrófono del Asistente/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Persona$/ }));
    expect(screen.getByText(/Identidad y Comportamiento de Zed/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Memoria$/ }));
    const memoryTitle = screen.getByText(/Memoria Compartida de Zed/i);
    expect(memoryTitle.closest('.qt-providers-container')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Proveedor$/ }));
    const gateway = screen.getByText(/Canal y Pasarela de Proveedor IA/i);
    expect(gateway.closest('.qt-providers-container')).not.toBeNull();
  });

  it('keeps inputs reactive on every keystroke while debouncing storage and credential persistence', () => {
    vi.useFakeTimers();
    const setItemSpy = vi.spyOn(localStorage, 'setItem');
    render(<ZedTab />);
    setItemSpy.mockClear();

    const accountInput = screen.getByPlaceholderText('Tu Account ID de Cloudflare') as HTMLInputElement;
    fireEvent.change(accountInput, { target: { value: 'acc-1' } });
    fireEvent.change(accountInput, { target: { value: 'acc-12' } });
    fireEvent.change(accountInput, { target: { value: 'acc-123' } });

    expect(accountInput.value).toBe('acc-123');
    expect(setItemSpy).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(OPERATOR_CONFIG_DEBOUNCE_MS);
    });

    const configWrites = setItemSpy.mock.calls.filter(([k]) => k === OPERATOR_CONFIG_STORAGE_KEY);
    expect(configWrites).toHaveLength(1);
    expect(JSON.parse(configWrites[0][1]).cloudflareAccountId).toBe('acc-123');
  });

  it('flushes pending debounced edits immediately on input blur', () => {
    vi.useFakeTimers();
    render(<ZedTab />);

    const accountInput = screen.getByPlaceholderText('Tu Account ID de Cloudflare');
    fireEvent.change(accountInput, { target: { value: 'blur-id-99' } });
    expect(localStorage.getItem(OPERATOR_CONFIG_STORAGE_KEY)).toBeNull();

    fireEvent.blur(accountInput);

    const stored = JSON.parse(localStorage.getItem(OPERATOR_CONFIG_STORAGE_KEY) ?? '{}');
    expect(stored.cloudflareAccountId).toBe('blur-id-99');
  });

  it('flushes pending debounced edits on component unmount so tab or modal close never drops changes', () => {
    vi.useFakeTimers();
    const { unmount } = render(<ZedTab />);

    const tokenInput = screen.getByLabelText('Cloudflare API Token');
    fireEvent.change(tokenInput, { target: { value: 'cf-secret-token' } });
    expect(localStorage.getItem(OPERATOR_CONFIG_STORAGE_KEY)).toBeNull();

    unmount();

    const stored = JSON.parse(localStorage.getItem(OPERATOR_CONFIG_STORAGE_KEY) ?? '{}');
    expect(stored.cloudflareApiToken).toBe('cf-secret-token');
  });
});
