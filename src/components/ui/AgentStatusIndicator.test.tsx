import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_ACTIVITY_INDICATOR_OPTIONS,
  AgentStatusIndicator,
} from './AgentStatusIndicator';
import {
  readAgentActivityIndicatorColor,
  readAgentActivityIndicatorStyle,
  writeAgentActivityIndicatorColor,
  writeAgentActivityIndicatorStyle,
} from '../../lib/kitePrefs';
import { resolveAgentRoleKind, SubagentRoleIcon } from './SubagentRoleIcon';

describe('AgentStatusIndicator', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('switches cleanly between running, backgroundWorking, waiting, completed, failed, and killed states', () => {
    const { rerender, container } = render(<AgentStatusIndicator status="running" size={14} />);
    expect(screen.getByTestId('agent-status-indicator')).toHaveAttribute('data-status', 'running');
    expect(screen.getByTestId('agent-status-indicator')).toHaveAttribute('data-variant', 'matrix-grid');
    expect(screen.getByTestId('agent-activity-matrix-grid')).toBeInTheDocument();

    rerender(<AgentStatusIndicator status="backgroundWorking" size={14} />);
    expect(screen.getByTestId('agent-status-indicator')).toHaveAttribute('data-status', 'backgroundWorking');
    expect(container.querySelectorAll('.agent-dot-bounce__dot')).toHaveLength(3);

    rerender(<AgentStatusIndicator status="waiting" toolName="run_command" size={14} />);
    expect(screen.getByTestId('agent-status-indicator')).toHaveAttribute('data-status', 'waiting');
    expect(screen.getByTestId('agent-status-indicator')).toHaveAttribute('data-attention-kind', 'terminal');
    expect(container.querySelector('.agent-status-attention__dot')).toBeInTheDocument();

    rerender(<AgentStatusIndicator status="completed" size={14} />);
    expect(screen.getByTestId('agent-status-indicator')).toHaveAttribute('data-status', 'completed');

    rerender(<AgentStatusIndicator status="completed" idleFallback={<span>3m</span>} size={14} />);
    expect(screen.getByText('3m')).toBeInTheDocument();

    rerender(<AgentStatusIndicator status="failed" size={14} />);
    expect(screen.getByTestId('agent-status-indicator')).toHaveAttribute('data-status', 'failed');

    rerender(<AgentStatusIndicator status="killed" size={14} />);
    expect(screen.getByTestId('agent-status-indicator')).toHaveAttribute('data-status', 'killed');
  });

  it('resolves distinct subagent and specialist role icons consistently', () => {
    expect(resolveAgentRoleKind({ typeName: 'browser', role: 'Web Helper' })).toBe('browser');
    expect(resolveAgentRoleKind({ typeName: 'research', role: 'Codebase Explorer' })).toBe('explore');
    expect(resolveAgentRoleKind({ role: 'Code & Security Auditor' })).toBe('review');
    expect(resolveAgentRoleKind({ id: 'architect', role: 'Software Architect' })).toBe('architect');
    expect(resolveAgentRoleKind({ id: 'debugger', role: 'Root-Cause Debugger' })).toBe('debug');
    expect(resolveAgentRoleKind({ id: 'backend', role: 'Backend & Systems' })).toBe('code');
    expect(resolveAgentRoleKind({ role: 'Swarm Coordinator' })).toBe('orchestrator');
    expect(resolveAgentRoleKind({ role: 'Worker' })).toBe('bot');

    const { rerender } = render(<SubagentRoleIcon typeName="research" role="Explorer" size={14} />);
    expect(screen.getByTestId('subagent-role-icon')).toHaveAttribute('data-role-kind', 'explore');

    rerender(<SubagentRoleIcon role="Auditor" size={14} />);
    expect(screen.getByTestId('subagent-role-icon')).toHaveAttribute('data-role-kind', 'review');
  });

  it('supports all 8 curated running variants, theme-accent/custom colors, and reactive updates', () => {
    expect(readAgentActivityIndicatorStyle()).toBe('matrix-grid');
    expect(readAgentActivityIndicatorColor()).toBe('status');
    expect(AGENT_ACTIVITY_INDICATOR_OPTIONS.map((o) => o.id)).toEqual([
      'matrix-grid',
      'signal-bars',
      'pulse-aura',
      'kite-diamond',
      'matrix-3x3',
      'wave-dots',
      'radar-sweep',
      'chevron-flow',
    ]);

    const { rerender } = render(<AgentStatusIndicator status="running" size={14} />);
    for (const option of AGENT_ACTIVITY_INDICATOR_OPTIONS) {
      rerender(<AgentStatusIndicator status="running" size={14} variant={option.id} />);
      expect(screen.getByTestId('agent-status-indicator')).toHaveAttribute('data-variant', option.id);
      expect(screen.getByTestId(`agent-activity-${option.id}`)).toBeInTheDocument();
    }

    rerender(<AgentStatusIndicator status="running" size={14} />);
    act(() => {
      writeAgentActivityIndicatorStyle('matrix-3x3');
      writeAgentActivityIndicatorColor('accent');
    });
    expect(readAgentActivityIndicatorStyle()).toBe('matrix-3x3');
    expect(readAgentActivityIndicatorColor()).toBe('accent');
    expect(screen.getByTestId('agent-status-indicator')).toHaveAttribute('data-variant', 'matrix-3x3');
    expect(screen.getByTestId('agent-status-indicator')).toHaveAttribute('data-color-mode', 'accent');
    expect(screen.getByTestId('agent-status-indicator')).toHaveStyle({
      color: 'var(--accent, #5c8fff)',
    });

    act(() => {
      writeAgentActivityIndicatorColor('#ff66aa');
    });
    expect(readAgentActivityIndicatorColor()).toBe('#ff66aa');
    expect(screen.getByTestId('agent-status-indicator')).toHaveAttribute('data-color-mode', '#ff66aa');
    expect(screen.getByTestId('agent-status-indicator')).toHaveStyle({ color: '#ff66aa' });

    localStorage.setItem('kite.agentActivityIndicator', 'orbit');
    expect(readAgentActivityIndicatorStyle()).toBe('matrix-grid');
    localStorage.setItem('kite.agentActivityIndicatorColor', 'not-a-color');
    expect(readAgentActivityIndicatorColor()).toBe('status');
  });
});
