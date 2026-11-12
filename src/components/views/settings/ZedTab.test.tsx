import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ZedTab } from './ZedTab';

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
});
