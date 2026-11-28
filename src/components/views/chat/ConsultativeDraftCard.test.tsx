import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ConsultativeDraftCard } from './ConsultativeDraftCard';
import { voiceSessionStore } from '../../../lib/operator/voice/voiceSessionStore';

describe('S7 / T6 — ConsultativeDraftCard v2 (Single-Step & Multi-Step Plans)', () => {
  beforeEach(() => {
    voiceSessionStore.stopSession();
    voiceSessionStore.clearDraftProposal('thread-card-1');
    voiceSessionStore.registerTextTurnExecutor(null);
    vi.clearAllMocks();
  });

  it('renders backward-compatible single-step DraftTaskProposal and triggers confirm/cancel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    voiceSessionStore.setDraftProposal('thread-card-1', {
      proposalId: 'prop-single-1',
      status: 'awaiting_confirmation',
      targetKind: 'subagent',
      title: 'Auditar autenticación',
      taskBrief: 'Revisar tokens y sesiones en auth.rs',
      role: 'Auditor',
      provider: 'claude',
      oddMode: true,
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    render(
      <ConsultativeDraftCard
        threadId="thread-card-1"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );

    const card = screen.getByTestId('consultative-draft-card');
    expect(card).toBeInTheDocument();
    expect(screen.getByText('Auditar autenticación')).toBeInTheDocument();
    expect(screen.queryByTestId('consultative-draft-steps')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(voiceSessionStore.getDraftProposal('thread-card-1')).toBeNull();
  });

  it('renders multi-step checklist, allows toggling steps, disables Confirm at 0 enabled, and shows live execution badges', () => {
    voiceSessionStore.setDraftProposal('thread-card-1', {
      proposalId: 'prop-multi-1',
      status: 'awaiting_confirmation',
      targetKind: 'subagent',
      title: 'Plan de verificación y tarea',
      taskBrief: 'Explorar módulo, crear ticket y correr Vitest',
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [
        {
          stepId: 's1',
          title: 'Explorar operator',
          action: { type: 'peek_changes', includeDiff: true },
          enabled: true,
          status: 'pending',
        },
        {
          stepId: 's2',
          title: 'Crear tarea en Kite Tasks',
          action: { type: 'manage_tasks', operation: 'create', title: 'QA Argos' },
          dependsOn: ['s1'],
          enabled: true,
          status: 'pending',
        },
      ],
    });

    render(<ConsultativeDraftCard threadId="thread-card-1" />);

    const stepsList = screen.getByTestId('consultative-draft-steps');
    expect(stepsList).toBeInTheDocument();
    expect(screen.getByText('Explorar operator')).toBeInTheDocument();
    expect(screen.getByText('Crear tarea en Kite Tasks')).toBeInTheDocument();

    const step1Toggle = screen.getByTestId('draft-step-toggle-s1') as HTMLInputElement;
    const step2Toggle = screen.getByTestId('draft-step-toggle-s2') as HTMLInputElement;
    expect(step1Toggle.checked).toBe(true);
    expect(step2Toggle.checked).toBe(true);

    // Disable both steps -> Confirm disabled
    fireEvent.click(step1Toggle);
    fireEvent.click(step2Toggle);
    expect(screen.getByRole('button', { name: 'Confirmar' })).toBeDisabled();

    // Re-enable step 1 and simulate live executing status
    fireEvent.click(step1Toggle);
    expect(screen.getByRole('button', { name: 'Confirmar' })).not.toBeDisabled();

    act(() => {
      voiceSessionStore.updateDraftProposal('thread-card-1', {
        status: 'executing',
      });
      voiceSessionStore.updateDraftProposalStep('thread-card-1', 's1', {
        status: 'running',
      });
      voiceSessionStore.updateDraftProposalStep('thread-card-1', 's2', {
        status: 'skipped',
      });
    });

    expect(screen.getByTestId('draft-step-status-s1')).toHaveTextContent('Ejecutando');
    expect(screen.getByTestId('draft-step-status-s2')).toHaveTextContent('Omitido');
  });
});
