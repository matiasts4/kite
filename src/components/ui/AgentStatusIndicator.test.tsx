import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentStatusIndicator, OrbitDotsSpinner } from './AgentStatusIndicator';
import { resolveAgentRoleKind, SubagentRoleIcon } from './SubagentRoleIcon';

describe('OrbitDotsSpinner & AgentStatusIndicator', () => {
  it('renders 4 circular dots arranged on an orbital ring', () => {
    const { container } = render(<OrbitDotsSpinner size={14} />);
    const spinner = screen.getByTestId('agent-orbit-spinner');
    expect(spinner).toHaveClass('agent-orbit-spinner');
    const dots = container.querySelectorAll('circle');
    expect(dots).toHaveLength(4);
    dots.forEach((dot) => {
      expect(Number(dot.getAttribute('r'))).toBeGreaterThan(0);
    });
  });

  it('switches cleanly between running, backgroundWorking, waiting, completed, failed, and killed states', () => {
    const { rerender, container } = render(<AgentStatusIndicator status="running" size={14} />);
    expect(screen.getByTestId('agent-status-indicator')).toHaveAttribute('data-status', 'running');
    expect(screen.getByTestId('agent-orbit-spinner')).toBeInTheDocument();

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
});
