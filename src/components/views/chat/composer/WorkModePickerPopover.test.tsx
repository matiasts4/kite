import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { WorkModePickerPopover } from './WorkModePickerPopover';
import type { DriverChoice } from '../../../../lib/session/types';

describe('WorkModePickerPopover', () => {
  const sampleModes: DriverChoice[] = [
    { id: 'build', label: 'Build', detail: 'Standard build mode', plan: false } as DriverChoice,
    { id: 'plan', label: 'Plan', detail: 'Planning and analysis only', plan: true } as DriverChoice,
    { id: 'gentle-orchestrator', label: 'Gentle Orchestrator', detail: 'Coordinates sub-agents', plan: false } as DriverChoice,
  ];

  it('renders default Build work mode when neither agent nor plan is active', () => {
    render(
      <WorkModePickerPopover
        workModes={sampleModes}
        currentMode="acceptEdits"
        onSelectWorkMode={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox', { name: /work mode and agent/i })).toHaveTextContent('Build');
  });

  it('renders Plan when currentPlan is true', () => {
    render(
      <WorkModePickerPopover
        workModes={sampleModes}
        currentPlan={true}
        currentMode="readOnly"
        onSelectWorkMode={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox', { name: /work mode and agent/i })).toHaveTextContent('Plan');
  });

  it('renders custom agent name when currentAgent matches', () => {
    render(
      <WorkModePickerPopover
        workModes={sampleModes}
        currentAgent="gentle-orchestrator"
        currentMode="acceptEdits"
        onSelectWorkMode={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox', { name: /work mode and agent/i })).toHaveTextContent('Gentle Orchestrator');
  });

  it('opens popover and lists all available modes and custom agents', () => {
    render(
      <WorkModePickerPopover
        workModes={sampleModes}
        currentMode="acceptEdits"
        onSelectWorkMode={vi.fn()}
      />
    );

    const trigger = screen.getByRole('combobox', { name: /work mode and agent/i });
    fireEvent.click(trigger);

    expect(screen.getByText('Work Modes & Agents')).toBeInTheDocument();
    expect(screen.getByText('Gentle Orchestrator')).toBeInTheDocument();
    expect(screen.getByText('Coordinates sub-agents')).toBeInTheDocument();
  });

  it('switches to readOnly permission when selecting a plan agent', () => {
    const onSelect = vi.fn();
    render(
      <WorkModePickerPopover
        workModes={sampleModes}
        currentMode="acceptEdits"
        onSelectWorkMode={onSelect}
      />
    );

    fireEvent.click(screen.getByRole('combobox', { name: /work mode and agent/i }));
    const planOption = screen.getByRole('button', { name: /Plan/i });
    fireEvent.click(planOption);

    expect(onSelect).toHaveBeenCalledWith({
      agent: null,
      plan: true,
      mode: 'readOnly',
    });
  });

  it('switches to acceptEdits when selecting a build agent while in readOnly', () => {
    const onSelect = vi.fn();
    render(
      <WorkModePickerPopover
        workModes={sampleModes}
        currentPlan={true}
        currentMode="readOnly"
        onSelectWorkMode={onSelect}
      />
    );

    fireEvent.click(screen.getByRole('combobox', { name: /work mode and agent/i }));
    const orchestratorOption = screen.getByRole('button', { name: /Gentle Orchestrator/i });
    fireEvent.click(orchestratorOption);

    expect(onSelect).toHaveBeenCalledWith({
      agent: 'gentle-orchestrator',
      plan: false,
      mode: 'acceptEdits',
    });
  });
});
