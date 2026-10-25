import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarFooter } from './SidebarFooter';

vi.mock('../../hooks/useAppUpdater', () => ({
  useAppUpdater: () => ({
    state: { status: 'idle' },
    check: vi.fn(),
    install: vi.fn(),
    restart: vi.fn(),
    updateAndRestart: vi.fn(),
    clearError: vi.fn(),
  }),
}));

describe('SidebarFooter Component', () => {
  it('renders account name, plan tier, and credits when provided', () => {
    const onOpenSettings = vi.fn();
    const onToggleAppearance = vi.fn();

    render(
      <SidebarFooter
        accountName="Kite Developer"
        accountTier="PRO"
        accountTierPaid={true}
        creditsLabel="10,000"
        appearance="dark"
        onOpenSettings={onOpenSettings}
        onToggleAppearance={onToggleAppearance}
      />
    );

    // Verifies account name is rendered
    expect(screen.getByText('Kite Developer')).toBeInTheDocument();
    expect(screen.getByText('K')).toBeInTheDocument();

    // Verifies credits and subscription plan are displayed
    expect(screen.getByText('PRO')).toBeInTheDocument();
    expect(screen.getByText('10,000')).toBeInTheDocument();
  });

  it('falls back to Kite and K avatar when account name is not provided', () => {
    render(
      <SidebarFooter
        appearance="dark"
        onOpenSettings={vi.fn()}
        onToggleAppearance={vi.fn()}
      />
    );

    expect(screen.getByText('Kite')).toBeInTheDocument();
    expect(screen.getByText('K')).toBeInTheDocument();
  });

  it('triggers onOpenSettings when clicking the account row', async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();

    render(
      <SidebarFooter
        accountName="Alex"
        appearance="light"
        onOpenSettings={onOpenSettings}
        onToggleAppearance={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: /Account/i }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
