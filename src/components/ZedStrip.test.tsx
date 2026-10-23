import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ZedStripHost, type ZedCallState } from './ZedStrip';
import { ZedTab } from './views/settings/ZedTab';
import * as operatorBrain from '../lib/operator/operatorBrain';

vi.mock('./ZedOrb', () => ({
  ZedOrb: ({ size, state }: { size?: number; state?: string }) => (
    <div data-testid="zed-orb" data-size={size} data-state={state} />
  ),
}));

vi.mock('../lib/operator/ttsNarrator', () => ({
  ttsNarrator: {
    isMuted: vi.fn().mockReturnValue(false),
    toggleMute: vi.fn().mockReturnValue(true),
    stop: vi.fn(),
    speak: vi.fn(),
    onStateChange: vi.fn().mockReturnValue(() => {}),
  },
}));

const activeCall: ZedCallState = {
  isActive: true,
  status: 'connected',
  toolCalls: [],
};

describe('ZedStripHost & ZedTab (Clean Native Kite UI)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders the spherical ZedOrb and the 3 dock buttons [Mic, Speaker, Close]', async () => {
    const onToggleSpeaker = vi.fn();
    render(<ZedStripHost call={activeCall} onToggleSpeaker={onToggleSpeaker} />);

    // 1. Spherical Orb
    expect(screen.getByTestId('zed-orb')).toBeInTheDocument();

    // 2. Microphone toggle button
    expect(screen.getByLabelText(/dictar por voz/i)).toBeInTheDocument();

    // 3. Speaker (Parlante) toggle button
    const speakerBtn = screen.getByLabelText(/voz en altavoz/i);
    expect(speakerBtn).toBeInTheDocument();
    fireEvent.click(speakerBtn);
    expect(onToggleSpeaker).toHaveBeenCalledTimes(1);

    // 4. Close button
    expect(screen.getByLabelText(/cerrar asistente/i)).toBeInTheDocument();
  });

  it('dispatches operator commands from ZedStripHost and displays receipt note', async () => {
    vi.spyOn(operatorBrain, 'dispatchOperatorCommand').mockResolvedValueOnce({
      reply: 'Se abrieron 2 terminales con Grok.',
      actions: [
        {
          type: 'open_terminals',
          count: 2,
          engine: 'grok',
        },
      ],
      provider: 'opencode',
      model: 'deepseek-4.1-flash',
      latencyMs: 185,
      usedFallbackLocal: false,
    });

    render(
      <ZedStripHost
        call={activeCall}
        onExecuteCommand={(cmd) => operatorBrain.dispatchOperatorCommand(cmd)}
      />
    );

    const input = screen.getByPlaceholderText(/abre 2 terminales/i);
    fireEvent.change(input, { target: { value: 'Abre 2 terminales con Grok' } });
    fireEvent.submit(input.closest('form')!);

    await waitFor(() => {
      expect(operatorBrain.dispatchOperatorCommand).toHaveBeenCalledWith(
        'Abre 2 terminales con Grok'
      );
      expect(screen.getByText(/Se abrieron 2 terminales con Grok/i)).toBeInTheDocument();
      expect(screen.getAllByText(/185ms/i).length).toBeGreaterThan(0);
    });
  });

  it('renders ZedTab inside Settings with OpenCode Go and zero emojis', () => {
    const { container } = render(<ZedTab />);

    expect(screen.getByText(/Operador y Asistente de IA/i)).toBeInTheDocument();
    expect(screen.getByText(/Canal y Pasarela de Proveedor IA/i)).toBeInTheDocument();
    expect(screen.getAllByText(/DeepSeek.*4\.1.*Flash/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Rendimiento y Latencia por Proveedor/i)).toBeInTheDocument();

    // Verify no emoji characters exist in rendered text
    const text = container.textContent || '';
    expect(text).not.toMatch(/[\u{1F300}-\u{1F9FF}]/u);
  });

  it('filters the OpenCode model list from the search field', async () => {
    const user = userEvent.setup();
    render(<ZedTab />);

    await user.click(screen.getByRole('combobox', { name: 'Modelo de OpenCode' }));
    await user.type(screen.getByRole('combobox', { name: 'Buscar modelo' }), 'kimi');

    expect(screen.getAllByRole('option', { name: /kimi/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('option', { name: /deepseek/i })).not.toBeInTheDocument();
  });

  it('renders nothing when call.isActive is false (default closed pill state)', () => {
    const { container } = render(
      <ZedStripHost
        call={{
          isActive: false,
          status: 'idle',
          toolCalls: [],
        }}
      />
    );

    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('zed-orb')).not.toBeInTheDocument();
  });

  it('does not render bottom helper bar when idle (clean spherical widget)', () => {
    render(<ZedStripHost call={activeCall} />);

    // When idle, the bottom text bar is completely omitted as requested
    expect(screen.queryByTestId('zed-status')).not.toBeInTheDocument();
    expect(screen.queryByText(/Mantén para hablar/i)).not.toBeInTheDocument();
  });

  it('triggers onEndCall when clicking the visible ✕ close button', () => {
    const onEndCall = vi.fn();
    render(<ZedStripHost call={activeCall} onEndCall={onEndCall} />);

    const closeBtn = screen.getByLabelText('Cerrar Asistente');
    expect(closeBtn).toBeInTheDocument();
    fireEvent.click(closeBtn);

    expect(onEndCall).toHaveBeenCalledTimes(1);
  });

  it('triggers onEndCall when pressing Escape', () => {
    const onEndCall = vi.fn();
    render(<ZedStripHost call={activeCall} onEndCall={onEndCall} />);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onEndCall).toHaveBeenCalledTimes(1);
  });

  it('provides click-to-speak role and affordance on the sphere handle', () => {
    render(<ZedStripHost call={activeCall} />);

    const handle = screen.getByRole('button', { name: /Iniciar dictado de voz/i });
    expect(handle).toBeInTheDocument();
    expect(handle).toHaveAttribute('title', expect.stringContaining('Ctrl+Shift+V'));
  });

  it('supports dragging and push-to-talk with window pointer events', () => {
    vi.useFakeTimers();
    render(<ZedStripHost call={activeCall} />);

    const handle = screen.getByRole('button', { name: /Iniciar dictado de voz/i });

    // Drag move
    fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 150, clientY: 180 });
    fireEvent.pointerUp(window, { clientX: 150, clientY: 180 });

    vi.useRealTimers();
  });

});
