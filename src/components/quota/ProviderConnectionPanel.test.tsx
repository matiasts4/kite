import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProviderConnectionPanel } from './ProviderConnectionPanel';
import * as connectionMethods from '../../lib/quota/connectionMethods';

vi.mock('../../lib/ipc', () => ({
  saveProviderCredential: vi.fn().mockResolvedValue({ success: true, preview: 'sk-...1234' }),
  deleteProviderCredential: vi.fn().mockResolvedValue({ success: true }),
  getProviderCredentials: vi.fn().mockResolvedValue({ success: true, credentials: [] }),
  isTauriEnvironment: vi.fn().mockReturnValue(false),
}));

vi.mock('../../lib/terminalLinkNav', () => ({
  openExternalLink: vi.fn(),
}));

describe('ProviderConnectionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders CLI, API Key and Portal tabs for providers that support them', () => {
    render(
      <ProviderConnectionPanel
        providerId="claude"
        detectedSession={{
          providerId: 'claude',
          hasSession: false,
          sessionType: 'none',
          statusLabel: 'No instalado',
          statusTone: 'idle',
        }}
      />
    );

    // Tab buttons
    expect(screen.getByRole('tab', { name: /sesión cli \/ terminal/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /clave de api en bóveda/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /consola y enlaces/i })).toBeInTheDocument();

    // Default CLI tab shows the login command
    expect(screen.getByText('claude login')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copiar comando/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copiar e ir a terminal/i })).toBeInTheDocument();
  });

  it('allows switching to API Key tab and saving a key into the vault', async () => {
    const user = userEvent.setup();
    const handleChanged = vi.fn();

    render(
      <ProviderConnectionPanel
        providerId="codex"
        detectedSession={{
          providerId: 'codex',
          hasSession: false,
          sessionType: 'none',
          statusLabel: 'No instalado',
          statusTone: 'idle',
        }}
        onCredentialChanged={handleChanged}
      />
    );

    // Switch to API Key tab
    const apiKeyTab = screen.getByRole('tab', { name: /clave de api en bóveda/i });
    await user.click(apiKeyTab);

    // Input is visible
    const input = screen.getByPlaceholderText('sk-proj-...');
    expect(input).toBeInTheDocument();

    // Type API key and save
    await user.type(input, 'sk-proj-test-1234567890');
    const saveBtn = screen.getByRole('button', { name: /guardar clave en bóveda/i });
    expect(saveBtn).toBeEnabled();

    await user.click(saveBtn);

    expect(await screen.findByText(/clave de api guardada y cifrada en tu bóveda/i)).toBeInTheDocument();
    expect(handleChanged).toHaveBeenCalled();
  });

  it('copies command and navigates to terminal when clicking "Copiar e ir a Terminal"', async () => {
    const user = userEvent.setup();
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    render(
      <ProviderConnectionPanel
        providerId="grok"
        detectedSession={{
          providerId: 'grok',
          hasSession: false,
          sessionType: 'none',
          statusLabel: 'No instalado',
          statusTone: 'idle',
        }}
      />
    );

    const termBtn = screen.getByRole('button', { name: /copiar e ir a terminal/i });
    await user.click(termBtn);

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'kite:navigate-mode',
        detail: 'code',
      })
    );
  });

  it('switches to portal tab and allows opening the official web console', async () => {
    const user = userEvent.setup();
    const openPortalSpy = vi.spyOn(connectionMethods, 'openProviderPortal');

    render(
      <ProviderConnectionPanel
        providerId="antigravity"
        detectedSession={{
          providerId: 'antigravity',
          hasSession: false,
          sessionType: 'none',
          statusLabel: 'No instalado',
          statusTone: 'idle',
        }}
      />
    );

    const portalTab = screen.getByRole('tab', { name: /consola y enlaces/i });
    await user.click(portalTab);

    const portalBtn = screen.getByRole('button', { name: /abrir google ai studio/i });
    expect(portalBtn).toBeInTheDocument();

    await user.click(portalBtn);
    expect(openPortalSpy).toHaveBeenCalledWith('antigravity');
  });

  it('displays failure error message when an update job fails in CLI tab', async () => {
    const agentUpdatesMod = await import('../../lib/agentUpdates');
    const spy = vi.spyOn(agentUpdatesMod, 'useAgentUpdates').mockReturnValue({
      summary: {
        totalSupported: 1,
        installedCount: 1,
        outdatedCount: 1,
        advisories: {
          antigravity: {
            engine: 'antigravity',
            displayName: 'Antigravity',
            state: 'outdated',
            currentVersion: '1.5.17',
            latestVersion: '1.5.18',
            updateCommand: 'agy update',
            checkedAtUnixMs: Date.now(),
          },
        },
        lastCheckedUnixMs: Date.now(),
      },
      activeJobs: {
        antigravity: {
          jobId: 'job-err-1',
          engine: 'antigravity',
          action: 'update',
          status: 'failed',
          error: 'No se pudo ejecutar agy update',
          startedAtUnixMs: Date.now(),
          finishedAtUnixMs: Date.now(),
        },
      },
      isChecking: false,
      refresh: vi.fn(),
      triggerJob: vi.fn(),
    });

    render(
      <ProviderConnectionPanel
        providerId="antigravity"
        detectedSession={{
          providerId: 'antigravity',
          hasSession: true,
          sessionType: 'cli_authenticated',
          statusLabel: 'Conectada',
          statusTone: 'ok',
        }}
      />
    );

    expect(screen.getByText(/no se pudo ejecutar agy update/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
    // Lifecycle card must not be nested inside the login-command header flex row
    const loginHeading = screen.getByText(/comando de inicio de sesión/i);
    expect(loginHeading.parentElement?.querySelector('.qt-lifecycle')).toBeNull();
    spy.mockRestore();
  });
});
