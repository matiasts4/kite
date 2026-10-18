import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountTab } from './AccountTab';

vi.mock('../../../lib/settingsNav', () => ({
  openSettingsTab: vi.fn(),
}));

import { openSettingsTab } from '../../../lib/settingsNav';

describe('AccountTab Component', () => {
  it('renders profile information without plan tiers or credits section', () => {
    render(
      <AccountTab
        accountName="Test User"
        accountEmail="test@example.com"
        accountTier="STUDIO EDITION"
        creditsLabel="500,000"
      />
    );

    // Profile renders
    expect(screen.getByText('Test User')).toBeInTheDocument();
    expect(screen.getByText('test@example.com')).toBeInTheDocument();

    // Verify tier and credits are NOT displayed in AccountTab
    expect(screen.queryByText('STUDIO EDITION')).not.toBeInTheDocument();
    expect(screen.queryByText(/Capacidad y Créditos de IA/i)).not.toBeInTheDocument();
    expect(screen.queryByText('500,000')).not.toBeInTheDocument();
  });

  it('allows opening the Accounts Vault', async () => {
    const user = userEvent.setup();
    render(<AccountTab />);

    const vaultBtn = screen.getByRole('button', { name: /Bóveda de Cuentas…/i });
    await user.click(vaultBtn);

    expect(openSettingsTab).toHaveBeenCalledWith('quotas');
  });

  it('renders privacy and terms modals with Kite branding', async () => {
    const user = userEvent.setup();
    render(<AccountTab />);

    const privacyBtn = screen.getByLabelText(/Ver política de privacidad/i);
    await user.click(privacyBtn);

    expect(screen.getByText('Privacidad y Protección de Datos')).toBeInTheDocument();
    expect(screen.getByText(/Kite funciona bajo una arquitectura/i)).toBeInTheDocument();

    const closeBtn = screen.getByRole('button', { name: /Entendido/i });
    await user.click(closeBtn);
    expect(screen.queryByText('Privacidad y Protección de Datos')).not.toBeInTheDocument();
  });
});
