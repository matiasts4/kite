import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddProviderModal } from './AddProviderModal';
import { AccountSwitcherModal } from './AccountSwitcherModal';

vi.mock('../../lib/ipc', () => ({
  listSavedAccounts: vi.fn().mockResolvedValue([
    {
      id: 'acc-1',
      provider: 'antigravity',
      label: 'Google Personal',
      email: 'personal@gmail.com',
      isActive: true,
      primaryRemainingPercent: 88,
    },
    {
      id: 'acc-2',
      provider: 'antigravity',
      label: 'Google Work',
      email: 'work@company.com',
      isActive: false,
      primaryRemainingPercent: 40,
    },
  ]),
  switchAccountProfile: vi.fn().mockResolvedValue({
    success: true,
    profile: { id: 'acc-2', label: 'Google Work', isActive: true },
  }),
  saveCurrentAccountProfile: vi.fn().mockResolvedValue({
    success: true,
    profile: { id: 'acc-3', label: 'Google New', isActive: true },
  }),
  deleteAccountProfile: vi.fn().mockResolvedValue({ success: true }),
  getProviderCredentials: vi.fn().mockResolvedValue({ success: true, credentials: [] }),
  saveProviderCredential: vi.fn().mockResolvedValue({ success: true }),
  deleteProviderCredential: vi.fn().mockResolvedValue({ success: true }),
}));

describe('AddProviderModal & AccountSwitcherModal (Unified Modals)', () => {
  it('renders AddProviderModal with search filter and multi-selection', async () => {
    const user = userEvent.setup();
    const handleAdd = vi.fn();
    const handleClose = vi.fn();

    render(
      <AddProviderModal
        isOpen={true}
        onClose={handleClose}
        availableProviders={['codex', 'grok', 'cursor']}
        quotas={{}}
        onAdd={handleAdd}
      />
    );

    // Header and search are present
    expect(screen.getByText('Agregar proveedores de IA')).toBeInTheDocument();
    const searchInput = screen.getByPlaceholderText(/buscar por nombre, proveedor o modelo/i);
    expect(searchInput).toBeInTheDocument();

    // Provider cards are rendered
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('Grok Build')).toBeInTheDocument();
    expect(screen.getAllByText('Cursor').length).toBeGreaterThanOrEqual(1);

    // Filter by 'grok'
    await user.type(searchInput, 'grok');
    expect(screen.getByText('Grok Build')).toBeInTheDocument();
    expect(screen.queryByText('Codex')).not.toBeInTheDocument();

    // Select Grok Build card
    await user.click(screen.getByText('Grok Build'));

    // Submit button shows 1 selected
    const submitBtn = screen.getByRole('button', { name: /agregar 1 proveedor/i });
    expect(submitBtn).toBeEnabled();

    await user.click(submitBtn);
    expect(handleAdd).toHaveBeenCalledWith(['grok']);
    expect(handleClose).toHaveBeenCalled();
  });

  it('highlights detected sessions and supports "Solo con sesión detectada" in AddProviderModal', async () => {
    const user = userEvent.setup();
    const handleAdd = vi.fn();
    const handleClose = vi.fn();

    const detectedSessions: any = {
      codex: {
        providerId: 'codex',
        hasSession: true,
        sessionType: 'cli_authenticated',
        statusLabel: 'Sesión CLI detectada',
        statusTone: 'ok',
        email: 'codex@openai.com',
      },
      cursor: {
        providerId: 'cursor',
        hasSession: true,
        sessionType: 'terminal_agent',
        statusLabel: 'Agente en terminal',
        statusTone: 'ok',
        terminalTitle: 'Cursor Agent #1',
      },
      grok: {
        providerId: 'grok',
        hasSession: false,
        sessionType: 'cli_installed',
        statusLabel: 'CLI instalada',
        statusTone: 'warn',
      },
    };

    render(
      <AddProviderModal
        isOpen={true}
        onClose={handleClose}
        availableProviders={['codex', 'grok', 'cursor']}
        quotas={{}}
        detectedSessions={detectedSessions}
        onAdd={handleAdd}
      />
    );

    // Badges and emails are displayed
    expect(screen.getByText('Sesión CLI detectada')).toBeInTheDocument();
    expect(screen.getByText('Agente en terminal')).toBeInTheDocument();
    expect(screen.getByText('CLI instalada')).toBeInTheDocument();
    expect(screen.getByText('codex@openai.com')).toBeInTheDocument();
    expect(screen.getByText('Cursor Agent #1')).toBeInTheDocument();

    // Click "Solo con sesión detectada (2)"
    const detectedBtn = screen.getByRole('button', { name: /solo con sesión detectada/i });
    expect(detectedBtn).toBeInTheDocument();
    await user.click(detectedBtn);

    // Selected count is 2 (codex and cursor)
    const submitBtn = screen.getByRole('button', { name: /agregar 2 proveedores/i });
    expect(submitBtn).toBeEnabled();

    await user.click(submitBtn);
    expect(handleAdd).toHaveBeenCalledWith(expect.arrayContaining(['codex', 'cursor']));
  });

  it('renders AccountSwitcherModal with accounts list, active state and switch action', async () => {
    const user = userEvent.setup();
    const handleClose = vi.fn();
    const handleSwitched = vi.fn();

    render(
      <AccountSwitcherModal
        provider="antigravity"
        providerLabel="Antigravity"
        isOpen={true}
        onClose={handleClose}
        onAccountSwitched={handleSwitched}
      />
    );

    // Header
    expect(screen.getByText('Cuentas de Antigravity')).toBeInTheDocument();

    // Saved accounts
    expect(await screen.findByText('Google Personal')).toBeInTheDocument();
    expect(screen.getByText('Google Work')).toBeInTheDocument();
    expect(screen.getByText('personal@gmail.com')).toBeInTheDocument();

    // Active badge for personal
    expect(screen.getByText('Activa')).toBeInTheDocument();

    // Activate work account
    const activateBtn = screen.getByRole('button', { name: /activar/i });
    await user.click(activateBtn);

    expect(handleSwitched).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Google Work' })
    );
  });
});
