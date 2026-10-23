import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  it('renders all modular sections without crash', () => {
    render(<ZedTab />);

    // Hero section
    expect(screen.getByText(/Operador y Asistente de IA/i)).toBeInTheDocument();

    // Provider section
    expect(screen.getByText(/Canal y Pasarela de Proveedor IA/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /OpenCode Go/i })).toBeInTheDocument();

    // Latency section
    expect(screen.getByText(/Rendimiento y Latencia por Proveedor \/ Tarea/i)).toBeInTheDocument();

    // Audio section
    expect(screen.getByText(/Entrada de Audio y Micrófono del Asistente/i)).toBeInTheDocument();

    // Persona section
    expect(screen.getByText(/Identidad y Comportamiento de Zed/i)).toBeInTheDocument();

    // Memory section
    expect(screen.getByText(/Memoria Compartida de Zed/i)).toBeInTheDocument();
  });
});
